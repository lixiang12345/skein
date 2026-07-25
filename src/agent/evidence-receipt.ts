import {createHash} from 'node:crypto';
import type {DeterministicEvidenceReceipt} from '../types.js';
import {canonicalJson} from '../utils/canonical-json.js';

const hashPattern = /^[a-f0-9]{64}$/u;

export function createDeterministicEvidenceReceipt(input: {
  toolCallId: string;
  tool: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  content: string;
  changedFiles?: string[];
}): DeterministicEvidenceReceipt {
  const inputSha256 = sha256(canonicalJson(input.arguments));
  const outputSha256 = sha256(input.content);
  const changedFiles = input.changedFiles?.length
    ? [...new Set(input.changedFiles)].sort()
    : undefined;
  const changedFilesSha256 = changedFiles
    ? sha256(canonicalJson(changedFiles))
    : undefined;
  const body = {
    version: 1 as const,
    toolCallId: input.toolCallId,
    tool: input.tool,
    outcome: input.ok ? 'success' as const : 'failure' as const,
    inputSha256,
    outputSha256,
    ...(changedFilesSha256 ? {changedFilesSha256} : {}),
  };
  const receiptSha256 = sha256(canonicalJson(body));
  return {...body, id: `evidence:${receiptSha256}`, sha256: receiptSha256};
}

export function deterministicEvidenceReceiptValid(
  value: unknown,
  binding?: {toolCallId?: string; tool?: string; outcome?: DeterministicEvidenceReceipt['outcome']},
): value is DeterministicEvidenceReceipt {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Record<string, unknown>;
  if (receipt.version !== 1 || typeof receipt.id !== 'string' || typeof receipt.sha256 !== 'string' ||
    typeof receipt.toolCallId !== 'string' || typeof receipt.tool !== 'string' ||
    (receipt.outcome !== 'success' && receipt.outcome !== 'failure') ||
    typeof receipt.inputSha256 !== 'string' || typeof receipt.outputSha256 !== 'string') return false;
  if (!hashPattern.test(receipt.sha256) || !hashPattern.test(receipt.inputSha256) ||
    !hashPattern.test(receipt.outputSha256) ||
    (receipt.changedFilesSha256 !== undefined &&
      (typeof receipt.changedFilesSha256 !== 'string' || !hashPattern.test(receipt.changedFilesSha256)))) return false;
  if (binding?.toolCallId !== undefined && receipt.toolCallId !== binding.toolCallId) return false;
  if (binding?.tool !== undefined && receipt.tool !== binding.tool) return false;
  if (binding?.outcome !== undefined && receipt.outcome !== binding.outcome) return false;
  const body = {
    version: 1,
    toolCallId: receipt.toolCallId,
    tool: receipt.tool,
    outcome: receipt.outcome,
    inputSha256: receipt.inputSha256,
    outputSha256: receipt.outputSha256,
    ...(receipt.changedFilesSha256 ? {changedFilesSha256: receipt.changedFilesSha256} : {}),
  };
  const receiptSha256 = sha256(canonicalJson(body));
  return receipt.sha256 === receiptSha256 && receipt.id === `evidence:${receiptSha256}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
