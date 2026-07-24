import React from 'react';
import {Box, Text} from 'ink';
import {basename} from 'node:path';
import type {AgentPhase, ContextDegradation, ContextSource, MosaicConfig, SessionTask, ToolCall, ToolCategory, WorkingMemory} from '../types.js';
import {PRODUCT_MARK, PRODUCT_NAME} from '../brand.js';
import {commandForCall} from '../tools/permissions.js';
import {commandSuggestions, type CommandSuggestion} from './commands.js';
import {
  compactDisplayPath,
  displayWidth,
  limitTerminalText,
  padDisplay,
  sanitizeTerminalText,
  truncateDisplay,
} from './text.js';
import {formatPercent, formatTokens, useTheme} from './theme.js';

export type TimelineItem =
  | {id: string; kind: 'user'; text: string; clipped?: boolean}
  | {id: string; kind: 'assistant'; text: string; streaming?: boolean; clipped?: boolean}
  | {id: string; kind: 'context'; engine: string; hits: number; tokens: number; degradation?: ContextDegradation; truncated?: boolean; spans?: ContextSpan[]}
  | {id: string; kind: 'prompt'; intent: string; sections: string[]; tokens: number}
  | {id: string; kind: 'tool'; name: string; detail: string; state: 'running' | 'ok' | 'error'; startedAt?: number; durationMs?: number; errorDetail?: string; output?: string; meta?: string}
  | {id: string; kind: 'skill'; name: string; description: string}
  | {id: string; kind: 'memory'; count: number; scope: string}
  | {id: string; kind: 'agent'; profile: string; task: string; provider?: string; model?: string; phase?: AgentPhase; stage?: 'context' | 'thinking' | 'tool' | 'response' | 'review'; activityDetail?: string; activeTool?: string; toolCalls?: number; inputTokens?: number; outputTokens?: number; summary?: string; alerts?: string[]; retryOf?: string; superseded?: boolean; state: 'queued' | 'running' | 'ok' | 'error' | 'cancelled'; cancelReason?: string; startedAt?: number; durationMs?: number}
  | {id: string; kind: 'agent-message'; from: string; to: string; text: string}
  | {id: string; kind: 'workflow'; name: string; step: string; status: SessionTask['status']}
  | {id: string; kind: 'compaction'; messages: number; tokens: number}
  | {id: string; kind: 'list'; title: string; entries: ListEntry[]}
  | {id: string; kind: 'context-inspector'; status: ContextInspectorStatus; working?: WorkingMemory; summary?: string; sources?: ContextSource[]}
  | {id: string; kind: 'theme'; name: string}
  | {id: string; kind: 'banner'; model: string; engine: string; workspace: string; version: string}
  | {id: string; kind: 'notice'; text: string; tone?: 'info' | 'error' | 'success'}
  | {id: string; kind: 'update'; current: string; latest: string; command: string; highlights?: string[]};

export interface ListEntry {
  label: string;
  detail?: string;
  tone?: 'normal' | 'success' | 'warning' | 'error';
}

export interface ContextSpan {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  symbol?: string;
}

export interface ContextInspectorStatus {
  pressure: number;
  messageCount: number;
  activeTokens: number;
  summaryTokens: number;
  toolTokens: number;
  compactedMessages: number;
}

export interface ActivityState {
  label: string;
  startedAt: number;
  turn?: number;
}

export type GlyphMode = 'auto' | 'unicode' | 'ascii';

interface UiGlyphs {
  brand: string;
  activity: string;
  prompt: string;
  running: string;
  success: string;
  error: string;
  context: string;
  skill: string;
  memory: string;
  agent: string;
  compaction: string;
  pending: string;
  notice: string;
  info: string;
  warning: string;
  bullet: string;
  up: string;
  down: string;
  swatch: string;
  meterFull: string;
  meterEmpty: string;
  separator: string;
  arrow: string;
  collapsed: string;
  expanded: string;
  branch: string;
  branchLast: string;
  borderStyle: 'round' | 'classic';
}

const unicodeGlyphs: UiGlyphs = {
  brand: PRODUCT_MARK,
  activity: '●',
  prompt: '›',
  running: '◌',
  success: '✓',
  error: '×',
  context: '◇',
  skill: '+',
  memory: '#',
  agent: '@',
  compaction: '~',
  pending: '·',
  notice: '·',
  info: 'i',
  warning: '!',
  bullet: '·',
  up: '↑',
  down: '↓',
  swatch: '●',
  meterFull: '█',
  meterEmpty: '░',
  separator: '·',
  arrow: '→',
  collapsed: '›',
  expanded: '⌄',
  branch: '├─',
  branchLast: '└─',
  borderStyle: 'round',
};

const asciiGlyphs: UiGlyphs = {
  brand: '*',
  activity: 'o',
  prompt: '>',
  running: '~',
  success: '+',
  error: 'x',
  context: '@',
  skill: '+',
  memory: '#',
  agent: '@',
  compaction: '~',
  pending: '-',
  notice: '-',
  info: 'i',
  warning: '!',
  bullet: '-',
  up: 'up',
  down: 'dn',
  swatch: '*',
  meterFull: '#',
  meterEmpty: '.',
  separator: '|',
  arrow: '->',
  collapsed: '>',
  expanded: 'v',
  branch: '|-',
  branchLast: '\\-',
  borderStyle: 'classic',
};

export function resolveGlyphs(mode: GlyphMode = 'auto'): UiGlyphs {
  const configured = process.env.SKEIN_GLYPHS ?? process.env.MOSAIC_GLYPHS;
  // Capability detection is unreliable through multiplexers, so auto stays on
  // the standard Unicode set and offers an explicit, deterministic fallback.
  const forceAscii = configured === 'ascii';
  return mode === 'ascii' || (mode === 'auto' && forceAscii) ? asciiGlyphs : unicodeGlyphs;
}

export function Header({config, askMode, planMode = false, width = 80, glyphMode = 'auto'}: {
  config: MosaicConfig;
  askMode: boolean;
  planMode?: boolean;
  width?: number;
  glyphMode?: GlyphMode;
}) {
  const theme = useTheme();
  const glyphs = resolveGlyphs(glyphMode);
  const root = config.workspaceRoots[0] ?? process.cwd();
  const terminalWidth = safeWidth(width);
  const mode = planMode ? 'PLAN' : askMode ? 'ASK' : 'BUILD';
  // Each mode gets a semantic hue: BUILD is "go" (mutations live), PLAN is the
  // amber "thinking" state, ASK is a calm read-only muted tone.
  const modeColor = planMode ? theme.warning : askMode ? theme.muted : theme.accent;
  const brand = `${glyphs.brand} ${PRODUCT_NAME.toUpperCase()}`;
  const modeLabel = `${glyphs.activity} ${mode}`;
  const separator = ` ${glyphs.separator} `;
  const model = sanitizeInlineTerminalText(`${config.model.provider}/${config.model.model}`);
  const repository = sanitizeInlineTerminalText(basename(root) || root);
  const minimum = `${brand} ${modeLabel}`;
  const withRepository = `${brand}${separator}${repository}${separator}${modeLabel}`;
  const showRepository = terminalWidth >= 32 && displayWidth(withRepository) <= terminalWidth;
  const leftWidth = displayWidth(showRepository ? withRepository : minimum);
  const modelSpace = terminalWidth - leftWidth - 2;
  const showModel = terminalWidth >= 72 && modelSpace >= 12;

  return (
    <Box marginBottom={1}>
      <Text bold color={theme.accent}>{brand}</Text>
      {showRepository ? <>
        <Text color={theme.border}>{separator}</Text>
        <Text color={theme.muted}>{repository}</Text>
        <Text color={theme.border}>{separator}</Text>
      </> : <Text> </Text>}
      <Text bold color={modeColor}>{modeLabel}</Text>
      {showModel ? <><Box flexGrow={1} /><Text color={theme.dim}>{truncateDisplay(model, modelSpace)}</Text></> : null}
    </Box>
  );
}

function ToolGlyph({state, glyphs}: {state: 'queued' | 'running' | 'ok' | 'error' | 'cancelled'; glyphs: UiGlyphs}) {
  const theme = useTheme();
  if (state === 'queued') return <Text color={theme.muted}>{glyphs.pending}</Text>;
  if (state === 'running') return <Text color={theme.accent}>{glyphs.running}</Text>;
  if (state === 'ok') return <Text color={theme.success}>{glyphs.success}</Text>;
  if (state === 'cancelled') return <Text color={theme.warning}>{glyphs.warning}</Text>;
  return <Text color={theme.error}>{glyphs.error}</Text>;
}

export function Timeline({items, width = 80, glyphMode = 'auto', showToolOutput = false, expandedToolId, compact = false}: {
  items: TimelineItem[];
  width?: number;
  glyphMode?: GlyphMode;
  showToolOutput?: boolean;
  expandedToolId?: string;
  compact?: boolean;
}) {
  const theme = useTheme();
  const glyphs = resolveGlyphs(glyphMode);
  if (!items.length) {
    return (
      <Box paddingLeft={2} marginBottom={1}>
        <Text color={theme.muted}>Start with a request, @file, or /help.</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      {items.map((item, index) => {
        if (item.kind === 'user') {
          return (
            <Box key={item.id} marginBottom={compact || item.clipped ? 0 : 1}>
              <Box width={2}><Text bold color={theme.accent}>{glyphs.prompt}</Text></Box>
              <Text bold color={theme.textStrong} wrap="wrap">{sanitizeTerminalText(item.text)}</Text>
            </Box>
          );
        }
        if (item.kind === 'assistant') {
          return (
            <Box key={item.id} flexDirection="column" marginBottom={compact || item.clipped ? 0 : 1}>
              <Text bold color={theme.accent}>
                {glyphs.brand} {PRODUCT_NAME}{item.streaming ? <Text color={theme.muted}> {glyphs.separator} streaming</Text> : null}
              </Text>
              <Box paddingLeft={2} flexDirection="column">
                <RichText value={item.text} glyphs={glyphs} />
              </Box>
            </Box>
          );
        }
        if (item.kind === 'context') {
          const spans = item.spans ?? [];
          const spanLimit = compact ? 2 : 3;
          const innerWidth = Math.max(1, safeWidth(width) - 2);
          return (
            <Box key={item.id} flexDirection="column">
              <MetaRow
                width={width}
                glyph={glyphs.context}
                label="context"
                detail={`${sanitizeInlineTerminalText(item.engine)} ${glyphs.separator} ${item.hits} spans ${glyphs.separator} ~${formatTokens(item.tokens)}${item.truncated ? ` ${glyphs.separator} truncated` : ''}`}
                labelColor={theme.accent}
              />
              {spans.slice(0, spanLimit).map((span, spanIndex) => {
                const lines = span.startLine === span.endLine ? `${span.startLine}` : `${span.startLine}-${span.endLine}`;
                const location = `${compactDisplayPath(sanitizeInlineTerminalText(span.path), 44)}:${lines}`;
                const symbol = span.symbol ? ` ${glyphs.separator} ${sanitizeInlineTerminalText(span.symbol)}` : '';
                const marker = spanIndex === spans.length - 1 || spanIndex === spanLimit - 1 ? glyphs.branchLast : glyphs.branch;
                return (
                  <Text key={`${item.id}-span-${spanIndex}`} color={theme.dim}>
                    {truncateDisplay(`${marker} ${location}${symbol} ${glyphs.separator} ${span.score.toFixed(2)}`, innerWidth)}
                  </Text>
                );
              })}
              {spans.length > spanLimit ? (
                <Text color={theme.dim}>{truncateDisplay(`${glyphs.branchLast} +${spans.length - spanLimit} more spans`, innerWidth)}</Text>
              ) : null}
              {item.degradation ? (
                <MetaRow
                  width={width}
                  glyph={glyphs.warning}
                  label={contextDegradationLabel(item.degradation.code)}
                  detail={contextDegradationDetail(item.degradation)}
                  labelColor={theme.warning}
                />
              ) : null}
            </Box>
          );
        }
        if (item.kind === 'prompt') {
          return (
            <MetaRow
              key={item.id}
              width={width}
              glyph={glyphs.pending}
              label={`prompt/${sanitizeInlineTerminalText(item.intent)}`}
              detail={`${item.sections.map(sanitizeInlineTerminalText).join(` ${glyphs.separator} `)} ${glyphs.separator} ~${formatTokens(item.tokens)}`}
            />
          );
        }
        if (item.kind === 'tool') {
          const rowWidth = safeWidth(width);
          const detail = sanitizeInlineTerminalText(item.errorDetail || item.detail);
          const duration = item.durationMs !== undefined ? formatDuration(item.durationMs) : '';
          const detailText = [detail, duration].filter(Boolean).join('  ');
          const expanded = Boolean(item.output) && (showToolOutput || expandedToolId === item.id);
          const verbose = expanded && item.output
            ? limitTerminalText(item.output, compact ? 24 : 80)
            : undefined;
          const disclosure = item.output ? (expanded ? glyphs.expanded : glyphs.collapsed) : '';
          const disclosureWidth = disclosure ? displayWidth(disclosure) + 1 : 0;
          const nameLimit = Math.max(1, Math.min(rowWidth - 2 - disclosureWidth, rowWidth < 64 ? rowWidth - 2 - disclosureWidth : 28));
          const name = truncateDisplay(sanitizeInlineTerminalText(item.name), nameLimit);
          const output = verbose ? (
            <Box paddingLeft={2} flexDirection="column">
              <RichText value={verbose.text} glyphs={glyphs} />
              {verbose.truncated
                ? <Text color={theme.muted}>{glyphs.pending} output clipped; use print mode for the full result</Text>
                : null}
            </Box>
          ) : null;
          if (rowWidth < 64) {
            return (
              <Box key={item.id} flexDirection="column">
                <Box>
                  <ToolGlyph state={item.state} glyphs={glyphs} />
                  <Text color={theme.text}> {name}</Text>
                  {disclosure ? <Text color={theme.dim}> {disclosure}</Text> : null}
                </Box>
                {detailText ? <Text color={item.state === 'error' ? theme.error : theme.muted}>{`  ${truncateDisplay(detailText, Math.max(1, rowWidth - 2))}`}</Text> : null}
                {item.meta ? <Text color={theme.dim}>{`  ${glyphs.branchLast} ${truncateDisplay(sanitizeInlineTerminalText(item.meta), Math.max(1, rowWidth - 4))}`}</Text> : null}
                {output}
              </Box>
            );
          }
          const prefix = `${item.state === 'running' ? glyphs.running : item.state === 'ok' ? glyphs.success : glyphs.error} ${name}`;
          const suffix = duration ? `  ${duration}` : '';
          const detailLimit = Math.max(1, rowWidth - displayWidth(prefix) - displayWidth(suffix) - disclosureWidth - 2);
          return (
            <Box key={item.id} flexDirection="column">
              <Box>
                <ToolGlyph state={item.state} glyphs={glyphs} />
                <Text color={theme.text}> {name}</Text>
                {detail ? <Text color={item.state === 'error' ? theme.error : theme.muted}>  {truncateDisplay(detail, detailLimit)}</Text> : null}
                {suffix ? <Text color={theme.dim}>{suffix}</Text> : null}
                {disclosure ? <Text color={theme.dim}> {disclosure}</Text> : null}
              </Box>
              {item.meta ? <Text color={theme.dim}>{`  ${glyphs.branchLast} ${truncateDisplay(sanitizeInlineTerminalText(item.meta), Math.max(1, rowWidth - 4))}`}</Text> : null}
              {output}
            </Box>
          );
        }
        if (item.kind === 'skill') {
          return <MetaRow key={item.id} width={width} glyph={glyphs.skill} label={`skill/${item.name}`} detail={item.description} />;
        }
        if (item.kind === 'memory') {
          return <MetaRow key={item.id} width={width} glyph={glyphs.memory} label="memory" detail={`${item.count} relevant ${glyphs.separator} ${item.scope}`} />;
        }
        if (item.kind === 'agent') {
          const rowWidth = safeWidth(width);
          const agentTask = sanitizeInlineTerminalText(item.task);
          const agentSummary = item.summary ? sanitizeInlineTerminalText(item.summary) : undefined;
          const taskDetail = agentSummary ? `${agentTask} ${glyphs.arrow} ${agentSummary}` : agentTask;
          const task = truncateDisplay(taskDetail, Math.max(1, rowWidth - 4));
          const duration = item.durationMs !== undefined ? formatDuration(item.durationMs) : '';
          const branch = items[index + 1]?.kind === 'agent' ? glyphs.branch : glyphs.branchLast;
          const profileLimit = Math.max(1, Math.min(rowWidth - displayWidth(branch) - 3, rowWidth < 64 ? rowWidth - displayWidth(branch) - 3 : 24));
          const route = item.provider && item.model ? ` ${glyphs.separator} ${item.provider}/${item.model}` : '';
          const phase = item.phase && item.phase !== 'work' ? ` ${glyphs.separator} ${item.phase}` : '';
          const profile = truncateDisplay(`agent/${sanitizeInlineTerminalText(item.profile)}${phase}`, profileLimit);
          const routedTask = `${route}${route ? '  ' : ''}${task}`;
          if (rowWidth < 64) {
            return (
              <Box key={item.id} flexDirection="column">
                <Box><Text color={theme.dim}>{branch} </Text><ToolGlyph state={item.state} glyphs={glyphs} /><Text color={theme.text}> {profile}</Text></Box>
                <Text color={theme.dim}>{`    ${truncateDisplay([route.trim(), task, duration].filter(Boolean).join('  '), Math.max(1, rowWidth - 4))}`}</Text>
              </Box>
            );
          }
          return (
            <Box key={item.id}>
              <Text color={theme.dim}>{branch} </Text><ToolGlyph state={item.state} glyphs={glyphs} />
              <Text color={theme.text}> {profile}</Text>
              <Text color={theme.dim}>  {truncateDisplay(routedTask, Math.max(1, rowWidth - displayWidth(profile) - displayWidth(branch) - 5 - (duration ? displayWidth(duration) + 2 : 0)))}</Text>
              {duration ? <Text color={theme.dim}>  {duration}</Text> : null}
            </Box>
          );
        }
        if (item.kind === 'agent-message') {
          const from = sanitizeInlineTerminalText(item.from);
          const to = sanitizeInlineTerminalText(item.to);
          const text = sanitizeInlineTerminalText(item.text);
          return <MetaRow key={item.id} width={width} glyph={glyphs.agent} label={`${from} ${glyphs.arrow} ${to}`} detail={text} labelColor={theme.accent} />;
        }
        if (item.kind === 'workflow') {
          const color = item.status === 'completed' ? theme.success : item.status === 'in_progress' ? theme.accent : theme.muted;
          const glyph = item.status === 'completed' ? glyphs.success : item.status === 'in_progress' ? glyphs.prompt : glyphs.pending;
          return <MetaRow key={item.id} width={width} glyph={glyph} label={`workflow/${item.name}`} detail={item.step} labelColor={color} />;
        }
        if (item.kind === 'compaction') {
          return (
            <MetaRow
              key={item.id}
              width={width}
              glyph={glyphs.compaction}
              label="context compacted"
              detail={`${item.messages} messages ${glyphs.arrow} ${formatTokens(item.tokens)} tokens`}
            />
          );
        }
        if (item.kind === 'list') return <ListPanel key={item.id} title={item.title} entries={item.entries} width={width} glyphMode={glyphMode} />;
        if (item.kind === 'context-inspector') {
          return <ContextInspector key={item.id} status={item.status} working={item.working} summary={item.summary} width={width} compact={compact} glyphMode={glyphMode} />;
        }
        if (item.kind === 'theme') return <ThemePreview key={item.id} name={item.name} width={width} glyphs={glyphs} />;
        if (item.kind === 'banner') {
          return <Banner key={item.id} model={item.model} engine={item.engine} workspace={item.workspace} version={item.version} width={width} glyphs={glyphs} />;
        }
        if (item.kind === 'update') {
          return <UpdateNotice key={item.id} current={item.current} latest={item.latest} command={item.command} width={width} glyphs={glyphs} {...(item.highlights ? {highlights: item.highlights} : {})} />;
        }
        const color = item.tone === 'error'
          ? theme.error
          : item.tone === 'success'
            ? theme.success
            : theme.muted;
        const noticeGlyph = item.tone === 'error'
          ? glyphs.error
          : item.tone === 'success'
            ? glyphs.success
            : glyphs.info;
        return (
          <Box key={item.id}>
            <Text color={color} wrap="wrap">{`${noticeGlyph} ${sanitizeTerminalText(item.text)}`}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

export function TeamCockpit({items, width = 36, glyphMode = 'auto'}: {
  items: TimelineItem[];
  width?: number;
  glyphMode?: GlyphMode;
}) {
  const theme = useTheme();
  const glyphs = resolveGlyphs(glyphMode);
  const agents = items.filter((item): item is Extract<TimelineItem, {kind: 'agent'}> => item.kind === 'agent' && !item.superseded).slice(-3);
  const messages = items.filter((item): item is Extract<TimelineItem, {kind: 'agent-message'}> => item.kind === 'agent-message').slice(-2);
  const inner = Math.max(8, safeWidth(width) - 4);
  return (
    <Box flexDirection="column" width={width} borderStyle={glyphs.borderStyle} borderColor={theme.border} paddingX={1}>
      <Text bold color={theme.accent}>{truncateDisplay(`${glyphs.agent} TEAM COCKPIT`, inner)}</Text>
      {agents.map((agent) => {
        const status = agent.state === 'queued' ? glyphs.pending : agent.state === 'running' ? glyphs.running : agent.state === 'ok' ? glyphs.success : agent.state === 'cancelled' ? glyphs.warning : glyphs.error;
        const route = agent.provider && agent.model ? `${agent.provider}/${agent.model}` : 'inherited model';
        const activity = agent.state === 'cancelled' && agent.cancelReason
          ? agent.cancelReason
          : agent.activeTool
            ? `${agent.stage ?? 'tool'}: ${agent.activeTool}`
            : agent.activityDetail
              ? `${agent.stage ?? 'working'}: ${agent.activityDetail}`
              : agent.stage ?? 'queued';
        const telemetry = [
          agent.startedAt !== undefined || agent.durationMs !== undefined
            ? formatDuration(agent.durationMs ?? Math.max(0, Date.now() - (agent.startedAt ?? Date.now())))
            : '',
          agent.inputTokens !== undefined || agent.outputTokens !== undefined
            ? `${formatTokens((agent.inputTokens ?? 0) + (agent.outputTokens ?? 0))} tok`
            : '',
          agent.toolCalls !== undefined ? `${agent.toolCalls} tools` : '',
        ].filter(Boolean).join(` ${glyphs.separator} `);
        return (
          <Box key={agent.id} flexDirection="column">
            <Text color={agent.state === 'error' ? theme.error : agent.state === 'cancelled' ? theme.muted : agent.state === 'running' ? theme.accent : theme.text}>
              {truncateDisplay(`${status} ${agent.profile}${agent.phase && agent.phase !== 'work' ? ` ${glyphs.separator} ${agent.phase}` : ''}`, inner)}
            </Text>
            <Text color={theme.dim}>{truncateDisplay(route, inner)}</Text>
            <Text color={theme.muted}>{truncateDisplay(activity, inner)}</Text>
            {telemetry ? <Text color={theme.dim}>{truncateDisplay(telemetry, inner)}</Text> : null}
            {agent.alerts?.at(-1) ? <Text color={theme.warning}>{truncateDisplay(`${glyphs.warning} ${agent.alerts.at(-1)}`, inner)}</Text> : null}
          </Box>
        );
      })}
      {messages.length ? <Text color={theme.border}>{truncateDisplay('peer messages', inner)}</Text> : null}
      {messages.map((message) => (
        <Text key={message.id} color={theme.muted}>{truncateDisplay(`${message.from}${glyphs.arrow}${message.to}: ${message.text}`, inner)}</Text>
      ))}
    </Box>
  );
}

export type TeamWorkbenchView = 'agents' | 'tasks' | 'messages';

export interface TeamRunSummary {
  id?: string;
  objective?: string;
  startedAt?: number;
  accepted?: boolean;
  reviewRounds?: number;
}

export function TeamWorkbench({items, tasks, width = 80, glyphMode = 'auto', view = 'agents', selectedIndex = 0, expanded = false, run, notice}: {
  items: TimelineItem[];
  tasks: SessionTask[];
  width?: number;
  glyphMode?: GlyphMode;
  view?: TeamWorkbenchView;
  selectedIndex?: number;
  expanded?: boolean;
  run?: TeamRunSummary;
  notice?: string;
}) {
  const theme = useTheme();
  const glyphs = resolveGlyphs(glyphMode);
  const rowWidth = safeWidth(width);
  const inner = Math.max(8, rowWidth - 4);
  const agents = items.filter((item): item is Extract<TimelineItem, {kind: 'agent'}> => item.kind === 'agent' && !item.superseded);
  const messages = items.filter((item): item is Extract<TimelineItem, {kind: 'agent-message'}> => item.kind === 'agent-message');
  const visibleMessages = messages.slice(-12);
  const completed = agents.filter((agent) => agent.state === 'ok').length;
  const running = agents.filter((agent) => agent.state === 'running').length;
  const cancelled = agents.filter((agent) => agent.state === 'cancelled').length;
  const totalTokens = agents.reduce((sum, agent) => sum + (agent.inputTokens ?? 0) + (agent.outputTokens ?? 0), 0);
  const totalTools = agents.reduce((sum, agent) => sum + (agent.toolCalls ?? 0), 0);
  const status = run?.accepted === true ? 'accepted' : run?.accepted === false ? 'rejected' : running ? 'running' : agents.length ? 'complete' : 'idle';
  const summary = [
    `${status}${run?.reviewRounds !== undefined ? ` ${glyphs.separator} review ${run.reviewRounds}` : ''}`,
    `${completed}/${agents.length} done`,
    cancelled ? `${cancelled} cancelled` : '',
    `${formatTokens(totalTokens)} tok`,
    `${totalTools} tools`,
    run?.startedAt ? formatDuration(Date.now() - run.startedAt) : '',
  ].filter(Boolean).join(` ${glyphs.separator} `);
  const viewLabel = view === 'agents' ? 'Agents' : view === 'tasks' ? 'Tasks' : 'Messages';
  const tabs = ['agents', 'tasks', 'messages'].map((name) => name === view ? `[${name}]` : name).join(` ${glyphs.separator} `);

  return (
    <Box flexDirection="column" width={rowWidth} height="100%" borderStyle={glyphs.borderStyle} borderColor={theme.border} paddingX={1}>
      <Text bold color={theme.accent}>{truncateDisplay(`${glyphs.agent} TEAM WORKBENCH`, inner)}</Text>
      <Text color={theme.dim}>{truncateDisplay(summary, inner)}</Text>
      {run?.objective ? <Text color={theme.muted}>{truncateDisplay(`goal ${run.objective}`, inner)}</Text> : null}
      {notice ? <Text color={theme.warning}>{truncateDisplay(`${glyphs.info} ${notice}`, inner)}</Text> : null}
      <Text color={theme.border}>{truncateDisplay(tabs, inner)}</Text>
      {view === 'agents' ? (
        agents.length ? agents.map((agent, index) => {
          const marker = index === selectedIndex ? glyphs.arrow : ' ';
          const stateGlyph = agent.state === 'queued' ? glyphs.pending : agent.state === 'running' ? glyphs.running : agent.state === 'ok' ? glyphs.success : agent.state === 'cancelled' ? glyphs.warning : glyphs.error;
          const route = agent.provider && agent.model ? `${agent.provider}/${agent.model}` : 'inherited model';
          const activity = agent.state === 'cancelled' && agent.cancelReason ? agent.cancelReason : agent.activeTool ? `${agent.stage ?? 'tool'} ${agent.activeTool}` : agent.activityDetail ?? agent.stage ?? 'queued';
          const telemetry = `${formatTokens((agent.inputTokens ?? 0) + (agent.outputTokens ?? 0))} tok${glyphs.separator}${agent.toolCalls ?? 0} tools`;
          return (
            <Box key={agent.id} flexDirection="column">
              <Text color={index === selectedIndex ? theme.textStrong : theme.text}>{truncateDisplay(`${marker}${stateGlyph} ${agent.profile}${agent.phase && agent.phase !== 'work' ? ` ${glyphs.separator} ${agent.phase}` : ''}`, inner)}</Text>
              <Text color={theme.dim}>{truncateDisplay(`  ${route}`, inner)}</Text>
              <Text color={agent.alerts?.length ? theme.warning : theme.muted}>{truncateDisplay(`  ${activity}${glyphs.separator}${telemetry}`, inner)}</Text>
              {expanded && index === selectedIndex ? (
                <Box flexDirection="column" paddingLeft={2}>
                  <Text color={theme.text}>{truncateDisplay(`task ${agent.task}`, inner - 2)}</Text>
                  {agent.summary ? <Text color={theme.muted}>{truncateDisplay(`report ${agent.summary}`, inner - 2)}</Text> : null}
                  {agent.alerts?.map((alert) => <Text key={alert} color={theme.warning}>{truncateDisplay(`${glyphs.warning} ${alert}`, inner - 2)}</Text>)}
                </Box>
              ) : null}
            </Box>
          );
        }) : <Text color={theme.dim}>{truncateDisplay('No active specialist agents.', inner)}</Text>
      ) : view === 'tasks' ? (
        tasks.length ? tasks.map((task, index) => {
          const marker = index === selectedIndex ? glyphs.arrow : ' ';
          const stateGlyph = task.status === 'completed' ? glyphs.success : task.status === 'in_progress' ? glyphs.prompt : glyphs.pending;
          return <Text key={task.id} color={task.status === 'completed' ? theme.success : index === selectedIndex ? theme.textStrong : theme.text}>{truncateDisplay(`${marker}${stateGlyph} ${task.title}`, inner)}</Text>;
        }) : <Text color={theme.dim}>{truncateDisplay('No active plan.', inner)}</Text>
      ) : (
        visibleMessages.length ? visibleMessages.map((message, index) => <Text key={message.id} color={index === Math.min(selectedIndex, visibleMessages.length - 1) ? theme.textStrong : theme.muted}>{truncateDisplay(`${index === Math.min(selectedIndex, visibleMessages.length - 1) ? glyphs.arrow : ' '}${message.from}${glyphs.arrow}${message.to}: ${message.text}`, inner)}</Text>) : <Text color={theme.dim}>{truncateDisplay('No peer handoffs yet.', inner)}</Text>
      )}
      <Box flexGrow={1} />
      <Text color={theme.dim}>{truncateDisplay(`${view === 'agents' ? `s stop ${glyphs.separator} r retry ${glyphs.separator} ` : ''}${expanded ? 'enter collapse' : 'enter inspect'}`, inner)}</Text>
      <Text color={theme.dim}>{truncateDisplay(`left/right view ${glyphs.separator} up/down select ${glyphs.separator} esc close`, inner)}</Text>
      <Text color={theme.dim}>{truncateDisplay(`view ${viewLabel}`, inner)}</Text>
    </Box>
  );
}

function MetaRow({glyph, label, detail, labelColor, width = 80}: {
  glyph: string;
  label: string;
  detail: string;
  labelColor?: string;
  width?: number;
}) {
  const theme = useTheme();
  const rowWidth = safeWidth(width);
  const labelText = `${sanitizeInlineTerminalText(glyph)} ${sanitizeInlineTerminalText(label)}`;
  const detailText = sanitizeInlineTerminalText(detail);
  const detailColor = theme.muted;
  if (rowWidth < 64) {
    return (
      <Box flexDirection="column">
        <Text color={labelColor ?? theme.muted}>{truncateDisplay(labelText, rowWidth)}</Text>
        {detailText ? <Text color={detailColor}>{`  ${truncateDisplay(detailText, Math.max(1, rowWidth - 2))}`}</Text> : null}
      </Box>
    );
  }
  const detailLimit = Math.max(1, rowWidth - displayWidth(labelText) - 2);
  return (
    <Box>
      <Text color={labelColor ?? theme.muted}>{labelText}</Text>
      {detailText ? <Text color={detailColor}>  {truncateDisplay(detailText, detailLimit)}</Text> : null}
    </Box>
  );
}

function contextDegradationLabel(code: string): string {
  if (code === 'local-retrieval-failed') return 'context/unavailable';
  const reason = code.replace(/^local-/u, '') || 'degraded';
  return `fallback/${reason}`;
}

function contextDegradationDetail(degradation: ContextDegradation): string {
  const detail = degradation.detail?.trim();
  if (!detail) return degradation.summary;
  return /^Run\s/iu.test(detail)
    ? `${detail} ${degradation.summary}`
    : `${degradation.summary} ${detail}`;
}

export function TaskRail({tasks, width = 80, glyphMode = 'auto', maxItems}: {
  tasks: SessionTask[];
  width?: number;
  glyphMode?: GlyphMode;
  maxItems?: number;
}) {
  const theme = useTheme();
  const glyphs = resolveGlyphs(glyphMode);
  if (!tasks.length) return null;
  const rowWidth = safeWidth(width);
  const innerWidth = Math.max(1, rowWidth - 2);
  const done = tasks.filter((task) => task.status === 'completed').length;
  const active = tasks.filter((task) => task.status === 'in_progress').length;
  const visibleLimit = Math.max(1, maxItems ?? (width < 48 ? 5 : 12));
  const showMeter = rowWidth >= 40;
  const meterWidth = Math.max(8, Math.min(innerWidth - displayWidth(`Plan  ${done}/${tasks.length} `), 32));
  const meterSegments: MeterSegment[] = [
    {label: 'done', value: done, color: theme.success},
    {label: 'active', value: active, color: theme.accent},
  ];
  return (
    <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
      <Box>
        <Text bold color={theme.textStrong}>Plan</Text>
        <Text color={theme.dim}>  {done}/{tasks.length}</Text>
        {showMeter ? <><Text> </Text><MeterBar segments={meterSegments} total={tasks.length} width={meterWidth} glyphs={glyphs} /></> : null}
      </Box>
      {tasks.slice(0, visibleLimit).map((task) => {
        const glyph = task.status === 'completed'
          ? glyphs.success
          : task.status === 'in_progress'
            ? glyphs.prompt
            : glyphs.pending;
        const glyphColor = task.status === 'completed'
          ? theme.success
          : task.status === 'in_progress'
            ? theme.accent
            : theme.dim;
        const title = sanitizeInlineTerminalText(task.title);
        return (
          <Box key={task.id}>
            <Text color={glyphColor}>{glyph}</Text>
            <Text color={task.status === 'completed' ? theme.muted : theme.text} strikethrough={task.status === 'completed'}>
              {' '}{truncateDisplay(title, Math.max(1, innerWidth - 2))}
            </Text>
          </Box>
        );
      })}
      {tasks.length > visibleLimit
        ? <Text color={theme.dim}>  {glyphs.pending} {tasks.length - visibleLimit} more</Text>
        : null}
    </Box>
  );
}

export function PermissionCard({call, category, width = 80, glyphMode = 'auto', workspace, compact = false}: {
  call: ToolCall;
  category: ToolCategory;
  width?: number;
  glyphMode?: GlyphMode;
  workspace?: string;
  compact?: boolean;
}) {
  const theme = useTheme();
  const glyphs = resolveGlyphs(glyphMode);
  const summary = permissionSummary(call);
  const rowWidth = safeWidth(width);
  const innerWidth = Math.max(1, rowWidth - 2);
  const title = truncateDisplay(`Permission required ${glyphs.separator} ${category}`, innerWidth);
  const tool = truncateDisplay(`tool ${sanitizeInlineTerminalText(call.name)}`, innerWidth);
  const summaryLine = truncateDisplay(`${summary.label} ${summary.value}`, innerWidth);
  const argumentCwd = typeof call.arguments.cwd === 'string' ? call.arguments.cwd : undefined;
  const cwd = sanitizeInlineTerminalText(argumentCwd || workspace || '');
  const shortcuts: InlinePart[] = [
    {text: rowWidth >= 96 ? '[y] allow once' : '[y] once', color: theme.success},
    {text: rowWidth >= 96 ? '[a] allow target for session' : '[a] session', color: theme.success},
    {text: '[n] deny', color: theme.error},
    {text: rowWidth >= 96 ? '[Esc] deny + stop' : '[Esc] stop', color: theme.muted},
  ];
  const compactNarrowShortcuts: InlinePart[] = innerWidth >= 17
    ? [
        {text: '[y] once', color: theme.success},
        {text: '[a] sess', color: theme.success},
        {text: '[n] no', color: theme.error},
        {text: '[Esc] stop', color: theme.muted},
      ]
    : [
        {text: '[y] yes', color: theme.success},
        {text: '[a] sess', color: theme.success},
        {text: '[n] no', color: theme.error},
        {text: '[Esc]', color: theme.muted},
      ];
  const marker = glyphs.borderStyle === 'classic' ? '!' : '▎';
  return (
    <Box flexDirection="column" marginBottom={1}>
      <PermissionLine marker={marker}><Text bold color={theme.warning}>{title}</Text></PermissionLine>
      <PermissionLine marker={marker}><Text color={theme.muted}>{tool}</Text></PermissionLine>
      <PermissionLine marker={marker}><Text color={theme.text}>{summaryLine}</Text></PermissionLine>
      {cwd ? <PermissionLine marker={marker}><Text color={theme.muted}>{truncateDisplay(`cwd ${compactDisplayPath(cwd, Math.max(1, innerWidth - 4))}`, innerWidth)}</Text></PermissionLine> : null}
      {rowWidth >= 64 ? (
        <Box paddingLeft={2}>
          <InlineRow parts={shortcuts} width={innerWidth} separator={`  ${glyphs.separator}  `} separatorColor={theme.border} />
        </Box>
      ) : rowWidth >= 28 ? (
        <Box paddingLeft={2} flexDirection="column">
          <InlineRow parts={shortcuts.slice(0, 2)} width={innerWidth} separator="  " separatorColor={theme.border} />
          <InlineRow parts={shortcuts.slice(2)} width={innerWidth} separator="  " separatorColor={theme.border} />
        </Box>
      ) : compact ? (
        <Box paddingLeft={2} flexDirection="column">
          <InlineRow parts={compactNarrowShortcuts.slice(0, 2)} width={innerWidth} separator=" " separatorColor={theme.border} />
          <InlineRow parts={compactNarrowShortcuts.slice(2)} width={innerWidth} separator=" " separatorColor={theme.border} />
        </Box>
      ) : (
        <Box paddingLeft={2} flexDirection="column">
          {shortcuts.map((part) => part.color
            ? <Text key={part.text} color={part.color}>{truncateDisplay(part.text, innerWidth)}</Text>
            : <Text key={part.text}>{truncateDisplay(part.text, innerWidth)}</Text>)}
        </Box>
      )}
    </Box>
  );
}

function PermissionLine({marker, children}: {marker: string; children: React.ReactNode}) {
  const theme = useTheme();
  return <Box><Text color={theme.warning}>{marker} </Text>{children}</Box>;
}

export function PromptBar({busy, value, placeholder, width = 80, mode = 'chat', queueCount = 0, queuePreview, attachments = [], glyphMode = 'auto', children}: {
  busy: boolean;
  value: string;
  placeholder: string;
  width?: number;
  mode?: 'chat' | 'shell';
  queueCount?: number;
  queuePreview?: string;
  attachments?: string[];
  glyphMode?: GlyphMode;
  children: React.ReactNode;
}) {
  const theme = useTheme();
  const glyphs = resolveGlyphs(glyphMode);
  const shell = mode === 'shell';
  const borderColor = shell ? theme.warning : busy ? theme.border : theme.borderFocus;
  const rowWidth = safeWidth(width);
  const innerWidth = Math.max(1, rowWidth - 2);
  const safePlaceholder = sanitizeInlineTerminalText(placeholder);
  const busyHint = innerWidth < 24
    ? `steer ${glyphs.separator} esc stop`
    : innerWidth < 44
      ? `enter steer ${glyphs.separator} esc stop`
      : innerWidth < 72
        ? `enter steer ${glyphs.separator} alt+enter queue ${glyphs.separator} esc stop`
        : `enter steer ${glyphs.separator} alt+enter queue ${glyphs.separator} /queue manage ${glyphs.separator} esc stop`;
  const hint = busy
    ? busyHint
    : value
      ? `enter send ${glyphs.separator} ctrl+j newline`
      : safePlaceholder;
  const hintText = `${hint}${queueCount ? ` ${glyphs.separator} ${width < 44 ? `q${queueCount}` : `${queueCount} follow-up${queueCount === 1 ? '' : 's'}`}` : ''}`;
  const safeQueuePreview = sanitizeInlineTerminalText(queuePreview ?? '');
  const queueLabel = `${glyphs.pending} ${queueCount} queued`;
  const queuePreviewWidth = Math.max(1, innerWidth - displayWidth(queueLabel) - 1);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={borderColor}>{ruleLine(width, glyphs)}</Text>
      {attachments.length ? (
        <Box paddingLeft={2}>
          <Text color={theme.accent}>{glyphs.context} </Text>
          <Text color={theme.muted}>{truncateDisplay(attachments.map((path) => `@${compactDisplayPath(sanitizeInlineTerminalText(path), 28)}`).join('  '), Math.max(1, safeWidth(width) - 4))}</Text>
        </Box>
      ) : null}
      {queueCount && safeQueuePreview ? (
        <Box paddingLeft={2}>
          <Text color={theme.muted}>{queueLabel} </Text>
          <Text color={theme.text}>{truncateDisplay(safeQueuePreview, queuePreviewWidth)}</Text>
        </Box>
      ) : null}
      <Box>
        <Text bold color={shell ? theme.warning : theme.accent}>{shell ? '! ' : `${glyphs.prompt} `}</Text>
        {children}
      </Box>
      <Box paddingLeft={2}>
        <Text color={theme.muted}>{truncateDisplay(hintText, innerWidth)}</Text>
      </Box>
    </Box>
  );
}

function ruleLine(width: number, glyphs: UiGlyphs): string {
  const character = glyphs.borderStyle === 'classic' ? '-' : '─';
  return character.repeat(Math.max(1, width));
}

interface InlinePart {
  text: string;
  color?: string;
  optional?: boolean;
}

function inlinePartsWidth(parts: InlinePart[], separator: string): number {
  return parts.reduce((total, part) => total + displayWidth(part.text), 0) +
    Math.max(0, parts.length - 1) * displayWidth(separator);
}

function fitInlineParts(parts: InlinePart[], width: number, separator: string): InlinePart[] {
  const limit = safeWidth(width);
  const fitted = [...parts];
  while (fitted.length > 1 && inlinePartsWidth(fitted, separator) > limit) {
    const optional = fitted.findLastIndex((part) => part.optional);
    fitted.splice(optional >= 0 ? optional : fitted.length - 1, 1);
  }
  if (fitted.length && inlinePartsWidth(fitted, separator) > limit) {
    const prefixWidth = inlinePartsWidth(fitted.slice(0, -1), separator) +
      (fitted.length > 1 ? displayWidth(separator) : 0);
    fitted[fitted.length - 1] = {
      ...fitted[fitted.length - 1],
      text: truncateDisplay(fitted[fitted.length - 1]?.text ?? '', Math.max(1, limit - prefixWidth)),
    };
  }
  return fitted;
}

function InlineRow({parts, width, separator, separatorColor}: {
  parts: InlinePart[];
  width: number;
  separator: string;
  separatorColor: string;
}) {
  const safeParts = parts.map((part) => ({...part, text: sanitizeInlineTerminalText(part.text)}));
  const safeSeparator = sanitizeTerminalText(separator).replace(/[\r\n\t]+/gu, ' ');
  const fitted = fitInlineParts(safeParts, width, safeSeparator);
  return (
    <Box width={safeWidth(width)}>
      {fitted.map((part, index) => (
        <React.Fragment key={`${part.text}-${index}`}>
          {index ? <Text color={separatorColor}>{safeSeparator}</Text> : null}
          {part.color ? <Text color={part.color}>{part.text}</Text> : <Text>{part.text}</Text>}
        </React.Fragment>
      ))}
    </Box>
  );
}

export function Footer({busy, approval = false, tokens, maxTokens, changedFiles, width = 80, contextPressure, themeName, queueCount = 0, activeAgents = 0, frame, glyphMode = 'auto'}: {
  busy: boolean;
  approval?: boolean;
  tokens: number;
  maxTokens: number;
  changedFiles: number;
  width?: number;
  contextPressure?: number;
  themeName?: string;
  queueCount?: number;
  activeAgents?: number;
  frame?: string;
  glyphMode?: GlyphMode;
}) {
  const theme = useTheme();
  const glyphs = resolveGlyphs(glyphMode);
  const pressure = contextPressure ?? (maxTokens ? tokens / maxTokens : 0);
  const pressureColor = pressure >= 0.9 ? theme.error : pressure >= 0.75 ? theme.warning : theme.muted;
  const rowWidth = safeWidth(width);
  const safeFrame = sanitizeInlineTerminalText(frame ?? '');
  const status = approval
    ? `${glyphs.warning} approval required`
    : `${busy ? (safeFrame || glyphs.running) : glyphs.activity} ${busy ? 'working' : 'ready'}`;
  const context = `ctx ${formatPercent(pressure)}`;
  const tokenCount = `${formatTokens(tokens)} tokens`;
  const changed = `${changedFiles} changed`;
  const queued = queueCount ? `q${queueCount}` : '';
  const agents = activeAgents ? `${glyphs.agent}${activeAgents}` : '';
  const statusPart: InlinePart = {text: status, color: approval ? theme.warning : busy ? theme.accent : theme.success};
  const contextPart: InlinePart = {text: context, color: pressureColor};
  const changedPart: InlinePart = {text: changed, color: changedFiles ? theme.text : theme.dim};
  const queuePart: InlinePart | undefined = queued ? {text: queued, color: theme.muted} : undefined;
  const agentPart: InlinePart | undefined = agents ? {text: agents, color: theme.accent} : undefined;

  if (rowWidth < 48) {
    const firstLine = inlinePartsWidth([statusPart, contextPart], ` ${glyphs.separator} `) <= rowWidth
      ? [statusPart, contextPart]
      : [statusPart];
    const secondLine = [firstLine.length === 1 ? contextPart : undefined, changedPart, agentPart, queuePart]
      .filter((part): part is InlinePart => part !== undefined);
    return (
      <Box flexDirection="column">
        <InlineRow parts={firstLine} width={rowWidth} separator={` ${glyphs.separator} `} separatorColor={theme.border} />
        <InlineRow parts={secondLine} width={rowWidth} separator={` ${glyphs.separator} `} separatorColor={theme.border} />
      </Box>
    );
  }

  const mainParts: InlinePart[] = [
    statusPart,
    contextPart,
    ...(rowWidth >= 56 ? [{text: tokenCount, color: theme.muted, optional: true}] : []),
    changedPart,
    ...(agentPart ? [agentPart] : []),
    ...(queuePart ? [queuePart] : []),
  ];
  const right = rowWidth >= 72 ? `${sanitizeInlineTerminalText(themeName ?? theme.name)} ${glyphs.separator} /help` : '';
  const rightWidth = right ? displayWidth(right) + 2 : 0;
  return (
    <Box>
      <InlineRow
        parts={fitInlineParts(mainParts, Math.max(1, rowWidth - rightWidth), `  ${glyphs.separator}  `)}
        width={Math.max(1, rowWidth - rightWidth)}
        separator={`  ${glyphs.separator}  `}
        separatorColor={theme.border}
      />
      {right ? <><Box flexGrow={1} /><Text color={theme.muted}>{right}</Text></> : null}
    </Box>
  );
}

export function CommandHints({input, selectedIndex = 0}: {input: string; selectedIndex?: number}) {
  const theme = useTheme();
  const glyphs = resolveGlyphs();
  const suggestions = commandSuggestions(input).slice(0, 5);
  if (!suggestions.length) return null;
  return (
    <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
      {suggestions.map((suggestion, index) => {
        const selected = index === selectedIndex;
        const label = sanitizeInlineTerminalText(suggestion.label);
        const description = sanitizeInlineTerminalText(suggestion.description);
        return (
          <Box key={suggestion.value}>
            <Text bold={selected} color={selected ? theme.accent : theme.muted}>
              {selected ? glyphs.prompt : ' '} {label}
            </Text>
            <Text color={theme.muted}>  {description}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

export function CommandPalette({
  suggestions,
  selected = 0,
  width = 80,
  glyphMode = 'auto',
  title,
  hint: hintOverride,
  emptyText,
}: {
  suggestions: CommandSuggestion[];
  selected?: number;
  width?: number;
  glyphMode?: GlyphMode;
  title?: string;
  hint?: string;
  emptyText?: string;
}) {
  const theme = useTheme();
  const glyphs = resolveGlyphs(glyphMode);
  if (!suggestions.length && !title && !emptyText) return null;
  const rowWidth = safeWidth(width);
  const innerWidth = Math.max(1, rowWidth - 2);
  const pageSize = rowWidth < 28 ? 3 : rowWidth < 48 ? 4 : 6;
  const selectedIndex = Math.max(0, Math.min(selected, suggestions.length - 1));
  const start = Math.max(0, Math.min(selectedIndex - pageSize + 1, suggestions.length - pageSize));
  const visible = suggestions.slice(start, start + pageSize);
  const defaultHint = rowWidth < 28
    ? `${glyphs.up}${glyphs.down} enter`
    : rowWidth < 48
      ? `${glyphs.up}${glyphs.down} ${glyphs.separator} tab ${glyphs.separator} enter`
      : `${glyphs.up}${glyphs.down} select ${glyphs.separator} tab complete ${glyphs.separator} enter run`;
  const titleText = title ? sanitizeInlineTerminalText(title) : undefined;
  const empty = emptyText ? sanitizeInlineTerminalText(emptyText) : undefined;
  const hint = truncateDisplay(sanitizeInlineTerminalText(hintOverride ?? defaultHint), innerWidth);
  const activeSuggestion = suggestions[selectedIndex];
  return (
    <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
      {titleText ? (
        <Box>
          <Text bold color={theme.textStrong}>{truncateDisplay(titleText, innerWidth)}</Text>
        </Box>
      ) : null}
      {!visible.length && empty ? <Text color={theme.muted}>{truncateDisplay(empty, innerWidth)}</Text> : null}
      {visible.map((suggestion, index) => {
        const absoluteIndex = start + index;
        const active = absoluteIndex === selectedIndex;
        const marker = active ? glyphs.prompt : ' ';
        const labelLimit = rowWidth >= 64
          ? Math.min(24, Math.max(1, innerWidth - displayWidth(marker) - 1))
          : Math.max(1, innerWidth - displayWidth(marker) - 1);
        const label = truncateDisplay(sanitizeInlineTerminalText(suggestion.label), labelLimit);
        const description = sanitizeInlineTerminalText(suggestion.description);
        const descriptionLimit = Math.max(0, innerWidth - displayWidth(marker) - displayWidth(label) - 3);
        return (
          <Box key={`${suggestion.value}-${absoluteIndex}`} backgroundColor={active ? theme.selection : undefined}>
            <Text bold color={active ? theme.accent : theme.selection}>{marker}</Text>
            <Text bold={active} color={active ? theme.selectionText : theme.muted}>
              {' '}{label}
            </Text>
            {rowWidth >= 64 && descriptionLimit >= 4
              ? <Text color={theme.muted}>  {truncateDisplay(description, descriptionLimit)}</Text>
              : null}
          </Box>
        );
      })}
      {rowWidth < 64 && activeSuggestion?.description
        ? <Text color={theme.muted}>{`  ${truncateDisplay(sanitizeInlineTerminalText(activeSuggestion.description), Math.max(1, innerWidth - 2))}`}</Text>
        : null}
      <Text color={theme.muted}>{truncateDisplay(hint, innerWidth)}</Text>
    </Box>
  );
}

export function ActivityLine({activity, frame, width = 80}: {activity?: ActivityState; frame: string; width?: number}) {
  const theme = useTheme();
  if (!activity) return null;
  const rowWidth = safeWidth(width);
  const padding = rowWidth >= 4 ? 2 : 0;
  const innerWidth = Math.max(1, rowWidth - padding);
  const turn = activity.turn ? `turn ${activity.turn}` : '';
  const turnWidth = rowWidth >= 48 && turn ? displayWidth(turn) + 2 : 0;
  const safeFrame = sanitizeInlineTerminalText(frame);
  const label = truncateDisplay(sanitizeInlineTerminalText(activity.label), Math.max(1, innerWidth - displayWidth(safeFrame) - 1 - turnWidth));
  return (
    <Box marginBottom={1} paddingLeft={padding} flexDirection="column">
      <Box>
        <Text color={theme.accent}>{truncateDisplay(safeFrame, innerWidth)}</Text>
        <Text color={theme.text}>{` ${label}`}</Text>
        {rowWidth >= 48 && turn ? <Text color={theme.dim}>{`  ${turn}`}</Text> : null}
      </Box>
      {rowWidth < 48 && turn ? <Text color={theme.dim}>{truncateDisplay(turn, innerWidth)}</Text> : null}
    </Box>
  );
}

export function ListPanel({title, entries, width = 80, glyphMode = 'auto', hideTitle = false, header}: {
  title: string;
  entries: ListEntry[];
  width?: number;
  glyphMode?: GlyphMode;
  hideTitle?: boolean;
  header?: React.ReactNode;
}) {
  const theme = useTheme();
  const glyphs = resolveGlyphs(glyphMode);
  const rowWidth = safeWidth(width);
  const innerWidth = Math.max(1, rowWidth - 2);
  const titleText = sanitizeInlineTerminalText(title);
  return (
    <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
      {hideTitle ? null : <Text bold color={theme.textStrong}>{truncateDisplay(titleText, innerWidth)}</Text>}
      {header ?? null}
      {entries.length ? entries.map((entry, index) => {
        const color = entry.tone === 'success' ? theme.success
          : entry.tone === 'warning' ? theme.warning
            : entry.tone === 'error' ? theme.error : theme.text;
        const entryLabel = sanitizeInlineTerminalText(entry.label);
        const entryDetail = entry.detail ? sanitizeInlineTerminalText(entry.detail) : undefined;
        const labelLimit = entryDetail ? Math.max(1, Math.min(28, innerWidth - 4)) : innerWidth;
        const label = truncateDisplay(`${glyphs.bullet} ${entryLabel}`, labelLimit);
        // Pad each row to a stable inner width so incremental terminal
        // repaints overwrite trailing cells; short rows must not leave ghost
        // characters from a previously longer row at the same position.
        if (rowWidth < 52 && entryDetail) {
          const detailText = `  ${truncateDisplay(entryDetail, Math.max(1, innerWidth - 2))}`;
          return (
            <Box key={`${entry.label}-${index}`} flexDirection="column">
              <Text color={color}>{padDisplay(label, innerWidth)}</Text>
              <Text color={theme.muted}>{padDisplay(detailText, innerWidth)}</Text>
            </Box>
          );
        }
        const detailLimit = Math.max(1, innerWidth - displayWidth(label) - 2);
        const detailText = entryDetail ? truncateDisplay(entryDetail, detailLimit) : '';
        const trailing = Math.max(0, innerWidth - displayWidth(label) - (entryDetail ? 2 + displayWidth(detailText) : 0));
        return (
          <Box key={`${entry.label}-${index}`}>
            <Text color={color}>{label}</Text>
            {entryDetail ? <Text color={theme.muted}>{`  ${detailText}`}</Text> : null}
            {trailing > 0 ? <Text>{' '.repeat(trailing)}</Text> : null}
          </Box>
        );
      }) : <Text color={theme.dim}>{padDisplay(`${glyphs.bullet} none`, innerWidth)}</Text>}
    </Box>
  );
}

interface MeterSegment {
  label: string;
  value: number;
  color: string;
}

/**
 * A single-row composition meter: proportional filled cells per segment plus a
 * muted remainder for headroom. The Loom's signature — it turns the abstract
 * "context pressure" number into a visible budget you can read at a glance.
 */
export function MeterBar({segments, total, width, glyphs}: {
  segments: MeterSegment[];
  total: number;
  width: number;
  glyphs: UiGlyphs;
}) {
  const theme = useTheme();
  const cells = Math.max(4, safeWidth(width));
  const denominator = Math.max(total, segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0), 1);
  let used = 0;
  const filled = segments
    .filter((segment) => segment.value > 0)
    .map((segment) => {
      const count = Math.max(1, Math.round((segment.value / denominator) * cells));
      return {...segment, count};
    });
  // Never let rounding push the fill past the track width.
  let overflow = filled.reduce((sum, segment) => sum + segment.count, 0) - cells;
  for (let index = filled.length - 1; overflow > 0 && index >= 0; index -= 1) {
    const take = Math.min(overflow, (filled[index]!.count) - 1);
    filled[index]!.count -= take;
    overflow -= take;
  }
  used = filled.reduce((sum, segment) => sum + segment.count, 0);
  const remainder = Math.max(0, cells - used);
  return (
    <Box>
      {filled.map((segment, index) => (
        <Text key={`${segment.label}-${index}`} color={segment.color}>{glyphs.meterFull.repeat(segment.count)}</Text>
      ))}
      {remainder ? <Text color={theme.border}>{glyphs.meterEmpty.repeat(remainder)}</Text> : null}
    </Box>
  );
}

export function ContextInspector({status, working, summary, width, memory, connections, sources, compact = false, minimal = false, glyphMode = 'auto'}: {
  status: ContextInspectorStatus;
  working: WorkingMemory | undefined;
  summary?: string | undefined;
  width: number;
  memory?: string;
  connections?: string;
  sources?: ContextSource[];
  compact?: boolean;
  minimal?: boolean;
  glyphMode?: GlyphMode;
}) {
  const theme = useTheme();
  const glyphs = resolveGlyphs(glyphMode);
  if (minimal) {
    const rowWidth = safeWidth(width);
    const padding = rowWidth >= 4 ? 2 : 0;
    const innerWidth = Math.max(1, rowWidth - padding);
    const active = `${status.messageCount} msg ${glyphs.separator} ~${formatTokens(status.activeTokens)} tok`;
    const focus = sanitizeTerminalText(working?.focus || working?.goal || (summary ? 'summary ready' : 'not established'))
      .replace(/\s+/g, ' ')
      .trim() || 'not established';
    return (
      <Box flexDirection="column" paddingLeft={padding}>
        <Text bold color={theme.textStrong}>
          {truncateDisplay(`Context ${formatPercent(status.pressure)} ${glyphs.separator} ${active}`, innerWidth)}
        </Text>
        <Text color={working ? theme.text : theme.muted}>
          {truncateDisplay(`working ${focus}`, innerWidth)}
        </Text>
      </Box>
    );
  }
  const entries: ListEntry[] = [
    {label: 'active', detail: `${status.messageCount} messages ${glyphs.separator} ~${formatTokens(status.activeTokens)} tokens ${glyphs.separator} tools ~${formatTokens(status.toolTokens)}`},
    {label: 'short-term', detail: working ? `${working.focus || working.goal || 'ready'} ${glyphs.separator} ${relativeTime(working.lastUpdatedAt)}` : 'not established'},
    {label: 'summary', detail: summary ? `~${formatTokens(status.summaryTokens)} tokens ${glyphs.separator} ${status.compactedMessages} compacted` : 'not created'},
    {label: 'long-term', detail: memory ?? `retrieved by relevance ${glyphs.separator} untrusted context`},
  ];
  if (!compact && working?.constraints.length) entries.push({label: `constraints ${working.constraints.length}`, detail: working.constraints.slice(0, 2).join(` ${glyphs.separator} `)});
  if (!compact && working?.decisions.length) entries.push({label: `decisions ${working.decisions.length}`, detail: working.decisions.slice(0, 2).join(` ${glyphs.separator} `)});
  if (!compact && working?.openQuestions.length) entries.push({label: `open ${working.openQuestions.length}`, detail: working.openQuestions.slice(0, 2).join(` ${glyphs.separator} `), tone: 'warning'});
  if (!compact && working?.relevantFiles.length) entries.push({label: 'relevant files', detail: working.relevantFiles.map((file) => compactDisplayPath(sanitizeInlineTerminalText(file), 28)).join(` ${glyphs.separator} `)});
  if (sources?.length) {
    const pinned = sources.filter((source) => source.state === 'pinned');
    const muted = sources.filter((source) => source.state === 'muted');
    const pinnedTokens = pinned.reduce((sum, source) => sum + source.tokens, 0);
    const names = pinned.map((source) => compactDisplayPath(sanitizeInlineTerminalText(source.path), 28)).join(` ${glyphs.separator} `);
    entries.push({
      label: `pinned ${pinned.length}${muted.length ? ` ${glyphs.separator} ${muted.length} muted` : ''}`,
      detail: pinned.length
        ? `~${formatTokens(pinnedTokens)} tokens ${glyphs.separator} survives compaction ${glyphs.separator} ${names}`
        : `${muted.length} muted ${glyphs.separator} 0 tokens`,
      tone: 'success',
    });
  }
  if (connections) entries.push({label: 'connections', detail: connections});
  const rowWidth = safeWidth(width);
  const innerWidth = Math.max(1, rowWidth - 2);
  const pressureColor = status.pressure >= 0.9 ? theme.error : status.pressure >= 0.75 ? theme.warning : theme.accent;
  const summaryTokens = summary ? status.summaryTokens : 0;
  const segments: MeterSegment[] = [
    {label: 'active', value: status.activeTokens, color: theme.accent},
    {label: 'tools', value: status.toolTokens, color: theme.assistant},
    {label: 'summary', value: summaryTokens, color: theme.warning},
  ];
  // Scale the track to the same pressure the footer reports, so the remainder
  // reads as real headroom rather than an artifact of the segment sum.
  const meterTotal = status.pressure > 0
    ? (status.activeTokens + status.toolTokens + summaryTokens) / status.pressure
    : status.activeTokens + status.toolTokens + summaryTokens;
  const showMeter = rowWidth >= 32;
  const meterWidth = Math.max(8, Math.min(innerWidth - displayWidth(`Context ${formatPercent(status.pressure)} `), 48));
  return (
    <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
      <Box>
        <Text bold color={theme.textStrong}>{`Context `}</Text>
        <Text bold color={pressureColor}>{formatPercent(status.pressure)}</Text>
        {showMeter ? <><Text> </Text><MeterBar segments={segments} total={meterTotal} width={meterWidth} glyphs={glyphs} /></> : null}
      </Box>
      <ListPanel title="" hideTitle entries={entries} width={width} glyphMode={glyphMode} />
    </Box>
  );
}

function ThemePreview({name, width, glyphs}: {name: string; width: number; glyphs: UiGlyphs}) {
  const theme = useTheme();
  const innerWidth = Math.max(1, safeWidth(width) - 2);
  return (
    <Box marginBottom={1} paddingLeft={2} flexDirection="column">
      <Text bold color={theme.textStrong}>{truncateDisplay(`Theme ${sanitizeInlineTerminalText(name)}`, innerWidth)}</Text>
      {theme.accent || theme.success || theme.warning || theme.error ? (
        <Box>
          <Text color={theme.border}>{glyphs.swatch}</Text><Text color={theme.accent}> {glyphs.swatch}</Text>
          <Text color={theme.success}> {glyphs.swatch}</Text><Text color={theme.warning}> {glyphs.swatch}</Text><Text color={theme.error}> {glyphs.swatch}</Text>
        </Box>
      ) : <Text>text {glyphs.separator} accent {glyphs.separator} success {glyphs.separator} warning {glyphs.separator} error</Text>}
    </Box>
  );
}

function Banner({engine, workspace, version, width, glyphs}: {
  model: string;
  engine: string;
  workspace: string;
  version: string;
  width: number;
  glyphs: UiGlyphs;
}) {
  const theme = useTheme();
  const rowWidth = safeWidth(width);
  const padding = rowWidth >= 24 ? 2 : 0;
  const innerWidth = Math.max(1, rowWidth - padding);
  const safeEngine = sanitizeInlineTerminalText(engine);
  const meta = rowWidth >= 32
    ? `v${version} ${glyphs.separator} ${safeEngine} context`
    : `v${version}`;
  const cwd = `cwd ${compactDisplayPath(sanitizeInlineTerminalText(workspace), Math.max(1, innerWidth - 4))}`;
  const hint = rowWidth < 24
    ? `@file ${glyphs.separator} /help`
    : rowWidth < 48
      ? `request ${glyphs.separator} @file ${glyphs.separator} /help`
      : `Start with a request, @file, or /help.`;

  return (
    <Box
      marginBottom={1}
      flexDirection="column"
      paddingLeft={padding}
    >
      <Text bold color={theme.textStrong}>{truncateDisplay(`New session ${glyphs.separator} ${meta}`, innerWidth)}</Text>
      <Text color={theme.muted}>{truncateDisplay(cwd, innerWidth)}</Text>
      <Text color={theme.dim}>{truncateDisplay(hint, innerWidth)}</Text>
    </Box>
  );
}
function UpdateNotice({current, latest, command, highlights, width, glyphs}: {
  current: string;
  latest: string;
  command: string;
  highlights?: string[];
  width: number;
  glyphs: UiGlyphs;
}) {
  const theme = useTheme();
  const availableWidth = safeWidth(width);
  const compact = availableWidth < 48;
  // Narrow terminals prioritise the actual version delta. The long explanatory
  // copy and command must never push both version numbers beyond the viewport.
  const parts = compact ? [
    {text: `${glyphs.up} `, color: theme.accent, bold: true},
    {text: `v${current}`, color: theme.dim, bold: false},
    {text: ` ${glyphs.arrow} `, color: theme.muted, bold: false},
    {text: `v${latest}`, color: theme.success, bold: true},
  ] : [
    {text: glyphs.up, color: theme.accent, bold: true},
    {text: ' a new version is available  ', color: theme.text, bold: false},
    {text: `v${current}`, color: theme.dim, bold: false},
    {text: ` ${glyphs.arrow} `, color: theme.muted, bold: false},
    {text: `v${latest}`, color: theme.success, bold: true},
    {text: `   ${command}`, color: theme.dim, bold: false},
  ];
  const raw = parts.map((part) => part.text).join('');
  const rendered = truncateDisplay(raw, availableWidth);
  // When the line fits, render the multi-colour spans; if truncation kicked in
  // we fall back to a single dim line so no span is left dangling mid-word.
  const truncated = rendered !== raw;
  // Highlights are already sanitised and bounded (≤4 short lines) upstream; each
  // reads as a dim bullet under the version delta and is truncated to the width
  // so a long entry can never wrap into the transcript.
  const bulletPrefix = `  ${glyphs.separator} `;
  const bulletWidth = Math.max(0, safeWidth(width) - displayWidth(bulletPrefix));
  const bullets = bulletWidth > 0
    ? (highlights ?? []).map((line) => truncateDisplay(sanitizeInlineTerminalText(line), bulletWidth))
    : [];
  return (
    <Box marginBottom={1} flexDirection="column">
      <Box>
        {truncated
          ? <Text color={theme.muted}>{rendered}</Text>
          : parts.map((part, index) => (
            <Text key={index} color={part.color} bold={part.bold}>{part.text}</Text>
          ))}
      </Box>
      {compact ? <Text color={theme.dim}>{truncateDisplay(`  run ${command}`, availableWidth)}</Text> : null}
      {bullets.map((line, index) => (
        <Text key={index} color={theme.dim}>{`${bulletPrefix}${line}`}</Text>
      ))}
    </Box>
  );
}

function RichText({value, glyphs}: {value: string; glyphs: UiGlyphs}) {
  const theme = useTheme();
  let inCode = false;
  return <>{sanitizeTerminalText(value).split('\n').map((line, index) => {
    if (/^```/.test(line.trim())) {
      inCode = !inCode;
      return <Text key={index} color={theme.dim}>{inCode ? `${glyphs.context} code` : glyphs.compaction}</Text>;
    }
    if (inCode) {
      const color = line.startsWith('+') ? theme.diffAdded : line.startsWith('-') ? theme.diffRemoved : theme.accent;
      return <Text key={index} color={color}>{glyphs.separator} {line || ' '}</Text>;
    }
    const heading = line.match(/^#{1,4}\s+(.+)$/);
    if (heading) return <Text key={index} bold color={theme.textStrong}><InlineMarkup value={heading[1] as string} /></Text>;
    const bullet = line.match(/^\s*([-*]|\d+\.)\s+(.+)$/);
    if (bullet) return <Text key={index}><Text color={theme.accent}>{bullet[1]} </Text><InlineMarkup value={bullet[2] as string} /></Text>;
    if (line.startsWith('> ')) return <Text key={index} color={theme.muted}>{glyphs.separator} <InlineMarkup value={line.slice(2)} /></Text>;
    return <Text key={index} color={theme.text} wrap="wrap"><InlineMarkup value={line || ' '} /></Text>;
  })}</>;
}

function InlineMarkup({value}: {value: string}) {
  const theme = useTheme();
  return <>{value.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).filter(Boolean).map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return <Text key={index} color={theme.code}>{part.slice(1, -1)}</Text>;
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return <Text key={index} bold color={theme.textStrong}>{part.slice(2, -2)}</Text>;
    }
    return <React.Fragment key={index}>{part}</React.Fragment>;
  })}</>;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.max(1, Math.round(milliseconds))}ms`;
  const seconds = Math.floor(milliseconds / 1_000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function relativeTime(value: string): string {
  const elapsed = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return 'now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  return `${Math.floor(elapsed / 3_600_000)}h ago`;
}

export function toolDetail(call: ToolCall): string {
  const args = call.arguments;
  for (const key of ['path', 'query', 'command', 'pattern', 'task', 'title']) {
    const value = args[key];
    if (typeof value !== 'string') continue;
    const normalized = sanitizeInlineTerminalText(value);
    return key === 'path' ? compactDisplayPath(normalized, 68) : truncateDisplay(normalized, 68);
  }
  const keys = Object.keys(args).filter((key) => !isSensitiveKey(key));
  return keys.length ? keys.slice(0, 3).map(sanitizeInlineTerminalText).join(', ') : '';
}

function permissionSummary(call: ToolCall): {label: string; value: string} {
  const command = commandForCall(call);
  if (command) return {label: 'command', value: truncateDisplay(redactPermissionText(command), 240)};
  for (const key of ['command', 'path', 'url', 'domain', 'query', 'pattern', 'task', 'title']) {
    const value = call.arguments[key];
    if (typeof value === 'string') {
      return {label: key, value: isSensitiveKey(key) ? '[redacted]' : truncateDisplay(redactPermissionText(value), 240)};
    }
  }
  try {
    const value = JSON.stringify(call.arguments, (key, entry) => isSensitiveKey(key) ? '[redacted]' : entry) ?? '{}';
    return {label: 'args', value: truncateDisplay(sanitizeInlineTerminalText(value), 240)};
  } catch {
    return {label: 'args', value: toolDetail(call)};
  }
}

function redactPermissionText(value: string): string {
  return sanitizeInlineTerminalText(value.slice(0, 4_096))
    .replace(/(https?:\/\/)[^/\s:@]+(?::[^@\s/]*)?@/giu, '$1[redacted]@')
    .replace(/\b(bearer|basic)\s+[^\s,;]+/giu, '$1 [redacted]')
    .replace(/((?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, '$1[redacted]')
    .replace(/(--(?:api[_-]?key|password|secret|token)(?:=|\s+))[^\s]+/giu, '$1[redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,})\b/gu, '[redacted]');
}

function isSensitiveKey(key: string): boolean {
  return /(?:api[_-]?key|authorization|cookie|password|secret|token)/i.test(key);
}

function sanitizeInlineTerminalText(value: string): string {
  return sanitizeTerminalText(value).replace(/\s+/gu, ' ').trim();
}

function safeWidth(width: number): number {
  return Math.max(1, Math.floor(Number.isFinite(width) ? width : 80));
}
