import type {AgentEvent} from '../types.js';
import type {TimelineItem} from './components.js';
import {sanitizeTerminalText} from './text.js';

let itemCounter = 0;

/** Stable, monotonic id for synthetic timeline items the UI creates itself. */
export const nextId = (): string => `ui-${Date.now()}-${itemCounter++}`;

/** First non-empty line of a tool result, trimmed for a one-line detail. */
export function firstLine(value: string): string {
  return sanitizeTerminalText(value).split('\n').find((line) => line.trim())?.trim().slice(0, 180) ?? 'No details';
}

/**
 * One-line receipt of the durable side effects the runner attached to a tool
 * result — captured checkpoint, changed files, and hook counts — so the user
 * can see what actually happened to the workspace without expanding output.
 */
export function toolMetaSummary(metadata?: Record<string, unknown>): string | undefined {
  if (!metadata) return undefined;
  const parts: string[] = [];
  const changed = metadata.changedFiles;
  if (Array.isArray(changed) && changed.length) {
    parts.push(`${changed.length} file${changed.length === 1 ? '' : 's'} changed`);
  }
  if (typeof metadata.checkpointId === 'string' && metadata.checkpointId) {
    parts.push(`checkpoint ${metadata.checkpointId.slice(0, 12)}`);
  }
  const hooks = metadata.hooks;
  if (hooks && typeof hooks === 'object') {
    const before = Number((hooks as {before?: unknown}).before ?? 0);
    const after = Number((hooks as {after?: unknown}).after ?? 0);
    if (before || after) parts.push(`hooks ${before}/${after}`);
  }
  if (metadata.hookError && typeof metadata.hookError === 'string') {
    parts.push(`hook failed: ${sanitizeTerminalText(metadata.hookError).slice(0, 80)}`);
  }
  return parts.length ? parts.join(' · ') : undefined;
}

export function updateTool(
  items: TimelineItem[],
  result: {toolCallId: string; name: string; ok: boolean; content: string; metadata?: Record<string, unknown>},
): TimelineItem[] {
  const output = sanitizeTerminalText(result.content).slice(0, 100_000);
  const meta = toolMetaSummary(result.metadata);
  const found = items.some((item) => item.kind === 'tool' && item.id === result.toolCallId);
  if (!found) {
    return [...items, {
      id: result.toolCallId,
      kind: 'tool' as const,
      name: result.name,
      detail: result.ok ? '' : firstLine(result.content),
      state: result.ok ? 'ok' as const : 'error' as const,
      output,
      ...(meta ? {meta} : {}),
      ...(result.ok ? {} : {errorDetail: firstLine(result.content)}),
    }].slice(-100);
  }
  return items.map((item) => {
    if (item.kind !== 'tool' || item.id !== result.toolCallId) return item;
    return {
      ...item,
      state: result.ok ? 'ok' as const : 'error' as const,
      output,
      ...(meta ? {meta} : {}),
      ...(item.startedAt ? {durationMs: Date.now() - item.startedAt} : {}),
      ...(result.ok ? {} : {errorDetail: firstLine(result.content)}),
    };
  });
}

export function updateAssistantDelta(items: TimelineItem[], id: string, content: string): TimelineItem[] {
  const found = items.some((item) => item.kind === 'assistant' && item.id === id);
  if (!found) {
    return [...items, {id, kind: 'assistant' as const, text: content, streaming: true}].slice(-500);
  }
  return items.map((item) => item.kind === 'assistant' && item.id === id
    ? {...item, text: `${item.text}${content}`, streaming: true}
    : item);
}

export function finalizeAssistant(items: TimelineItem[], id: string | undefined, content: string): TimelineItem[] {
  if (!id) return [...items, {id: nextId(), kind: 'assistant' as const, text: content}].slice(-500);
  const found = items.some((item) => item.kind === 'assistant' && item.id === id);
  if (!found) return [...items, {id, kind: 'assistant' as const, text: content}].slice(-500);
  return items.map((item) => item.kind === 'assistant' && item.id === id
    ? {...item, text: content, streaming: false}
    : item);
}

export function endStreamingAssistants(items: TimelineItem[]): TimelineItem[] {
  return items.map((item) => item.kind === 'assistant' && item.streaming
    ? {...item, streaming: false}
    : item);
}

export function updateAgent(items: TimelineItem[], event: Extract<AgentEvent, {type: 'agent_done'}>): TimelineItem[] {
  const found = items.some((item) => item.kind === 'agent' && item.id === event.id);
  if (!found) {
    return [...items, {
      id: event.id,
      kind: 'agent' as const,
      profile: event.profile,
      task: 'delegated task',
      summary: event.summary,
      state: event.ok ? 'ok' as const : 'error' as const,
      ...(event.provider ? {provider: event.provider} : {}),
      ...(event.model ? {model: event.model} : {}),
      ...(event.phase ? {phase: event.phase} : {}),
      ...(event.durationMs !== undefined ? {durationMs: event.durationMs} : {}),
      ...(event.toolCalls !== undefined ? {toolCalls: event.toolCalls} : {}),
      ...(event.usage ? {inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens} : {}),
    }].slice(-100);
  }
  return items.map((item) => item.kind === 'agent' && item.id === event.id
    ? {
      ...item,
      state: event.ok ? 'ok' as const : 'error' as const,
      summary: event.summary,
      stage: 'response' as const,
      activityDetail: event.ok ? 'final report ready' : 'worker failed',
      ...(event.durationMs !== undefined ? {durationMs: event.durationMs} : item.startedAt ? {durationMs: Date.now() - item.startedAt} : {}),
      ...(event.toolCalls !== undefined ? {toolCalls: event.toolCalls} : {}),
      ...(event.usage ? {inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens} : {}),
    }
    : item);
}

export function updateAgentTelemetry(items: TimelineItem[], event: Extract<AgentEvent, {type: 'agent_update'}>): TimelineItem[] {
  return items.map((item) => {
    if (item.kind !== 'agent' || item.id !== event.id) return item;
    const {activeTool: previousTool, ...withoutTool} = item;
    const newAlert = event.detail && /(?:soft .*threshold|soft budget exceeded)/iu.test(event.detail)
      ? event.detail
      : undefined;
    const alerts = newAlert
      ? [...new Set([...(item.alerts ?? []), newAlert])].slice(-3)
      : item.alerts;
    return {
      ...(event.stage === 'tool' && event.tool === undefined ? item : withoutTool),
      stage: event.stage,
      ...(event.detail !== undefined ? {activityDetail: event.detail} : {}),
      ...(event.tool !== undefined ? {activeTool: event.tool} : event.stage === 'tool' && previousTool ? {activeTool: previousTool} : {}),
      ...(event.toolCalls !== undefined ? {toolCalls: event.toolCalls} : {}),
      ...(event.inputTokens !== undefined ? {inputTokens: event.inputTokens} : {}),
      ...(event.outputTokens !== undefined ? {outputTokens: event.outputTokens} : {}),
      ...(alerts?.length ? {alerts} : {}),
    };
  });
}
