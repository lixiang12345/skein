import {describe, expect, it, vi} from 'vitest';
import {selectContextBudget} from '../../src/context/budget.js';
import {ContextEngine} from '../../src/context/context-engine.js';
import {packContextHits} from '../../src/context/local-index.js';
import type {MosaicConfig} from '../../src/types.js';

const config = {context: {maxTokens: 12_000, topK: 16}};

describe('adaptive context budget', () => {
  it('selects deterministic tiers from task shape and records the reason', () => {
    expect(selectContextBudget('hi', config, {trivial: true})).toMatchObject({
      tier: 'none', budgetTokens: 0, topK: 0, reason: expect.stringContaining('skipped'),
    });
    expect(selectContextBudget('Explain src/parser.ts', config, {intent: 'explain'})).toMatchObject({
      tier: 'focused', budgetTokens: 2_000, topK: 4, incrementalBudgetTokens: 0,
    });
    expect(selectContextBudget('Fix the parser regression', config, {intent: 'debug'})).toMatchObject({
      tier: 'standard', budgetTokens: 4_000, topK: 8, incrementalBudgetTokens: 2_000,
    });
    expect(selectContextBudget('Audit all usages across modules', config, {intent: 'review'})).toMatchObject({
      tier: 'broad', budgetTokens: 8_000, topK: 12,
      reason: expect.stringContaining('repository-wide'),
    });
    expect(selectContextBudget(
      'Perform a comprehensive repository-wide architecture migration, then update all modules and all call sites',
      config,
      {intent: 'refactor'},
    )).toMatchObject({
      tier: 'maximum', budgetTokens: 12_000, topK: 16, incrementalBudgetTokens: 10_000,
      reason: expect.stringContaining('exhaustive'),
    });
  });

  it('treats configuration as a ceiling rather than consuming it by default', () => {
    expect(selectContextBudget('Fix the parser regression', {
      context: {maxTokens: 3_000, topK: 5},
    }, {intent: 'debug'})).toMatchObject({
      tier: 'standard', budgetTokens: 3_000, topK: 5,
      reason: expect.stringContaining('capped by configuration'),
    });
  });

  it('does not touch the local index for a zero-budget turn', async () => {
    const engine = new ContextEngine(fullConfig());
    const pack = vi.spyOn(engine.local, 'pack');
    const packed = await engine.pack('hello', {intent: 'implement', trivial: true});
    expect(pack).not.toHaveBeenCalled();
    expect(packed).toMatchObject({
      budgetTier: 'none', budgetTokens: 0, candidateHits: 0, selectedHits: 0,
    });
  });

  it('passes the selected budget to the local index and returns a receipt', async () => {
    const engine = new ContextEngine(fullConfig());
    const pack = vi.spyOn(engine.local, 'pack').mockResolvedValue({
      text: 'evidence', hits: [], estimatedTokens: 600, engine: 'local', truncated: false,
      candidateHits: 3, selectedHits: 2, duplicateHits: 1,
    });
    const packed = await engine.pack('Fix the parser regression', {intent: 'debug'});
    expect(pack).toHaveBeenCalledWith('Fix the parser regression', 8, 4_000);
    expect(packed).toMatchObject({
      budgetTier: 'standard', budgetTokens: 4_000, baseBudgetTokens: 2_000,
      incrementalBudgetTokens: 2_000, incrementalEvidenceTokens: 0,
      candidateHits: 3, selectedHits: 2, duplicateHits: 1,
    });
  });

  it('deduplicates overlapping spans and reports bounded selection', () => {
    const hits = [
      hit('/workspace/a.ts', 1, 100, 'a'.repeat(400), 3),
      hit('/workspace/a.ts', 30, 90, 'duplicate', 2),
      hit('/workspace/b.ts', 1, 20, 'b'.repeat(400), 1),
    ];
    const packed = packContextHits(hits, ['/workspace'], 150, 'local');
    expect(packed).toMatchObject({candidateHits: 3, selectedHits: 2, duplicateHits: 1, truncated: true});
    expect(packed.estimatedTokens).toBeLessThanOrEqual(150);
    expect(packed.hits[1]?.endLine).toBeLessThanOrEqual(20);
  });

  it('keeps a diverse file mix after two non-overlapping spans from one file', () => {
    const hits = [
      hit('/workspace/a.ts', 1, 10, 'first useful span', 4),
      hit('/workspace/a.ts', 30, 40, 'second useful span', 3),
      hit('/workspace/a.ts', 60, 70, 'third useful span', 2),
      hit('/workspace/b.ts', 1, 10, 'other useful span', 1),
    ];
    const packed = packContextHits(hits, ['/workspace'], 500, 'local');

    expect(packed.hits.map((hit) => hit.path)).toEqual([
      '/workspace/a.ts', '/workspace/a.ts', '/workspace/b.ts',
    ]);
    expect(packed).toMatchObject({candidateHits: 4, selectedHits: 3, duplicateHits: 1});
  });
});

function fullConfig(): MosaicConfig {
  return {
    model: {provider: 'compatible', model: 'test'},
    workspaceRoots: ['/tmp/skein-context-budget'],
    context: {maxTokens: 12_000, topK: 16},
    permissions: {read: 'allow', write: 'deny', shell: 'deny', git: 'deny', network: 'deny', allowCommands: [], denyCommands: []},
    hooks: {},
    agent: {maxTurns: 1, maxSessionTokens: 20_000, autoVerify: false, verifyCommands: [], checkpointBeforeWrite: false},
    ui: {color: false, compact: true},
  };
}

function hit(path: string, startLine: number, endLine: number, content: string, score: number) {
  return {path, startLine, endLine, content, score, source: 'local'};
}
