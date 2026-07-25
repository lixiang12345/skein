import {describe, expect, it} from 'vitest';
import {
  buildRedactedReviewBundle,
  parseReviewScope,
  reviewTurnInstructions,
} from '../../src/ui/review-bundle.js';
import type {Session} from '../../src/types.js';

describe('redacted review bundle', () => {
  it('fixes working-tree, commit, and branch review scopes', () => {
    expect(parseReviewScope('')).toEqual({kind: 'working-tree'});
    expect(parseReviewScope('working-tree')).toEqual({kind: 'working-tree'});
    expect(parseReviewScope('commit HEAD~2')).toEqual({kind: 'commit', ref: 'HEAD~2'});
    expect(parseReviewScope('branch origin/main')).toEqual({kind: 'branch', ref: 'origin/main'});
    expect(() => parseReviewScope('commit --all')).toThrow('without control characters or leading dashes');
    expect(() => parseReviewScope('everything')).toThrow('Usage: /review');
  });

  it('retains only content-free review evidence and omits secrets and raw commands', () => {
    const bundle = buildRedactedReviewBundle(session(), '/workspace', {kind: 'working-tree'});
    const serialized = JSON.stringify(bundle);

    expect(bundle).toMatchObject({
      version: 1,
      redacted: true,
      changedFiles: ['src/api.ts'],
      lastRun: {
        status: 'verification_failed',
        checks: [{tool: 'shell', kind: 'test', ok: false}],
      },
      failures: [{tool: 'shell', category: 'shell', class: 'command_exit', retryable: true}],
    });
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('deploy --token');
    expect(serialized).not.toContain('private request');
  });

  it('marks the review instructions read-only, fixed-scope, and redacted', () => {
    const instructions = reviewTurnInstructions(
      buildRedactedReviewBundle(session(), '/workspace', {kind: 'commit', ref: 'abc123'}),
    );
    expect(instructions).toContain('read-only review');
    expect(instructions).toContain('scope fixed');
    expect(instructions).toContain('"redacted": true');
    expect(instructions).not.toContain('super-secret');
  });
});

function session(): Session {
  return {
    id: 'session-review',
    title: 'private request super-secret',
    workspace: '/workspace',
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:01.000Z',
    model: 'test-model',
    provider: 'compatible',
    messages: [{
      id: 'message-secret',
      role: 'user',
      content: 'private request super-secret',
      createdAt: '2026-07-25T00:00:00.000Z',
    }],
    tasks: [],
    changedFiles: ['/workspace/src/api.ts'],
    audit: [{
      id: 'audit-failure',
      createdAt: '2026-07-25T00:00:01.000Z',
      type: 'tool',
      toolCallId: 'call-failure',
      tool: 'shell',
      category: 'shell',
      outcome: 'failure',
      reason: 'deploy --token super-secret',
      metadata: {
        command: 'deploy --token super-secret',
        failure: {class: 'command_exit', retryable: true, circuitOpen: false, repairHint: 'Inspect output.'},
      },
    }],
    lastRun: {
      status: 'verification_failed',
      changedFiles: ['/workspace/src/api.ts'],
      checks: [{
        toolCallId: 'check-secret',
        tool: 'shell',
        command: 'deploy --token super-secret',
        kind: 'test',
        ok: false,
      }],
      detail: 'private failure detail super-secret',
      reason: 'verification_failed',
      finishedAt: '2026-07-25T00:00:01.000Z',
    },
    usage: {inputTokens: 0, outputTokens: 0},
  };
}
