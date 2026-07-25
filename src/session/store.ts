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

const reuseReceiptSchema = z.object({
  requestId: z.string().uuid(),
  queryHash: z.string().regex(/^[a-f0-9]{64}$/u),
  targetPaths: z.array(z.string()).max(8),
  trigger: z.enum(['new-file', 'new-symbol']),
  decision: z.enum(['reuse', 'extend', 'new', 'unresolved']),
  candidates: z.array(z.object({
    path: z.string(),
    symbol: z.string().optional(),
    score: z.number().finite(),
    read: z.enum(['current', 'unreadable']),
  }).strict()).max(5),
  selectedPath: z.string().optional(),
  selectedSymbol: z.string().optional(),
  rationale: z.string().max(500),
  indexGeneration: z.string().optional(),
  changeSequence: z.number().int().nonnegative(),
  status: z.enum(['warning', 'skipped', 'unresolved']),
  warningOnly: z.literal(true),
}).strict();

const auditMetadataSchema = z.record(z.string(), z.unknown()).superRefine((metadata, ctx) => {
  const receipt = metadata.reuseReceipt;
  if (receipt !== undefined && !reuseReceiptSchema.safeParse(receipt).success) {
    ctx.addIssue({code: 'custom', message: 'Invalid reuse receipt'});
  }
});

const auditSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  type: z.enum(['permission', 'tool']),
  toolCallId: z.string(),
  tool: z.string(),
  category: z.enum(['read', 'write', 'shell', 'git', 'network']).optional(),
  outcome: z.enum(['allow', 'deny', 'success', 'failure']),
  reason: z.string().optional(),
  metadata: auditMetadataSchema.optional(),
}).strict();

const contextSourceSchema = z.object({
  path: z.string().min(1).max(4_096),
  state: z.enum(['pinned', 'muted']),
  tokens: z.number().int().nonnegative(),
  addedAt: z.string(),
}).strict();

const toolArtifactSchema = z.object({
  toolCallId: z.string().min(1).max(512).refine((value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value)),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  bytes: z.number().int().nonnegative().max(5 * 1024 * 1024),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  redacted: z.boolean(),
}).strict();

const verificationEvidenceSchema = z.object({
  toolCallId: z.string(),
  tool: z.enum(['shell', 'git']),
  command: z.string(),
  kind: z.enum(['configured', 'test', 'typecheck', 'lint', 'build', 'diff', 'check']),
  ok: z.boolean(),
}).strict();

const lastRunSchema = z.object({
  status: z.enum(['no_changes', 'verified', 'unverified', 'verification_failed']),
  changedFiles: z.array(z.string()),
  checks: z.array(verificationEvidenceSchema),
  detail: z.string(),
  mutationTracking: z.enum(['complete', 'unknown']).optional(),
  acceptance: z.object({
    state: z.enum(['draft', 'active', 'satisfied', 'blocked']),
    total: z.number().int().nonnegative(),
    satisfied: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    missingVerification: z.array(z.string()),
    unresolved: z.array(z.object({
      id: z.string(),
      description: z.string(),
      status: z.enum(['pending', 'satisfied', 'blocked']),
    }).strict()),
  }).strict().optional(),
  reason: z.string(),
  finishedAt: z.string(),
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

const taskContractCriterionSchema = z.object({
  id: z.string().min(1).max(128),
  description: z.string().min(1).max(2_000),
  required: z.boolean(),
  status: z.enum(['pending', 'satisfied', 'blocked']),
  evidenceRefs: z.array(z.string().min(1).max(256)).max(64),
  note: z.string().max(2_000).optional(),
}).strict();

const taskContractSchema = z.object({
  version: z.literal(1),
  state: z.enum(['draft', 'active', 'satisfied', 'blocked']),
  objective: z.string().min(1).max(20_000),
  scope: z.array(z.string().min(1).max(2_000)).max(64),
  constraints: z.array(z.string().min(1).max(2_000)).max(64),
  nonGoals: z.array(z.string().min(1).max(2_000)).max(64),
  acceptanceCriteria: z.array(taskContractCriterionSchema).min(1).max(64),
  verificationRequirements: z.array(z.string().min(1).max(2_000)).max(64),
  createdAt: z.string(),
  updatedAt: z.string(),
  auditBoundaryId: z.string().min(1).max(128).optional(),
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
  toolArtifacts: z.array(toolArtifactSchema).max(200).optional(),
  taskContract: taskContractSchema.optional(),
  lastRun: lastRunSchema.optional(),
  usage: z.object({
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    source: z.enum(['actual', 'estimated', 'mixed', 'unknown']).optional(),
    inputSource: z.enum(['actual', 'estimated', 'mixed', 'unknown']).optional(),
    outputSource: z.enum(['actual', 'estimated', 'mixed', 'unknown']).optional(),
    actualInputTokens: z.number().nonnegative().optional(),
    actualOutputTokens: z.number().nonnegative().optional(),
    estimatedInputTokens: z.number().nonnegative().optional(),
    estimatedOutputTokens: z.number().nonnegative().optional(),
  }).strict(),
  tokenLedger: z.array(z.object({
    requestId: z.string().uuid(),
    turn: z.number().int().positive(),
    recordedAt: z.string().datetime(),
    estimated: z.object({
      stableTokens: z.number().nonnegative(),
      dynamicTokens: z.number().nonnegative(),
      conversationTokens: z.number().nonnegative(),
      toolResultTokens: z.number().nonnegative(),
      retrievedTokens: z.number().nonnegative(),
      toolSchemaTokens: z.number().nonnegative(),
      estimatedInputTokens: z.number().nonnegative(),
      outputAllowanceTokens: z.number().nonnegative(),
      outputTokens: z.number().nonnegative(),
    }).strict(),
    actual: z.object({
      inputTokens: z.number().nonnegative().optional(),
      outputTokens: z.number().nonnegative().optional(),
    }).strict(),
    inputSource: z.enum(['actual', 'estimated']),
    outputSource: z.enum(['actual', 'estimated']),
    tools: z.object({
      loaded: z.array(z.string()),
      deferredCount: z.number().int().nonnegative(),
    }).strict(),
    retrieval: z.object({
      engine: z.string(),
      budgetTier: z.enum(['none', 'focused', 'standard', 'broad', 'maximum']).optional(),
      budgetTokens: z.number().nonnegative().optional(),
      candidateHits: z.number().int().nonnegative().optional(),
      selectedHits: z.number().int().nonnegative().optional(),
      duplicateHits: z.number().int().nonnegative().optional(),
      incrementalEvidenceTokens: z.number().nonnegative().optional(),
      discarded: z.array(z.object({
        reason: z.enum(['overlapping-span', 'budget-cap']),
        count: z.number().int().positive(),
      }).strict()),
    }).strict(),
  }).strict()).max(256).optional(),
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
