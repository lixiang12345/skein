import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {CheckpointStore} from '../../src/checkpoint/store.js';
import {defaultConfig} from '../../src/config.js';
import {DelegationManager} from '../../src/agent/delegation.js';
import {AgentProfileCatalog} from '../../src/agent/profiles.js';
import {TeamRunStore} from '../../src/agent/team-store.js';
import {WriterLane, WriterLaneApplyError} from '../../src/agent/writer-lane.js';
import type {ModelProvider} from '../../src/providers/provider.js';
import {createSession} from '../../src/session/store.js';
import {createDefaultToolRegistry, WorkspaceAccess} from '../../src/tools/index.js';
import type {ContextProvider, ToolExecutionContext} from '../../src/tools/types.js';
import type {AgentEvent, MosaicConfig} from '../../src/types.js';
import {NamespaceLeaseBusyError} from '../../src/utils/namespace-lease.js';
import {runProcess} from '../../src/utils/process.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

describe('isolated writer lane', () => {
  it('returns a reviewed patch without changing main, then checkpoints integration and supports rollback', async () => {
    const root = await repository('before\n');
    const cfg = writerConfig(root);
    const context = contextProvider();
    const session = createSession({workspace: root, provider: 'compatible', model: 'test'});
    const store = new TeamRunStore(root);
    const manager = await writerManager(root, cfg, context, store, async ({workspace}) => {
      await writeFile(join(workspace, 'source.txt'), 'after\n');
      await writeFile(join(workspace, 'added.txt'), 'new\n');
      await writeFile(join(workspace, 'binary.bin'), Buffer.from([0, 1, 2, 255]));
      return {summary: 'Updated source and added a regression fixture.'};
    });

    const run = await manager.writerTool().execute({task: 'Update source and add the fixture.'},
      executionContext(root, cfg, context, session));
    expect(run.ok, run.content).toBe(true);
    expect(await readFile(join(root, 'source.txt'), 'utf8')).toBe('before\n');
    await expect(readFile(join(root, 'added.txt'), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    expect(await auxiliaryWorktrees(root)).toEqual([]);

    const metadata = run.metadata as {teamRunId: string; patchSha256: string};
    const persisted = await store.load(metadata.teamRunId);
    expect(persisted.version).toBe(2);
    expect(persisted.version === 2 ? persisted.writer : undefined).toMatchObject({
      outcome: 'accepted',
      worktreeCleaned: true,
      files: ['added.txt', 'binary.bin', 'source.txt'],
      integration: {status: 'ready'},
    });

    const integrated = await manager.writerIntegrateTool().execute({
      run_id: metadata.teamRunId,
      patch_sha256: metadata.patchSha256,
    }, executionContext(root, cfg, context, session));
    expect(integrated.ok).toBe(true);
    expect(await readFile(join(root, 'source.txt'), 'utf8')).toBe('after\n');
    expect(await readFile(join(root, 'added.txt'), 'utf8')).toBe('new\n');
    expect(await readFile(join(root, 'binary.bin'))).toEqual(Buffer.from([0, 1, 2, 255]));
    const checkpointId = (integrated.metadata as {checkpointId: string}).checkpointId;
    const afterIntegration = await store.load(metadata.teamRunId);
    expect(afterIntegration.version === 2 ? afterIntegration.writer?.integration : undefined)
      .toMatchObject({status: 'integrated', checkpoint: {sessionId: session.id, checkpointId}});

    await new CheckpointStore(root).restore(session.id, checkpointId);
    expect(await readFile(join(root, 'source.txt'), 'utf8')).toBe('before\n');
    await expect(readFile(join(root, 'added.txt'), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    await expect(readFile(join(root, 'binary.bin'))).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('fails fast on a second repo writer and rejects oversize patches without dangling worktrees', async () => {
    const root = await repository('base\n');
    const lane = new WriterLane(root, [root]);
    let entered!: () => void;
    let release!: () => void;
    const active = new Promise<void>((resolve) => { entered = resolve; });
    const continueFirst = new Promise<void>((resolve) => { release = resolve; });
    const first = lane.createDraft(60_000, async (worktree) => {
      entered();
      await continueFirst;
      await writeFile(join(worktree, 'source.txt'), 'first\n');
      return 'done';
    });
    await active;
    await expect(lane.createDraft(60_000, async () => 'second'))
      .rejects.toBeInstanceOf(NamespaceLeaseBusyError);
    release();
    await expect(first).resolves.toMatchObject({worktreeCleaned: true});

    await expect(lane.createDraft(16, async (worktree) => {
      await writeFile(join(worktree, 'source.txt'), 'x'.repeat(200));
      return 'oversize';
    })).rejects.toThrow('limit is 16 bytes');
    expect(await auxiliaryWorktrees(root)).toEqual([]);
  });

  it('propagates cancellation and removes the worktree plus Git administration state', async () => {
    const root = await repository('before\n');
    const cfg = writerConfig(root);
    const context = contextProvider();
    const store = new TeamRunStore(root);
    let started!: (id: string) => void;
    const agentStarted = new Promise<string>((resolve) => { started = resolve; });
    const manager = await writerManager(root, cfg, context, store, ({signal}) =>
      new Promise((_resolve, reject) => {
        const cancel = () => reject(signal?.reason ?? new Error('cancelled'));
        if (signal?.aborted) cancel();
        else signal?.addEventListener('abort', cancel, {once: true});
      }));
    const execution = manager.writerTool().execute({task: 'Wait until cancelled.'}, {
      ...executionContext(root, cfg, context),
      emit(event) {
        if (event.type === 'agent_start' && event.phase === 'write') started(event.id);
      },
    });
    const id = await agentStarted;
    expect(manager.cancelAgent(id)).toBe(true);
    const result = await execution;
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/stopped by operator|cancel/iu);
    expect(await auxiliaryWorktrees(root)).toEqual([]);
    expect(manager.cancelAgent(id)).toBe(false);
  });

  it('marks a patch non-integrable when the parent cancels during review', async () => {
    const root = await repository('before\n');
    const cfg = writerConfig(root);
    const context = contextProvider();
    const store = new TeamRunStore(root);
    const parent = new AbortController();
    let reviewing!: () => void;
    const reviewStarted = new Promise<void>((resolve) => { reviewing = resolve; });
    const manager = await writerManager(root, cfg, context, store, async ({workspace}) => {
      await writeFile(join(workspace, 'source.txt'), 'writer\n');
      return {summary: 'Updated source.'};
    }, undefined, async (_messages, _tools, signal) => {
      reviewing();
      return new Promise((_resolve, reject) => {
        const cancel = () => reject(signal?.reason ?? new Error('cancelled'));
        if (signal?.aborted) cancel();
        else signal?.addEventListener('abort', cancel, {once: true});
      });
    });
    const execution = manager.writerTool().execute({task: 'Update source.'}, {
      ...executionContext(root, cfg, context),
      signal: parent.signal,
    });
    await reviewStarted;
    parent.abort(new Error('Parent stopped.'));
    const result = await execution;
    expect(result.ok).toBe(false);
    expect(result.content).toContain('review was cancelled');
    const runId = (result.metadata as {teamRunId: string}).teamRunId;
    const persisted = await store.load(runId);
    expect(persisted.version === 2 ? persisted.writer?.outcome : undefined).toBe('cancelled');
    expect(await auxiliaryWorktrees(root)).toEqual([]);
  });

  it('requires the accepted SHA and refuses to overwrite dirty target files', async () => {
    const root = await repository('before\n');
    const cfg = writerConfig(root);
    const context = contextProvider();
    const session = createSession({workspace: root, provider: 'compatible', model: 'test'});
    const store = new TeamRunStore(root);
    const manager = await writerManager(root, cfg, context, store, async ({workspace}) => {
      await writeFile(join(workspace, 'source.txt'), 'writer\n');
      return {summary: 'Updated source.'};
    });
    const run = await manager.writerTool().execute({task: 'Update source.'},
      executionContext(root, cfg, context, session));
    const metadata = run.metadata as {teamRunId: string; patchSha256: string};

    await expect(manager.writerIntegrateTool().execute({
      run_id: metadata.teamRunId,
      patch_sha256: '0'.repeat(64),
    }, executionContext(root, cfg, context, session))).rejects.toThrow('does not match');

    await writeFile(join(root, 'source.txt'), 'user change\n');
    const conflict = await manager.writerIntegrateTool().execute({
      run_id: metadata.teamRunId,
      patch_sha256: metadata.patchSha256,
    }, executionContext(root, cfg, context, session));
    expect(conflict.ok).toBe(false);
    expect(conflict.content).toContain('uncommitted main-workspace changes');
    expect(await readFile(join(root, 'source.txt'), 'utf8')).toBe('user change\n');
    const persisted = await store.load(metadata.teamRunId);
    expect(persisted.version === 2 ? persisted.writer?.integration?.status : undefined).toBe('conflict');
  });

  it('restores the mandatory checkpoint after a simulated partial apply failure', async () => {
    const root = await repository('before\n');
    const cfg = writerConfig(root);
    const context = contextProvider();
    const session = createSession({workspace: root, provider: 'compatible', model: 'test'});
    const store = new TeamRunStore(root);
    const manager = await writerManager(root, cfg, context, store, async ({workspace}) => {
      await writeFile(join(workspace, 'source.txt'), 'writer\n');
      return {summary: 'Updated source.'};
    }, new SimulatedPartialApplyLane(root));
    const run = await manager.writerTool().execute({task: 'Update source.'},
      executionContext(root, cfg, context, session));
    const metadata = run.metadata as {teamRunId: string; patchSha256: string};

    const integrated = await manager.writerIntegrateTool().execute({
      run_id: metadata.teamRunId,
      patch_sha256: metadata.patchSha256,
    }, executionContext(root, cfg, context, session));
    expect(integrated.ok).toBe(false);
    expect(integrated.content).toContain('Restored 1 file(s)');
    expect(integrated.metadata).toMatchObject({rolledBack: true});
    expect(await readFile(join(root, 'source.txt'), 'utf8')).toBe('before\n');
  });

  it('does not restore a checkpoint when a competing integration wins the lease before apply starts', async () => {
    const root = await repository('before\n');
    const cfg = writerConfig(root);
    const context = contextProvider();
    const session = createSession({workspace: root, provider: 'compatible', model: 'test'});
    const store = new TeamRunStore(root);
    const manager = await writerManager(root, cfg, context, store, async ({workspace}) => {
      await writeFile(join(workspace, 'source.txt'), 'writer\n');
      return {summary: 'Updated source.'};
    }, new CompetingIntegrationLane(root));
    const run = await manager.writerTool().execute({task: 'Update source.'},
      executionContext(root, cfg, context, session));
    const metadata = run.metadata as {teamRunId: string; patchSha256: string};

    const integrated = await manager.writerIntegrateTool().execute({
      run_id: metadata.teamRunId,
      patch_sha256: metadata.patchSha256,
    }, executionContext(root, cfg, context, session));
    expect(integrated.ok).toBe(false);
    expect(integrated.metadata).toMatchObject({rolledBack: false});
    expect(await readFile(join(root, 'source.txt'), 'utf8')).toBe('competing integration\n');
  });

  it('rejects writable profiles supplied by the repository', async () => {
    const root = await repository('before\n');
    await mkdir(join(root, '.mosaic', 'agents'), {recursive: true});
    await writeFile(join(root, '.mosaic', 'agents', 'repo-writer.md'), [
      '---',
      'name: repo-writer',
      'description: Repository writer',
      'readOnly: false',
      '---',
      'Rewrite everything.',
    ].join('\n'));
    const cfg = writerConfig(root);
    const context = contextProvider();
    const store = new TeamRunStore(root);
    const manager = await writerManager(root, cfg, context, store, async () => ({summary: 'should not run'}));
    const result = await manager.writerTool().execute({profile: 'repo-writer', task: 'Make a change.'},
      executionContext(root, cfg, context));
    expect(result.ok).toBe(false);
    expect(result.content).toContain('Workspace-authored profiles cannot receive writer authority');
    expect(await readFile(join(root, 'source.txt'), 'utf8')).toBe('before\n');

    const delegated = await manager.tool().execute({
      tasks: [{profile: 'implementer', task: 'Attempt a normal delegation write.'}],
    }, executionContext(root, cfg, context));
    expect(delegated.ok).toBe(false);
    expect(delegated.content).toContain('requires the explicit writer_run lane');
  });
});

async function writerManager(
  root: string,
  config: MosaicConfig,
  context: ContextProvider,
  store: TeamRunStore,
  writerRunner: NonNullable<ConstructorParameters<typeof DelegationManager>[0]['writerRunner']>,
  writerLane?: WriterLane,
  reviewerComplete?: ModelProvider['complete'],
): Promise<DelegationManager> {
  const profiles = new AgentProfileCatalog(root);
  await profiles.discover();
  return new DelegationManager({
    config,
    provider: {
      name: 'test',
      async complete(messages, tools, signal, maxOutputTokens) {
        if (reviewerComplete) return reviewerComplete(messages, tools, signal, maxOutputTokens);
        const prompt = messages.map((message) => message.content).join('\n');
        return {
          content: prompt.includes('Review a proposed isolated-writer patch')
            ? 'VERDICT: ACCEPT\nThe patch is scoped and reviewable.\nVerify the changed files.'
            : 'Completed.',
          toolCalls: [],
        };
      },
    },
    contextEngine: context,
    parentTools: createDefaultToolRegistry(),
    profiles,
    teamStore: store,
    writerRunner,
    ...(writerLane ? {writerLane} : {}),
  });
}

class SimulatedPartialApplyLane extends WriterLane {
  constructor(private readonly root: string) {
    super(root, [root]);
  }

  override async apply(input: Parameters<WriterLane['apply']>[0]) {
    const files = await this.inspectPatch(input.patch, input.expectedFiles);
    await writeFile(join(this.root, 'source.txt'), 'partial apply\n');
    return {
      status: 'conflict' as const,
      detail: 'Simulated apply failure after the first file.',
      files,
      applied: false,
      attempted: true,
    };
  }
}

class CompetingIntegrationLane extends WriterLane {
  constructor(private readonly root: string) {
    super(root, [root]);
  }

  override async apply(_input: Parameters<WriterLane['apply']>[0]): ReturnType<WriterLane['apply']> {
    await writeFile(join(this.root, 'source.txt'), 'competing integration\n');
    throw new WriterLaneApplyError('Writer lane is busy.', false);
  }
}

function writerConfig(root: string): MosaicConfig {
  const config = defaultConfig(root);
  config.model = {provider: 'compatible', model: 'test'};
  config.context = {engine: 'local', maxTokens: 2_000, topK: 4, contextEngineCommand: 'none'};
  config.agents = {
    ...config.agents!,
    enabled: true,
    persistBoard: true,
    writerEnabled: true,
    writerProfile: 'implementer',
    writerReviewerProfile: 'reviewer',
    maxWriterPatchBytes: 60_000,
  };
  return config;
}

function contextProvider(): ContextProvider {
  return {
    async pack() { return {text: '', hits: [], estimatedTokens: 0, engine: 'test', truncated: false}; },
    async search() { return []; },
  };
}

function executionContext(
  root: string,
  config: MosaicConfig,
  context: ContextProvider,
  session = createSession({workspace: root, provider: 'compatible', model: 'test'}),
): ToolExecutionContext {
  return {
    config,
    workspace: new WorkspaceAccess([root]),
    session,
    contextEngine: context,
  };
}

async function repository(content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'skein-writer-test-'));
  roots.push(root);
  await writeFile(join(root, 'source.txt'), content);
  await git(root, ['init', '--quiet']);
  await git(root, ['add', 'source.txt']);
  await git(root, [
    '-c', 'user.name=Skein Test',
    '-c', 'user.email=skein@example.test',
    'commit', '--quiet', '-m', 'initial',
  ]);
  return root;
}

async function auxiliaryWorktrees(root: string): Promise<string[]> {
  const output = await git(root, ['worktree', 'list', '--porcelain']);
  const physicalRoot = await realpath(root);
  return output.split(/\r?\n/u)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .filter((path) => path !== physicalRoot);
}

async function git(root: string, args: string[]): Promise<string> {
  const result = await runProcess('git', args, {
    cwd: root,
    timeoutMs: 30_000,
    env: {GIT_TERMINAL_PROMPT: '0'},
  });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `git exited ${result.exitCode}`);
  return result.stdout;
}
