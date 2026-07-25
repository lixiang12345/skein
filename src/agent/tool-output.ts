import stripAnsi from 'strip-ansi';
import type {ToolFailureReceipt} from '../types.js';
import type {ToolArtifactArchiveResult, ToolArtifactStore} from '../session/tool-artifacts.js';
import {
  estimateTokens,
  estimatedTokenCost,
  sliceEndByTokens,
  sliceStartByTokens,
} from '../utils/tokens.js';

const MIN_TOOL_OUTPUT_TOKENS = 1_024;
const MAX_TOOL_OUTPUT_TOKENS = 8_192;

export interface ToolOutputMetadata {
  originalChars: number;
  originalBytes: number;
  estimatedTokens: number;
  budgetTokens: number;
  truncated: boolean;
  redacted: boolean;
  sanitized: boolean;
  artifact?: {
    toolCallId: string;
    sha256: string;
    bytes: number;
    createdAt: string;
    expiresAt: string;
  };
  artifactUnavailable?: 'too_large' | 'total_limit' | 'conflict' | 'storage_error';
}

export interface ProtectToolOutputOptions {
  content: string;
  sessionId: string;
  toolCallId: string;
  tool: string;
  ok: boolean;
  budgetTokens: number;
  metadata: Record<string, unknown>;
  artifacts: ToolArtifactStore;
}

export interface ProtectedToolOutput {
  content: string;
  metadata: ToolOutputMetadata;
}

/**
 * Keeps model-visible tool output inside the current context budget while
 * retaining oversized, redacted output in a session-bound local artifact.
 */
export async function protectToolOutput(options: ProtectToolOutputOptions): Promise<ProtectedToolOutput> {
  const safe = sanitizeToolOutput(options.content);
  const sanitized = redactToolOutput(safe.text);
  const estimatedTokens = estimateToolOutputTokens(sanitized.text);
  const budgetTokens = clamp(options.budgetTokens, MIN_TOOL_OUTPUT_TOKENS, MAX_TOOL_OUTPUT_TOKENS);
  const base: ToolOutputMetadata = {
    originalChars: options.content.length,
    originalBytes: Buffer.byteLength(options.content),
    estimatedTokens,
    budgetTokens,
    truncated: estimatedTokens > budgetTokens,
    redacted: sanitized.redacted,
    sanitized: safe.sanitized,
  };
  if (estimatedTokens <= budgetTokens) return {content: sanitized.text, metadata: base};

  let archived: ToolArtifactArchiveResult;
  try {
    archived = await options.artifacts.archive(
      options.sessionId,
      options.toolCallId,
      sanitized.text,
      {redacted: sanitized.redacted},
    );
  } catch {
    archived = {stored: false, reason: 'storage_error'};
  }
  const artifact = archived.stored ? archived.artifact : undefined;
  const artifactUnavailable = archived.stored ? undefined : archived.reason;
  const metadata: ToolOutputMetadata = {
    ...base,
    ...(artifact ? {
      artifact: {
        toolCallId: artifact.toolCallId,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
        createdAt: artifact.createdAt,
        expiresAt: artifact.expiresAt,
      },
    } : artifactUnavailable ? {artifactUnavailable} : {}),
  };
  const receipt = formatReceipt(options, metadata, '');
  const previewBudget = Math.max(0, budgetTokens - estimateToolOutputTokens(receipt));
  const preview = boundedPreview(sanitized.text, previewBudget);
  return {
    content: formatReceipt(options, metadata, preview),
    metadata,
  };
}

export function dynamicToolOutputBudget(
  contextWindowTokens: number,
  activeContextTokens: number,
  remainingSessionTokens: number,
): number {
  const contextHeadroom = Math.max(0, contextWindowTokens - activeContextTokens);
  const sessionHeadroom = Math.max(0, remainingSessionTokens);
  const budget = Math.min(
    Math.floor(contextHeadroom * 0.35),
    Math.floor(sessionHeadroom * 0.12),
  );
  return clamp(budget, MIN_TOOL_OUTPUT_TOKENS, MAX_TOOL_OUTPUT_TOKENS);
}

export function estimateToolOutputTokens(value: string): number {
  return Math.max(1, estimateTokens(value));
}

function formatReceipt(
  options: ProtectToolOutputOptions,
  metadata: ToolOutputMetadata,
  preview: string,
): string {
  const lines = [
    '[Oversized tool output bounded for the model transcript]',
    `tool: ${boundedInlineByTokens(options.tool, 64)}`,
    `tool-call-id: ${boundedInlineByTokens(options.toolCallId, 96)}`,
    `status: ${options.ok ? 'success' : 'failure'}`,
    `original-output: ${metadata.originalChars} chars, ${metadata.originalBytes} bytes, ~${metadata.estimatedTokens} tokens`,
    `model-budget: ${metadata.budgetTokens} tokens (head + tail preview)`,
    ...(metadata.redacted ? ['sensitive-values: redacted before display and retention'] : []),
    ...preservedSignals(options.metadata),
    ...(metadata.artifact ? [
      `artifact: session-scoped; sha256 ${metadata.artifact.sha256}; ${metadata.artifact.bytes} bytes`,
      `read-back: read_tool_artifact({"sha256":"${metadata.artifact.sha256}","start_line":1,"max_lines":200}) before ${metadata.artifact.expiresAt}`,
    ] : [`artifact: unavailable (${metadata.artifactUnavailable ?? 'unknown'}); rerun the tool with a narrower result if more detail is needed`]),
    'preview:',
    preview,
  ];
  return lines.join('\n');
}

function preservedSignals(metadata: Record<string, unknown>): string[] {
  const lines: string[] = [];
  if (typeof metadata.exitCode === 'number') lines.push(`exit-code: ${metadata.exitCode}`);
  if (metadata.timedOut === true) lines.push('timed-out: true');
  if (metadata.sourceTruncated === true) {
    lines.push('source-truncated: true; the producing tool reached its capture limit before this firewall');
  }
  const changedFiles = metadata.changedFiles;
  if (Array.isArray(changedFiles)) {
    const allPaths = changedFiles.filter((path): path is string => typeof path === 'string');
    const paths = allPaths.slice(0, 3).map((path) => boundedInlineByTokens(path, 24));
    if (paths.length) {
      lines.push(`changed-files: ${paths.join(', ')}${allPaths.length > paths.length ? ` (+${allPaths.length - paths.length} more in metadata)` : ''}`);
    }
  }
  const failure = metadata.failure;
  if (isFailureReceipt(failure)) {
    lines.push(`failure-class: ${failure.class}; attempt ${failure.attempt}; ${failure.remaining} retries remain`);
  }
  return lines;
}

function isFailureReceipt(value: unknown): value is ToolFailureReceipt {
  return typeof value === 'object' && value !== null &&
    typeof (value as ToolFailureReceipt).class === 'string' &&
    typeof (value as ToolFailureReceipt).attempt === 'number' &&
    typeof (value as ToolFailureReceipt).remaining === 'number';
}

function redactToolOutput(value: string): {text: string; redacted: boolean} {
  let redacted = false;
  const replace = (expression: RegExp, replacement: string): void => {
    expression.lastIndex = 0;
    if (!expression.test(value)) return;
    redacted = true;
    expression.lastIndex = 0;
    value = value.replace(expression, replacement);
  };
  replace(/\b(sk-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,})\b/gu, '[redacted-secret]');
  replace(/\b(authorization\s*:\s*(?:bearer\s+|basic\s+)?)\S+/giu, '$1[redacted]');
  replace(/\b((?:api[_-]?key|access[_-]?token|authorization|cookie|password|client[_-]?secret)\s*[:=]\s*)(?:"[A-Za-z0-9+/_=-]{8,}"|'[A-Za-z0-9+/_=-]{8,}'|[A-Za-z0-9+/_=-]{8,})/giu, '$1[redacted]');
  replace(/(--(?:api[_-]?key|access[_-]?token|password|client[_-]?secret)(?:=|\s+))[A-Za-z0-9+/_=-]{8,}/giu, '$1[redacted]');
  return {text: value, redacted};
}

function sanitizeToolOutput(value: string): {text: string; sanitized: boolean} {
  const text = stripAnsi(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '');
  return {text, sanitized: text !== value};
}

function boundedPreview(value: string, budget: number): string {
  if (budget <= 0) return '';
  if (estimateToolOutputTokens(value) <= budget) return value;
  let low = 0;
  let high = budget;
  let best = '';
  while (low <= high) {
    const contentBudget = Math.floor((low + high) / 2);
    const headBudget = Math.ceil(contentBudget * 0.6);
    const tailBudget = Math.max(0, contentBudget - headBudget);
    const head = sliceStartByTokens(value, headBudget);
    const tail = sliceEndByTokens(value, tailBudget);
    const preview = `${head}\n… ${Math.max(0, value.length - head.length - tail.length)} chars omitted …\n${tail}`;
    if (estimateToolOutputTokens(preview) <= budget) {
      best = preview;
      low = contentBudget + 1;
    } else {
      high = contentBudget - 1;
    }
  }
  return best || sliceStartByTokens(value, budget);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function boundedInlineByTokens(value: string, maxTokens: number): string {
  const normalized = value.replace(/[\r\n\t]+/gu, ' ').trim();
  if (estimateToolOutputTokens(normalized) <= maxTokens) return normalized;
  const suffix = '…';
  return `${sliceStartByTokens(normalized, Math.max(0, maxTokens - estimatedTokenCost(suffix)))}${suffix}`;
}
