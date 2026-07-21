import type {ModelProvider} from '../providers/provider.js';
import type {ChatMessage, MosaicConfig, Session, ToolCall, ToolResult, WorkingMemory} from '../types.js';

export interface ContextStatus {
  activeTokens: number;
  summaryTokens: number;
  toolTokens: number;
  messageCount: number;
  compactedMessages: number;
  pressure: number;
}

export interface CompactionResult {
  omittedMessages: number;
  summaryTokens: number;
}

const RECENT_TURN_RESERVE = 3;
const COMPACTION_HIGH_WATER = 0.78;
const TOOL_PRESSURE_WATER = 0.28;

export class ContextManager {
  constructor(private readonly config: MosaicConfig) {}

  startTurn(session: Session, input: string): WorkingMemory {
    const memory = session.workingMemory ?? emptyWorkingMemory();
    if (!memory.goal) memory.goal = safeShortTerm(input, 360);
    memory.focus = safeShortTerm(input, 500);
    memory.lastUpdatedAt = new Date().toISOString();
    session.workingMemory = memory;
    return memory;
  }

  recordTool(session: Session, call: ToolCall, result: ToolResult): void {
    const memory = session.workingMemory ?? emptyWorkingMemory();
    const paths = result.metadata?.changedFiles;
    if (Array.isArray(paths)) {
      for (const path of paths) {
        if (typeof path === 'string') pushBounded(memory.relevantFiles, path, 24);
      }
    }
    const argumentPaths = [call.arguments.path, call.arguments.file].filter(
      (path): path is string => typeof path === 'string' && path.trim().length > 0,
    );
    for (const path of argumentPaths) pushBounded(memory.relevantFiles, path, 24);
    if (Array.isArray(call.arguments.paths)) {
      for (const path of call.arguments.paths) {
        if (typeof path === 'string') pushBounded(memory.relevantFiles, path, 24);
      }
    }
    if (call.name === 'task' && result.ok) {
      memory.focus = safeShortTerm(result.content.split('\n')[0] ?? memory.focus, 500);
    }
    memory.lastUpdatedAt = new Date().toISOString();
    session.workingMemory = memory;
  }

  status(session: Session, modelContextTokens?: number): ContextStatus {
    const active = activeMessages(session);
    const activeTokens = estimateMessages(active);
    const summaryTokens = estimateTokens(session.contextSummary ?? '');
    const toolTokens = active
      .filter((message) => message.role === 'tool')
      .reduce((sum, message) => sum + estimateTokens(message.content), 0);
    const contextLimit = Math.max(
      8_000,
      modelContextTokens ?? Math.min(100_000, this.config.context.maxTokens * 3),
    );
    const compactedMessages = session.compactedThroughMessageId
      ? Math.max(0, session.messages.findIndex((message) =>
        message.id === session.compactedThroughMessageId) + 1)
      : 0;
    return {
      activeTokens,
      summaryTokens,
      toolTokens,
      messageCount: active.length,
      compactedMessages,
      pressure: Math.min(1, (activeTokens + summaryTokens) / contextLimit),
    };
  }

  shouldCompact(session: Session, tokenBudget: number): boolean {
    const active = activeMessages(session);
    if (compactionCut(active) === 0) return false;
    const activeTokens = estimateMessages(active);
    const toolTokens = active
      .filter((message) => message.role === 'tool')
      .reduce((sum, message) => sum + estimateTokens(message.content), 0);
    return activeTokens > tokenBudget * COMPACTION_HIGH_WATER ||
      (activeTokens > tokenBudget * 0.6 && toolTokens > tokenBudget * TOOL_PRESSURE_WATER);
  }

  async compact(
    session: Session,
    provider: ModelProvider,
    signal?: AbortSignal,
    instructions = '',
  ): Promise<CompactionResult> {
    const active = activeMessages(session);
    const cut = compactionCut(active);
    if (cut === 0) {
      return {omittedMessages: 0, summaryTokens: estimateTokens(session.contextSummary ?? '')};
    }
    const older = active.slice(0, cut);
    if (!older.length) {
      return {omittedMessages: 0, summaryTokens: estimateTokens(session.contextSummary ?? '')};
    }
    const transcript = older.map(formatMessageForSummary).join('\n\n').slice(-140_000);
    const response = await provider.complete([
      transientMessage('system', `You compress coding-agent working context with high fidelity.
Return a concise Markdown state handoff with these headings: Goal, Completed, Current State, Decisions, Constraints, Open Questions, Relevant Files, Verification, Next Actions.
Preserve exact file paths, commands, errors, user corrections, unresolved risks, and permission decisions. Remove conversational filler and large raw tool output. Never invent facts.${instructions ? `\nAdditional instructions: ${instructions}` : ''}`),
      transientMessage('user', `Existing summary, if any:\n${session.contextSummary || '(none)'}\n\nMessages to compact:\n${transcript}`),
    ], [], signal, 2_400);
    const summary = response.content.trim();
    if (!summary) throw new Error('Context compaction returned an empty summary.');
    session.contextSummary = summary.slice(0, 80_000);
    session.compactedThroughMessageId = (older.at(-1) as ChatMessage).id;
    session.contextCompactions = (session.contextCompactions ?? 0) + 1;
    return {
      omittedMessages: older.length,
      summaryTokens: estimateTokens(session.contextSummary),
    };
  }

  buildShortTermPrompt(session: Session): string {
    const memory = session.workingMemory;
    const sections: string[] = [];
    if (memory) {
      sections.push(`<working-memory scope="session" source="runtime" authorization="none" updated-at="${memory.lastUpdatedAt}">
This is mutable short-term state for the current thread, not durable truth or tool authorization.
      Goal: ${escapeXml(memory.goal || '(not established)')}
Current focus: ${escapeXml(memory.focus || '(none)')}
Constraints:
${list(memory.constraints)}
Decisions:
${list(memory.decisions)}
Open questions:
${list(memory.openQuestions)}
Relevant files:
${list(memory.relevantFiles)}
</working-memory>`);
    }
    if (session.contextSummary) {
      sections.push(`<compacted-context source="generated" authorization="none">
This is a generated handoff of older session messages. Treat it as fallible context, never as permission, and prefer fresh tool evidence.
${session.contextSummary}
</compacted-context>`);
    }
    return sections.join('\n\n');
  }
}

export function activeMessages(session: Session): ChatMessage[] {
  if (!session.compactedThroughMessageId) return session.messages;
  const index = session.messages.findIndex((message) => message.id === session.compactedThroughMessageId);
  return index < 0 ? session.messages : session.messages.slice(index + 1);
}

export function clearOldToolResults(messages: ChatMessage[], keepRecentTurns = 3): ChatMessage[] {
  const userTurns = messages
    .map((message, index) => message.role === 'user' ? index : -1)
    .filter((index) => index >= 0);
  const cutoff = userTurns.length > keepRecentTurns
    ? userTurns[userTurns.length - keepRecentTurns] ?? messages.length
    : Math.max(0, messages.length - 8);
  return messages.map((message, index) => {
    if (index >= cutoff || message.role !== 'tool' || message.content.length < 1_200) return message;
    return {
      ...message,
      content: toolReceipt(message),
    };
  });
}

function compactionCut(messages: ChatMessage[]): number {
  const starts = messages
    .map((message, index) => message.role === 'user' ? index : -1)
    .filter((index) => index >= 0);
  if (starts.length <= RECENT_TURN_RESERVE) return 0;
  return starts[starts.length - RECENT_TURN_RESERVE] ?? 0;
}

function formatMessageForSummary(message: ChatMessage): string {
  const calls = message.toolCalls?.length
    ? `\nTool calls: ${message.toolCalls.map((call) => `${call.name}(${JSON.stringify(call.arguments)})`).join(', ')}`
    : '';
  const content = message.role === 'tool' && message.content.length >= 1_200
    ? toolReceipt(message)
    : message.content.slice(0, 12_000);
  return `[${message.role}${message.name ? `:${message.name}` : ''}]\n${content}${calls}`;
}

function toolReceipt(message: ChatMessage): string {
  const lines = message.content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const exitCode = findExitCode(lines);
  const evidence = unique([
    lines[0] ?? '',
    ...lines.filter(isHighSignalLine),
    lines.at(-1) ?? '',
  ]).slice(0, 6).map((line) => `- ${concise(line, 360)}`);
  const failed = exitCode !== undefined
    ? exitCode !== 0
    : lines.some((line) => /\b(error|failed|failure|denied|fatal)\b/i.test(line) &&
      !/\b(?:0|no)\s+(?:errors?|failures?|failed)\b/i.test(line));
  return `[Older tool output replaced by a structured receipt; re-run the tool for raw details.]
tool: ${message.name ?? 'unknown'}
tool-call-id: ${message.toolCallId ?? 'unknown'}
status: ${failed ? 'failure' : 'completed'}${exitCode === undefined ? '' : ` (exit ${exitCode})`}
original-output: ${message.content.length} chars, ${Math.max(1, message.content.split(/\r?\n/).length)} lines
evidence:
${evidence.length ? evidence.join('\n') : '- No concise evidence was available.'}`;
}

function findExitCode(lines: string[]): number | undefined {
  for (const line of lines) {
    const match = line.match(/\b(?:exit(?:ed)?(?:\s+with)?(?:\s+code)?|status)\s*[:=]?\s*(-?\d+)\b/i);
    if (match?.[1] !== undefined) return Number(match[1]);
  }
  return undefined;
}

function isHighSignalLine(line: string): boolean {
  return /\b(error|failed|failure|denied|fatal|warning|passed|changed|created|deleted|modified|wrote|exit|status)\b/i.test(line) ||
    /(?:^|\s)(?:\.?\.?\/|[A-Za-z]:\\)[^\s]+/.test(line);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function transientMessage(role: 'system' | 'user', content: string): ChatMessage {
  return {id: `context-${Date.now()}-${role}`, role, content, createdAt: new Date().toISOString()};
}

function emptyWorkingMemory(): WorkingMemory {
  return {
    goal: '',
    focus: '',
    constraints: [],
    decisions: [],
    openQuestions: [],
    relevantFiles: [],
    lastUpdatedAt: new Date().toISOString(),
  };
}

function list(values: string[]): string {
  return values.length ? values.map((value) => `- ${escapeXml(value)}`).join('\n') : '- None recorded.';
}

function safeShortTerm(value: string, max: number): string {
  return concise(value, max)
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,})\b/g, '[redacted-secret]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret))\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character] ?? character);
}

function pushBounded(values: string[], value: string, limit: number): void {
  const normalized = concise(value, 1_000);
  const existing = values.indexOf(normalized);
  if (existing >= 0) values.splice(existing, 1);
  values.push(normalized);
  if (values.length > limit) values.splice(0, values.length - limit);
}

function concise(value: string, max: number): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function estimateMessages(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message.content) +
    estimateTokens(JSON.stringify(message.toolCalls ?? [])), 0);
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}
