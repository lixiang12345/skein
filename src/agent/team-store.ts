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
import {
  reviewContractSchema,
  reviewContractIntegrityValid,
  reviewVerdictSchema,
  reviewVerdictBindingValid,
  reviewVerdictAccepted,
  type ReviewContract,
  type ReviewVerdict,
} from './review-verdict.js';
import {
  createHumanArbitration,
  humanArbitrationIntegrityValid,
  humanArbitrationSchema,
  resolveReviewGate,
  reviewContractHighRisk,
  reviewCriterionConflictsIntegrityValid,
  reviewCriterionConflictSchema,
  reviewIndependenceIntegrityValid,
  reviewIndependenceSchema,
  type HumanArbitration,
  type HumanArbitrationDecision,
  type ReviewCriterionConflict,
  type ReviewIndependence,
} from './review-arbitration.js';

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

const writerLaneV2Schema = z.object({
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

const writerLaneV3Schema = writerLaneV2Schema.extend({
  contract: reviewContractSchema,
  verdict: reviewVerdictSchema.optional(),
}).strict();

const writerLaneV4Schema = writerLaneV3Schema.omit({outcome: true}).extend({
  outcome: z.enum(['accepted', 'rejected', 'needs_review', 'failed', 'cancelled']),
  independence: reviewIndependenceSchema.optional(),
  criterionConflicts: z.array(reviewCriterionConflictSchema).max(64),
}).strict();

const reviewRecordSchema = z.object({
  artifact: artifactSchema,
  verdict: reviewVerdictSchema,
}).strict();

const reviewRecordV4Schema = reviewRecordSchema.extend({
  independence: reviewIndependenceSchema,
  criterionConflicts: z.array(reviewCriterionConflictSchema).max(64),
}).strict();

const manifestFields = {
  id: runIdSchema,
  workspace: z.string(),
  objective: z.string().max(30_000),
  reviewer: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  maxReviewRounds: z.number().int().min(0).max(3),
  reviewRounds: z.number().int().min(0).max(3),
  agents: z.array(agentRecordSchema).max(256),
  messages: z.array(messageRecordSchema).max(512),
};

const manifestV1Schema = z.object({
  version: z.literal(1),
  ...manifestFields,
  status: z.enum(['running', 'accepted', 'rejected', 'failed']),
}).strict();

const manifestV2Schema = z.object({
  version: z.literal(2),
  ...manifestFields,
  status: z.enum(['running', 'accepted', 'rejected', 'failed']),
  writer: writerLaneV2Schema.optional(),
}).strict();

const manifestV3Schema = z.object({
  version: z.literal(3),
  ...manifestFields,
  status: z.enum(['running', 'accepted', 'rejected', 'failed']),
  reviews: z.array(reviewRecordSchema).max(4),
  contract: reviewContractSchema.optional(),
  writer: writerLaneV3Schema.optional(),
}).strict();

const manifestV4Schema = z.object({
  version: z.literal(4),
  ...manifestFields,
  status: z.enum(['running', 'accepted', 'rejected', 'needs_review', 'failed']),
  reviews: z.array(reviewRecordV4Schema).max(4),
  contract: reviewContractSchema.optional(),
  writer: writerLaneV4Schema.optional(),
  arbitrations: z.array(humanArbitrationSchema).max(128),
}).strict();

const manifestSchema = z.discriminatedUnion('version', [manifestV1Schema, manifestV2Schema, manifestV3Schema, manifestV4Schema]);

export type TeamRunManifest = z.infer<typeof manifestSchema>;
export type TeamRunAgentRecord = z.infer<typeof agentRecordSchema>;
export type TeamRunMessageRecord = z.infer<typeof messageRecordSchema>;
export type TeamRunWriterRecord = z.infer<typeof writerLaneV2Schema> | z.infer<typeof writerLaneV3Schema> | z.infer<typeof writerLaneV4Schema>;
export type TeamRunWriterV3Record = z.infer<typeof writerLaneV3Schema>;
export type TeamRunWriterV4Record = z.infer<typeof writerLaneV4Schema>;
export type TeamRunWriterIntegration = z.infer<typeof writerIntegrationSchema>;
export type TeamRunReviewRecord = z.infer<typeof reviewRecordSchema>;
export type TeamRunReviewV4Record = z.infer<typeof reviewRecordV4Schema>;

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
      version: 4,
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
      reviews: [],
      arbitrations: [],
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
    contract: ReviewContract;
    verdict?: ReviewVerdict;
    independence?: ReviewIndependence;
    criterionConflicts?: ReviewCriterionConflict[];
    review?: string;
    integration?: TeamRunWriterIntegration;
  }): Promise<void> {
    await this.update(runId, async (manifest) => {
      if (manifest.version !== 4) throw new Error('Writer lane records require a Team Run v4 manifest.');
      if (input.verdict && !input.independence) {
        throw new Error('Structured writer verdicts require persisted author/reviewer independence evidence.');
      }
      if (input.verdict && (!reviewVerdictBindingValid(input.contract, createHash('sha256').update(input.patch).digest('hex'), input.verdict) ||
        !reviewIndependenceIntegrityValid(input.independence as ReviewIndependence, reviewContractHighRisk(input.contract)) ||
        !reviewCriterionConflictsIntegrityValid(input.contract, input.verdict, input.criterionConflicts ?? []))) {
        throw new Error('Structured writer review evidence is corrupt or inconsistent.');
      }
      if (!input.verdict && (input.independence || input.criterionConflicts?.length)) {
        throw new Error('Writer independence and conflicts require a structured verdict.');
      }
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
          contract: input.contract,
          ...(input.verdict ? {verdict: input.verdict} : {}),
          ...(input.independence ? {independence: input.independence} : {}),
          criterionConflicts: input.criterionConflicts ?? [],
          ...(review ? {review} : {}),
          ...(input.integration ? {integration: input.integration} : {}),
        },
      };
    });
  }

  async recordReviewVerdict(
    runId: string,
    contract: ReviewContract,
    verdict: ReviewVerdict,
    artifact: string,
    independence: ReviewIndependence,
    criterionConflicts: ReviewCriterionConflict[] = [],
  ): Promise<void> {
    await this.update(runId, async (manifest) => {
      if (manifest.version !== 4) throw new Error('Structured review verdicts require a Team Run v4 manifest.');
      if (!reviewVerdictBindingValid(contract, verdict.artifactSha256, verdict)) {
        throw new Error('Structured review verdict does not match its contract or artifact binding.');
      }
      if (!reviewIndependenceIntegrityValid(independence, reviewContractHighRisk(contract)) ||
        !reviewCriterionConflictsIntegrityValid(contract, verdict, criterionConflicts)) {
        throw new Error('Structured review independence or conflict evidence is corrupt or inconsistent.');
      }
      if (manifest.contract && manifest.contract.sha256 !== contract.sha256) {
        throw new Error('A Team Run cannot change its review contract after review starts.');
      }
      const artifactReference = await this.writeArtifact(runId, artifact, false);
      if (artifactReference.sha256 !== verdict.artifactSha256) {
        throw new Error('Structured review artifact content does not match the verdict binding.');
      }
      return {
        ...manifest,
        contract,
        reviews: [...manifest.reviews, {
          artifact: artifactReference,
          verdict,
          independence,
          criterionConflicts,
        }].slice(-4),
      };
    });
  }

  async recordWriterIntegration(runId: string, integration: TeamRunWriterIntegration): Promise<void> {
    await this.update(runId, async (manifest) => {
      if ((manifest.version !== 2 && manifest.version !== 3 && manifest.version !== 4) || !manifest.writer) {
        throw new Error('Writer lane integration requires a Team Run writer record.');
      }
      if (manifest.writer.integration?.status === 'integrated' && integration.status !== 'integrated') {
        throw new Error('An integrated writer record cannot be downgraded.');
      }
      if (manifest.version === 2) return {...manifest, writer: {...manifest.writer, integration}};
      if (manifest.version === 3) return {...manifest, writer: {...manifest.writer, integration}};
      return {...manifest, writer: {...manifest.writer, integration}};
    });
  }

  async complete(runId: string, input: {accepted: boolean; reviewRounds: number; failed?: boolean; needsReview?: boolean}): Promise<void> {
    await this.update(runId, async (manifest) => {
      if (manifest.version === 4) return {
        ...manifest,
        status: input.failed
          ? 'failed' as const
          : input.accepted
            ? 'accepted' as const
            : input.needsReview
              ? 'needs_review' as const
              : 'rejected' as const,
        reviewRounds: input.reviewRounds,
      };
      return {
        ...manifest,
        status: input.failed ? 'failed' as const : input.accepted ? 'accepted' as const : 'rejected' as const,
        reviewRounds: input.reviewRounds,
      };
    });
  }

  async arbitrate(runId: string, input: {
    criterionId: string;
    decision: HumanArbitrationDecision;
    reason: string;
    now?: string;
  }): Promise<{arbitration: HumanArbitration; gate: ReturnType<typeof resolveReviewGate>}> {
    let result: {arbitration: HumanArbitration; gate: ReturnType<typeof resolveReviewGate>} | undefined;
    await this.update(runId, async (manifest) => {
      if (manifest.version !== 4) {
        throw new Error('Human arbitration requires a Team Run v4 manifest; rerun the review for current evidence.');
      }
      const active = activeStructuredReview(manifest);
      if (!active) throw new Error('Team Run has no structured verdict available for arbitration.');
      const currentGate = resolveReviewGate({...active, arbitrations: manifest.arbitrations});
      if (manifest.status !== 'needs_review' || currentGate.status !== 'needs_review') {
        throw new Error('Human arbitration is only available while the bound Team Run is in needs_review.');
      }
      const criterion = active.contract.criteria.find((item) => item.id === input.criterionId);
      if (!criterion) {
        throw new Error(`Unknown review criterion: ${input.criterionId}`);
      }
      if (!criterion.required) throw new Error('Human arbitration is only valid for required review criteria.');
      if (!currentGate.unresolvedCriteria.includes(criterion.id)) {
        throw new Error(`Review criterion is not awaiting human arbitration: ${criterion.id}`);
      }
      if (input.decision === 'accept' && active.verdict.evidence.some((evidence) =>
        evidence.kind === 'deterministic' && evidence.status === 'failed')) {
        throw new Error('Human arbitration cannot accept a criterion while deterministic evidence is failed.');
      }
      const arbitration = createHumanArbitration({
        criterionId: input.criterionId,
        contractSha256: active.contract.sha256,
        artifactSha256: active.artifactSha256,
        decision: input.decision,
        reason: input.reason,
        ...(input.now ? {now: input.now} : {}),
      });
      const arbitrations = [...manifest.arbitrations, arbitration].slice(-128);
      const gate = resolveReviewGate({...active, arbitrations});
      result = {arbitration, gate};
      const writer = manifest.writer?.verdict && manifest.writer.independence &&
        manifest.writer.contract.sha256 === active.contract.sha256 &&
        manifest.writer.patch.sha256 === active.artifactSha256
        ? {...manifest.writer, outcome: gate.status}
        : manifest.writer;
      return {
        ...manifest,
        arbitrations,
        status: gate.status,
        ...(writer ? {writer} : {}),
      };
    });
    if (!result) throw new Error('Human arbitration was not persisted.');
    return result;
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
    assertStructuredManifestIntegrity(manifest);
    if (verify) {
      for (const artifact of [
        ...manifest.agents.map((agent) => agent.report),
        ...manifest.messages.map((message) => message.content),
        ...((manifest.version === 3 || manifest.version === 4) ? manifest.reviews.map((review) => review.artifact) : []),
        ...((manifest.version === 2 || manifest.version === 3 || manifest.version === 4) && manifest.writer
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
      assertStructuredManifestIntegrity(next);
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
    const manifest = manifestSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown);
    assertStructuredManifestIntegrity(manifest);
    return manifest;
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

function assertStructuredManifestIntegrity(manifest: TeamRunManifest): void {
  if (manifest.version !== 3 && manifest.version !== 4) return;
  if (manifest.contract && (!reviewContractIntegrityValid(manifest.contract) ||
    manifest.reviews.some((review) => !reviewVerdictBindingValid(
      manifest.contract as ReviewContract,
      review.artifact.sha256,
      review.verdict,
    )))) throw new Error('Team run structured review integrity check failed.');
  if (manifest.reviews.length && !manifest.contract) {
    throw new Error('Team run structured reviews are missing their contract.');
  }
  if (manifest.version === 3) {
    if (manifest.writer && (!reviewContractIntegrityValid(manifest.writer.contract) ||
      (manifest.writer.verdict && !reviewVerdictBindingValid(
        manifest.writer.contract,
        manifest.writer.patch.sha256,
        manifest.writer.verdict,
      )) || (manifest.writer.outcome === 'accepted' &&
        (!manifest.writer.verdict || !reviewVerdictAccepted(
          manifest.writer.contract,
          manifest.writer.patch.sha256,
          manifest.writer.verdict,
        ))) || (manifest.writer.integration?.status === 'integrated' &&
        manifest.writer.outcome !== 'accepted'))) {
      throw new Error('Team run writer verdict integrity check failed.');
    }
    return;
  }
  if (manifest.reviews.some((review) =>
    !reviewIndependenceIntegrityValid(review.independence, reviewContractHighRisk(manifest.contract as ReviewContract)) ||
    !reviewCriterionConflictsIntegrityValid(
      manifest.contract as ReviewContract,
      review.verdict,
      review.criterionConflicts,
    ))) {
    throw new Error('Team run structured review independence or conflict integrity check failed.');
  }
  const bindings = manifest.reviews.map((review) => ({
    contract: manifest.contract as ReviewContract,
    artifactSha256: review.artifact.sha256,
    verdict: review.verdict,
    independence: review.independence,
    conflicts: review.criterionConflicts,
  }));
  if (manifest.arbitrations.some((arbitration) => !humanArbitrationIntegrityValid(arbitration))) {
    throw new Error('Team run human arbitration integrity check failed.');
  }
  if (manifest.writer) {
    const writer = manifest.writer;
    const writerGate = writer.verdict && writer.independence
      ? resolveReviewGate({
          contract: writer.contract,
          artifactSha256: writer.patch.sha256,
          verdict: writer.verdict,
          independence: writer.independence,
          conflicts: writer.criterionConflicts,
          arbitrations: manifest.arbitrations,
        })
      : undefined;
    if (!reviewContractIntegrityValid(writer.contract) ||
      (writer.verdict && (!writer.independence || !reviewVerdictBindingValid(
        writer.contract,
        writer.patch.sha256,
        writer.verdict,
      ) || !reviewIndependenceIntegrityValid(writer.independence, reviewContractHighRisk(writer.contract)) ||
      !reviewCriterionConflictsIntegrityValid(writer.contract, writer.verdict, writer.criterionConflicts))) ||
      (!writer.verdict && (writer.independence || writer.criterionConflicts.length > 0)) ||
      ((writer.outcome === 'accepted' || writer.outcome === 'needs_review') && !writerGate) ||
      (writerGate && writer.outcome !== writerGate.status) ||
      (writer.integration?.status === 'integrated' && writerGate?.status !== 'accepted')) {
      throw new Error('Team run writer verdict integrity check failed.');
    }
    if (writer.verdict && writer.independence) bindings.push({
      contract: writer.contract,
      artifactSha256: writer.patch.sha256,
      verdict: writer.verdict,
      independence: writer.independence,
      conflicts: writer.criterionConflicts,
    });
  }
  const active = activeStructuredReview(manifest);
  const activeGate = active ? resolveReviewGate({...active, arbitrations: manifest.arbitrations}) : undefined;
  if ((manifest.status === 'needs_review' && activeGate?.status !== 'needs_review') ||
    (manifest.status === 'accepted' && activeGate?.status !== 'accepted')) {
    throw new Error('Team run status is inconsistent with its active structured review gate.');
  }
  const arbitrationBindings = new Set<string>();
  for (const arbitration of manifest.arbitrations) {
    const binding = bindings.find((item) =>
      item.contract.sha256 === arbitration.contractSha256 && item.artifactSha256 === arbitration.artifactSha256);
    const arbitrationKey = `${arbitration.contractSha256}:${arbitration.artifactSha256}:${arbitration.criterionId}`;
    if (!humanArbitrationIntegrityValid(arbitration) || !binding ||
      !binding.contract.criteria.some((criterion) => criterion.id === arbitration.criterionId && criterion.required) ||
      arbitrationBindings.has(arbitrationKey)) {
      throw new Error('Team run human arbitration integrity check failed.');
    }
    arbitrationBindings.add(arbitrationKey);
  }
}

function activeStructuredReview(manifest: Extract<TeamRunManifest, {version: 4}>): {
  contract: ReviewContract;
  artifactSha256: string;
  verdict: ReviewVerdict;
  independence: ReviewIndependence;
  conflicts: ReviewCriterionConflict[];
} | undefined {
  if (manifest.writer?.verdict && manifest.writer.independence) {
    return {
      contract: manifest.writer.contract,
      artifactSha256: manifest.writer.patch.sha256,
      verdict: manifest.writer.verdict,
      independence: manifest.writer.independence,
      conflicts: manifest.writer.criterionConflicts,
    };
  }
  const latest = manifest.reviews.at(-1);
  if (!latest || !manifest.contract) return undefined;
  return {
    contract: manifest.contract,
    artifactSha256: latest.artifact.sha256,
    verdict: latest.verdict,
    independence: latest.independence,
    conflicts: latest.criterionConflicts,
  };
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
