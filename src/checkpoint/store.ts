import {createHash, randomUUID} from 'node:crypto';
import {lstat, mkdir, readFile, readdir, unlink} from 'node:fs/promises';
import {basename, dirname, join, relative, resolve} from 'node:path';
import {z} from 'zod';
import {WorkspaceAccess} from '../tools/workspace.js';
import {atomicWrite} from '../tools/write.js';
import {assertNoSymlinkPath, ensureWorkspaceStorageDirectory} from '../utils/storage.js';

const entrySchema = z.object({
  path: z.string(),
  relativePath: z.string(),
  existed: z.boolean(),
  blob: z.string().optional(),
  mode: z.number().int().min(0).max(0o777).optional(),
}).strict();

const manifestSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  sessionId: z.string(),
  createdAt: z.string(),
  reason: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  entries: z.array(entrySchema),
}).strict();

export type CheckpointManifest = z.infer<typeof manifestSchema>;

export class CheckpointStore {
  readonly directory: string;
  private readonly workspace: WorkspaceAccess;
  private readonly managedDirectory: boolean;

  constructor(workspace: string | WorkspaceAccess, directory?: string) {
    this.workspace = typeof workspace === 'string'
      ? new WorkspaceAccess([workspace])
      : workspace;
    this.managedDirectory = directory === undefined;
    this.directory = directory
      ? resolve(directory)
      : join(this.workspace.primaryRoot, '.mosaic', 'checkpoints');
  }

  async capture(
    sessionId: string,
    paths: string[],
    options: {reason?: string; metadata?: Record<string, unknown>} = {},
  ): Promise<CheckpointManifest | undefined> {
    validateIdentifier(sessionId, 'session');
    const unique = [...new Set(paths)];
    if (!unique.length) return undefined;
    const id = `${Date.now().toString(36)}-${randomUUID()}`;
    const target = join(this.directory, sessionId, id);
    const blobDirectory = join(target, 'blobs');
    await this.ensureDirectory();
    await this.assertManagedPath(target);
    await mkdir(blobDirectory, {recursive: true});
    await this.assertManagedPath(blobDirectory);
    const entries: CheckpointManifest['entries'] = [];
    for (const input of unique) {
      const path = await this.workspace.resolvePath(input, {allowMissing: true});
      try {
        const info = await lstat(path);
        if (info.isSymbolicLink()) throw new Error(`Cannot checkpoint a symbolic link: ${input}`);
        if (!info.isFile()) throw new Error(`Cannot checkpoint a non-file path: ${input}`);
        if (info.size > 25_000_000) {
          throw new Error(`File is too large to checkpoint (${info.size} bytes): ${input}`);
        }
        const blob = `${createHash('sha256').update(path).digest('hex')}.bin`;
        await atomicWrite(join(blobDirectory, blob), await readFile(path), 0o600);
        entries.push({
          path,
          relativePath: relative(this.workspace.primaryRoot, path),
          existed: true,
          blob,
          mode: info.mode & 0o777,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        entries.push({
          path,
          relativePath: relative(this.workspace.primaryRoot, path),
          existed: false,
        });
      }
    }
    const manifest: CheckpointManifest = {
      version: 1,
      id,
      sessionId,
      createdAt: new Date().toISOString(),
      reason: options.reason ?? 'before write',
      ...(options.metadata ? {metadata: options.metadata} : {}),
      entries,
    };
    await atomicWrite(
      join(target, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      0o600,
    );
    return manifest;
  }

  async load(sessionId: string, checkpointId: string): Promise<CheckpointManifest> {
    validateIdentifier(sessionId, 'session');
    validateIdentifier(checkpointId, 'checkpoint');
    if (!(await this.directoryAvailable())) {
      throw new Error(`Checkpoint not found: ${checkpointId}`);
    }
    const checkpointDirectory = join(this.directory, sessionId, checkpointId);
    await this.assertManagedPath(checkpointDirectory);
    const manifestPath = join(checkpointDirectory, 'manifest.json');
    await this.assertManagedFile(manifestPath);
    const raw = await readFile(manifestPath, 'utf8');
    const manifest = manifestSchema.parse(JSON.parse(raw) as unknown);
    if (manifest.sessionId !== sessionId || manifest.id !== checkpointId) {
      throw new Error('Checkpoint manifest identity does not match its location.');
    }
    return manifest;
  }

  async restore(sessionId: string, checkpointId: string): Promise<string[]> {
    const manifest = await this.load(sessionId, checkpointId);
    const blobDirectory = join(this.directory, sessionId, checkpointId, 'blobs');
    await this.assertManagedPath(blobDirectory);
    const actions: RestoreAction[] = [];
    for (const entry of manifest.entries) {
      const path = await this.workspace.resolvePath(entry.path, {allowMissing: true});
      if (path !== entry.path) throw new Error('Checkpoint path resolution changed.');
      const before = await readSnapshot(path);
      if (!entry.existed) {
        actions.push({path, before, after: null});
        continue;
      }
      if (!entry.blob) throw new Error(`Checkpoint blob is missing for ${entry.relativePath}.`);
      if (!/^[a-f0-9]{64}\.bin$/.test(entry.blob) || basename(entry.blob) !== entry.blob) {
        throw new Error(`Checkpoint blob name is invalid for ${entry.relativePath}.`);
      }
      const blobPath = join(blobDirectory, entry.blob);
      const blobInfo = await lstat(blobPath);
      if (!blobInfo.isFile() || blobInfo.isSymbolicLink()) {
        throw new Error(`Checkpoint blob is not a regular file for ${entry.relativePath}.`);
      }
      if (blobInfo.size > 25_000_000) {
        throw new Error(`Checkpoint blob is too large for ${entry.relativePath}.`);
      }
      actions.push({
        path,
        before,
        after: {
          content: await readFile(blobPath),
          ...(entry.mode !== undefined ? {mode: entry.mode} : {}),
        },
      });
    }

    const restored: string[] = [];
    const committed: RestoreAction[] = [];
    try {
      for (const action of actions) {
        await writeSnapshot(action.path, action.after, this.workspace);
        committed.push(action);
        restored.push(action.path);
      }
    } catch (error) {
      let rollbackFailed = false;
      for (const action of committed.reverse()) {
        try {
          await writeSnapshot(action.path, action.before, this.workspace);
        } catch {
          rollbackFailed = true;
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Checkpoint restore failed${rollbackFailed ? ' and rollback was incomplete' : ''}: ${message}`);
    }
    return restored;
  }

  async list(sessionId: string): Promise<CheckpointManifest[]> {
    validateIdentifier(sessionId, 'session');
    if (!(await this.directoryAvailable())) return [];
    const directory = join(this.directory, sessionId);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const manifests: CheckpointManifest[] = [];
    for (const name of names) {
      try {
        manifests.push(await this.load(sessionId, name));
      } catch {
        // Ignore incomplete checkpoints left by a process interruption.
      }
    }
    return manifests.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  private async ensureDirectory(): Promise<void> {
    if (this.managedDirectory) {
      await ensureWorkspaceStorageDirectory(this.workspace.primaryRoot, this.directory);
      return;
    }
    await mkdir(this.directory, {recursive: true, mode: 0o700});
  }

  private async directoryAvailable(): Promise<boolean> {
    if (this.managedDirectory) {
      await assertNoSymlinkPath(this.workspace.primaryRoot, this.directory);
    }
    try {
      const info = await lstat(this.directory);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`Checkpoint storage is not a regular directory: ${this.directory}`);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private async assertManagedPath(path: string): Promise<void> {
    if (this.managedDirectory) {
      await assertNoSymlinkPath(this.workspace.primaryRoot, path);
    }
  }

  private async assertManagedFile(path: string): Promise<void> {
    await this.assertManagedPath(dirname(path));
    if (!this.managedDirectory) return;
    try {
      if ((await lstat(path)).isSymbolicLink()) {
        throw new Error(`Checkpoint path cannot contain a symbolic link: ${path}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

interface FileSnapshot {
  content: Buffer;
  mode?: number;
}

interface RestoreAction {
  path: string;
  before: FileSnapshot | null;
  after: FileSnapshot | null;
}

async function readSnapshot(path: string): Promise<FileSnapshot | null> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Cannot restore over a symbolic link: ${path}`);
    if (!info.isFile()) throw new Error(`Cannot restore over a non-file path: ${path}`);
    return {content: await readFile(path), mode: info.mode};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeSnapshot(
  path: string,
  snapshot: FileSnapshot | null,
  workspace: WorkspaceAccess,
): Promise<void> {
  if (!snapshot) {
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    return;
  }
  await workspace.ensureParent(path);
  await atomicWrite(path, snapshot.content, snapshot.mode);
}

function validateIdentifier(value: string, kind: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) {
    throw new Error(`Invalid ${kind} id.`);
  }
}
