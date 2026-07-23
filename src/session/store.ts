import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import {basename, dirname, join, resolve} from 'node:path';
import {z} from 'zod';
import type {ProviderName, Session} from '../types.js';
import {assertNoSymlinkPath, ensureWorkspaceStorageDirectory} from '../utils/storage.js';
import {
  assertActiveProjectNamespacePath,
  projectNamespacePaths,
  resolveProjectNamespaceSync,
} from '../utils/namespace.js';
import {withNamespaceLease} from '../utils/namespace-lease.js';

const sessionIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);

const toolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
}).strict();

const messageSchema = z.object({
  id: z.string(),
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  createdAt: z.string(),
  toolCalls: z.array(toolCallSchema).optional(),
  toolCallId: z.string().optional(),
  name: z.string().optional(),
}).strict();

const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
}).strict();

const auditSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  type: z.enum(['permission', 'tool']),
  toolCallId: z.string(),
  tool: z.string(),
  category: z.enum(['read', 'write', 'shell', 'git', 'network']).optional(),
  outcome: z.enum(['allow', 'deny', 'success', 'failure']),
  reason: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

const contextSourceSchema = z.object({
  path: z.string().min(1).max(4_096),
  state: z.enum(['pinned', 'muted']),
  tokens: z.number().int().nonnegative(),
  addedAt: z.string(),
}).strict();

const workingMemorySchema = z.object({
  goal: z.string(),
  focus: z.string(),
  constraints: z.array(z.string()),
  decisions: z.array(z.string()),
  openQuestions: z.array(z.string()),
  relevantFiles: z.array(z.string()),
  lastUpdatedAt: z.string(),
}).strict();

const sessionSchema = z.object({
  id: sessionIdSchema,
  title: z.string(),
  workspace: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  model: z.string(),
  provider: z.enum(['openai', 'anthropic', 'gemini', 'compatible']),
  messages: z.array(messageSchema),
  tasks: z.array(taskSchema),
  changedFiles: z.array(z.string()),
  audit: z.array(auditSchema).default([]),
  contextSummary: z.string().max(200_000).optional(),
  contextCompactions: z.number().int().nonnegative().optional(),
  compactedThroughMessageId: z.string().optional(),
  workingMemory: workingMemorySchema.optional(),
  contextSources: z.array(contextSourceSchema).max(64).optional(),
  usage: z.object({
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
  }).strict(),
}).strict();

export interface CreateSessionOptions {
  title?: string;
  model: string;
  provider: ProviderName;
  id?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  workspace: string;
  model: string;
  provider: ProviderName;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  changedFileCount: number;
}

export class SessionStore {
  readonly workspace: string;
  readonly directory: string;
  private readonly managedDirectory: boolean;
  private writes: Promise<void> = Promise.resolve();

  constructor(workspace: string, directory?: string) {
    this.workspace = resolve(workspace);
    this.managedDirectory = directory === undefined;
    this.directory = directory
      ? resolve(directory)
      : join(resolveProjectNamespaceSync(this.workspace).active, 'sessions');
  }

  async create(options: CreateSessionOptions): Promise<Session> {
    const session = createSession({...options, workspace: this.workspace});
    await this.save(session);
    return session;
  }

  async save(session: Session): Promise<void> {
    validateId(session.id);
    if (resolve(session.workspace) !== this.workspace) {
      throw new Error('Session workspace does not match this store.');
    }
    session.updatedAt = new Date().toISOString();
    const validated = parseSession(session);
    const operation = this.writes.then(() => this.withManagedLease(() => this.writeAtomic(validated)));
    this.writes = operation.catch(() => undefined);
    return operation;
  }

  async load(id: string): Promise<Session> {
    validateId(id);
    return this.withManagedLease(() => this.loadUnlocked(id));
  }

  private async loadUnlocked(id: string): Promise<Session> {
    await this.writes;
    if (!(await this.directoryAvailable())) {
      throw new Error(`Session not found or unreadable: ${id}`);
    }
    const primary = this.pathFor(id);
    await this.assertManagedFile(primary);
    const loaded = await tryReadSession(primary);
    if (loaded?.id === id) return this.assertWorkspace(loaded);
    const recovered = await this.recover(id);
    if (!recovered) throw new Error(`Session not found or unreadable: ${id}`);
    await this.writeAtomic(recovered);
    return this.assertWorkspace(recovered);
  }

  async resume(id?: string): Promise<Session | undefined> {
    if (id) return this.load(id);
    const latest = (await this.list())[0];
    return latest ? this.load(latest.id) : undefined;
  }

  async list(): Promise<SessionSummary[]> {
    await this.writes;
    if (!(await this.directoryAvailable())) return [];
    const entries = await readdir(this.directory, {withFileTypes: true});
    const summaries = await Promise.all(
      entries
        .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
        .map(async entry => {
          const session = await tryReadSession(join(this.directory, entry.name));
          if (!session || resolve(session.workspace) !== this.workspace) return;
          return toSummary(session);
        }),
    );
    return summaries.filter(summary => summary !== undefined).sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  }

  async remove(id: string): Promise<boolean> {
    validateId(id);
    return this.withManagedLease(async () => {
      await this.writes;
      if (!(await this.directoryAvailable())) return false;
      let removed = false;
      for (const path of [this.pathFor(id), this.backupPathFor(id)]) {
        try {
          await unlink(path);
          removed = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      return removed;
    });
  }

  private async writeAtomic(session: Session): Promise<void> {
    await this.ensureDirectory();
    const target = this.pathFor(session.id);
    const backup = this.backupPathFor(session.id);
    await this.assertManagedFile(target);
    await this.assertManagedFile(backup);
    const temporary = join(this.directory, `.${session.id}.${randomUUID()}.tmp`);
    const data = `${JSON.stringify(session, null, 2)}\n`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      if (await exists(target)) await this.copyBackup(target, backup);
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private async copyBackup(source: string, target: string): Promise<void> {
    const temporary = join(this.directory, `.${basename(target)}.${randomUUID()}.tmp`);
    try {
      await copyFile(source, temporary, constants.COPYFILE_EXCL);
      await chmod(temporary, 0o600);
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private async recover(id: string): Promise<Session | undefined> {
    const candidates: Array<{path: string; mtimeMs: number}> = [];
    for (const path of [this.backupPathFor(id), ...(await this.temporaryPaths(id))]) {
      try {
        candidates.push({path, mtimeMs: (await stat(path)).mtimeMs});
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
    for (const candidate of candidates) {
      await this.assertManagedFile(candidate.path);
      const session = await tryReadSession(candidate.path);
      if (session?.id === id && resolve(session.workspace) === this.workspace) return session;
    }
    return undefined;
  }

  private async temporaryPaths(id: string): Promise<string[]> {
    try {
      const names = await readdir(this.directory);
      return names
        .filter((name) => name.startsWith(`.${id}.`) && name.endsWith('.tmp'))
        .map((name) => join(this.directory, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private assertWorkspace(session: Session): Session {
    if (resolve(session.workspace) !== this.workspace) {
      throw new Error('Stored session belongs to a different workspace.');
    }
    return session;
  }

  private pathFor(id: string): string {
    return join(this.directory, `${id}.json`);
  }

  private backupPathFor(id: string): string {
    return join(this.directory, `${id}.bak`);
  }

  private async ensureDirectory(): Promise<void> {
    if (this.managedDirectory) {
      await ensureWorkspaceStorageDirectory(this.workspace, this.directory, {requireActiveNamespace: true});
      return;
    }
    await mkdir(this.directory, {recursive: true, mode: 0o700});
  }

  private async withManagedLease<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.managedDirectory) return operation();
    return withNamespaceLease(projectNamespacePaths(this.workspace).canonical, 'shared', async () => {
      assertActiveProjectNamespacePath(this.workspace, this.directory);
      return operation();
    });
  }

  private async directoryAvailable(): Promise<boolean> {
    if (this.managedDirectory) {
      await assertNoSymlinkPath(this.workspace, this.directory);
    }
    try {
      const info = await lstat(this.directory);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`Session storage is not a regular directory: ${this.directory}`);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private async assertManagedFile(path: string): Promise<void> {
    if (!this.managedDirectory) return;
    await assertNoSymlinkPath(this.workspace, dirname(path));
    try {
      if ((await lstat(path)).isSymbolicLink()) {
        throw new Error(`Session path cannot contain a symbolic link: ${path}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export function createSession(
  options: CreateSessionOptions & {workspace: string},
): Session {
  const id = options.id ?? randomUUID();
  validateId(id);
  const now = new Date().toISOString();
  return {
    id,
    title: cleanTitle(options.title ?? 'New session'),
    workspace: resolve(options.workspace),
    createdAt: now,
    updatedAt: now,
    model: options.model,
    provider: options.provider,
    messages: [],
    tasks: [],
    changedFiles: [],
    audit: [],
    usage: {inputTokens: 0, outputTokens: 0},
  };
}

function parseSession(value: unknown): Session {
  return sessionSchema.parse(value) as Session;
}

async function tryReadSession(path: string): Promise<Session | undefined> {
  try {
    return parseSession(JSON.parse(await readFile(path, 'utf8')) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError ||
      error instanceof z.ZodError) return undefined;
    throw error;
  }
}

function toSummary(session: Session): SessionSummary {
  return {
    id: session.id,
    title: session.title,
    workspace: session.workspace,
    model: session.model,
    provider: session.provider,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    changedFileCount: session.changedFiles.length,
  };
}

function cleanTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').slice(0, 120) || 'New session';
}

function validateId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) {
    throw new Error(`Invalid session id: ${basename(id)}`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
