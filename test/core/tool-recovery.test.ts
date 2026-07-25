import {describe, expect, it} from 'vitest';
import {
  classifyToolFailure,
  formatFailureReceipt,
  ToolRecoveryController,
} from '../../src/agent/tool-recovery.js';
import type {ToolCall, ToolResult} from '../../src/types.js';

describe('tool recovery', () => {
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
});

function toolCall(id: string, arguments_: Record<string, unknown> = {}): ToolCall {
  return {id, name: 'shell', arguments: arguments_};
}

function result(metadata: Record<string, unknown>): ToolResult {
  return {toolCallId: 'result', name: 'shell', ok: false, content: 'failed', metadata};
}
