import {afterEach, describe, expect, it, vi} from 'vitest';
import {HeadlessReporter} from '../../src/cli/output.js';
import {HEADLESS_EXIT_CODES, resolveHeadlessOutcome} from '../../src/cli/headless-contract.js';
import type {RunCompletion, Session} from '../../src/types.js';

const session: Session = {
  id: '12345678-session',
  title: 'Reporter test',
  workspace: '/tmp/reporter-test',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  model: 'test-model',
  provider: 'compatible',
  messages: [],
  tasks: [],
  changedFiles: [],
  usage: {inputTokens: 10, outputTokens: 5},
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HeadlessReporter', () => {
  it('preserves the optional structured team verdict in stream JSON', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const reporter = new HeadlessReporter({format: 'stream-json', color: false});
    reporter.onEvent({
      type: 'team_done', id: 'run-1', accepted: false, reviewRounds: 1,
      review: {decision: 'escalate', pass: 2, fail: 1, unknown: 3},
    });
    expect(JSON.parse(stdout.mock.calls.map(([chunk]) => String(chunk)).join(''))).toEqual({
      type: 'team_done', id: 'run-1', accepted: false, reviewRounds: 1,
      review: {decision: 'escalate', pass: 2, fail: 1, unknown: 3},
    });
  });

  it('prints only the latest assistant response once in quiet mode', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const reporter = new HeadlessReporter({format: 'text', quiet: true, color: false});

    reporter.onEvent({type: 'assistant', content: 'Working on it.'});
    reporter.onEvent({type: 'assistant', content: 'Completed.'});

    expect(stdout).not.toHaveBeenCalled();
    reporter.finish(session);

    expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join('')).toBe('Completed.\n');
    expect(stderr).not.toHaveBeenCalled();
  });

  it('keeps a streamed error event and adds one versioned terminal record', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const reporter = new HeadlessReporter({format: 'stream-json'});
    const error = new Error('provider unavailable');

    reporter.onEvent({type: 'error', error});
    reporter.fail(error);

    const lines = stdout.mock.calls.map(([chunk]) => String(chunk));
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '')).toEqual({type: 'error', error: 'provider unavailable'});
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({
      schemaVersion: 1,
      type: 'final',
      ok: false,
      status: 'error',
      exitCode: HEADLESS_EXIT_CODES.error,
    });
  });

  it.each([
    ['completed', {reason: 'completed', completion: {status: 'no_changes'}}, 0],
    ['verified', {reason: 'completed', completion: {status: 'verified'}}, 0],
    ['needs_input', {reason: 'needs_input', completion: {status: 'no_changes'}}, 2],
    ['unverified', {reason: 'unverified', completion: {status: 'unverified'}}, 3],
    ['verification_failed', {reason: 'verification_failed', completion: {status: 'verification_failed'}}, 4],
    ['blocked', {reason: 'unverified', completion: {status: 'unverified', acceptance: {state: 'blocked'}}}, 5],
    ['cancelled', {reason: 'aborted', completion: {status: 'no_changes'}}, 6],
    ['max_turns', {reason: 'max_turns', completion: {status: 'unverified'}}, 7],
    ['token_budget', {reason: 'token_budget', completion: {status: 'unverified'}}, 8],
    ['error', {reason: 'error', error: new Error('failed')}, 1],
  ])('maps %s to a stable headless exit code', (status, input, exitCode) => {
    const candidate = input as {
      reason: string;
      completion?: Partial<RunCompletion> & {status: RunCompletion['status']};
      error?: Error;
    };
    const acceptance = candidate.completion?.acceptance;
    const completion = candidate.completion ? {
      changedFiles: [],
      checks: [],
      detail: 'test',
      ...candidate.completion,
      ...(acceptance ? {acceptance: {
        state: acceptance.state ?? 'blocked',
        total: acceptance.total ?? 1,
        satisfied: acceptance.satisfied ?? 0,
        pending: acceptance.pending ?? 0,
        blocked: acceptance.blocked ?? 1,
        missingVerification: acceptance.missingVerification ?? [],
        unresolved: acceptance.unresolved ?? [],
      }} : {}),
    } as RunCompletion : undefined;
    expect(resolveHeadlessOutcome({
      reason: candidate.reason,
      ...(completion ? {completion} : {}),
      ...(candidate.error ? {error: candidate.error} : {}),
    })).toMatchObject({schemaVersion: 1, status, exitCode, ok: exitCode === 0});
  });

  it('prints streamed assistant text once and retains the final response for quiet output', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const reporter = new HeadlessReporter({format: 'text', color: false});

    reporter.onEvent({type: 'assistant_delta', id: 'response-1', content: 'Hello '});
    reporter.onEvent({type: 'assistant_delta', id: 'response-1', content: 'world.'});
    reporter.onEvent({type: 'assistant', id: 'response-1', content: 'Hello world.'});

    expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join('')).toBe('Hello world.\n');
  });

  it('retains structured context degradation in final JSON output', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const reporter = new HeadlessReporter({format: 'json'});
    reporter.onEvent({
      type: 'context',
      packed: {
        text: 'omitted from summary',
        hits: [],
        estimatedTokens: 0,
        engine: 'local',
        truncated: false,
        degradation: {
          code: 'local-retrieval-failed',
          summary: 'Local retrieval failed.',
        },
      },
    });
    reporter.onEvent({type: 'assistant', content: 'Completed.'});
    reporter.finish(session);

    const output = JSON.parse(stdout.mock.calls.map(([chunk]) => String(chunk)).join('')) as {
      context?: {engine?: string; hits?: number; degradation?: {code?: string}};
    };
    expect(output.context).toMatchObject({
      engine: 'local',
      hits: 0,
      degradation: {code: 'local-retrieval-failed'},
    });
    expect(JSON.stringify(output.context)).not.toContain('omitted from summary');
  });

  it('retains budget and usage provenance in JSON without prompt content', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const reporter = new HeadlessReporter({format: 'stream-json'});
    reporter.onEvent({
      type: 'context',
      packed: {
        text: 'private source bytes', hits: [], estimatedTokens: 0, engine: 'local', truncated: false,
        budgetTier: 'focused', budgetTokens: 2_000, baseBudgetTokens: 2_000,
        incrementalBudgetTokens: 0, budgetReason: 'explicit path', candidateHits: 0,
        selectedHits: 0, duplicateHits: 0, incrementalEvidenceTokens: 0,
      },
    });
    reporter.onEvent({
      type: 'prompt', intent: 'explain', sections: ['intent:explain'], estimatedTokens: 120,
      breakdown: {
        stableTokens: 40, dynamicTokens: 20, conversationTokens: 10,
        toolResultTokens: 0, retrievedTokens: 0, toolSchemaTokens: 50, estimatedInputTokens: 120,
        outputAllowanceTokens: 800,
      },
    });
    reporter.onEvent({
      type: 'usage', inputTokens: 120, outputTokens: 20, source: 'mixed',
      inputSource: 'actual', outputSource: 'estimated',
      actual: {
        inputTokens: 120,
        outputTokens: 0,
        cachedInputTokens: 80,
        cacheWriteInputTokens: 10,
        reasoningTokens: 4,
      },
      estimated: {inputTokens: 0, outputTokens: 20},
    });

    const lines = stdout.mock.calls.map(([chunk]) => JSON.parse(String(chunk)) as Record<string, unknown>);
    expect(lines).toEqual([
      expect.objectContaining({type: 'context', packed: expect.objectContaining({budgetTier: 'focused', budgetTokens: 2_000})}),
      expect.objectContaining({type: 'prompt', breakdown: expect.objectContaining({toolSchemaTokens: 50, outputAllowanceTokens: 800})}),
      expect.objectContaining({
        type: 'usage', source: 'mixed', outputSource: 'estimated',
        actual: expect.objectContaining({cachedInputTokens: 80, cacheWriteInputTokens: 10, reasoningTokens: 4}),
      }),
    ]);
    expect(JSON.stringify(lines[1])).not.toContain('private source bytes');
  });

  it('labels legacy session totals as unknown instead of actual', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const reporter = new HeadlessReporter({format: 'text', color: false});
    reporter.finish(session);
    expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain('15 tokens (unknown source)');
    expect(stdout).not.toHaveBeenCalled();
  });

  it('reports an unverified run as structured non-success', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const reporter = new HeadlessReporter({format: 'json'});
    reporter.onEvent({type: 'assistant', content: 'Claimed complete.'});
    reporter.onEvent({
      type: 'done',
      reason: 'unverified',
      completion: {
        status: 'unverified',
        changedFiles: ['/tmp/reporter-test/result.ts'],
        checks: [],
        detail: 'No successful verification was recorded after the last change to 1 workspace file.',
      },
    });
    reporter.finish(session);

    const output = JSON.parse(stdout.mock.calls.map(([chunk]) => String(chunk)).join('')) as {
      ok?: boolean;
      reason?: string;
      completion?: {status?: string};
    };
    expect(output).toMatchObject({
      schemaVersion: 1,
      type: 'result',
      ok: false,
      status: 'unverified',
      exitCode: HEADLESS_EXIT_CODES.unverified,
      reason: 'unverified',
      completion: {status: 'unverified'},
    });
  });

  it('keeps successful read-only runs successful in JSON', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const reporter = new HeadlessReporter({format: 'json'});
    reporter.onEvent({type: 'assistant', content: 'The code path is read-only.'});
    reporter.onEvent({
      type: 'done',
      reason: 'completed',
      completion: {
        status: 'no_changes',
        changedFiles: [],
        checks: [],
        detail: 'No workspace files changed in this run.',
      },
    });
    reporter.finish(session);

    const output = JSON.parse(stdout.mock.calls.map(([chunk]) => String(chunk)).join('')) as {ok?: boolean};
    expect(output.ok).toBe(true);
    expect(output).toMatchObject({schemaVersion: 1, status: 'completed', exitCode: 0});
  });

  it('streams completion evidence before the final session record', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const reporter = new HeadlessReporter({format: 'stream-json'});
    const completion = {
      status: 'verified' as const,
      changedFiles: ['/tmp/reporter-test/result.ts'],
      checks: [{
        toolCallId: 'check-1',
        tool: 'shell' as const,
        command: 'npm test',
        kind: 'test' as const,
        ok: true,
      }],
      detail: '1 current verification check passed for 1 workspace file.',
    };
    reporter.onEvent({type: 'done', reason: 'completed', completion});
    reporter.finish({...session, lastRun: {...completion, reason: 'completed', finishedAt: new Date().toISOString()}});

    const lines = stdout.mock.calls.map(([chunk]) => JSON.parse(String(chunk)) as {
      type?: string;
      completion?: {status?: string};
      session?: {lastRun?: {status?: string}};
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({type: 'done', completion: {status: 'verified'}});
    expect(lines[1]).toMatchObject({type: 'session', session: {lastRun: {status: 'verified'}}});
    expect(lines[1]).toMatchObject({schemaVersion: 1, status: 'verified', exitCode: 0});
  });

  it('retains content-free duplication audit receipts in JSON and JSONL tool results', () => {
    const receipt = {
      baselineGeneration: 'g-before',
      changeSequence: 1,
      status: 'warning' as const,
      warningOnly: true as const,
      checkedFunctions: 1,
      skippedSmallFunctions: 0,
      matches: [{
        matchId: 'abcdef0123456789abcdef01',
        changedPath: '/tmp/reporter-test/copy.ts', changedSymbol: 'copy',
        candidatePath: '/tmp/reporter-test/helper.ts', candidateSymbol: 'helper',
        kind: 'type-1-or-2' as const, similarity: 1,
      }],
      rationale: 'One deterministic duplicate candidate found.',
    };

    for (const format of ['json', 'stream-json'] as const) {
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const reporter = new HeadlessReporter({format});
      reporter.onEvent({
        type: 'tool_result',
        result: {
          toolCallId: 'write-copy', name: 'write_file', ok: true, content: 'Created copy.ts.',
          metadata: {duplicationAudit: receipt},
        },
      });
      reporter.finish(session);
      const serialized = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(serialized).toContain('duplicationAudit');
      expect(serialized).toContain('type-1-or-2');
      expect(serialized).not.toContain('normalizedTokens');
      stdout.mockRestore();
    }
  });

  it('retains content-free compaction receipts in JSON and JSONL session output', () => {
    const compaction = {
      id: '00000000-0000-4000-8000-000000000003',
      recordedAt: '2026-07-25T00:00:00.000Z',
      mode: 'automatic' as const,
      status: 'compacted' as const,
      reason: 'compacted' as const,
      omittedMessages: 8,
      compactedThroughMessageId: 'message-8',
      predictedReuses: 3,
      estimated: {
        inputTokens: 800, outputTokens: 100, predictedOutputTokens: 140,
        outputAllowanceTokens: 1600, omittedTokens: 900,
        priorSummaryTokens: 0, factsTokens: 80,
        projectedGrossSavingsTokens: 2040, projectedNetSavingsTokens: 1100,
      },
      actual: {inputTokens: 780, outputTokens: 95},
      inputSource: 'actual' as const,
      outputSource: 'actual' as const,
      narrative: 'present' as const,
    };

    for (const format of ['json', 'stream-json'] as const) {
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const reporter = new HeadlessReporter({format});
      reporter.onEvent({
        type: 'context_compacted', omittedMessages: 8, summaryTokens: 180,
        status: 'compacted', reason: 'compacted', receipt: compaction,
      });
      reporter.finish({...session, contextCompactionReceipts: [compaction]});
      const serialized = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(serialized).toContain('contextCompactionReceipts');
      expect(serialized).toContain('projectedNetSavingsTokens');
      expect(serialized).not.toContain('private transcript');
      stdout.mockRestore();
    }
  });

  it('keeps unresolved Contract acceptance non-successful in JSON', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const reporter = new HeadlessReporter({format: 'json'});
    reporter.onEvent({
      type: 'done',
      reason: 'unverified',
      completion: {
        status: 'unverified',
        changedFiles: [],
        checks: [],
        detail: 'Task Contract acceptance is unresolved: 1 pending required criterion.',
        acceptance: {
          state: 'active', total: 1, satisfied: 0, pending: 1, blocked: 0, missingVerification: [],
          unresolved: [{id: 'criterion-1', description: 'Verify behavior', status: 'pending'}],
        },
      },
    });
    reporter.finish(session);

    const output = JSON.parse(stdout.mock.calls.map(([chunk]) => String(chunk)).join('')) as {
      ok?: boolean;
      completion?: {acceptance?: {pending?: number}};
    };
    expect(output).toMatchObject({ok: false, completion: {acceptance: {pending: 1}}});
  });

  it('keeps needs-input actionable in quiet text and structured JSON', () => {
    const pending = {
      id: '00000000-0000-4000-8000-000000000020',
      runId: '00000000-0000-4000-8000-000000000021',
      createdAt: '2026-07-25T00:00:00.000Z',
      originalRequest: 'Change the public API.',
      question: 'Which compatibility policy?',
      options: [
        {id: 'compatible', label: 'Compatible', impact: 'Keep callers working.', recommended: true},
        {id: 'breaking', label: 'Breaking', impact: 'Require migration.', recommended: false},
      ],
      reason: 'public_api_compatibility_missing' as const,
    };
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const quiet = new HeadlessReporter({format: 'text', quiet: true, color: false});
    quiet.onEvent({type: 'needs_input', pending});
    expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain('Which compatibility policy?');
    stderr.mockRestore();

    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const json = new HeadlessReporter({format: 'json', color: false});
    json.onEvent({type: 'needs_input', pending});
    json.onEvent({type: 'done', reason: 'needs_input', completion: {
      status: 'no_changes', changedFiles: [], checks: [], detail: 'No workspace mutations were recorded.',
    }});
    json.finish({...session, pendingInput: pending});
    const output = JSON.parse(stdout.mock.calls.map(([chunk]) => String(chunk)).join('')) as {
      ok?: boolean; reason?: string; session?: {pendingInput?: {runId?: string}};
    };
    expect(output).toMatchObject({ok: false, reason: 'needs_input', session: {pendingInput: {runId: pending.runId}}});
  });

  it('uses only ASCII chrome when the fallback glyph mode is enabled', () => {
    const previous = process.env.SKEIN_GLYPHS;
    process.env.SKEIN_GLYPHS = 'ascii';
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const reporter = new HeadlessReporter({format: 'text', color: false});
      reporter.onEvent({type: 'thinking', turn: 1});
      reporter.onEvent({
        type: 'context',
        packed: {text: '', hits: [], estimatedTokens: 1200, engine: 'local', truncated: false},
      });
      reporter.onEvent({
        type: 'tool_start',
        category: 'shell',
        call: {id: 'tool-1', name: 'shell', arguments: {command: 'npm test', env: {CI: '1'}}},
      });
      reporter.onEvent({
        type: 'tool_result',
        result: {toolCallId: 'tool-1', name: 'shell', ok: true, content: 'passed', metadata: {changedFiles: []}},
      });
      reporter.onEvent({type: 'tasks', tasks: [{id: 'task-1', title: 'Verify', status: 'completed'}]});
      reporter.finish(session);

      const output = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(output).toContain('- context | local');
      expect(output).toContain('~ shell | npm test | env CI');
      expect(output).toContain('+ shell | 0 files');
      expect(output).not.toMatch(/[^\x00-\x7F]/u);
    } finally {
      if (previous === undefined) delete process.env.SKEIN_GLYPHS;
      else process.env.SKEIN_GLYPHS = previous;
    }
  });

  it('reports the same redacted active connection in text, JSON, and JSONL finals', () => {
    const connection = {
      id: 'work', provider: 'compatible' as const, protocol: 'openai-responses' as const,
      source: 'environment' as const, endpoint: 'https://relay.example/v1',
      modelsEndpoint: 'https://relay.example/v1', authType: 'env' as const,
      authStatus: 'configured' as const, complete: true, issues: [],
    };
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    new HeadlessReporter({format: 'text', color: false, connection}).finish(session);
    const textOutput = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(textOutput).toContain('connection @work');
    expect(textOutput).toContain('openai-responses');
    expect(textOutput).toContain('environment');
    expect(textOutput).toContain('env/configured');
    expect(textOutput).toContain('inference https://relay.example/v1');
    expect(textOutput).toContain('models https://relay.example/v1');
    stderr.mockRestore();

    for (const format of ['json', 'stream-json'] as const) {
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      new HeadlessReporter({format, color: false, connection}).finish(session);
      const records = stdout.mock.calls.map(([chunk]) => String(chunk).trim()).filter(Boolean)
        .map((line) => JSON.parse(line) as {connection?: typeof connection});
      expect(records.at(-1)?.connection).toEqual(connection);
      expect(JSON.stringify(records)).not.toContain('secret');
      stdout.mockRestore();
    }
  });

  it('prints warning-only duplication status without downgrading verified completion', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const reporter = new HeadlessReporter({format: 'text', color: false});
    reporter.onEvent({
      type: 'done', reason: 'completed',
      completion: {
        status: 'verified', changedFiles: ['/tmp/reporter-test/copy.ts'], checks: [],
        detail: 'Verification passed.',
        duplication: {
          enforcement: 'warning', status: 'warning', warningCount: 1,
          unresolvedCount: 0, suppressedCount: 0, matches: [],
        },
      },
    });
    expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join(''))
      .toContain('verified · Verification passed. · duplication warning (1 warning, 0 incomplete, 0 suppressed)');
  });
});
