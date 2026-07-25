import {access, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {CheckpointStore} from '../../src/checkpoint/store.js';
import {createSession, SessionStore} from '../../src/session/store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

describe('sessions and checkpoints', () => {
  it('keeps empty list operations side-effect free', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-storage-read-'));
    roots.push(root);
    await expect(new SessionStore(root).list()).resolves.toEqual([]);
    await expect(new CheckpointStore(root).list('session-1')).resolves.toEqual([]);
    await expect(access(join(root, '.skein'))).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('persists and resumes an auditable session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-session-'));
    roots.push(root);
    const store = new SessionStore(root);
    const session = await store.create({title: 'Fix queue', model: 'test', provider: 'compatible'});
    session.messages.push({
      id: 'message-1', role: 'user', content: 'Fix it', createdAt: new Date().toISOString(),
    });
    await store.save(session);
    const loaded = await store.load(session.id);
    expect(loaded.messages).toHaveLength(1);
    expect((await store.list())[0]?.title).toBe('Fix queue');
  });

  it('round-trips normalized provider usage in session totals and token receipts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-session-provider-usage-'));
    roots.push(root);
    const store = new SessionStore(root);
    const session = createSession({workspace: root, model: 'test', provider: 'compatible'});
    session.usage.actualCachedInputTokens = 0;
    session.usage.actualCacheWriteInputTokens = 3;
    session.usage.actualReasoningTokens = 4;
    session.tokenLedger = [{
      requestId: '00000000-0000-4000-8000-000000000001',
      turn: 1,
      recordedAt: '2026-07-25T00:00:00.000Z',
      estimated: {
        stableTokens: 1,
        dynamicTokens: 2,
        conversationTokens: 3,
        toolResultTokens: 4,
        retrievedTokens: 5,
        toolSchemaTokens: 6,
        estimatedInputTokens: 21,
        outputAllowanceTokens: 8,
        outputTokens: 7,
      },
      actual: {
        inputTokens: 20,
        outputTokens: 7,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 3,
        reasoningTokens: 4,
      },
      inputSource: 'actual',
      outputSource: 'actual',
      tools: {loaded: [], deferredCount: 0},
      retrieval: {engine: 'none', discarded: []},
    }];

    await store.save(session);
    const loaded = await store.load(session.id);
    expect(loaded.usage).toMatchObject({
      actualCachedInputTokens: 0,
      actualCacheWriteInputTokens: 3,
      actualReasoningTokens: 4,
    });
    expect(loaded.tokenLedger?.[0]?.actual).toEqual({
      inputTokens: 20,
      outputTokens: 7,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 3,
      reasoningTokens: 4,
    });
  });

  it('round-trips content-free duplication audit receipts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-session-duplication-'));
    roots.push(root);
    const store = new SessionStore(root);
    const session = createSession({workspace: root, model: 'test', provider: 'compatible'});
    session.audit?.push({
      id: 'audit-duplicate',
      createdAt: '2026-07-25T00:00:00.000Z',
      type: 'tool',
      toolCallId: 'write-copy',
      tool: 'write_file',
      category: 'write',
      outcome: 'success',
      metadata: {
        duplicationAudit: {
          baselineGeneration: 'g-before',
          changeSequence: 1,
          status: 'warning',
          warningOnly: true,
          checkedFunctions: 1,
          skippedSmallFunctions: 0,
          matches: [{
            matchId: '0123456789abcdef01234567',
            changedPath: join(root, 'copy.ts'),
            changedSymbol: 'copy',
            candidatePath: join(root, 'helper.ts'),
            candidateSymbol: 'helper',
            kind: 'type-1-or-2',
            similarity: 1,
          }],
          rationale: 'One deterministic duplicate candidate found.',
        },
      },
    });
    session.duplicationSuppressions = [{
      matchId: '0123456789abcdef01234567',
      reasonCode: 'separate-boundary',
      reason: 'Separate trust boundaries require this implementation.',
      createdAt: '2026-07-25T00:00:01.000Z',
      toolCallId: 'suppress-copy',
    }];
    session.lastRun = {
      status: 'verified', changedFiles: [join(root, 'copy.ts')], checks: [],
      detail: 'Verification passed.', reason: 'completed', finishedAt: '2026-07-25T00:00:02.000Z',
      duplication: {
        enforcement: 'warning', status: 'suppressed', warningCount: 0,
        unresolvedCount: 0, suppressedCount: 1, matches: [],
      },
    };
    await store.save(session);

    const loaded = await store.load(session.id);
    expect(loaded.audit?.[0]?.metadata?.duplicationAudit).toEqual(
      session.audit?.[0]?.metadata?.duplicationAudit,
    );
    expect(loaded.duplicationSuppressions).toEqual(session.duplicationSuppressions);
    expect(loaded.lastRun?.duplication).toEqual(session.lastRun.duplication);
    const persisted = await readFile(join(store.directory, `${session.id}.json`), 'utf8');
    expect(persisted).not.toContain('function helper');
    expect(persisted).not.toContain('normalizedTokens');
  });

  it('loads an unmodified legacy 0.3.9 session without Contract fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-session-legacy-'));
    const directory = join(root, 'sessions');
    roots.push(root);
    await mkdir(directory, {recursive: true});
    const legacy = {
      id: 'legacy-039',
      title: 'Legacy session',
      workspace: root,
      createdAt: '2026-07-24T00:00:00.000Z',
      updatedAt: '2026-07-24T00:00:00.000Z',
      model: 'test',
      provider: 'compatible',
      messages: [],
      tasks: [],
      changedFiles: [],
      audit: [],
      usage: {inputTokens: 0, outputTokens: 0},
    };
    await writeFile(join(directory, 'legacy-039.json'), `${JSON.stringify(legacy)}\n`);
    const loaded = await new SessionStore(root, directory).load('legacy-039');
    expect(loaded.taskContract).toBeUndefined();
    expect(loaded.lastRun).toBeUndefined();
  });

  it('loads legacy 0.3.15 duplication receipts without match ids', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-session-legacy-duplication-'));
    const directory = join(root, 'sessions');
    roots.push(root);
    await mkdir(directory, {recursive: true});
    const session = createSession({
      workspace: root, model: 'test', provider: 'compatible', id: 'legacy-duplication-0315',
    });
    session.audit?.push({
      id: 'legacy-audit', createdAt: '2026-07-25T00:00:00.000Z',
      type: 'tool', toolCallId: 'legacy-write', tool: 'write_file', outcome: 'success',
      metadata: {duplicationAudit: {
        baselineGeneration: 'legacy', changeSequence: 1, status: 'warning', warningOnly: true,
        checkedFunctions: 1, skippedSmallFunctions: 0, rationale: 'Legacy warning.',
        matches: [{
          changedPath: join(root, 'copy.ts'), changedSymbol: 'copy',
          candidatePath: join(root, 'helper.ts'), candidateSymbol: 'helper',
          kind: 'type-1-or-2', similarity: 1,
        }],
      }},
    });
    await writeFile(join(directory, `${session.id}.json`), `${JSON.stringify(session)}\n`);
    const loaded = await new SessionStore(root, directory).load(session.id);
    expect(loaded.audit?.[0]?.metadata?.duplicationAudit).toMatchObject({
      baselineGeneration: 'legacy', matches: [{changedSymbol: 'copy'}],
    });
  });

  it('restores file bytes without touching the project Git history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-checkpoint-'));
    roots.push(root);
    const path = join(root, 'settings.json');
    await writeFile(path, '{"safe":true}\n');
    const store = new CheckpointStore(root);
    const manifest = await store.capture('session-1', [path], {reason: 'before test write'});
    expect(manifest?.entries).toHaveLength(1);
    await writeFile(path, '{"safe":false}\n');
    await store.restore('session-1', manifest?.id ?? '');
    expect(await readFile(path, 'utf8')).toBe('{"safe":true}\n');
  });

  it('prevents a repository symlink from redirecting Mosaic storage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-storage-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'mosaic-storage-outside-'));
    roots.push(root, outside);
    await symlink(outside, join(root, '.skein'));
    await expect(new SessionStore(root).list()).rejects.toThrow('symbolic link');
    await expect(new CheckpointStore(root).capture('session-1', [join(root, 'file.txt')]))
      .rejects.toThrow('symbolic link');
  });

  it('preflights all checkpoint blobs before restoring any file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-checkpoint-preflight-'));
    roots.push(root);
    const first = join(root, 'first.txt');
    const second = join(root, 'second.txt');
    await writeFile(first, 'first before\n');
    await writeFile(second, 'second before\n');
    const store = new CheckpointStore(root);
    const manifest = await store.capture('session-1', [first, second]);
    const secondEntry = manifest?.entries[1];
    await writeFile(first, 'first changed\n');
    await writeFile(second, 'second changed\n');
    await unlink(join(root, '.skein', 'checkpoints', 'session-1', manifest?.id ?? '', 'blobs', secondEntry?.blob ?? ''));
    await expect(store.restore('session-1', manifest?.id ?? '')).rejects.toThrow('blob');
    expect(await readFile(first, 'utf8')).toBe('first changed\n');
    expect(await readFile(second, 'utf8')).toBe('second changed\n');
  });

  it('rejects symlinked checkpoint subdirectories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-checkpoint-symlink-'));
    const outside = await mkdtemp(join(tmpdir(), 'mosaic-checkpoint-symlink-outside-'));
    roots.push(root, outside);
    const file = join(root, 'file.txt');
    await writeFile(file, 'before\n');
    const store = new CheckpointStore(root);
    await store.capture('session-1', [file]);
    await symlink(outside, join(root, '.skein', 'checkpoints', 'session-1', 'redirect'));
    await expect(store.load('session-1', 'redirect')).rejects.toThrow('symbolic link');
  });

  it('does not follow a symlinked session backup during save', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-session-backup-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'mosaic-session-backup-outside-'));
    roots.push(root, outside);
    const victim = join(outside, 'victim.txt');
    await writeFile(victim, 'unchanged\n');
    const store = new SessionStore(root);
    const session = await store.create({
      id: 'session-1', title: 'Before', model: 'test', provider: 'compatible',
    });
    await symlink(victim, join(root, '.skein', 'sessions', 'session-1.bak'));
    session.title = 'After';
    await expect(store.save(session)).rejects.toThrow('symbolic link');
    expect(await readFile(victim, 'utf8')).toBe('unchanged\n');
  });

  it('rejects a stored session whose identity does not match its file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-session-identity-'));
    roots.push(root);
    const store = new SessionStore(root);
    await store.create({
      id: 'session-1', title: 'Original', model: 'test', provider: 'compatible',
    });
    const path = join(root, '.skein', 'sessions', 'session-1.json');
    const stored = JSON.parse(await readFile(path, 'utf8')) as {id: string};
    stored.id = 'different-session';
    await writeFile(path, `${JSON.stringify(stored)}\n`);
    await expect(store.load('session-1')).rejects.toThrow('not found or unreadable');
  });
});
