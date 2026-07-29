import React, {useEffect, useState} from 'react';
import {Box, Text} from 'ink';
import {basename} from 'node:path';
import type {AgentPhase, ContextBudgetTier, ContextDegradation, ContextSource, MosaicConfig, PendingInput, PromptTokenBreakdown, RouteCostReceipt, SessionTask, ToolCall, ToolCategory, WorkingMemory} from '../types.js';
import {PRODUCT_FLIGHT_MARK, PRODUCT_FLIGHT_MARK_ASCII, PRODUCT_MARK, PRODUCT_NAME} from '../brand.js';
import {commandForCall} from '../tools/permissions.js';
import {commandSuggestions, type CommandSuggestion} from './commands.js';
import {
  compactDisplayPath,
  displayWidth,
  limitTerminalText,
  padDisplay,
  sanitizeTerminalText,
  terminalEllipsis,
  truncateDisplay,
} from './text.js';
import {elapsed, formatPercent, formatTokens, useTheme} from './theme.js';
import {GOOSE_HEIGHT, GOOSE_LINES, GOOSE_MIN_WIDTH, GOOSE_WIDTH, gooseRowColors} from './logo.js';
import {resolveTerminalAccessibility} from './terminal-capabilities.js';

export type TimelineItem =
  | {id: string; kind: 'user'; text: string; clipped?: boolean}
  | {id: string; kind: 'assistant'; text: string; streaming?: boolean; clipped?: boolean}
  | {id: string; kind: 'context'; engine: string; hits: number; tokens: number; budgetTier?: ContextBudgetTier; degradation?: ContextDegradation; truncated?: boolean}
  | {id: string; kind: 'prompt'; intent: string; sections: string[]; tokens: number; breakdown?: PromptTokenBreakdown}
  | {id: string; kind: 'tool'; name: string; detail: string; state: 'queued' | 'running' | 'ok' | 'error' | 'cancelled'; grouped?: boolean; startedAt?: number; durationMs?: number; errorDetail?: string; output?: string; meta?: string}
  | {id: string; kind: 'skill'; name: string; description: string}
  | {id: string; kind: 'memory'; count: number; scope: string}
  | {id: string; kind: 'agent'; profile: string; task: string; provider?: string; model?: string; phase?: AgentPhase; stage?: 'context' | 'thinking' | 'tool' | 'response' | 'review'; activityDetail?: string; activeTool?: string; toolCalls?: number; inputTokens?: number; outputTokens?: number; cost?: RouteCostReceipt; hostedToolCalls?: number; sourceCount?: number; summary?: string; alerts?: string[]; retryOf?: string; superseded?: boolean; state: 'queued' | 'running' | 'ok' | 'error' | 'cancelled'; cancelReason?: string; startedAt?: number; durationMs?: number}
  | {id: string; kind: 'agent-message'; from: string; to: string; text: string}
  | {id: string; kind: 'workflow'; name: string; step: string; status: SessionTask['status']}
  | {id: string; kind: 'compaction'; messages: number; tokens: number}
  | {id: string; kind: 'turn'; turn: number; model: string; durationMs: number; inputTokens: number; outputTokens: number}
  | {id: string; kind: 'clarification'; pending: PendingInput}
  | {id: string; kind: 'list'; title: string; entries: ListEntry[]}
  | {id: string; kind: 'context-inspector'; status: ContextInspectorStatus; working?: WorkingMemory; summary?: string; sources?: ContextSource[]}
  | {id: string; kind: 'theme'; name: string}
  | {id: string; kind: 'banner'; engine: string; status: 'ready' | 'empty' | 'blocked'; version: string; files?: number; chunks?: number; rebuilt?: boolean; reused?: number; durationMs?: number; workspace?: string; model?: string; trust?: string; resume?: {title: string; updatedAt: string}}
  | {id: string; kind: 'notice'; text: string; tone?: 'info' | 'error' | 'success' | 'warning'; wrapWidth?: number}
  | {id: string; kind: 'update'; current: string; latest: string; command: string; highlights?: string[]};

export interface ListEntry {
  label: string;
  detail?: string;
  tone?: 'normal' | 'success' | 'warning' | 'error';
}

export interface ContextInspectorStatus {
  pressure: number;
  promptTokens: number;
  promptSource: 'actual' | 'estimated' | 'none';
  contextWindowTokens: number;
  messageCount: number;
  activeTokens: number;
  summaryTokens: number;
  toolTokens: number;
  compactedMessages: number;
  epochIndex?: number;
  epochCount?: number;
  epochTokens?: number;
  epochBudget?: number;
  lifetimeTokens?: number;
  lifetimeBudget?: number;
}

export interface WorkspacePanelStatus {
  model: string;
  mode: 'ask' | 'plan' | 'build';
  context: 'ready' | 'empty';
  files: number;
  chunks: number;
  permissions: string;
  tools: number;
  skills: number;
  mcpConnected: number;
  mcpTotal: number;
  memory: 'on' | 'off';
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
  /** Left rail drawn beside fenced code and quoted blocks. */
  codeRail: string;
  listBullet: string;
  borderStyle: 'round' | 'classic';
}

const unicodeGlyphs: UiGlyphs = {
  brand: PRODUCT_MARK,
  activity: '●',
  prompt: '›',
  running: '◌',
  success: '✓',
  error: '×',
  // Meta rows share the quiet pending dot; role lives in the `skill/` / `memory`
  // / `agent` text prefix so the gutter stays a three-glyph status system:
  // live spinner, success, failure/warning.
  context: '·',
  skill: '·',
  memory: '·',
  agent: '·',
  compaction: '·',
  pending: '·',
  notice: '·',
  info: '·',
  warning: '!',
  bullet: '·',
  up: '↑',
  down: '↓',
  swatch: '●',
  // A thin rail reads as a measurement; full blocks read as a wall of ink and
  // dominate every other row in the frame.
  meterFull: '━',
  // A dashed track, not a solid one: `─` is already the composer rule and the
  // `└─` continuation marker, so a solid empty slot made one glyph carry three
  // different meanings in a single frame.
  meterEmpty: '┄',
  separator: '·',
  arrow: '→',
  collapsed: '›',
  expanded: '⌄',
  branch: '├─',
  branchLast: '└─',
  codeRail: '│',
  listBullet: '•',
  borderStyle: 'round',
};

const asciiGlyphs: UiGlyphs = {
  brand: '*',
  activity: 'o',
  prompt: '>',
  running: '~',
  success: '+',
  error: 'x',
  context: '-',
  skill: '-',
  memory: '-',
  agent: '-',
  compaction: '-',
  pending: '-',
  notice: '-',
  info: '-',
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
  codeRail: '|',
  listBullet: '-',
  borderStyle: 'classic',
};

/** Compact goose-in-flight mark for headers and the fresh banner identity row. */
export function flightMark(glyphs: UiGlyphs): string {
  return glyphs.borderStyle === 'classic' ? PRODUCT_FLIGHT_MARK_ASCII : PRODUCT_FLIGHT_MARK;
}

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
  expanded?: boolean;
}) {
  const theme = useTheme();
  const glyphs = resolveGlyphs(glyphMode);
  const root = config.workspaceRoots[0] ?? process.cwd();
  const terminalWidth = safeWidth(width);
  const mode = planMode ? 'PLAN' : askMode ? 'ASK' : 'BUILD';
  // Each mode gets a semantic hue: BUILD is "go" (mutations live), PLAN is the
  // amber "thinking" state, ASK is a calm read-only muted tone.
  const modeColor = planMode ? theme.warning : askMode ? theme.muted : theme.accent;
  // The compact flight mark is the product animal at ordinary widths. It
  // retracts with the header after the conversation starts; the transcript
  // keeps the one-cell thread mark instead of repeating the goose.
  const mark = flightMark(glyphs);
  const brand = PRODUCT_NAME.toUpperCase();
  const modeLabel = mode;
  const separator = ` ${glyphs.separator} `;
  const model = sanitizeInlineTerminalText(config.activeConnection && config.activeConnection.source !== 'legacy'
    ? `@${config.activeConnection.id}/${config.model.model}`
    : `${config.model.provider}/${config.model.model}`);
  const repository = sanitizeInlineTerminalText(basename(root) || root);
  // The flight mark is the first thing to drop: identity survives on the
  // wordmark alone, so narrow terminals keep the repository and mode instead.
  const showMark = terminalWidth >= 40;
  const markWidth = showMark ? displayWidth(mark) + 1 : 0;
  const minimum = `${brand}${separator}${modeLabel}`;
  const withRepository = `${brand}${separator}${repository}`;
  const showRepository = terminalWidth >= 32 && displayWidth(withRepository) + markWidth <= terminalWidth;
  const leftWidth = displayWidth(showRepository ? withRepository : minimum) + markWidth;
  const modelSpace = terminalWidth - leftWidth - 2;
  const showModel = terminalWidth >= 72 && modelSpace >= 12;

  return (
    <Box marginBottom={1} height={1} overflowY="hidden">
      {showMark ? <Text color={theme.accent} aria-hidden>{mark} </Text> : null}
      <Text bold color={theme.accent} aria-label={PRODUCT_NAME}>{brand}</Text>
      {showRepository ? <>
        <Text color={theme.border}>{separator}</Text>
        <Text color={theme.muted}>{repository}</Text>
      </> : <Text> </Text>}
      {showModel ? <><Box flexGrow={1} /><Text color={theme.dim} wrap="truncate">{truncateDisplay(model, Math.max(1, modelSpace - displayWidth(modeLabel) - displayWidth(separator)))}</Text><Text color={theme.border}>{separator}</Text></> : showRepository ? <Text color={theme.border}>{separator}</Text> : null}
      <Text bold color={modeColor}>{modeLabel}</Text>
    </Box>
  );
}

/**
 * The one animated glyph the whole surface shares: a thread winding into a
 * ball. Frames are one cell by contract so they fit the shared gutter.
 */
export const SPINNER_FRAMES: readonly string[] = ['◌', '◍', '◎', '◉', '◎', '◍'];

function WindingSpinner() {
  const theme = useTheme();
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((value) => (value + 1) % SPINNER_FRAMES.length), 110);
    return () => clearInterval(timer);
  }, []);
  return <Text color={theme.accent}>{SPINNER_FRAMES[frame]}</Text>;
}

function ToolGlyph({state, glyphs}: {state: 'queued' | 'running' | 'ok' | 'error' | 'cancelled'; glyphs: UiGlyphs}) {
  const theme = useTheme();
  if (state === 'queued') return <Text color={theme.muted}>{glyphs.pending}</Text>;
  if (state === 'running') return glyphs.borderStyle === 'round' && !resolveTerminalAccessibility().reducedMotion
    ? <WindingSpinner />
    : <Text color={theme.accent}>{glyphs.running}</Text>;
  if (state === 'ok') return <Text color={theme.success}>{glyphs.success}</Text>;
  if (state === 'cancelled') return <Text color={theme.warning}>{glyphs.warning}</Text>;
  return <Text color={theme.error}>{glyphs.error}</Text>;
}

/**
 * The single left edge every transcript row shares: two columns of gutter for a
 * status glyph, then content. A row claims the gutter only when it needs
 * attention — a settled success is silent, because a column of green ticks
 * makes the one real failure weigh exactly as much as the four that worked.
 *
 * Every `estimateTimelineItemRows` branch assumes this shape, so content here
 * must never wrap outside the width it is given.
 */
const GUTTER = 2;

/** Han ideographs — used only to pick the language of a built-in hint line. */
const CJK_PATTERN = /[㐀-鿿]/u;

function Row({glyph, children}: {glyph?: React.ReactNode; children: React.ReactNode}) {
  // The gutter is exactly `GUTTER` cells and never grows: a spinner frame or
  // theme glyph wider than that is clipped, because letting it wrap would push
  // the content column down a row and break the shared left edge.
  return (
    <Box>
      <Box width={GUTTER} height={1} overflow="hidden">{glyph ?? null}</Box>
      {children}
    </Box>
  );
}

/**
 * Gutter content for a tool row. `ok` and `queued` return nothing: routine
 * progress is carried by the row appearing at all, and by its duration.
 */
function toolGutter(
  state: 'queued' | 'running' | 'ok' | 'error' | 'cancelled',
  glyphs: UiGlyphs,
): React.ReactNode {
  if (state === 'running') return <ToolGlyph state={state} glyphs={glyphs} />;
  if (state === 'error' || state === 'cancelled') return <ToolGlyph state={state} glyphs={glyphs} />;
  return null;
}

/**
 * Width of the tool name column. Derived from the terminal width alone, never
 * from the names currently on screen: a column that grew when a long tool name
 * streamed in would reflow every row above it.
 */
function toolNameColumn(width: number): number {
  if (width >= 72) return 14;
  if (width >= 64) return 12;
  return 0;
}

/** Mark every tool except the last of a contiguous run so the run shares one trailing gap. */
export function prepareTimelineItems(items: readonly TimelineItem[], _expandedToolId?: string, _showToolOutput = false): TimelineItem[] {
  return items.map((item, index) => item.kind === 'tool'
    ? {...item, grouped: items[index + 1]?.kind === 'tool'}
    : item);
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
      <Box paddingLeft={GUTTER} marginBottom={1}>
        <Text color={theme.muted}>No messages yet.</Text>
      </Box>
    );
  }
  const preparedItems = items.some((item) => item.kind === 'tool' && item.grouped !== undefined)
    ? items
    : prepareTimelineItems(items);
  const rowWidth = safeWidth(width);
  const contentWidth = Math.max(1, rowWidth - GUTTER);
  return (
    <Box flexDirection="column" aria-role="list">
      {preparedItems.map((item) => {
        if (item.kind === 'user') {
          // The request is the one row that claims the accent gutter: it is the
          // anchor a reader scrolls to when looking for "where did this start".
          return (
            <Box key={item.id} marginBottom={compact || item.clipped ? 0 : 1}>
              <Box width={GUTTER}><Text bold color={theme.accent}>{glyphs.prompt}</Text></Box>
              <Box width={contentWidth}>
                <Text bold color={theme.textStrong} wrap="wrap">{sanitizeTerminalText(item.text)}</Text>
              </Box>
            </Box>
          );
        }
        if (item.kind === 'assistant') {
          // The reply is the surface, so it carries no nameplate and no gutter
          // glyph: the `›` on the request above is the only role marker needed.
          //
          // Each block owns only the gap below it. A leading gap here would read
          // better against the receipt stack, but Ink does not collapse margins
          // and `estimateTimelineItemRows` scores items in isolation, so it
          // would double up after a user turn and desync the viewport.
          return (
            <Box
              key={item.id}
              flexDirection="column"
              paddingLeft={GUTTER}
              marginBottom={compact || item.clipped ? 0 : 1}
              aria-label={`${PRODUCT_NAME}${item.streaming ? ' streaming' : ''}`}
            >
              {item.streaming
                ? <Text color={theme.dim}>{glyphs.brand} writing{terminalEllipsis()}</Text>
                : null}
              <RichText value={item.text} glyphs={glyphs} />
            </Box>
          );
        }
        if (item.kind === 'context') {
          // A retrieval that simply worked is not news. Only a degraded or
          // clipped run earns a row, and it earns the warning gutter because it
          // changes how much the reader should trust the answer.
          //
          // These two rows wrap rather than truncate: a degradation carries the
          // remediation command, and a receipt that hides the fix is worse than
          // one that costs a second line in a state this rare.
          if (!item.degradation && !item.truncated) return null;
          return (
            <Box key={item.id} flexDirection="column">
              {item.truncated && !item.degradation ? (
                <WrappedReceipt
                  width={rowWidth}
                  glyph={glyphs.warning}
                  text={contextClippedReceiptText(item.engine, item.hits, glyphs.separator)}
                />
              ) : null}
              {item.degradation ? (
                <WrappedReceipt
                  width={rowWidth}
                  glyph={glyphs.warning}
                  text={contextDegradedReceiptText(item.degradation)}
                />
              ) : null}
            </Box>
          );
        }
        if (item.kind === 'prompt') {
          // Per-turn model-input estimates are accounting, not conversation.
          // `/context` and the structured event stream keep the full ledger.
          return null;
        }
        if (item.kind === 'tool') {
          return (
            <ToolRow
              key={item.id}
              item={item}
              width={rowWidth}
              glyphs={glyphs}
              compact={compact}
              expanded={Boolean(item.output) && (showToolOutput || expandedToolId === item.id)}
            />
          );
        }
        if (item.kind === 'skill') {
          return <MetaRow key={item.id} width={rowWidth} glyph={glyphs.skill} label={`skill/${item.name}`} detail={item.description} />;
        }
        if (item.kind === 'memory') {
          return <MetaRow key={item.id} width={rowWidth} glyph={glyphs.memory} label="memory" detail={`${item.count} relevant ${glyphs.separator} ${item.scope}`} />;
        }
        if (item.kind === 'agent') {
          // Agents follow the tool contract for the gutter — only a live or
          // failed teammate marks it — but the profile flows rather than sitting
          // in the tool name column: it is the row's subject and must stay whole.
          const agentTask = sanitizeInlineTerminalText(item.task);
          const agentSummary = item.summary ? sanitizeInlineTerminalText(item.summary) : undefined;
          const phase = item.phase && item.phase !== 'work' ? `${glyphs.separator} ${item.phase}` : '';
          const route = item.provider && item.model ? `${item.provider}/${item.model}` : '';
          const duration = item.durationMs !== undefined ? formatDuration(item.durationMs) : '';
          const detail = [route, phase, agentSummary ? `${agentTask} ${glyphs.arrow} ${agentSummary}` : agentTask]
            .filter(Boolean).join(' ');
          return (
            <AlignedRow
              key={item.id}
              width={rowWidth}
              column={0}
              gutter={toolGutter(item.state, glyphs)}
              name={`agent/${sanitizeInlineTerminalText(item.profile)}`}
              nameColor={theme.text}
              detail={detail}
              detailColor={item.state === 'error' ? theme.error : item.state === 'cancelled' ? theme.warning : theme.muted}
              trailing={duration}
            />
          );
        }
        if (item.kind === 'agent-message') {
          const from = sanitizeInlineTerminalText(item.from);
          const to = sanitizeInlineTerminalText(item.to);
          const text = sanitizeInlineTerminalText(item.text);
          return <MetaRow key={item.id} width={rowWidth} glyph={glyphs.agent} label={`${from} ${glyphs.arrow} ${to}`} detail={text} />;
        }
        if (item.kind === 'workflow') {
          // Only a live step claims the accent gutter; a finished one is settled
          // evidence and reads like the tool rows above it.
          const glyph = item.status === 'completed' ? glyphs.success : item.status === 'in_progress' ? glyphs.prompt : glyphs.pending;
          const glyphColor = item.status === 'completed' ? theme.success : item.status === 'in_progress' ? theme.accent : theme.dim;
          return <MetaRow key={item.id} width={rowWidth} glyph={glyph} glyphColor={glyphColor} label={`workflow/${item.name}`} detail={item.step} />;
        }
        if (item.kind === 'compaction') {
          return (
            <MetaRow
              key={item.id}
              width={rowWidth}
              glyph={glyphs.compaction}
              label="context compacted"
              detail={`${item.messages} messages ${glyphs.arrow} ${formatTokens(item.tokens)} tokens`}
            />
          );
        }
        if (item.kind === 'turn') {
          // One quiet receipt per model interaction: the same content-free
          // evidence language as the other meta rows — duration and token
          // flow, never prompt text.
          return (
            <MetaRow
              key={item.id}
              width={rowWidth}
              glyph={glyphs.context}
              label={`turn ${item.turn}`}
              detail={`${sanitizeInlineTerminalText(item.model)} ${glyphs.separator} ${formatDuration(item.durationMs)} ${glyphs.separator} ${glyphs.up}${formatTokens(item.inputTokens)} ${glyphs.down}${formatTokens(item.outputTokens)} tok`}
            />
          );
        }
        if (item.kind === 'clarification') {
          const chinese = CJK_PATTERN.test(item.pending.question);
          // A pending question is the one place the transcript may spend extra
          // rows: the reader cannot answer an option whose consequence was
          // truncated away. `viewport` scores this with the same wrapping.
          return (
            <Box key={item.id} flexDirection="column" marginBottom={1}>
              <Row glyph={<Text color={theme.warning}>{glyphs.warning}</Text>}>
                <Box width={contentWidth}>
                  <Text bold color={theme.warning} wrap="wrap">{sanitizeTerminalText(item.pending.question)}</Text>
                </Box>
              </Row>
              {item.pending.options.map((option, optionIndex) => {
                const label = clarificationOptionLabel(option, optionIndex, chinese);
                const impact = sanitizeInlineTerminalText(option.impact);
                if (rowWidth < 48) {
                  return (
                    <Box key={option.id} flexDirection="column" paddingLeft={GUTTER}>
                      <Text color={option.recommended ? theme.textStrong : theme.text}>
                        {truncateDisplay(label, contentWidth)}
                      </Text>
                      <Box width={contentWidth}>
                        <Text color={theme.dim} wrap="wrap">{impact}</Text>
                      </Box>
                    </Box>
                  );
                }
                return (
                  <Box key={option.id} paddingLeft={GUTTER} width={rowWidth}>
                    <Box width={contentWidth}>
                      <Text color={option.recommended ? theme.textStrong : theme.text} wrap="wrap">
                        {`${label} ${glyphs.separator} ${impact}`}
                      </Text>
                    </Box>
                  </Box>
                );
              })}
              <Box paddingLeft={GUTTER}>
                <Text color={theme.dim}>{truncateDisplay(clarificationHint(chinese), contentWidth)}</Text>
              </Box>
            </Box>
          );
        }
        if (item.kind === 'list') return <ListPanel key={item.id} title={item.title} entries={item.entries} width={rowWidth} glyphMode={glyphMode} />;
        if (item.kind === 'context-inspector') {
          return <ContextInspector key={item.id} status={item.status} working={item.working} summary={item.summary} width={rowWidth} compact={compact} glyphMode={glyphMode} />;
        }
        if (item.kind === 'theme') return <ThemePreview key={item.id} name={item.name} width={rowWidth} glyphs={glyphs} />;
        if (item.kind === 'banner') {
          return <Banner
            key={item.id}
            engine={item.engine}
            status={item.status}
            version={item.version}
            width={rowWidth}
            glyphs={glyphs}
            {...(item.files !== undefined ? {files: item.files} : {})}
            {...(item.chunks !== undefined ? {chunks: item.chunks} : {})}
            {...(item.rebuilt !== undefined ? {rebuilt: item.rebuilt} : {})}
            {...(item.reused !== undefined ? {reused: item.reused} : {})}
            {...(item.durationMs !== undefined ? {durationMs: item.durationMs} : {})}
            {...(item.workspace ? {workspace: item.workspace} : {})}
            {...(item.model ? {model: item.model} : {})}
            {...(item.trust ? {trust: item.trust} : {})}
          />;
        }
        if (item.kind === 'update') {
          return <UpdateNotice key={item.id} current={item.current} latest={item.latest} command={item.command} width={rowWidth} glyphs={glyphs} {...(item.highlights ? {highlights: item.highlights} : {})} />;
        }
        // A notice is the one receipt allowed to be loud: each is either the
        // evidence that closed a run or something the reader has to act on.
        const color = item.tone === 'error'
          ? theme.error
          : item.tone === 'warning'
            ? theme.warning
          : item.tone === 'success'
            ? theme.success
            : theme.muted;
        const noticeGlyph = item.tone === 'error'
          ? glyphs.error
          : item.tone === 'warning'
            ? glyphs.warning
          : item.tone === 'success'
            ? glyphs.success
            : glyphs.info;
        return (
          <Box key={item.id} width={rowWidth}>
            <Box width={GUTTER}><Text color={color}>{noticeGlyph}</Text></Box>
            <Box width={Math.max(1, safeWidth(item.wrapWidth ?? rowWidth) - GUTTER)}>
              <Text color={color} wrap="wrap">{sanitizeTerminalText(item.text)}</Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

export function TeamSummary({items, width = 36, glyphMode = 'auto'}: {
  items: TimelineItem[];
  width?: number;
  glyphMode?: GlyphMode;
}) {
  const theme = useTheme();
  const glyphs = resolveGlyphs(glyphMode);
  const agents = items.filter((item): item is Extract<TimelineItem, {kind: 'agent'}> => item.kind === 'agent' && !item.superseded);
  const active = agents.filter((agent) => agent.state === 'queued' || agent.state === 'running');
  if (!active.length) return null;
  const rowWidth = safeWidth(width);
  const padding = rowWidth >= 24 ? 2 : 0;
  const inner = Math.max(1, rowWidth - padding);
  const running = active.filter((agent) => agent.state === 'running').length;
  const queued = active.length - running;
  const reviewing = active.filter((agent) => agent.phase === 'review').length;
  const summary = [
    `${active.length} agent${active.length === 1 ? '' : 's'}`,
    running ? `${running} running` : '',
    queued ? `${queued} queued` : '',
    reviewing ? `${reviewing} review` : '',
    rowWidth >= 48 ? 'ctrl+t details' : '',
  ].filter(Boolean).join(` ${glyphs.separator} `);
  const profiles = active.map((agent) => {
    const state = agent.state === 'running' ? glyphs.running : glyphs.pending;
    return `${state} ${sanitizeInlineTerminalText(agent.profile)}`;
  }).join(`  ${glyphs.separator}  `);
  return (
    <Box flexDirection="column" width={rowWidth} paddingLeft={padding} marginBottom={1} aria-label={`Active team agents: ${summary}${rowWidth >= 64 ? `. ${profiles}` : ''}`}>
      <Text color={theme.accent}>{truncateDisplay(summary, inner)}</Text>
      {rowWidth >= 64 ? <Text color={theme.dim}>{truncateDisplay(profiles, inner)}</Text> : null}
    </Box>
  );
}

export function WorkspacePanel({status, width = 36, glyphMode = 'auto'}: {
  status: WorkspacePanelStatus;
  width?: number;
  glyphMode?: GlyphMode;
}) {
  const theme = useTheme();
  const glyphs = resolveGlyphs(glyphMode);
  const inner = Math.max(8, safeWidth(width) - 4);
  const contextLabel = status.context === 'empty' ? 'ready · empty workspace' : 'ready';
  const mcpLabel = status.mcpTotal ? `${status.mcpConnected}/${status.mcpTotal} connected` : 'off';
  return (
    <Box flexDirection="column" width={width} height={13} borderStyle={glyphs.borderStyle} borderColor={theme.border} paddingX={1}>
      <Text bold color={theme.accent}>{truncateDisplay(`${glyphs.brand} WORKSPACE`, inner)}</Text>
      <Text color={theme.dim}>{truncateDisplay('CONTEXT', inner)}</Text>
      <Text color={status.context === 'empty' ? theme.warning : theme.success}>{truncateDisplay(`${glyphs.success} local index ${contextLabel}`, inner)}</Text>
      <Text color={theme.muted}>{truncateDisplay(`${status.files} files ${glyphs.separator} ${status.chunks} chunks`, inner)}</Text>
      <Text color={theme.dim}>{truncateDisplay('RUNTIME', inner)}</Text>
      <Text color={theme.text}>{truncateDisplay(status.model, inner)}</Text>
      <Text color={theme.muted}>{truncateDisplay(`mode ${status.mode.toUpperCase()} ${glyphs.separator} ${status.permissions}`, inner)}</Text>
      <Text color={theme.dim}>{truncateDisplay('EXTENSIONS', inner)}</Text>
      <Text color={theme.muted}>{truncateDisplay(`${status.tools} tools ${glyphs.separator} ${status.skills} skills`, inner)}</Text>
      <Text color={theme.muted}>{truncateDisplay(`MCP ${mcpLabel} ${glyphs.separator} memory ${status.memory}`, inner)}</Text>
      <Text color={theme.dim}>{truncateDisplay(`@file pin ${glyphs.separator} /status inspect`, inner)}</Text>
    </Box>
  );
}

export type TeamWorkbenchView = 'agents' | 'tasks' | 'messages';

export interface TeamRunSummary {
  id?: string;
  objective?: string;
  startedAt?: number;
  accepted?: boolean;
  needsReview?: boolean;
  unresolvedCriteria?: string[];
  reviewRounds?: number;
  review?: {
    decision: 'accept' | 'revise' | 'escalate';
    pass: number;
    fail: number;
    unknown: number;
  };
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
  const pricedCostMicros = agents.reduce((sum, agent) =>
    sum + (agent.cost?.status === 'priced' ? agent.cost.amountMicros : 0), 0);
  const pricedAgents = agents.filter((agent) => agent.cost?.status === 'priced').length;
  const unpricedAgents = agents.filter((agent) => agent.cost?.status === 'unpriced').length;
  const costSummary = pricedAgents
    ? `$${(pricedCostMicros / 1_000_000).toFixed(6)}${unpricedAgents ? ` + ${unpricedAgents} unpriced` : ''}`
    : unpricedAgents
      ? `${unpricedAgents} unpriced`
      : agents.length ? 'cost pending' : '';
  const hostedToolCalls = agents.reduce((sum, agent) => sum + (agent.hostedToolCalls ?? 0), 0);
  const sourceCount = agents.reduce((sum, agent) => sum + (agent.sourceCount ?? 0), 0);
  const status = run?.needsReview ? 'needs review' : run?.accepted === true ? 'accepted' : run?.accepted === false ? 'rejected' : running ? 'running' : agents.length ? 'complete' : 'idle';
  const summary = [
    `${status}${run?.reviewRounds !== undefined ? ` ${glyphs.separator} review ${run.reviewRounds}` : ''}`,
    run?.review ? `judge ${run.review.decision} ${run.review.pass}/${run.review.fail}/${run.review.unknown}` : '',
    run?.needsReview && run.unresolvedCriteria?.length ? `${run.unresolvedCriteria.length} unresolved` : '',
    `${completed}/${agents.length} done`,
    cancelled ? `${cancelled} cancelled` : '',
    `${formatTokens(totalTokens)} tok`,
    `${totalTools} tools`,
    costSummary,
    `${hostedToolCalls} hosted`,
    `${sourceCount} sources`,
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
          const agentCost = agent.cost?.status === 'priced'
            ? `$${(agent.cost.amountMicros / 1_000_000).toFixed(6)}`
            : agent.cost ? 'unpriced' : 'cost pending';
          const telemetry = `${formatTokens((agent.inputTokens ?? 0) + (agent.outputTokens ?? 0))} tok${glyphs.separator}${agent.toolCalls ?? 0} tools${glyphs.separator}${agentCost}${glyphs.separator}${agent.hostedToolCalls ?? 0} hosted${glyphs.separator}${agent.sourceCount ?? 0} sources`;
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

/**
 * A receipt row: glyph in the shared gutter, a label, and dim detail. Receipts
 * are scannable evidence rather than prose, so the label and detail both sit a
 * step below body text and the eye can skip the block and land on the reply.
 *
 * Narrow terminals keep this to one row and drop the detail rather than
 * stacking a second line, so a run of receipts cannot double in height the
 * moment the window shrinks.
 */
function MetaRow({glyph, label, detail, glyphColor, width = 80}: {
  glyph: string;
  label: string;
  detail: string;
  glyphColor?: string;
  width?: number;
}) {
  const theme = useTheme();
  const rowWidth = safeWidth(width);
  const contentWidth = Math.max(1, rowWidth - GUTTER);
  const labelText = sanitizeInlineTerminalText(label);
  const detailText = sanitizeInlineTerminalText(detail);
  const detailLimit = Math.max(0, contentWidth - displayWidth(labelText) - 2);
  const showDetail = Boolean(detailText) && detailLimit >= 8;
  return (
    <Row glyph={<Text color={glyphColor ?? theme.dim}>{sanitizeInlineTerminalText(glyph)}</Text>}>
      <Text color={theme.muted}>{truncateDisplay(labelText, contentWidth)}</Text>
      {showDetail ? <Text color={theme.dim}>{`  ${truncateDisplay(detailText, detailLimit)}`}</Text> : null}
    </Row>
  );
}

/**
 * The alignment contract shared by tool and agent rows: gutter, a name padded
 * to a width-derived column, then detail, then a right-hand trailing field.
 *
 * The name column comes from the terminal width alone — never from the names
 * currently on screen — so a long name arriving mid-run cannot reflow the rows
 * above it. Below the threshold where a real column would leave no usable room
 * for detail, the column collapses to zero and the row degrades to a single
 * space-separated line rather than wrapping onto a second row.
 */
function AlignedRow({width, gutter, name, nameColor, detail, detailColor, trailing, disclosure, column: columnOverride}: {
  width: number;
  gutter?: React.ReactNode;
  name: string;
  nameColor: string;
  detail: string;
  detailColor: string;
  trailing?: string;
  disclosure?: string;
  /**
   * Explicit name-column width. `0` means "flow": the name takes only the space
   * it needs. Agents pass 0 because a profile like `agent/security-reviewer` is
   * far longer than any tool name, and forcing it into the tool column would
   * truncate the one word identifying who did the work.
   */
  column?: number;
}) {
  const theme = useTheme();
  const rowWidth = safeWidth(width);
  const contentWidth = Math.max(1, rowWidth - GUTTER);
  const column = columnOverride ?? toolNameColumn(rowWidth);
  const trailingText = trailing ? sanitizeInlineTerminalText(trailing) : '';
  const disclosureText = disclosure ? sanitizeInlineTerminalText(disclosure) : '';
  const trailingWidth = trailingText ? displayWidth(trailingText) + 2 : 0;
  const disclosureWidth = disclosureText ? displayWidth(disclosureText) + 1 : 0;
  // The trailing field and disclosure marker are reserved before the name and
  // detail get their budget, so a long path can never push the duration off the
  // row. On a terminal too narrow to hold both, the name wins and they drop:
  // a row that wrapped would break the shared gutter for everything below it.
  const showTrailing = trailingWidth > 0 && contentWidth - trailingWidth - disclosureWidth >= 6;
  const showDisclosure = disclosureWidth > 0 && contentWidth - disclosureWidth >= 6;
  const reserved = (showTrailing ? trailingWidth : 0) + (showDisclosure ? disclosureWidth : 0);
  const available = Math.max(1, contentWidth - reserved);
  const nameLimit = column ? Math.min(column - 1, available) : Math.min(displayWidth(name), available);
  const nameText = truncateDisplay(sanitizeInlineTerminalText(name), Math.max(1, nameLimit));
  const nameCell = column && displayWidth(nameText) < available
    ? padDisplay(nameText, Math.min(column, available))
    : `${nameText}${displayWidth(nameText) < available ? ' ' : ''}`;
  const detailLimit = Math.max(0, available - displayWidth(nameCell));
  const detailText = detail ? truncateDisplay(sanitizeInlineTerminalText(detail), detailLimit) : '';
  const showDetail = Boolean(detailText) && detailLimit > 0;
  // Pad to the exact content width so the trailing field lands on the same
  // column in every row and short rows overwrite longer previous repaints.
  const pad = Math.max(0, available - displayWidth(nameCell) - (showDetail ? displayWidth(detailText) : 0));
  return (
    <Row glyph={gutter}>
      <Text color={nameColor}>{nameCell}</Text>
      {showDetail ? <Text color={detailColor}>{detailText}</Text> : null}
      {pad > 0 ? <Text>{' '.repeat(pad)}</Text> : null}
      {showTrailing ? <Text color={theme.dim}>{`  ${trailingText}`}</Text> : null}
      {showDisclosure ? <Text color={theme.dim}>{` ${disclosureText}`}</Text> : null}
    </Row>
  );
}

/**
 * One tool call. Collapsed it is a single aligned row; expanded it adds its
 * bounded output indented to the content column. `viewport.estimateTimelineItemRows`
 * mirrors this row count exactly — changing the shape here means changing it there.
 */
function ToolRow({item, width, glyphs, compact, expanded}: {
  item: Extract<TimelineItem, {kind: 'tool'}>;
  width: number;
  glyphs: UiGlyphs;
  compact: boolean;
  expanded: boolean;
}) {
  const theme = useTheme();
  const rowWidth = safeWidth(width);
  const contentWidth = Math.max(1, rowWidth - GUTTER);
  const detail = item.errorDetail || item.detail;
  const duration = item.durationMs !== undefined ? formatDuration(item.durationMs) : '';
  const verbose = expanded && item.output ? limitTerminalText(item.output, compact ? 24 : 80) : undefined;
  const disclosure = item.output ? (expanded ? glyphs.expanded : glyphs.collapsed) : '';
  return (
    <Box flexDirection="column" marginBottom={compact || item.grouped ? 0 : 1}>
      <AlignedRow
        width={rowWidth}
        gutter={toolGutter(item.state, glyphs)}
        name={item.name}
        nameColor={item.state === 'error' ? theme.error : theme.text}
        detail={detail}
        detailColor={item.state === 'error' ? theme.error : item.state === 'cancelled' ? theme.warning : theme.muted}
        trailing={duration}
        disclosure={disclosure}
      />
      {item.meta ? (
        // The checkpoint line belongs to the row above it, so it starts at the
        // detail column rather than at the content column, where it would read
        // as a separate receipt.
        <Box paddingLeft={GUTTER + toolNameColumn(rowWidth)}>
          <Text color={theme.dim}>
            {truncateDisplay(sanitizeInlineTerminalText(item.meta), Math.max(1, contentWidth - toolNameColumn(rowWidth)))}
          </Text>
        </Box>
      ) : null}
      {verbose ? (
        <Box paddingLeft={GUTTER + 2} flexDirection="column">
          <RichText value={verbose.text} glyphs={glyphs} />
          {verbose.truncated
            ? <Text color={theme.muted}>{glyphs.pending} output clipped; use print mode for the full result</Text>
            : null}
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * Text of a clarification option and its trailing hint. Exported so `viewport`
 * can score their wrapped height from exactly the strings the renderer uses.
 */
export function clarificationOptionLabel(
  option: {label: string; recommended?: boolean},
  index: number,
  chinese: boolean,
): string {
  return `${index + 1}. ${sanitizeInlineTerminalText(option.label)}${option.recommended ? (chinese ? '（推荐）' : ' (recommended)') : ''}`;
}

export function clarificationHint(chinese: boolean): string {
  return chinese
    ? '回复编号、选项名称，或简短说明你的决定。'
    : 'Reply with a number, option label, or a short custom decision.';
}

export function isChineseText(value: string): boolean {
  return CJK_PATTERN.test(value);
}

function contextDegradationLabel(code: string): string {
  if (code === 'local-retrieval-failed') return 'context/unavailable';
  const reason = code.replace(/^local-/u, '') || 'degraded';
  return `fallback/${reason}`;
}

/**
 * Text of the two context receipts. Exported so `viewport` can score their
 * wrapped height from the same string the renderer uses. Callers pass the
 * active glyph set's separator so an ASCII, dumb, or screen-reader terminal
 * never receives a Unicode middot.
 */
export function contextClippedReceiptText(engine: string, hits: number, separator: string): string {
  return `context clipped  ${sanitizeInlineTerminalText(engine)} ${separator} ${hits} span${hits === 1 ? '' : 's'} kept`;
}

export function contextDegradedReceiptText(degradation: ContextDegradation): string {
  return sanitizeInlineTerminalText(
    `${contextDegradationLabel(degradation.code)}  ${contextDegradationDetail(degradation)}`);
}

/**
 * A warning receipt that must stay legible: it wraps to the content column
 * instead of truncating, because these rows carry the reason and the remedy.
 * `viewport` scores it with the same `wrappedRows` calculation as a notice.
 */
function WrappedReceipt({width, glyph, text}: {width: number; glyph: string; text: string}) {
  const theme = useTheme();
  const rowWidth = safeWidth(width);
  return (
    <Box width={rowWidth}>
      <Box width={GUTTER}><Text color={theme.warning}>{sanitizeInlineTerminalText(glyph)}</Text></Box>
      <Box width={Math.max(1, rowWidth - GUTTER)}>
        <Text color={theme.warning} wrap="wrap">{sanitizeInlineTerminalText(text)}</Text>
      </Box>
    </Box>
  );
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
  const contentWidth = Math.max(1, rowWidth - GUTTER);
  const done = tasks.filter((task) => task.status === 'completed').length;
  const active = tasks.filter((task) => task.status === 'in_progress').length;
  const visibleLimit = Math.max(1, maxItems ?? (width < 48 ? 5 : 12));
  const showMeter = rowWidth >= 40;
  const meterWidth = Math.max(8, Math.min(contentWidth - displayWidth(`Plan  ${done}/${tasks.length} `), 32));
  const meterSegments: MeterSegment[] = [
    {label: 'done', value: done, color: theme.success},
    {label: 'active', value: active, color: theme.accent},
  ];
  return (
    // The rail is a panel, not a transcript entry, so it keeps a blank row above
    // as well as below; without it the meter collides with the last reply line.
    // `tui.taskRows` counts both gaps.
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Box paddingLeft={GUTTER}>
        <Text bold color={theme.textStrong}>Plan</Text>
        <Text color={theme.dim}>  {done}/{tasks.length}</Text>
        {showMeter ? <><Text> </Text><MeterBar segments={meterSegments} total={tasks.length} width={meterWidth} glyphs={glyphs} /></> : null}
      </Box>
      {tasks.slice(0, visibleLimit).map((task) => {
        // The step glyphs share the transcript gutter, so a plan reads as part
        // of the same column as the receipts above it.
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
          <Row key={task.id} glyph={<Text color={glyphColor}>{glyph}</Text>}>
            <Text color={task.status === 'completed' ? theme.muted : theme.text} strikethrough={task.status === 'completed'}>
              {truncateDisplay(title, contentWidth)}
            </Text>
          </Row>
        );
      })}
      {tasks.length > visibleLimit
        ? <Box paddingLeft={GUTTER}><Text color={theme.dim}>{truncateDisplay(`${tasks.length - visibleLimit} more`, contentWidth)}</Text></Box>
        : null}
    </Box>
  );
}

export function PermissionCard({call, category, reason, humanOnly = false, width = 80, glyphMode = 'auto', workspace, compact = false, preview}: {
  call: ToolCall;
  category: ToolCategory;
  reason?: string;
  humanOnly?: boolean;
  width?: number;
  glyphMode?: GlyphMode;
  workspace?: string;
  compact?: boolean;
  preview?: {lines: string[]; more: number};
}) {
  const theme = useTheme();
  const glyphs = resolveGlyphs(glyphMode);
  const summary = permissionSummary(call);
  const rowWidth = safeWidth(width);
  const innerWidth = Math.max(1, rowWidth - 2);
  const title = truncateDisplay(`${humanOnly ? 'Live human approval required' : 'Permission required'} ${glyphs.separator} ${category}`, innerWidth);
  const summaryLine = truncateDisplay(`${sanitizeInlineTerminalText(call.name)} ${glyphs.separator} ${summary.label} ${summary.value}`, innerWidth);
  const riskLine = truncateDisplay(permissionRisk(category), innerWidth);
  const argumentCwd = typeof call.arguments.cwd === 'string' ? call.arguments.cwd : undefined;
  const cwd = sanitizeInlineTerminalText(argumentCwd || workspace || '');
  const shortcuts: InlinePart[] = [
    {text: rowWidth >= 96 ? '[y] allow once' : '[y] once', color: theme.success},
    ...(humanOnly ? [] : [{text: rowWidth >= 96 ? '[a] allow target for session' : '[a] session', color: theme.success} as InlinePart]),
    {text: '[n] deny', color: theme.error},
    {text: rowWidth >= 96 ? '[Esc] deny + stop' : '[Esc] stop', color: theme.muted},
  ];
  const compactNarrowShortcuts: InlinePart[] = innerWidth >= 17
    ? [
        {text: '[y] once', color: theme.success},
        ...(humanOnly ? [] : [{text: '[a] sess', color: theme.success} as InlinePart]),
        {text: '[n] no', color: theme.error},
        {text: '[Esc] stop', color: theme.muted},
      ]
    : [
        {text: '[y] yes', color: theme.success},
        ...(humanOnly ? [] : [{text: '[a] sess', color: theme.success} as InlinePart]),
        {text: '[n] no', color: theme.error},
        {text: '[Esc]', color: theme.muted},
      ];
  const marker = glyphs.borderStyle === 'classic' ? '!' : '▎';
  // Decision surface: what, where, risk, keys. Reason prose stays out unless
  // the terminal is wide enough that an extra line does not bury the shortcuts.
  const showReason = !compact && rowWidth >= 72 && reason;
  const reasonLine = showReason
    ? truncateDisplay(redactPermissionText(reason), innerWidth)
    : undefined;
  return (
    <Box flexDirection="column" marginBottom={1} aria-role="radiogroup">
      <PermissionLine marker={marker}><Text bold color={theme.warning}>{title}</Text></PermissionLine>
      <PermissionLine marker={marker}><Text color={theme.text}>{summaryLine}</Text></PermissionLine>
      <PermissionLine marker={marker}><Text color={theme.warning}>{riskLine}</Text></PermissionLine>
      {cwd && rowWidth >= 48 ? <PermissionLine marker={marker}><Text color={theme.muted}>{truncateDisplay(`cwd ${compactDisplayPath(cwd, Math.max(1, innerWidth - 4))}`, innerWidth)}</Text></PermissionLine> : null}
      {reasonLine ? <PermissionLine marker={marker}><Text color={theme.muted}>{reasonLine}</Text></PermissionLine> : null}
      {preview && !compact && rowWidth >= 48 ? (
        <>
          {preview.lines.map((line, index) => (
            <PermissionLine key={`preview-${index}`} marker={marker}>
              <Text color={line.startsWith('+') ? theme.success : line.startsWith('-') ? theme.error : theme.muted}>
                {truncateDisplay(line || ' ', innerWidth)}
              </Text>
            </PermissionLine>
          ))}
          {preview.more > 0 ? (
            <PermissionLine marker={marker}>
              <Text color={theme.muted}>{truncateDisplay(`… ${preview.more} more diff line${preview.more === 1 ? '' : 's'}`, innerWidth)}</Text>
            </PermissionLine>
          ) : null}
        </>
      ) : null}
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

function permissionRisk(category: ToolCategory): string {
  if (category === 'read') return 'workspace content may enter model context';
  if (category === 'write') return 'workspace files may be created, replaced, or deleted';
  if (category === 'shell') return 'a local process may read or change workspace state';
  if (category === 'git') return 'repository state or remotes may change';
  return 'data may leave this machine or remote state may change';
}

export function PromptBar({busy, disabled = false, focused = true, value, placeholder, width = 80, mode = 'chat', queueCount = 0, queuePreview, attachments = [], glyphMode = 'auto', showRule = true, children}: {
  busy: boolean;
  disabled?: boolean;
  focused?: boolean;
  value: string;
  placeholder: string;
  width?: number;
  mode?: 'chat' | 'shell';
  queueCount?: number;
  queuePreview?: string;
  attachments?: string[];
  glyphMode?: GlyphMode;
  showRule?: boolean;
  children: React.ReactNode;
}) {
  const theme = useTheme();
  const glyphs = resolveGlyphs(glyphMode);
  const shell = mode === 'shell';
  const rowWidth = safeWidth(width);
  const contentWidth = Math.max(1, rowWidth - GUTTER);
  const safePlaceholder = sanitizeInlineTerminalText(placeholder);
  const busyHint = contentWidth < 24
    ? `steer ${glyphs.separator} esc stop`
    : contentWidth < 44
      ? `enter steer ${glyphs.separator} esc stop`
      : contentWidth < 72
        ? `enter steer ${glyphs.separator} alt+enter queue ${glyphs.separator} esc stop`
        : `enter steer ${glyphs.separator} alt+enter queue ${glyphs.separator} /queue manage ${glyphs.separator} esc stop`;
  // The composer's mode lives in the prompt glyph and this one hint row. A
  // labelled rule said the same thing a third time, in the loudest position.
  const hint = disabled
    ? `input paused ${glyphs.separator} external editor active`
    : shell
      ? `local command ${glyphs.separator} enter run ${glyphs.separator} esc cancel`
    : busy
      ? busyHint
    : value
      ? `enter send ${glyphs.separator} ctrl+j newline`
      : safePlaceholder;
  const hintText = `${hint}${queueCount ? ` ${glyphs.separator} ${contentWidth < 44 ? `q${queueCount}` : `${queueCount} follow-up${queueCount === 1 ? '' : 's'}`}` : ''}`;
  const safeQueuePreview = sanitizeInlineTerminalText(queuePreview ?? '');
  const queueLabel = `${queueCount} queued`;
  const queuePreviewWidth = Math.max(1, contentWidth - displayWidth(queueLabel) - 2);
  return (
    <Box flexDirection="column">
      {showRule ? <ComposerRule width={rowWidth} color={theme.border} glyphs={glyphs} /> : null}
      {attachments.length ? (
        <Row glyph={<Text color={theme.accent}>{glyphs.context}</Text>}>
          <Text color={theme.muted}>{truncateDisplay(attachments.map((path) => `@${compactDisplayPath(sanitizeInlineTerminalText(path), 28)}`).join('  '), contentWidth)}</Text>
        </Row>
      ) : null}
      {queueCount && safeQueuePreview ? (
        <Row glyph={<Text color={theme.dim}>{glyphs.pending}</Text>}>
          <Text color={theme.muted}>{queueLabel} </Text>
          <Text color={theme.text}>{truncateDisplay(safeQueuePreview, queuePreviewWidth)}</Text>
        </Row>
      ) : null}
      <Box aria-role="textbox">
        <Box width={GUTTER}>
          <Text bold color={disabled || !focused ? theme.dim : shell ? theme.warning : theme.accent}>{shell ? '!' : glyphs.prompt}</Text>
        </Box>
        {children}
      </Box>
      <Box paddingLeft={GUTTER}>
        <Text color={theme.muted}>{truncateDisplay(hintText, contentWidth)}</Text>
      </Box>
    </Box>
  );
}

/**
 * The boundary between the transcript and the composer: one neutral full-width
 * rule. It carries no label — the prompt glyph and hint row already state the
 * mode, and a titled rule made the loudest element in the frame repeat them.
 */
function ComposerRule({width, color, glyphs}: {
  width: number;
  color: string;
  glyphs: UiGlyphs;
}) {
  const character = glyphs.borderStyle === 'classic' ? '-' : '─';
  const rowWidth = safeWidth(width);
  return (
    <Box width={rowWidth} height={1} overflowY="hidden">
      <Text color={color}>{character.repeat(rowWidth)}</Text>
    </Box>
  );
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

export function Footer({busy, approval = false, tokens = 0, changedFiles, width = 80, contextPressure, queueCount = 0, activeAgents = 0, frame, glyphMode = 'auto', mode = 'BUILD', route, identityVisible = false, pinProductIdentity = false}: {
  busy: boolean;
  approval?: boolean;
  tokens?: number;
  maxTokens: number;
  changedFiles: number;
  width?: number;
  contextPressure?: number;
  themeName?: string;
  queueCount?: number;
  activeAgents?: number;
  frame?: string;
  glyphMode?: GlyphMode;
  mode?: string;
  route?: string;
  /**
   * True while the identity header is on screen. The header already states the
   * mode and route, so the footer drops both rather than printing them twice in
   * the same frame.
   */
  identityVisible?: boolean;
  /** Keep the product wordmark in the footer after the opening banner scrolls away. */
  pinProductIdentity?: boolean;
}) {
  const theme = useTheme();
  const glyphs = resolveGlyphs(glyphMode);
  const identityLabel = resolveTerminalAccessibility().screenReader
    ? PRODUCT_NAME
    : PRODUCT_NAME.toUpperCase();
  const rowWidth = safeWidth(width);
  const contentWidth = Math.max(1, rowWidth - GUTTER);
  // A spinner frame is one cell by contract; bound it to the gutter so a longer
  // value cannot displace the status label.
  const safeFrame = truncateDisplay(sanitizeInlineTerminalText(frame ?? ''), GUTTER, '');
  // The status glyph sits in the shared gutter, so the footer starts on the same
  // left edge as every transcript row instead of half a column inboard.
  const statusGlyph = approval ? glyphs.warning : busy ? (safeFrame || glyphs.running) : glyphs.activity;
  const statusColor = approval ? theme.warning : busy ? theme.accent : theme.success;
  const statusLabel = approval ? 'approval required' : busy ? 'working' : 'ready';
  const pressurePart: InlinePart | undefined = contextPressure !== undefined && contextPressure >= 0.75 && rowWidth >= 40
    ? {text: `context ${formatPercent(contextPressure)}`, color: contextPressure >= 0.9 ? theme.error : theme.warning}
    : undefined;
  // Read order follows urgency: live state, then anything demanding attention,
  // then pending work, and finally static reference detail. Only the leading
  // status and genuine signals carry colour; mode, route, and `/help` are
  // reference material and stay dim so the row has one focal point.
  const mainParts: InlinePart[] = [
    {text: statusLabel, color: statusColor},
    ...(pressurePart ? [pressurePart] : []),
    ...(rowWidth >= 40 && changedFiles ? [{text: `${changedFiles} changed`, color: theme.text, optional: true}] : []),
    ...(activeAgents ? [{text: `@${activeAgents}`, color: theme.accent, optional: true}] : []),
    ...(queueCount ? [{text: `q${queueCount}`, color: theme.muted, optional: true}] : []),
    // Pin the wordmark in the footer whenever the header is hidden so identity
    // survives after the opening banner scrolls out of the transcript viewport.
    ...(pinProductIdentity ? [{text: identityLabel, color: theme.muted, optional: true}] : []),
    ...(!identityVisible && rowWidth >= 28 ? [{text: sanitizeInlineTerminalText(mode), color: theme.muted}] : []),
    ...(!identityVisible && rowWidth >= 64 && route ? [{text: sanitizeInlineTerminalText(route), color: theme.dim, optional: true}] : []),
    ...(rowWidth >= 72 && tokens > 0 ? [{text: `${formatTokens(tokens)} tok`, color: theme.dim, optional: true}] : []),
    ...(rowWidth >= 72 ? [{text: '/help', color: theme.dim, optional: true}] : []),
  ];
  return (
    <Row glyph={<Text color={statusColor}>{statusGlyph}</Text>}>
      <InlineRow parts={mainParts} width={contentWidth} separator={`  ${glyphs.separator}  `} separatorColor={theme.border} />
    </Row>
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
  const innerWidth = Math.max(1, rowWidth - GUTTER);
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
    <Box flexDirection="column" marginBottom={1}>
      {titleText ? (
        <Box paddingLeft={GUTTER}>
          <Text bold color={theme.textStrong}>{truncateDisplay(titleText, innerWidth)}</Text>
        </Box>
      ) : null}
      {!visible.length && empty ? <Box paddingLeft={GUTTER}><Text color={theme.muted}>{truncateDisplay(empty, innerWidth)}</Text></Box> : null}
      {visible.map((suggestion, index) => {
        const absoluteIndex = start + index;
        const active = absoluteIndex === selectedIndex;
        // The selection marker shares the transcript gutter, and only the active
        // row carries the accent — selection is the one live thing in the panel.
        const labelLimit = rowWidth >= 64
          ? Math.min(24, innerWidth)
          : innerWidth;
        const label = truncateDisplay(sanitizeInlineTerminalText(suggestion.label), Math.max(1, labelLimit));
        const description = sanitizeInlineTerminalText(suggestion.description);
        const descriptionLimit = Math.max(0, innerWidth - displayWidth(label) - 2);
        return (
          <Box key={`${suggestion.value}-${absoluteIndex}`} backgroundColor={active ? theme.selection : undefined}>
            <Box width={GUTTER}>
              {active ? <Text bold color={theme.accent}>{glyphs.prompt}</Text> : null}
            </Box>
            <Text bold={active} color={active ? theme.selectionText : theme.muted}>
              {label}
            </Text>
            {rowWidth >= 64 && descriptionLimit >= 4
              ? <Text color={theme.muted}>  {truncateDisplay(description, descriptionLimit)}</Text>
              : null}
          </Box>
        );
      })}
      {rowWidth < 64 && activeSuggestion?.description
        ? <Box paddingLeft={GUTTER}><Text color={theme.muted}>{truncateDisplay(sanitizeInlineTerminalText(activeSuggestion.description), innerWidth)}</Text></Box>
        : null}
      <Box paddingLeft={GUTTER}><Text color={theme.muted}>{truncateDisplay(hint, innerWidth)}</Text></Box>
    </Box>
  );
}

export function ActivityLine({activity, frame, width = 80, run}: {
  activity?: ActivityState;
  frame: string;
  width?: number;
  /** Run-wide telemetry: start time plus token flow since the run began. */
  run?: {startedAt: number; inputTokens: number; outputTokens: number};
}) {
  const theme = useTheme();
  if (!activity) return null;
  const glyphs = resolveGlyphs();
  const rowWidth = safeWidth(width);
  const contentWidth = Math.max(1, rowWidth - GUTTER);
  // Everything after the label is reference telemetry, most disposable last:
  // the turn, the run clock, the token flow, then the interrupt hint.
  const detail = [
    activity.turn ? `turn ${activity.turn}` : '',
    run ? elapsed(run.startedAt) : '',
    run && (run.inputTokens > 0 || run.outputTokens > 0)
      ? `${glyphs.up}${formatTokens(run.inputTokens)} ${glyphs.down}${formatTokens(run.outputTokens)} tok`
      : '',
    rowWidth >= 84 ? 'esc interrupts' : '',
  ].filter(Boolean).join(` ${glyphs.separator} `);
  const detailWidth = rowWidth >= 48 && detail ? displayWidth(detail) + 2 : 0;
  // A spinner frame is one cell by contract; bound it to the gutter so a longer
  // value cannot push the label out of the shared content column.
  const safeFrame = truncateDisplay(sanitizeInlineTerminalText(frame), GUTTER, '');
  const label = truncateDisplay(sanitizeInlineTerminalText(activity.label), Math.max(1, contentWidth - detailWidth));
  return (
    // The spinner lives in the shared gutter so the live row lines up with the
    // receipts above it instead of starting two columns further in.
    <Box marginBottom={1} flexDirection="column">
      <Row glyph={<Text color={theme.accent}>{safeFrame}</Text>}>
        <Text color={theme.text}>{label}</Text>
        {rowWidth >= 48 && detail ? <Text color={theme.dim}>{`  ${detail}`}</Text> : null}
      </Row>
      {rowWidth < 48 && detail ? <Box paddingLeft={GUTTER}><Text color={theme.dim}>{truncateDisplay(detail, contentWidth)}</Text></Box> : null}
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
  const innerWidth = Math.max(1, rowWidth - GUTTER);
  const titleText = sanitizeInlineTerminalText(title);
  const bullet = <Text color={theme.dim}>{glyphs.bullet}</Text>;
  return (
    <Box flexDirection="column" marginBottom={1}>
      {hideTitle ? null : <Box paddingLeft={GUTTER}><Text bold color={theme.textStrong}>{truncateDisplay(titleText, innerWidth)}</Text></Box>}
      {header ?? null}
      {entries.length ? entries.map((entry, index) => {
        // Tone is the only colour a list row may claim, and only when the entry
        // genuinely carries that state; ordinary rows stay body text.
        const color = entry.tone === 'success' ? theme.success
          : entry.tone === 'warning' ? theme.warning
            : entry.tone === 'error' ? theme.error : theme.text;
        const entryLabel = sanitizeInlineTerminalText(entry.label);
        const entryDetail = entry.detail ? sanitizeInlineTerminalText(entry.detail) : undefined;
        const labelLimit = entryDetail ? Math.max(1, Math.min(28, innerWidth - 4)) : innerWidth;
        const label = truncateDisplay(entryLabel, labelLimit);
        // Pad each row to a stable inner width so incremental terminal
        // repaints overwrite trailing cells; short rows must not leave ghost
        // characters from a previously longer row at the same position.
        if (rowWidth < 52 && entryDetail) {
          return (
            <Box key={`${entry.label}-${index}`} flexDirection="column">
              <Row glyph={bullet}><Text color={color}>{padDisplay(label, innerWidth)}</Text></Row>
              <Box paddingLeft={GUTTER}>
                <Text color={theme.muted}>{padDisplay(truncateDisplay(entryDetail, innerWidth), innerWidth)}</Text>
              </Box>
            </Box>
          );
        }
        const detailLimit = Math.max(1, innerWidth - displayWidth(label) - 2);
        const detailText = entryDetail ? truncateDisplay(entryDetail, detailLimit) : '';
        const trailing = Math.max(0, innerWidth - displayWidth(label) - (entryDetail ? 2 + displayWidth(detailText) : 0));
        return (
          <Row key={`${entry.label}-${index}`} glyph={bullet}>
            <Text color={color}>{label}</Text>
            {entryDetail ? <Text color={theme.muted}>{`  ${detailText}`}</Text> : null}
            {trailing > 0 ? <Text>{' '.repeat(trailing)}</Text> : null}
          </Row>
        );
      }) : <Row glyph={bullet}><Text color={theme.dim}>{padDisplay('none', innerWidth)}</Text></Row>}
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

export interface ContextInspectorContent {
  status: ContextInspectorStatus;
  working?: WorkingMemory | undefined;
  summary?: string | undefined;
  memory?: string | undefined;
  connections?: string | undefined;
  sources?: ContextSource[] | undefined;
  compact?: boolean;
  /** Separator from the active glyph set, so ASCII terminals stay ASCII. */
  separator: string;
}

/**
 * Build the inspector's evidence rows. Exported so `viewport` scores exactly
 * what the renderer will draw instead of guessing at a row count.
 */
export function contextInspectorEntries({
  status, working, summary, memory, connections, sources, compact = false, separator,
}: ContextInspectorContent): ListEntry[] {
  const hasCompactedContext = status.compactedMessages > 0 || Boolean(summary);
  const entries: ListEntry[] = [
    {label: 'model input', detail: `~${formatTokens(status.promptTokens)}/${formatTokens(status.contextWindowTokens)} tokens ${separator} ${status.promptSource === 'none' ? 'not requested' : status.promptSource}`},
    {label: 'transcript', detail: `${status.messageCount} persisted messages ${separator} ~${formatTokens(status.activeTokens)} tokens ${separator} tools ~${formatTokens(status.toolTokens)}`},
    {label: 'short-term', detail: working ? `${working.focus || working.goal || 'ready'} ${separator} ${relativeTime(working.lastUpdatedAt)}` : 'not established'},
    {label: 'summary', detail: hasCompactedContext ? `~${formatTokens(status.summaryTokens)} tokens ${separator} ${status.compactedMessages} compacted${summary ? '' : ` ${separator} facts`}` : 'not created'},
    {label: 'long-term', detail: memory ?? `retrieved by relevance ${separator} untrusted context`},
  ];
  if (status.epochIndex !== undefined && status.epochCount !== undefined &&
    status.epochTokens !== undefined && status.epochBudget !== undefined &&
    status.lifetimeTokens !== undefined && status.lifetimeBudget !== undefined) {
    entries.splice(1, 0, {
      label: 'epoch',
      detail: `#${status.epochIndex} ${formatTokens(status.epochTokens)}/${formatTokens(status.epochBudget)} ${separator} lifetime ${formatTokens(status.lifetimeTokens)}/${formatTokens(status.lifetimeBudget)}`,
    });
  }
  if (!compact && working?.constraints.length) entries.push({label: `constraints ${working.constraints.length}`, detail: working.constraints.slice(0, 2).join(` ${separator} `)});
  if (!compact && working?.decisions.length) entries.push({label: `decisions ${working.decisions.length}`, detail: working.decisions.slice(0, 2).join(` ${separator} `)});
  if (!compact && working?.openQuestions.length) entries.push({label: `open ${working.openQuestions.length}`, detail: working.openQuestions.slice(0, 2).join(` ${separator} `), tone: 'warning'});
  if (!compact && working?.relevantFiles.length) entries.push({label: 'relevant files', detail: working.relevantFiles.map((file) => compactDisplayPath(sanitizeInlineTerminalText(file), 28)).join(` ${separator} `)});
  if (sources?.length) {
    const pinned = sources.filter((source) => source.state === 'pinned');
    const muted = sources.filter((source) => source.state === 'muted');
    const pinnedTokens = pinned.reduce((sum, source) => sum + source.tokens, 0);
    const names = pinned.map((source) => compactDisplayPath(sanitizeInlineTerminalText(source.path), 28)).join(` ${separator} `);
    entries.push({
      label: `pinned ${pinned.length}${muted.length ? ` ${separator} ${muted.length} muted` : ''}`,
      detail: pinned.length
        ? `~${formatTokens(pinnedTokens)} tokens ${separator} survives compaction ${separator} ${names}`
        : `${muted.length} muted ${separator} 0 tokens`,
      tone: 'success',
    });
  }
  if (connections) entries.push({label: 'connections', detail: connections});
  return entries;
}

/**
 * Rendered height of a `ListPanel`, including its trailing gap. A narrow
 * terminal stacks each entry's detail onto its own row, so the count depends on
 * the width; `viewport` needs the same answer the renderer produces.
 */
export function listPanelRows(entries: readonly ListEntry[], width: number, hideTitle = false): number {
  const stacked = safeWidth(width) < 52;
  const entryRows = entries.length
    ? entries.reduce((rows, entry) => rows + (stacked && entry.detail ? 2 : 1), 0)
    : 1;
  return (hideTitle ? 0 : 1) + entryRows + 1;
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
  const hasCompactedContext = status.compactedMessages > 0 || Boolean(summary);
  if (minimal) {
    const rowWidth = safeWidth(width);
    const innerWidth = Math.max(1, rowWidth - GUTTER);
    const modelInput = `~${formatTokens(status.promptTokens)}/${formatTokens(status.contextWindowTokens)} ${status.promptSource}`;
    const focus = sanitizeTerminalText(working?.focus || working?.goal || (hasCompactedContext ? 'handoff ready' : 'not established'))
      .replace(/\s+/g, ' ')
      .trim() || 'not established';
    return (
      <Box flexDirection="column" paddingLeft={GUTTER}>
        <Text bold color={theme.textStrong}>
          {truncateDisplay(`Context ${glyphs.separator} window ${formatPercent(status.pressure)} ${glyphs.separator} ${modelInput}`, innerWidth)}
        </Text>
        <Text color={working ? theme.text : theme.muted}>
          {truncateDisplay(`working ${focus}`, innerWidth)}
        </Text>
      </Box>
    );
  }
  const entries = contextInspectorEntries({
    status,
    working,
    summary,
    memory,
    connections,
    sources,
    compact,
    separator: glyphs.separator,
  });
  const rowWidth = safeWidth(width);
  const innerWidth = Math.max(1, rowWidth - GUTTER);
  const pressureColor = status.pressure >= 0.9 ? theme.error : status.pressure >= 0.75 ? theme.warning : theme.accent;
  const segments: MeterSegment[] = [
    {label: 'model input', value: status.promptTokens, color: theme.accent},
  ];
  // The meter only appears when the heading leaves genuine room for it. Ink
  // shrinks flex children rather than dropping them, so an over-wide meter used
  // to squeeze the heading into `Contex· windo31%`.
  const headingWidth = displayWidth(`Context ${glyphs.separator} window ${formatPercent(status.pressure)} `);
  const meterRoom = innerWidth - headingWidth;
  const showMeter = meterRoom >= 8;
  const meterWidth = Math.max(8, Math.min(meterRoom, 48));
  return (
    // The trailing gap belongs to the evidence list, which already owns one;
    // adding a second here left a stray blank row under the panel.
    <Box flexDirection="column">
      <Box paddingLeft={GUTTER} height={1} overflow="hidden">
        <Text bold color={theme.textStrong}>{`Context `}</Text>
        <Text color={theme.dim}>{`${glyphs.separator} window `}</Text>
        <Text bold color={pressureColor}>{formatPercent(status.pressure)}</Text>
        {showMeter ? <><Text> </Text><MeterBar segments={segments} total={status.contextWindowTokens} width={meterWidth} glyphs={glyphs} /></> : null}
      </Box>
      {/* The list keeps the full width so its bullets land in the shared gutter
          and every label aligns with the heading above. */}
      <ListPanel title="" hideTitle entries={entries} width={rowWidth} glyphMode={glyphMode} />
    </Box>
  );
}

function ThemePreview({name, width, glyphs}: {name: string; width: number; glyphs: UiGlyphs}) {
  const theme = useTheme();
  const innerWidth = Math.max(1, safeWidth(width) - GUTTER);
  const colored = Boolean(theme.accent || theme.success || theme.warning || theme.error);
  // The swatch strip is one row at every width: without colour it degrades to a
  // truncated name list rather than wrapping into a second, unaccounted row.
  return (
    <Box marginBottom={1} paddingLeft={GUTTER} flexDirection="column">
      <Text bold color={theme.textStrong}>{truncateDisplay(`Theme ${sanitizeInlineTerminalText(name)}`, innerWidth)}</Text>
      {colored ? (
        <Box height={1} overflow="hidden">
          <Text color={theme.border}>{glyphs.swatch}</Text><Text color={theme.accent}> {glyphs.swatch}</Text>
          <Text color={theme.success}> {glyphs.swatch}</Text><Text color={theme.warning}> {glyphs.swatch}</Text><Text color={theme.error}> {glyphs.swatch}</Text>
        </Box>
      ) : (
        <Text>{truncateDisplay(
          `text ${glyphs.separator} accent ${glyphs.separator} success ${glyphs.separator} warning ${glyphs.separator} error`,
          innerWidth,
        )}</Text>
      )}
    </Box>
  );
}

type BannerItem = Extract<TimelineItem, {kind: 'banner'}>;

interface BannerReceipt {
  tone: 'success' | 'warning' | 'meta' | 'quiet';
  label: string;
  detail: string;
}

interface BannerLayout {
  /** Render the block wordmark; falls back to the text wordmark elsewhere. */
  logo: boolean;
  /** `undefined` only in the single-line variant. */
  tagline?: string;
  receipts: BannerReceipt[];
  hint?: string;
  /** Single-line fallback for very narrow terminals. */
  line?: string;
  /** Content rows excluding the trailing transcript gap. */
  rows: number;
}

const BANNER_TAGLINE = 'context-first coding agent';
const BANNER_LABEL_COLUMN = 11;

function formatBannerDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

/**
 * The one layout model both the renderer and the viewport estimator consume.
 * Every branch below produces single-line rows only — the banner never wraps,
 * so `rows` is exact at any width and the scroll anchor cannot drift.
 */
export function bannerLayout(item: BannerItem, width: number, glyphs: UiGlyphs): BannerLayout {
  const rowWidth = safeWidth(width);
  const separator = ` ${glyphs.separator} `;
  const unicode = glyphs.borderStyle === 'round';
  if (rowWidth < 30) {
    const state = item.status === 'ready' ? 'ready' : item.status === 'empty' ? 'empty' : 'setup';
    // Ultra-narrow terminals keep the product name in the one-line banner; the
    // footer still carries the live ready state when the line cannot fit it.
    const line = rowWidth < 24
      ? `${PRODUCT_NAME.toUpperCase()}${separator}v${item.version}`
      : `${PRODUCT_NAME.toUpperCase()}${separator}${state}${separator}v${item.version}`;
    return {logo: false, receipts: [], line, rows: 1};
  }

  // The three-row goose is a wide-terminal ceremony only. Ordinary widths keep
  // the compact flight mark so the composer stays inside the first handful of
  // rows; workspace/model/trust stay in `/status`, not the resting frame.
  const logo = unicode && rowWidth >= GOOSE_MIN_WIDTH;
  const indexDetail = item.status === 'ready'
    ? item.files !== undefined
      ? [
        'local context',
        `${item.files.toLocaleString('en-US')} files`,
        ...(item.chunks !== undefined && rowWidth >= 64 ? [`${item.chunks.toLocaleString('en-US')} chunks`] : []),
        item.rebuilt
          ? `indexed${item.durationMs !== undefined ? ` in ${formatBannerDuration(item.durationMs)}` : ''}`
          : 'reused',
      ].join(separator)
      : `local context verified`
    : item.status === 'empty'
      ? 'empty workspace — no source files indexed yet'
      : 'setup required — follow the notice below';
  const receipts: BannerReceipt[] = [{
    tone: item.status === 'ready' ? 'success' : 'warning',
    label: item.status === 'blocked' ? 'setup' : item.status === 'ready' ? 'ready' : 'index',
    detail: indexDetail,
  }];
  const hint = logo
    ? undefined
    : rowWidth >= 56
      ? `/help${separator}@file${separator}/commands`
      : `/help${separator}@file`;
  // Keep the version visible at ordinary widths: the long tagline truncates
  // before `vX` on 40-column terminals, which hides the only version signal.
  const tagline = logo || rowWidth >= 56
    ? `${BANNER_TAGLINE}${separator}v${item.version}`
    : `v${item.version}`;
  // Goose lockup: art (with wordmark/tagline beside) + one receipt. Compact:
  // flight identity + receipt + short hint. No blank spacer rows.
  const rows = logo
    ? GOOSE_HEIGHT + receipts.length
    : 1 + receipts.length + (hint ? 1 : 0);
  return {
    logo,
    tagline,
    receipts,
    rows,
    ...(hint ? {hint} : {}),
  };
}

/** Exact content height of a banner at `width`; the viewport adds the trailing gap. */
export function bannerContentRows(item: BannerItem, width: number, glyphs: UiGlyphs = resolveGlyphs()): number {
  return bannerLayout(item, width, glyphs).rows;
}

function BannerReceiptRow({receipt, width, glyphs}: {receipt: BannerReceipt; width: number; glyphs: UiGlyphs}) {
  const theme = useTheme();
  const glyph = receipt.tone === 'success'
    ? glyphs.success
    : receipt.tone === 'warning'
      ? glyphs.warning
      : glyphs.pending;
  const color = receipt.tone === 'success' ? theme.success : receipt.tone === 'warning' ? theme.warning : theme.muted;
  const detailWidth = Math.max(1, width - GUTTER - BANNER_LABEL_COLUMN);
  return (
    <Box height={1} overflowY="hidden">
      <Box width={GUTTER}><Text color={color}>{glyph}</Text></Box>
      <Text color={receipt.tone === 'quiet' ? theme.dim : theme.muted}>{padDisplay(receipt.label, BANNER_LABEL_COLUMN)}</Text>
      <Text color={receipt.tone === 'warning' ? theme.warning : receipt.tone === 'quiet' ? theme.dim : theme.text} wrap="truncate">
        {truncateDisplay(receipt.detail, detailWidth)}
      </Text>
    </Box>
  );
}

function Banner({engine, status, version, width, glyphs, files, chunks, rebuilt, reused, durationMs, workspace, model, trust}: {
  engine: string;
  status: 'ready' | 'empty' | 'blocked';
  version: string;
  width: number;
  glyphs: UiGlyphs;
  files?: number;
  chunks?: number;
  rebuilt?: boolean;
  reused?: number;
  durationMs?: number;
  workspace?: string;
  model?: string;
  trust?: string;
}) {
  const theme = useTheme();
  const rowWidth = safeWidth(width);
  const contentWidth = Math.max(1, rowWidth - GUTTER);
  const item: BannerItem = {
    id: 'banner', kind: 'banner', engine, status, version,
    ...(files !== undefined ? {files} : {}),
    ...(chunks !== undefined ? {chunks} : {}),
    ...(rebuilt !== undefined ? {rebuilt} : {}),
    ...(reused !== undefined ? {reused} : {}),
    ...(durationMs !== undefined ? {durationMs} : {}),
    ...(workspace ? {workspace} : {}),
    ...(model ? {model} : {}),
    ...(trust ? {trust} : {}),
  };
  const layout = bannerLayout(item, rowWidth, glyphs);
  const spokenDetail = `${PRODUCT_NAME} v${version}. ${layout.receipts.map((receipt) => `${receipt.label}: ${receipt.detail}.`).join(' ') || `${status}.`}`;

  if (layout.line) {
    const glyph = status === 'ready' ? glyphs.success : glyphs.warning;
    const color = status === 'ready' ? theme.success : theme.warning;
    return (
      <Box marginBottom={1} height={1} overflowY="hidden" aria-label={spokenDetail}>
        <Box width={GUTTER}><Text bold color={color}>{glyph}</Text></Box>
        <Text color={status === 'ready' ? theme.text : theme.warning}>{truncateDisplay(layout.line, contentWidth)}</Text>
      </Box>
    );
  }

  const gooseColors = gooseRowColors(theme);
  const mark = flightMark(glyphs);
  const wordmark = PRODUCT_NAME.toUpperCase();
  // Beside the goose: product name on the head row, tagline on the body, so
  // the animal and the type form one lockup rather than a logo stacked on copy.
  const besideWidth = Math.max(1, contentWidth - GOOSE_WIDTH - 1);
  const identityRemainder = Math.max(
    1,
    rowWidth - displayWidth(mark) - 1 - displayWidth(wordmark) - 2,
  );
  return (
    <Box marginBottom={1} flexDirection="column" aria-label={spokenDetail}>
      {layout.logo ? (
        GOOSE_LINES.map((line, index) => (
          <Box key={`goose-${index}`} height={1} overflowY="hidden" paddingLeft={GUTTER}>
            <Text color={gooseColors[index] || theme.accent} aria-hidden>{line}</Text>
            <Text color={index === 0 ? theme.accent : theme.dim}>
              {truncateDisplay(
                index === 0 ? ` ${wordmark}` : index === 1 ? ` ${layout.tagline ?? ''}` : '',
                besideWidth,
              )}
            </Text>
          </Box>
        ))
      ) : (
        <Box height={1} overflowY="hidden">
          <Text color={theme.accent} aria-hidden>{mark} </Text>
          <Text bold color={theme.accent} aria-label={PRODUCT_NAME}>{wordmark}</Text>
          <Text color={theme.dim}>{truncateDisplay(`  ${layout.tagline ?? ''}`, identityRemainder)}</Text>
        </Box>
      )}
      {layout.receipts.map((receipt) => (
        <BannerReceiptRow key={receipt.label} receipt={receipt} width={rowWidth} glyphs={glyphs} />
      ))}
      {layout.hint ? (
        <Box height={1} overflowY="hidden">
          <Box width={GUTTER}><Text color={theme.accent}>{glyphs.prompt}</Text></Box>
          <Text color={theme.dim}>{truncateDisplay(layout.hint, contentWidth)}</Text>
        </Box>
      ) : null}
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
  const contentWidth = Math.max(1, availableWidth - GUTTER);
  const compact = availableWidth < 48;
  // Narrow terminals prioritise the actual version delta. The long explanatory
  // copy and command must never push both version numbers beyond the viewport.
  const parts = compact ? [
    {text: `v${current}`, color: theme.dim, bold: false},
    {text: ` ${glyphs.arrow} `, color: theme.muted, bold: false},
    {text: `v${latest}`, color: theme.accent, bold: true},
  ] : [
    {text: 'a new version is available  ', color: theme.text, bold: false},
    {text: `v${current}`, color: theme.dim, bold: false},
    {text: ` ${glyphs.arrow} `, color: theme.muted, bold: false},
    // The new version is the actionable value, so it takes the accent. `success`
    // is reserved for evidence that something finished, and nothing has yet.
    {text: `v${latest}`, color: theme.accent, bold: true},
    {text: `   ${command}`, color: theme.dim, bold: false},
  ];
  const raw = parts.map((part) => part.text).join('');
  const rendered = truncateDisplay(raw, contentWidth);
  // When the line fits, render the multi-colour spans; if truncation kicked in
  // we fall back to a single dim line so no span is left dangling mid-word.
  const truncated = rendered !== raw;
  // Highlights are already sanitised and bounded (≤4 short lines) upstream; each
  // reads as a dim continuation line under the version delta and is truncated to
  // the width so a long entry can never wrap into the transcript.
  const bullets = (highlights ?? []).map((line) =>
    truncateDisplay(sanitizeInlineTerminalText(line), contentWidth));
  return (
    <Box marginBottom={1} flexDirection="column">
      <Row glyph={<Text bold color={theme.accent}>{glyphs.up}</Text>}>
        {truncated
          ? <Text color={theme.muted}>{rendered}</Text>
          : parts.map((part, index) => (
            <Text key={index} color={part.color} bold={part.bold}>{part.text}</Text>
          ))}
      </Row>
      {compact ? <Box paddingLeft={GUTTER}><Text color={theme.dim}>{truncateDisplay(`run ${command}`, contentWidth)}</Text></Box> : null}
      {bullets.map((line, index) => (
        <Box key={index} paddingLeft={GUTTER}><Text color={theme.dim}>{line}</Text></Box>
      ))}
    </Box>
  );
}

/**
 * Render assistant markdown as terminal prose. Fenced code and quotes get a
 * quiet left rail instead of a per-line marker, so a block reads as one unit
 * rather than a column of punctuation. `viewport.richTextRows` mirrors these
 * rules exactly; changing the row shape here means changing it there too.
 */
function RichText({value, glyphs}: {value: string; glyphs: UiGlyphs}) {
  const theme = useTheme();
  let inCode = false;
  let codeLanguage = '';
  return <>{sanitizeTerminalText(value).split('\n').flatMap((line, index) => {
    const fence = line.trim().match(/^```+\s*([\w+#.-]*)/u);
    if (fence) {
      inCode = !inCode;
      // Only an opening fence with a language carries information; a bare fence
      // and every closing fence render nothing rather than a stray glyph.
      codeLanguage = inCode ? fence[1] ?? '' : '';
      return codeLanguage
        ? [<Text key={index} color={theme.dim}>{`${glyphs.codeRail} ${codeLanguage}`}</Text>]
        : [];
    }
    if (inCode) {
      const color = line.startsWith('+')
        ? theme.diffAdded
        : line.startsWith('-') ? theme.diffRemoved : theme.code;
      return [
        <Text key={index}>
          <Text color={theme.border}>{glyphs.codeRail} </Text>
          {line.startsWith('+') || line.startsWith('-')
            ? <Text color={color}>{line || ' '}</Text>
            : <HighlightedCode value={line || ' '} language={codeLanguage} />}
        </Text>,
      ];
    }
    const heading = line.match(/^#{1,4}\s+(.+)$/);
    if (heading) return [<Text key={index} bold color={theme.heading}><InlineMarkup value={heading[1] as string} /></Text>];
    const bullet = line.match(/^(\s*)([-*]|\d+\.)\s+(.+)$/);
    if (bullet) {
      const marker = bullet[2] === '-' || bullet[2] === '*' ? glyphs.listBullet : bullet[2] as string;
      return [
        <Text key={index} wrap="wrap">
          {bullet[1]}<Text color={theme.dim}>{marker} </Text><InlineMarkup value={bullet[3] as string} />
        </Text>,
      ];
    }
    if (line.startsWith('> ')) {
      return [
        <Text key={index} wrap="wrap">
          <Text color={theme.border}>{glyphs.codeRail} </Text>
          <Text color={theme.muted}><InlineMarkup value={line.slice(2)} /></Text>
        </Text>,
      ];
    }
    return [<Text key={index} color={theme.text} wrap="wrap"><InlineMarkup value={line || ' '} /></Text>];
  })}</>;
}

const codeKeywords = new Set([
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'def', 'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'from',
  'function', 'if', 'import', 'in', 'interface', 'let', 'new', 'None', 'null',
  'return', 'switch', 'throw', 'true', 'try', 'type', 'undefined', 'while', 'yield',
]);

/**
 * The exact visible text `RichText` will render for one source line, or `null`
 * when the line renders nothing at all (a bare or closing fence).
 *
 * Exported for `viewport.richTextRows`, which has to wrap the same string at the
 * same width to score an item's height. Composing the prefix into the string
 * matters: Ink wraps a whole `<Text>` including its rail or bullet marker, so
 * scoring the content alone against a reduced width disagrees with the render
 * whenever a line wraps.
 *
 * `state` carries the fence tracking across calls, since a line's meaning
 * depends on whether a fence is open.
 */
export interface RichTextScanState {
  inCode: boolean;
}

export function richTextLine(line: string, state: RichTextScanState, codeRail = '│', listBullet = '•'): string | null {
  const fence = line.trim().match(/^```+\s*([\w+#.-]*)/u);
  if (fence) {
    state.inCode = !state.inCode;
    const language = state.inCode ? fence[1] ?? '' : '';
    return language ? `${codeRail} ${language}` : null;
  }
  if (state.inCode) return `${codeRail} ${line || ' '}`;
  const heading = line.match(/^#{1,4}\s+(.+)$/);
  if (heading) return inlineMarkupText(heading[1] as string);
  const bullet = line.match(/^(\s*)([-*]|\d+\.)\s+(.+)$/);
  if (bullet) {
    const marker = bullet[2] === '-' || bullet[2] === '*' ? listBullet : bullet[2] as string;
    return `${bullet[1]}${marker} ${inlineMarkupText(bullet[3] as string)}`;
  }
  if (line.startsWith('> ')) return `${codeRail} ${inlineMarkupText(line.slice(2))}`;
  return inlineMarkupText(line || ' ') || ' ';
}

/** Visible text of an inline-markup span: the `` ` `` and `**` delimiters are chrome. */
function inlineMarkupText(value: string): string {
  return value.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).filter(Boolean).map((part) => {
    if (part.startsWith('`') && part.endsWith('`')) return part.slice(1, -1);
    if (part.startsWith('**') && part.endsWith('**')) return part.slice(2, -2);
    return part;
  }).join('');
}

/**
 * Deliberately restrained highlighting. An earlier version painted strings with
 * `success` and numbers with `warning`, so every code block competed with the
 * real status rows for the same two colours. Literals now use a neutral step
 * below `code`, and only keywords take the accent.
 */
function HighlightedCode({value, language}: {value: string; language: string}) {
  const theme = useTheme();
  const commentPrefix = /^(?:py|python|sh|shell|bash|zsh)$/i.test(language) ? '#' : '//';
  const tokens = value.split(/(`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\/\/.*$|#.*$|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/gu);
  return <>{tokens.filter(Boolean).map((token, index) => {
    if (token.startsWith(commentPrefix)) return <Text key={index} color={theme.dim}>{token}</Text>;
    if (/^[`'"]/u.test(token)) return <Text key={index} color={theme.codeLiteral}>{token}</Text>;
    if (/^\d/u.test(token)) return <Text key={index} color={theme.codeLiteral}>{token}</Text>;
    if (codeKeywords.has(token)) return <Text key={index} bold color={theme.accent}>{token}</Text>;
    return <Text key={index} color={theme.code}>{token}</Text>;
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
