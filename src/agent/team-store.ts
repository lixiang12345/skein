import {createHash, randomUUID} from 'node:crypto';
import {lstat, readFile, readdir, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {z} from 'zod';
import {atomicWrite} from '../tools/write.js';
import {resolveProjectNamespaceSync} from '../utils/namespace.js';
import {assertNoSymlinkPath, ensureWorkspaceStorageDirectory} from '../utils/storage.js';

const runIdSchema = z.string().uuid();
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);

const artifactSchema = z.object({
  sha256: hashSchema,
  bytes: z.number().int().nonnegative().max(500_000),
}).strict();

const agentRecordSchema = z.object({
  id: z.string().uuid(),
  profile: z.string(),
  provider: z.string(),
  model: z.string(),
  phase: z.enum(['work', 'review', 'revision']),
  ok: z.boolean(),
  createdAt: z.string(),
  report: artifactSchema,
}).strict();

const messageRecordSchema = z.object({
  id: z.string().uuid(),
  from: z.string(),
  to: z.string(),
  createdAt: z.string(),
  content: artifactSchema,
}).strict();

const manifestSchema = z.object({
  version: z.literal(1),
  id: runIdSchema,
  workspace: z.string(),
  objective: z.string().max(30_000),
  reviewer: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: z.enum(['running', 'accepted', 'rejected', 'failed']),
  maxReviewRounds: z.number().int().min(0).max(3),
  reviewRounds: z.number().int().min(0).max(3),
  agents: z.array(agentRecordSchema).max(256),
  messages: z.array(messageRecordSchema).max(512),
}).strict();

export type TeamRunManifest = z.infer<typeof manifestSchema>;
export type TeamRunAgentRecord = z.infer<typeof agentRecordSchema>;
export type TeamRunMessageRecord = z.infer<typeof messageRecordSchema>;

export interface TeamRunSummary {
  id: string;
  objective: string;
  status: TeamRunManifest['status'];
  reviewer: string;
  createdAt: string;
  updatedAt: string;
  agentCount: number;
  messageCount: number;
  reviewRounds: number;
}

export class TeamRunStore {
  readonly workspace: string;
  readonly directory: string;
  private writes: Promise<void> = Promise.resolve();

  constructor(workspace: string, directory?: string) {
    this.workspace = resolve(workspace);
    this.directory = directory
      ? resolve(directory)
      : join(resolveProjectNamespaceSync(this.workspace).active, 'team-runs');
  }

  async create(input: {objective: string; reviewer: string; maxReviewRounds: number}): Promise<TeamRunManifest> {
    const now = new Date().toISOString();
    const manifest = manifestSchema.parse({
      version: 1,
      id: randomUUID(),
      workspace: this.workspace,
      objective: input.objective,
      reviewer: input.reviewer,
      createdAt: now,
      updatedAt: now,
      status: 'running',
      maxReviewRounds: input.maxReviewRounds,
      reviewRounds: 0,
      agents: [],
      messages: [],
    });
    await this.queueWrite(async () => this.writeManifest(manifest));
    return manifest;
  }

  async recordAgent(runId: string, input: Omit<TeamRunAgentRecord, 'createdAt' | 'report'> & {report: string}): Promise<void> {
    await this.update(runId, async (manifest) => ({
      ...manifest,
      agents: [...manifest.agents, {
        ...input,
        createdAt: new Date().toISOString(),
        report: await this.writeArtifact(runId, input.report),
      }],
    }));
  }

  async recordMessage(runId: string, input: Omit<TeamRunMessageRecord, 'createdAt' | 'content'> & {content: string}): Promise<void> {
    await this.update(runId, async (manifest) => ({
      ...manifest,
      messages: [...manifest.messages, {
        ...input,
        createdAt: new Date().toISOString(),
        content: await this.writeArtifact(runId, input.content),
      }],
    }));
  }

  async complete(runId: string, input: {accepted: boolean; reviewRounds: number; failed?: boolean}): Promise<void> {
    await this.update(runId, async (manifest) => ({
      ...manifest,
      status: input.failed ? 'failed' : input.accepted ? 'accepted' : 'rejected',
      reviewRounds: input.reviewRounds,
    }));
  }

  async load(runId: string, verify = true): Promise<TeamRunManifest> {
    runIdSchema.parse(runId);
    await this.writes;
    await this.assertRunDirectory(runId);
    const path = join(this.runDirectory(runId), 'manifest.json');
    await this.assertRegularFile(path);
    const manifest = manifestSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown);
    if (manifest.id !== runId || resolve(manifest.workspace) !== this.workspace) {
      throw new Error('Team run manifest identity does not match its location.');
    }
    if (verify) {
      for (const artifact of [
        ...manifest.agents.map((agent) => agent.report),
        ...manifest.messages.map((message) => message.content),
      ]) await this.verifyArtifact(runId, artifact);
    }
    return manifest;
  }

  async readArtifact(runId: string, artifact: {sha256: string; bytes: number}): Promise<string> {
    await this.verifyArtifact(runId, artifact);
    return readFile(this.artifactPath(runId, artifact.sha256), 'utf8');
  }

  async list(): Promise<TeamRunSummary[]> {
    await this.writes;
    try {
      await assertNoSymlinkPath(this.workspace, this.directory);
      const entries = await readdir(this.directory, {withFileTypes: true});
      const summaries: TeamRunSummary[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !runIdSchema.safeParse(entry.name).success) continue;
        try {
          const manifest = await this.load(entry.name, false);
          summaries.push(toSummary(manifest));
        } catch {
          // An interrupted or corrupt run remains on disk for doctor/recovery,
          // but does not poison the normal list view.
        }
      }
      return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async remove(runId: string): Promise<boolean> {
    runIdSchema.parse(runId);
    await this.writes;
    const directory = this.runDirectory(runId);
    await assertNoSymlinkPath(this.workspace, directory);
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Team run storage is not a regular directory.');
      await rm(directory, {recursive: true});
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private async update(runId: string, operation: (manifest: TeamRunManifest) => Promise<TeamRunManifest>): Promise<void> {
    runIdSchema.parse(runId);
    await this.queueWrite(async () => {
      const current = await this.loadUnlocked(runId);
      const next = manifestSchema.parse({...await operation(current), updatedAt: new Date().toISOString()});
      await this.writeManifest(next);
    });
  }

  private async queueWrite(operation: () => Promise<void>): Promise<void> {
    const next = this.writes.then(operation);
    this.writes = next.catch(() => undefined);
    return next;
  }

  private async loadUnlocked(runId: string): Promise<TeamRunManifest> {
    await this.assertRunDirectory(runId);
    const path = join(this.runDirectory(runId), 'manifest.json');
    await this.assertRegularFile(path);
    return manifestSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown);
  }

  private async writeManifest(manifest: TeamRunManifest): Promise<void> {
    const directory = this.runDirectory(manifest.id);
    await ensureWorkspaceStorageDirectory(this.workspace, directory);
    await atomicWrite(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
  }

  private async writeArtifact(runId: string, content: string): Promise<{sha256: string; bytes: number}> {
    const data = content.slice(0, 500_000);
    const bytes = Buffer.byteLength(data);
    const sha256 = createHash('sha256').update(data).digest('hex');
    const directory = join(this.runDirectory(runId), 'blobs');
    await ensureWorkspaceStorageDirectory(this.workspace, directory);
    const path = join(directory, `${sha256}.txt`);
    try {
      await this.assertRegularFile(path);
      const existing = await readFile(path);
      if (createHash('sha256').update(existing).digest('hex') !== sha256) {
        throw new Error(`Team artifact hash collision or corruption: ${sha256}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await atomicWrite(path, data, 0o600);
    }
    return {sha256, bytes};
  }

  private async verifyArtifact(runId: string, artifact: {sha256: string; bytes: number}): Promise<void> {
    hashSchema.parse(artifact.sha256);
    const path = this.artifactPath(runId, artifact.sha256);
    await this.assertRegularFile(path);
    const data = await readFile(path);
    const hash = createHash('sha256').update(data).digest('hex');
    if (hash !== artifact.sha256 || data.byteLength !== artifact.bytes) {
      throw new Error(`Team artifact integrity check failed: ${artifact.sha256}`);
    }
  }

  private artifactPath(runId: string, sha256: string): string {
    return join(this.runDirectory(runId), 'blobs', `${sha256}.txt`);
  }

  private runDirectory(runId: string): string {
    return join(this.directory, runId);
  }

  private async assertRunDirectory(runId: string): Promise<void> {
    const directory = this.runDirectory(runId);
    await assertNoSymlinkPath(this.workspace, directory);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Team run storage is not a regular directory.');
  }

  private async assertRegularFile(path: string): Promise<void> {
    await assertNoSymlinkPath(this.workspace, resolve(path, '..'));
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Team run file is not a regular file: ${path}`);
  }
}

function toSummary(manifest: TeamRunManifest): TeamRunSummary {
  return {
    id: manifest.id,
    objective: manifest.objective,
    status: manifest.status,
    reviewer: manifest.reviewer,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    agentCount: manifest.agents.length,
    messageCount: manifest.messages.length,
    reviewRounds: manifest.reviewRounds,
  };
}
