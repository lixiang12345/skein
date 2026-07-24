import {describe, expect, it} from 'vitest';
import {
  buildRunCompletion,
  captureVerification,
  classifyVerificationCommand,
} from '../../src/agent/completion-gate.js';
import type {ToolCall, ToolResult} from '../../src/types.js';

describe('completion gate', () => {
  it.each([
    ['npm test', 'test'],
    ['pnpm run typecheck', 'typecheck'],
    ['cargo clippy', 'lint'],
    ['npm run build', 'build'],
    ['git diff --check', 'diff'],
    ['npm run check', 'check'],
    ['CI=1 npm run typecheck && npm test', 'check'],
  ] as const)('classifies %s as %s evidence', (command, kind) => {
    expect(classifyVerificationCommand(command)).toBe(kind);
  });

  it.each(['echo npm test', 'node script.js', 'git status', 'npm install']) (
    'does not treat %s as verification',
    (command) => {
      expect(classifyVerificationCommand(command)).toBeUndefined();
    },
  );

  it('accepts configured checks and redacts credentials from persisted evidence', () => {
    const command = 'API_KEY=secret-value node verify.js';
    const evidence = captureVerification(
      shellCall('configured', command),
      result('configured', true),
      2,
      [command],
    );
    expect(evidence).toMatchObject({kind: 'configured', ok: true, changeSequence: 2});
    expect(evidence?.command).toBe('API_KEY=[redacted] node verify.js');
    expect(evidence?.command).not.toContain('secret-value');
  });

  it('rejects stale checks performed before the latest change', () => {
    const evidence = captureVerification(
      shellCall('test-before-change', 'npm test'),
      result('test-before-change', true),
      1,
      [],
    );
    expect(buildRunCompletion(['/workspace/src/app.ts'], evidence ? [evidence] : [], 2)).toMatchObject({
      status: 'unverified',
      checks: [],
    });
  });

  it('uses the latest result per command without hiding another failing check', () => {
    const failedTest = captureVerification(
      shellCall('test-failed', 'npm test'), result('test-failed', false), 3, [],
    );
    const passedTest = captureVerification(
      shellCall('test-passed', 'npm test'), result('test-passed', true), 3, [],
    );
    const failedLint = captureVerification(
      shellCall('lint-failed', 'npm run lint'), result('lint-failed', false), 3, [],
    );
    const evidence = [failedTest, passedTest, failedLint].filter(
      (item): item is NonNullable<typeof item> => Boolean(item),
    );
    const report = buildRunCompletion(['/workspace/src/app.ts'], evidence, 3);
    expect(report.status).toBe('verification_failed');
    expect(report.checks).toEqual([
      expect.objectContaining({toolCallId: 'test-passed', kind: 'test', ok: true}),
      expect.objectContaining({toolCallId: 'lint-failed', kind: 'lint', ok: false}),
    ]);
  });

  it('never reports no changes when shell mutation tracking is unknown', () => {
    const report = buildRunCompletion([], [], 0, 'unknown');
    expect(report).toMatchObject({
      status: 'unverified',
      changedFiles: [],
      mutationTracking: 'unknown',
    });
    expect(report.detail).toContain('may have changed workspace files');
  });
});

function shellCall(id: string, command: string): ToolCall {
  return {id, name: 'shell', arguments: {command}};
}

function result(toolCallId: string, ok: boolean): ToolResult {
  return {toolCallId, name: 'shell', ok, content: ok ? 'passed' : 'failed'};
}
