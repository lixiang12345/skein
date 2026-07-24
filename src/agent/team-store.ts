import {createHash, randomUUID} from 'node:crypto';
import {lstat, readFile, readdir, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {z} from 'zod';
import {atomicWrite} from '../tools/write.js';
import {
  assertActiveProjectNamespacePath,
  projectNamespacePaths,
  resolveProjectNamespaceSync,
} from '../utils/namespace.js';
import {withNamespaceLease} from '../utils/namespace-lease.js';
import {assertNoSymlinkPath, ensureWorkspaceStorageDirectory} from '../utils/storage.js';

const runIdSchema = z.string().uuid();
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);

const artifactSchema = z.object({
  sha256: hashSchema,
  bytes: z.number().int().nonnegative().max(500_000),
}).strict();

const phaseSchema = z.enum(['work', 'review', 'revision', 'write']);

const agentRecordSchema = z.object({
  id: z.string().uuid(),
  profile: z.string(),
  provider: z.string(),
  model: z.string(),
  phase: phaseSchema,
  ok: z.boolean(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  toolCalls: z.number().int().nonnegative().optional(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }).strict().optional(),
  report: artifactSchema,
}).strict();

const messageRecordSchema = z.object({
  id: z.string().uuid(),
  from: z.string(),
  to: z.string(),
  createdAt: z.string(),
  content: artifactSchema,
}).strict();

const writerIntegrationSchema = z.object({
  status: z.enum(['ready', 'conflict', 'integrated']),
  checkedAt: z.string(),
  detail: z.string().max(20_000),
  checkpoint: z.object({
    sessionId: z.string(),
    checkpointId: z.string(),
  }).strict().optional(),
  integratedAt: z.string().optional(),
}).strict();

const writerLaneSchema = z.object({
  profile: z.string(),
  reviewer: z.string(),
  baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/u),
  outcome: z.enum(['accepted', 'rejected', 'failed', 'cancelled']),
  patch: artifactSchema,
  files: z.array(z.string().min(1).max(4_000)).max(2_000),
  worktreeCleaned: z.boolean(),
  review: artifactSchema.optional(),
  integration: writerIntegrationSchema.optional(),
}).strict();

const manifestFields = {
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
};

const manifestV1Schema = z.object({
  version: z.literal(1),
  ...manifestFields,
}).strict();

const manifestV2Schema = z.object({
  version: z.literal(2),
  ...manifestFields,
  writer: writerLaneSchema.optional(),
}).strict();

const manifestSchema = z.discriminatedUnion('version', [manifestV1Schema, manifestV2Schema]);

export type TeamRunManifest = z.infer<typeof manifestSchema>;
export type TeamRunAgentRecord = z.infer<typeof agentRecordSchema>;
export type TeamRunMessageRecord = z.infer<typeof messageRecordSchema>;
export type TeamRunWriterRecord = z.infer<typeof writerLaneSchema>;
export type TeamRunWriterIntegration = z.infer<typeof writerIntegrationSchema>;

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
  totalTokens: number;
  toolCalls: number;
}

export class TeamRunStore {
  readonly workspace: string;
  readonly directory: string;
  private readonly managedDirectory: boolean;
  private writes: Promise<void> = Promise.resolve();

  constructor(workspace: string, directory?: string) {
    this.workspace = resolve(workspace);
    this.managedDirectory = directory === undefined;
    this.directory = directory
      ? resolve(directory)
      : join(resolveProjectNamespaceSync(this.workspace).active, 'team-runs');
  }

  async create(input: {objective: string; reviewer: string; maxReviewRounds: number}): Promise<TeamRunManifest> {
    const now = new Date().toISOString();
    const manifest = manifestSchema.parse({
      version: 2,
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
    await this.queueWrite(async () => this.withManagedLease(() => this.writeManifest(manifest)));
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

  async recordWriterLane(runId: string, input: {
    profile: string;
    reviewer: string;
    baseCommit: string;
    outcome: TeamRunWriterRecord['outcome'];
    patch: string;
    files: string[];
    worktreeCleaned: boolean;
    review?: string;
    integration?: TeamRunWriterIntegration;
  }): Promise<void> {
    await this.update(runId, async (manifest) => {
      if (manifest.version !== 2) throw new Error('Writer lane records require a Team Run v2 manifest.');
      const patch = await this.writeArtifact(runId, input.patch, false);
      const review = input.review === undefined
        ? undefined
        : await this.writeArtifact(runId, input.review);
      return {
        ...manifest,
        writer: {
          profile: input.profile,
          reviewer: input.reviewer,
          baseCommit: input.baseCommit,
          outcome: input.outcome,
          patch,
          files: [...input.files],
          worktreeCleaned: input.worktreeCleaned,
          ...(review ? {review} : {}),
          ...(input.integration ? {integration: input.integration} : {}),
        },
      };
    });
  }

  async recordWriterIntegration(runId: string, integration: TeamRunWriterIntegration): Promise<void> {
    await this.update(runId, async (manifest) => {
      if (manifest.version !== 2 || !manifest.writer) {
        throw new Error('Writer lane integration requires a Team Run v2 writer record.');
      }
      if (manifest.writer.integration?.status === 'integrated' && integration.status !== 'integrated') {
        throw new Error('An integrated writer record cannot be downgraded.');
      }
      return {...manifest, writer: {...manifest.writer, integration}};
    });
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
        ...(manifest.version === 2 && manifest.writer
          ? [manifest.writer.patch, ...(manifest.writer.review ? [manifest.writer.review] : [])]
          : []),
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
    return this.withManagedLease(async () => {
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
    });
  }

  private async update(runId: string, operation: (manifest: TeamRunManifest) => Promise<TeamRunManifest>): Promise<void> {
    runIdSchema.parse(runId);
    await this.queueWrite(async () => this.withManagedLease(async () => {
      const current = await this.loadUnlocked(runId);
      const next = manifestSchema.parse({...await operation(current), updatedAt: new Date().toISOString()});
      await this.writeManifest(next);
    }));
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
    await ensureWorkspaceStorageDirectory(this.workspace, directory, {
      requireActiveNamespace: this.managedDirectory,
    });
    await atomicWrite(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
  }

  private async writeArtifact(
    runId: string,
    content: string,
    truncate = true,
  ): Promise<{sha256: string; bytes: number}> {
    const data = boundedArtifactText(content, 500_000, truncate);
    const bytes = Buffer.byteLength(data);
    const sha256 = createHash('sha256').update(data).digest('hex');
    const directory = join(this.runDirectory(runId), 'blobs');
    await ensureWorkspaceStorageDirectory(this.workspace, directory, {
      requireActiveNamespace: this.managedDirectory,
    });
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

  private async withManagedLease<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.managedDirectory) return operation();
    return withNamespaceLease(projectNamespacePaths(this.workspace).canonical, 'shared', async () => {
      assertActiveProjectNamespacePath(this.workspace, this.directory);
      return operation();
    });
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

function boundedArtifactText(content: string, maxBytes: number, truncate: boolean): string {
  const encoded = Buffer.from(content, 'utf8');
  if (encoded.byteLength <= maxBytes) return content;
  if (!truncate) throw new Error(`Team artifact exceeds the ${maxBytes}-byte limit.`);
  let end = maxBytes;
  while (end > 0 && (encoded[end] ?? 0) >= 0x80 && (encoded[end] ?? 0) < 0xc0) end -= 1;
  return encoded.subarray(0, end).toString('utf8');
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
    totalTokens: manifest.agents.reduce((total, agent) => total + (agent.usage?.inputTokens ?? 0) + (agent.usage?.outputTokens ?? 0), 0),
    toolCalls: manifest.agents.reduce((total, agent) => total + (agent.toolCalls ?? 0), 0),
  };
}
