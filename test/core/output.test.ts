import {afterEach, describe, expect, it, vi} from 'vitest';
import {HeadlessReporter} from '../../src/cli/output.js';
import type {Session} from '../../src/types.js';

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

  it('does not duplicate a streamed terminal error', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const reporter = new HeadlessReporter({format: 'stream-json'});
    const error = new Error('provider unavailable');

    reporter.onEvent({type: 'error', error});
    reporter.fail(error);

    const lines = stdout.mock.calls.map(([chunk]) => String(chunk));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({type: 'error', error: 'provider unavailable'});
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
      actual: {inputTokens: 120, outputTokens: 0},
      estimated: {inputTokens: 0, outputTokens: 20},
    });

    const lines = stdout.mock.calls.map(([chunk]) => JSON.parse(String(chunk)) as Record<string, unknown>);
    expect(lines).toEqual([
      expect.objectContaining({type: 'context', packed: expect.objectContaining({budgetTier: 'focused', budgetTokens: 2_000})}),
      expect.objectContaining({type: 'prompt', breakdown: expect.objectContaining({toolSchemaTokens: 50, outputAllowanceTokens: 800})}),
      expect.objectContaining({type: 'usage', source: 'mixed', outputSource: 'estimated'}),
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
      ok: false,
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
});
