import {createHash} from 'node:crypto';
import type {
  ToolCall,
  ToolFailureClass,
  ToolFailureReceipt,
  ToolResult,
} from '../types.js';

const RETRY_BUDGET: Record<ToolFailureClass, number> = {
  schema_input: 3,
  unknown_tool: 2,
  permission_denied: 0,
  command_exit: 3,
  timeout: 2,
  cancelled: 0,
  hook: 1,
  execution: 3,
  no_progress: 0,
  contract_required: 2,
};

const REPAIR_HINT: Record<ToolFailureClass, string> = {
  schema_input: 'Correct the arguments to match the tool schema.',
  unknown_tool: 'Choose a tool exposed for this turn.',
  permission_denied: 'Do not retry unless the user or configuration changes permission.',
  command_exit: 'Inspect the exit output, change the command or fix the cause, then retry once.',
  timeout: 'Narrow the operation or increase its allowed timeout.',
  cancelled: 'Stop work and preserve the current state.',
  hook: 'Fix the hook failure before relying on the tool result.',
  execution: 'Use the error detail to change the inputs or approach.',
  no_progress: 'Stop repeating the same search; use current evidence or change the query, path, or mode.',
  contract_required: 'Activate the Task Contract before any workspace mutation.',
};

interface SignatureState {
  failureClass: ToolFailureClass;
  failures: number;
}

interface EvidenceState {
  fingerprint: string;
  repeats: number;
}

export interface EvidenceProgressReceipt {
  status: 'new' | 'empty' | 'repeated';
  repeatCount: number;
  stop: boolean;
  signature: string;
}

export class ToolRecoveryController {
  private readonly signatures = new Map<string, SignatureState>();
  private readonly classFailures = new Map<ToolFailureClass, number>();
  private readonly toolClasses = new Map<string, ToolFailureClass>();
  private readonly evidence = new Map<string, EvidenceState>();

  preflight(call: ToolCall): ToolFailureReceipt | undefined {
    const callKey = callSignature(call);
    const evidence = this.evidence.get(callKey);
    if (evidence && evidence.repeats >= 2) {
      return this.receipt(call, 'no_progress', evidence.repeats + 1, true);
    }
    const signatureState = this.signatures.get(callKey);
    if (signatureState && (signatureState.failures >= 2 ||
      !isRetryable(signatureState.failureClass))) {
      return this.receipt(
        call,
        signatureState.failureClass,
        signatureState.failures + 1,
        true,
      );
    }
    const lastClass = this.toolClasses.get(call.name);
    if (lastClass && (this.classFailures.get(lastClass) ?? 0) >= RETRY_BUDGET[lastClass] &&
      RETRY_BUDGET[lastClass] > 0) {
      return this.receipt(call, lastClass, (signatureState?.failures ?? 0) + 1, true);
    }
    return undefined;
  }

  recordFailure(call: ToolCall, failureClass: ToolFailureClass): ToolFailureReceipt {
    const callKey = callSignature(call);
    const current = this.signatures.get(callKey);
    const failures = current?.failureClass === failureClass ? current.failures + 1 : 1;
    this.signatures.set(callKey, {failureClass, failures});
    this.toolClasses.set(call.name, failureClass);
    this.classFailures.set(failureClass, (this.classFailures.get(failureClass) ?? 0) + 1);
    return this.receipt(
      call,
      failureClass,
      failures,
      failures >= 2 || !isRetryable(failureClass),
    );
  }

  recordSuccess(call: ToolCall): void {
    this.signatures.delete(callSignature(call));
    this.toolClasses.delete(call.name);
  }

  recordEvidence(call: ToolCall, result: ToolResult): EvidenceProgressReceipt | undefined {
    if (call.name !== 'search_code' || !result.ok) return undefined;
    const callKey = callSignature(call);
    const fingerprint = createHash('sha256')
      .update(`${result.content}\0${stableJson(result.metadata ?? {})}`)
      .digest('hex');
    const count = typeof result.metadata?.count === 'number' ? result.metadata.count : undefined;
    const current = this.evidence.get(callKey);
    const repeated = current?.fingerprint === fingerprint;
    const repeats = count === 0
      ? (repeated ? current.repeats + 1 : 1)
      : repeated ? current.repeats + 1 : 0;
    this.evidence.set(callKey, {fingerprint, repeats});
    return {
      status: count === 0 ? 'empty' : repeated ? 'repeated' : 'new',
      repeatCount: repeats,
      stop: repeats >= 2,
      signature: createHash('sha256').update(`${callKey}\0${fingerprint}`).digest('hex'),
    };
  }

  private receipt(
    call: ToolCall,
    failureClass: ToolFailureClass,
    attempt: number,
    circuitOpen: boolean,
  ): ToolFailureReceipt {
    const budget = RETRY_BUDGET[failureClass];
    const consumed = this.classFailures.get(failureClass) ?? 0;
    return {
      class: failureClass,
      retryable: isRetryable(failureClass) && consumed < budget && !circuitOpen,
      repairHint: REPAIR_HINT[failureClass],
      attempt,
      remaining: Math.max(0, budget - consumed),
      circuitOpen,
      signature: failureSignature(call, failureClass),
    };
  }
}

export function classifyToolFailure(
  result: ToolResult,
  fallback: ToolFailureClass = 'execution',
): ToolFailureClass {
  if (result.metadata?.failureClass && isFailureClass(result.metadata.failureClass)) {
    return result.metadata.failureClass;
  }
  if (result.metadata?.aborted === true) return 'cancelled';
  if (result.metadata?.timedOut === true) return 'timeout';
  if (result.metadata?.hookError) return 'hook';
  if (typeof result.metadata?.exitCode === 'number' && result.metadata.exitCode !== 0) {
    return 'command_exit';
  }
  return fallback;
}

export function formatFailureReceipt(receipt: ToolFailureReceipt): string {
  return `Failure: ${receipt.class}; attempt ${receipt.attempt}; ${receipt.remaining} retries remain; circuit ${receipt.circuitOpen ? 'open' : 'closed'}. Repair: ${receipt.repairHint}`;
}

function isRetryable(failureClass: ToolFailureClass): boolean {
  return RETRY_BUDGET[failureClass] > 0;
}

function callSignature(call: ToolCall): string {
  return createHash('sha256')
    .update(`${call.name}\0${stableJson(redact(call.arguments))}`)
    .digest('hex');
}

function failureSignature(call: ToolCall, failureClass: ToolFailureClass): string {
  return createHash('sha256')
    .update(`${call.name}\0${stableJson(redact(call.arguments))}\0${failureClass}`)
    .digest('hex');
}

function redact(value: unknown, key = ''): unknown {
  if (/api[_-]?key|authorization|cookie|password|secret|token/i.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, item]) => [name, redact(item, name)]));
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function isFailureClass(value: unknown): value is ToolFailureClass {
  return typeof value === 'string' && Object.hasOwn(RETRY_BUDGET, value);
}
