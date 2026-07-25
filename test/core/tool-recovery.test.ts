import {describe, expect, it} from 'vitest';
import {
  classifyToolFailure,
  formatFailureReceipt,
  resolvableFailureSignatures,
  ToolRecoveryController,
} from '../../src/agent/tool-recovery.js';
import type {ToolCall, ToolResult} from '../../src/types.js';

describe('tool recovery', () => {
  it('emits the content-free signature a later identical success can resolve', () => {
    const call = toolCall('same-call');
    const failure = new ToolRecoveryController().recordFailure(call, 'command_exit');

    expect(resolvableFailureSignatures(call)).toContain(failure.signature);
  });

  it('opens the circuit after two identical failures and rejects the third call', () => {
    const controller = new ToolRecoveryController();
    const call = toolCall('one');
    expect(controller.preflight(call)).toBeUndefined();
    expect(controller.recordFailure(call, 'schema_input')).toMatchObject({
      attempt: 1, circuitOpen: false, retryable: true,
    });
    expect(controller.recordFailure({...call, id: 'two'}, 'schema_input')).toMatchObject({
      attempt: 2, circuitOpen: true, retryable: false,
    });
    expect(controller.preflight({...call, id: 'three'})).toMatchObject({
      class: 'schema_input', attempt: 3, circuitOpen: true,
    });
  });

  it('allows a corrected call while consuming the class retry budget', () => {
    const controller = new ToolRecoveryController();
    controller.recordFailure(toolCall('one'), 'command_exit');
    const corrected = toolCall('two', {command: 'npm test -- --runInBand'});
    expect(controller.preflight(corrected)).toBeUndefined();
    const receipt = controller.recordFailure(corrected, 'command_exit');
    expect(receipt).toMatchObject({attempt: 1, remaining: 1, circuitOpen: false});
  });

  it('treats permission denial and cancellation as non-retryable', () => {
    const permission = new ToolRecoveryController().recordFailure(
      toolCall('permission'), 'permission_denied',
    );
    const cancelled = new ToolRecoveryController().recordFailure(
      toolCall('cancelled'), 'cancelled',
    );
    expect(permission).toMatchObject({retryable: false, remaining: 0, circuitOpen: true});
    expect(cancelled).toMatchObject({retryable: false, remaining: 0, circuitOpen: true});
  });

  it('classifies stable execution metadata instead of parsing prose', () => {
    expect(classifyToolFailure(result({exitCode: 2}))).toBe('command_exit');
    expect(classifyToolFailure(result({timedOut: true}))).toBe('timeout');
    expect(classifyToolFailure(result({aborted: true}))).toBe('cancelled');
    expect(classifyToolFailure(result({hookError: 'failed'}))).toBe('hook');
  });

  it('keeps repair receipts concise and free of call arguments', () => {
    const controller = new ToolRecoveryController();
    const receipt = controller.recordFailure({
      id: 'secret',
      name: 'shell',
      arguments: {command: 'curl https://example.test', api_key: 'top-secret'},
    }, 'execution');
    const formatted = formatFailureReceipt(receipt);
    expect(formatted.length).toBeLessThan(300);
    expect(formatted).not.toContain('top-secret');
    expect(formatted).not.toContain('example.test');
  });

  it('stops identical empty or repeated searches after bounded no-progress evidence', () => {
    const controller = new ToolRecoveryController();
    const call: ToolCall = {id: 'search-1', name: 'search_code', arguments: {query: 'missing'}};
    const empty = {toolCallId: 'search-1', name: 'search_code', ok: true, content: 'No matches found.', metadata: {count: 0}};
    expect(controller.recordEvidence(call, empty)).toMatchObject({status: 'empty', repeatCount: 1, stop: false});
    expect(controller.preflight({...call, id: 'search-2'})).toBeUndefined();
    expect(controller.recordEvidence({...call, id: 'search-2'}, empty)).toMatchObject({
      status: 'empty', repeatCount: 2, stop: true,
    });
    expect(controller.preflight({...call, id: 'search-3'})).toMatchObject({
      class: 'no_progress', retryable: false, circuitOpen: true,
    });

    const found: ToolResult = {...empty, content: 'src/app.ts:1', metadata: {count: 1}};
    const other: ToolCall = {id: 'found-1', name: 'search_code', arguments: {query: 'app'}};
    expect(controller.recordEvidence(other, found)).toMatchObject({status: 'new', repeatCount: 0});
    expect(controller.recordEvidence({...other, id: 'found-2'}, found)).toMatchObject({
      status: 'repeated', repeatCount: 1, stop: false,
    });
  });
});

function toolCall(id: string, arguments_: Record<string, unknown> = {}): ToolCall {
  return {id, name: 'shell', arguments: arguments_};
}

function result(metadata: Record<string, unknown>): ToolResult {
  return {toolCallId: 'result', name: 'shell', ok: false, content: 'failed', metadata};
}
