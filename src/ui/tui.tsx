import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Box, render, Text, useApp, useInput, useStdin, useWindowSize} from 'ink';
import {relative} from 'node:path';
import type {AgentRunner} from '../agent/index.js';
import {PLAN_MODE_INSTRUCTIONS} from '../agent/prompt.js';
import {resolveAgentModelRoute} from '../agent/model-route.js';
import {listConnectionModels} from '../agent/model-catalog.js';
import {discoverCustomCommands, expandCustomCommand, type CustomCommand} from './custom-commands.js';
import {providerApiKeyEnv, saveUiPreference} from '../config.js';
import {
  activeMentionToken,
  contextHitMentionSuggestions,
  getMentionPathIndex,
  invalidateMentionPathIndex,
  rankMentionSuggestions,
  replaceActiveMentionToken,
} from '../context/mentions.js';
import type {ExtensionRuntime} from '../runtime/index.js';
import {evaluatePermission} from '../tools/index.js';
import type {
  AgentEvent,
  ChatMessage,
  MosaicConfig,
  Session,
  SessionTask,
  PermissionGrant,
  ToolCall,
  ToolCategory,
} from '../types.js';
import {PRODUCT_COMMAND, PRODUCT_NAME} from '../brand.js';
import packageJson from '../../package.json' with {type: 'json'};
import {
  ActivityLine,
  CommandPalette,
  ContextInspector,
  Footer,
  Header,
  PermissionCard,
  PromptBar,
  resolveGlyphs,
  TaskRail,
  TeamSummary,
  TeamWorkbench,
  type TeamRunSummary,
  type TeamWorkbenchView,
  Timeline,
  type ActivityState,
  type ContextInspectorStatus,
  type ListEntry,
  type TimelineItem,
} from './components.js';
import type {WorkspaceReadiness} from './workspace-preparation.js';
import {commandDefinitions, commandSuggestions, reservedCommandNames} from './commands.js';
import {refreshUpdateCache, resolveCachedUpdateNotice, type UpdateNotice} from '../utils/update-check.js';
import {ComposerInput} from './composer.js';
import {
  createHistorySearchState,
  moveHistorySearchSelection,
  resolveHistorySearch,
  selectedHistorySearchValue,
  setHistorySearchQuery,
  type HistorySearchState,
} from './history-search.js';
import {displayWidth, sanitizeTerminalText, terminalEllipsis, truncateDisplay} from './text.js';
import {resolveKittyKeyboardConfig, resolveTerminalAccessibility} from './terminal-capabilities.js';
import {nextTheme, reloadUserThemes, resolveThemeWithColor, ThemeProvider, themes} from './theme.js';
import {editComposerDraft} from './external-editor.js';
import {starterHint} from './starter-hints.js';
import {buildPermissionPreview, permissionPreviewRows, type PermissionPreview} from './permission-preview.js';
import {estimateTimelineItemRows, fitTimelineToRows} from './viewport.js';
import {
  buildRedactedReviewBundle,
  parseReviewScope,
  reviewRequest,
  reviewTurnInstructions,
} from './review-bundle.js';
import {
  endStreamingAssistants,
  finalizeAssistant,
  firstLine,
  nextId,
  cancelAgent,
  startAgent,
  updateAgent,
  updateAgentQueued,
  updateAgentTelemetry,
  updateAssistantDelta,
  updateContractProgress,
  updateTool,
} from './timeline-reducers.js';

interface PermissionRequest {
  call: ToolCall;
  category: ToolCategory;
  reason?: string;
  humanOnly?: boolean;
  preview?: PermissionPreview;
  /** Epoch ms when the card was armed; approvals ignore earlier keystrokes. */
  armedAt: number;
  resolve: (grant: PermissionGrant) => void;
}

/**
 * Keystrokes buffered before the approval card rendered must not grant
 * anything: a person typing a steering sentence can hit y/a the instant the
 * card appears. Denial (n/Esc) stays instant — refusing fast is always safe.
 */
const PERMISSION_ARMING_MS = 300;

/** Second Ctrl+C within this window exits; outside it, the press only warns. */
const EXIT_CONFIRM_WINDOW_MS = 2_000;

interface AgentQueueItem {
  kind: 'agent';
  display: string;
  runInput: string;
  turnInstructions?: string;
  readOnly?: boolean;
}

interface LocalQueueItem {
  kind: 'local';
  display: string;
  value: string;
}

type QueueItem = AgentQueueItem | LocalQueueItem;
type LocalCommandResult = false | true | AgentQueueItem;

export interface TuiOptions {
  runner: AgentRunner;
  config: MosaicConfig;
  extensions?: ExtensionRuntime;
  initialPrompt?: string;
  askMode?: boolean;
  planMode?: boolean;
  workspaceReadiness?: WorkspaceReadiness;
  resumeHint?: {title: string; updatedAt: string};
}


export function SkeinApp({runner, config, extensions, initialPrompt, askMode = false, planMode = false, workspaceReadiness, resumeHint}: TuiOptions) {
  const {exit} = useApp();
  const {setRawMode} = useStdin();
  const {columns, rows} = useWindowSize();
  const terminalWidth = Math.max(1, columns || 80);
  const terminalHeight = Math.max(1, rows || 24);
  const horizontalPadding = terminalWidth >= 24 ? 1 : 0;
  const contentWidth = Math.max(1, Math.min(124, terminalWidth - horizontalPadding * 2));
  const terminalAccessibility = resolveTerminalAccessibility();
  const glyphMode = terminalAccessibility.ascii ? 'ascii' as const : 'auto' as const;
  const glyphs = resolveGlyphs(glyphMode);
  const separator = ` ${glyphs.separator} `;
  const ellipsis = terminalEllipsis();
  const initialSession = runner.getSession();
  const setupProblem = config.model.provider !== 'compatible' && !config.model.apiKey
    ? `No ${config.model.provider} API key found. Set it and restart: export ${providerApiKeyEnv(config.model.provider)}=<your-key>${separator}then run ${PRODUCT_COMMAND} again. Use ${PRODUCT_COMMAND} doctor to verify, or --model to switch provider.`
    : config.model.provider === 'compatible' && !config.model.baseUrl
      ? `No model endpoint configured. Set one and restart: export SKEIN_BASE_URL=<endpoint>${separator}or pass --base-url <endpoint>. Run ${PRODUCT_COMMAND} doctor to verify.`
      : undefined;
  const colorEnabled = config.ui.color && terminalAccessibility.color;
  const [theme, setTheme] = useState(() => resolveThemeWithColor(config.ui.theme, colorEnabled));
  const [themeCatalogRevision, setThemeCatalogRevision] = useState(0);
  const [compact, setCompact] = useState(config.ui.compact);
  const [interactionMode, setInteractionMode] = useState<'ask' | 'plan' | 'build'>(planMode ? 'plan' : askMode ? 'ask' : 'build');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [timeline, setTimeline] = useState<TimelineItem[]>(() => initialTimeline(initialSession, {
    engine: 'local',
    status: setupProblem ? 'blocked' : workspaceReadiness?.files === 0 ? 'empty' : 'ready',
    version: packageJson.version,
    ...(workspaceReadiness?.files ? {files: workspaceReadiness.files} : {}),
    ...(resumeHint ? {resume: resumeHint} : {}),
  }, setupProblem));
  const [tasks, setTasks] = useState<SessionTask[]>(initialSession.tasks.map((task) => ({...task})));
  const [session, setSession] = useState<Session>(() => snapshotSession(initialSession));
  const [permission, setPermission] = useState<PermissionRequest>();
  const [activity, setActivity] = useState<ActivityState>();
  const [history, setHistory] = useState<string[]>(() => initialHistory(initialSession));
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [historySearch, setHistorySearch] = useState<HistorySearchState>();
  const [composerCursor, setComposerCursor] = useState(0);
  const [cursorRequest, setCursorRequest] = useState<{value: string; offset: number}>();
  const [mentionMatches, setMentionMatches] = useState<string[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [showToolOutput, setShowToolOutput] = useState(false);
  const [expandedToolId, setExpandedToolId] = useState<string>();
  const [showContextInspector, setShowContextInspector] = useState(false);
  const [teamWorkbenchOpen, setTeamWorkbenchOpen] = useState(false);
  const [teamWorkbenchView, setTeamWorkbenchView] = useState<TeamWorkbenchView>('agents');
  const [teamWorkbenchIndex, setTeamWorkbenchIndex] = useState(0);
  const [teamWorkbenchExpanded, setTeamWorkbenchExpanded] = useState(false);
  const [teamWorkbenchNotice, setTeamWorkbenchNotice] = useState<string>();
  const [teamRun, setTeamRun] = useState<TeamRunSummary>();
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [suggestionsDismissedFor, setSuggestionsDismissedFor] = useState<string>();
  const [frameIndex, setFrameIndex] = useState(0);
  const [starterHintIndex, setStarterHintIndex] = useState(0);
  const controller = useRef<AbortController | undefined>(undefined);
  const processing = useRef(false);
  const queued = useRef<QueueItem[]>([]);
  const clarificationBacklog = useRef<QueueItem[]>([]);
  const stopRequested = useRef(false);
  const startedInitial = useRef(false);
  const lastSubmitted = useRef<{value: string; at: number} | undefined>(undefined);
  const lastEventError = useRef<string | undefined>(undefined);
  const historyDraft = useRef('');
  const mentionRequest = useRef(0);
  const exitArmedAt = useRef(0);

  const workflows = useMemo(() => extensions?.listWorkflows() ?? [], [extensions]);
  const [customCommands, setCustomCommands] = useState<CustomCommand[]>([]);
  useEffect(() => {
    let cancelled = false;
    void discoverCustomCommands(runner.workspace.primaryRoot, reservedCommandNames)
      .then((commands) => {
        if (!cancelled && commands.length) setCustomCommands(commands);
      });
    return () => {
      cancelled = true;
    };
  }, [runner]);
  const commandMatches = useMemo(() => commandSuggestions(input, {
    themes: ['auto', ...Object.keys(themes)],
    workflows,
    custom: customCommands,
  }), [customCommands, input, themeCatalogRevision, workflows]);
  const mentionToken = useMemo(() => activeMentionToken(input, composerCursor), [composerCursor, input]);
  const rawSuggestionMode = historySearch
    ? 'history' as const
    : mentionToken && !input.startsWith('/')
      ? 'mention' as const
      : commandMatches.length
        ? 'command' as const
        : 'none' as const;
  const suggestionMode = suggestionsDismissedFor === input && !historySearch
    ? 'none' as const
    : rawSuggestionMode;
  const suggestions = useMemo(() => suggestionMode === 'history' && historySearch
    ? historySearch.results.map((entry) => ({
      value: entry,
      label: entry.replace(/\s+/g, ' ').trim(),
      description: 'prompt history',
    }))
    : suggestionMode === 'mention'
      ? mentionMatches.map((path) => ({value: path, label: `@${path}`, description: 'attach file'}))
      : suggestionMode === 'command'
        ? commandMatches
        : [], [commandMatches, historySearch, mentionMatches, suggestionMode]);
  const selectedIndex = historySearch ? historySearch.activeIndex : suggestionIndex;
  const selectedSuggestion = suggestions[selectedIndex] ?? suggestions[0];

  const append = useCallback((item: TimelineItem) => {
    setTimeline((items) => [...items, item].slice(-500));
  }, []);

  // A cleared draft is never lost: it joins prompt history so ArrowUp
  // restores it, and longer drafts say so because silently losing a
  // paragraph of typing is the actual failure mode being fixed.
  const clearDraftRecoverably = useCallback(() => {
    setInput((draft) => {
      if (draft) {
        setHistory((prev) => prev[prev.length - 1] === draft ? prev : [...prev, draft]);
        if (draft.length >= 20) {
          append({id: nextId(), kind: 'notice', tone: 'info', text: 'Draft cleared. Press ArrowUp to restore it.'});
        }
      }
      return '';
    });
    setHistoryIndex(-1);
  }, [append]);

  // The runner mutates its durable session while a turn is streaming. Keep the
  // inspector on a detached snapshot so React observes each working-memory and
  // compaction update instead of waiting for the final turn result.
  const refreshSession = useCallback(() => {
    const next = snapshotSession(runner.getSession());
    setSession(next);
    setTasks(next.tasks.map((task) => ({...task})));
  }, [runner]);

  useEffect(() => {
    setSuggestionIndex(0);
  }, [input]);

  // Surface an "update available" line on fresh sessions only. A cached result
  // paints on the first frame with zero latency; a background refresh (bounded,
  // fire-and-forget) can upgrade the line mid-session if the registry answers
  // while the TUI is open. The notice slots directly under the banner and is
  // de-duplicated by target version, so neither path can double-insert.
  useEffect(() => {
    let cancelled = false;
    const showNotice = (notice: UpdateNotice | undefined): void => {
      if (cancelled || !notice) return;
      setTimeline((items) => {
        const bannerIndex = items.findIndex((item) => item.kind === 'banner');
        if (bannerIndex === -1) return items; // resumed session: no banner, stay quiet
        const existing = items.find((item) => item.kind === 'update');
        if (existing) {
          if (existing.kind === 'update' && existing.latest === notice.latest) return items;
          return items.map((item) => (item === existing
            ? {id: item.id, kind: 'update' as const, current: notice.current, latest: notice.latest, command: notice.command, ...(notice.highlights ? {highlights: notice.highlights} : {})}
            : item));
        }
        const next = items.slice();
        next.splice(bannerIndex + 1, 0, {id: nextId(), kind: 'update', current: notice.current, latest: notice.latest, command: notice.command, ...(notice.highlights ? {highlights: notice.highlights} : {})});
        return next;
      });
    };
    void resolveCachedUpdateNotice(packageJson.version).then(showNotice);
    void refreshUpdateCache(packageJson.version).then(showNotice);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (suggestionMode !== 'mention' || !mentionToken) {
      mentionRequest.current += 1;
      setMentionMatches([]);
      setMentionLoading(false);
      return undefined;
    }
    const request = ++mentionRequest.current;
    const query = mentionToken.query;
    setMentionLoading(true);
    const timer = setTimeout(() => {
      void (async () => {
        let rankedPaths: string[] = [];
        if (query.trim().length >= 2) {
          try {
            const hits = await runner.contextEngine.search(query, 12);
            rankedPaths = contextHitMentionSuggestions(hits, runner.workspace.roots, query, 8);
          } catch {
            // Local retrieval failure should not make file completion unavailable.
          }
        }
        try {
          const index = await getMentionPathIndex(runner.workspace.roots);
          const paths = rankMentionSuggestions([
            ...rankedPaths,
            ...index.suggest(query, 12),
          ], query, 6);
          if (request === mentionRequest.current) setMentionMatches(paths);
        } catch {
          if (request === mentionRequest.current) setMentionMatches(rankedPaths);
        } finally {
          if (request === mentionRequest.current) setMentionLoading(false);
        }
      })();
    }, 150);
    return () => clearTimeout(timer);
  }, [mentionToken?.query, runner, suggestionMode]);

  useEffect(() => {
    setHistorySearch((current) => current
      ? setHistorySearchQuery(current, input)
      : current);
  }, [input]);

  useEffect(() => {
    if (!busy || terminalAccessibility.reducedMotion) {
      setFrameIndex(0);
      return undefined;
    }
    const timer = setInterval(() => setFrameIndex((value) => (value + 1) % spinnerFrames().length), 120);
    return () => clearInterval(timer);
  }, [busy, terminalAccessibility.reducedMotion]);

  const composerEmpty = input.length === 0;
  useEffect(() => {
    if (busy || !composerEmpty || terminalAccessibility.reducedMotion) {
      setStarterHintIndex(0);
      return undefined;
    }
    const timer = setInterval(() => setStarterHintIndex((value) => value + 1), 10_000);
    return () => clearInterval(timer);
  }, [busy, composerEmpty, terminalAccessibility.reducedMotion]);

  const requestPermission = useCallback(async (call: ToolCall, category: ToolCategory, reason?: string) => {
    // Live approval UI shows the person exactly what they are approving: a
    // bounded diff for writes, the complete wrapped command otherwise. The
    // preview is display-only and never persisted.
    const preview = await buildPermissionPreview(
      call,
      category,
      (path) => runner.workspace.resolvePath(path, {allowMissing: true}),
      contentWidth,
    );
    return new Promise<PermissionGrant>((resolve) => setPermission({
      call,
      category,
      ...(reason ? {reason} : {}),
      ...(preview ? {preview} : {}),
      armedAt: Date.now(),
      resolve,
    }));
  }, [runner, contentWidth]);

  const requestHumanApproval = useCallback(async (call: ToolCall, category: ToolCategory, reason?: string) => {
    const preview = await buildPermissionPreview(
      call,
      category,
      (path) => runner.workspace.resolvePath(path, {allowMissing: true}),
      contentWidth,
    );
    return new Promise<boolean>((resolve) => setPermission({
      call,
      category,
      humanOnly: true,
      ...(reason ? {reason} : {}),
      ...(preview ? {preview} : {}),
      armedAt: Date.now(),
      resolve: (grant) => resolve(grant === true),
    }));
  }, [runner, contentWidth]);

  const onEvent = useCallback((event: AgentEvent) => {
    switch (event.type) {
      case 'thinking':
        setActivity({label: event.turn > 1 ? 'Reviewing the latest tool result' : 'Thinking', startedAt: Date.now(), turn: event.turn});
        break;
      case 'context':
        refreshSession();
        append({
          id: nextId(),
          kind: 'context',
          engine: event.packed.engine,
          hits: event.packed.hits.length,
          tokens: event.packed.estimatedTokens,
          ...(event.packed.budgetTier ? {budgetTier: event.packed.budgetTier} : {}),
          ...(event.packed.budgetTokens !== undefined ? {budgetTokens: event.packed.budgetTokens} : {}),
          ...(event.packed.budgetReason ? {budgetReason: event.packed.budgetReason} : {}),
          truncated: event.packed.truncated,
          spans: event.packed.hits.slice(0, 5).map((hit) => ({
            path: relative(runner.workspace.primaryRoot, hit.path) || hit.path,
            startLine: hit.startLine,
            endLine: hit.endLine,
            score: hit.score,
            ...(hit.symbol ? {symbol: hit.symbol} : {}),
          })),
          ...(event.packed.degradation ? {degradation: event.packed.degradation} : {}),
        });
        setActivity({label: 'Assembling relevant context', startedAt: Date.now()});
        break;
      case 'prompt':
        append({
          id: nextId(), kind: 'prompt', intent: event.intent, sections: event.sections,
          tokens: event.estimatedTokens,
          ...(event.breakdown ? {breakdown: event.breakdown} : {}),
        });
        setActivity({label: 'Preparing the model prompt', startedAt: Date.now()});
        break;
      case 'assistant_delta':
        setTimeline((items) => updateAssistantDelta(items, event.id, event.content));
        setActivity({label: 'Writing response', startedAt: Date.now()});
        break;
      case 'assistant':
        if (event.content.trim()) {
          setTimeline((items) => finalizeAssistant(items, event.id, event.content.trim()));
        }
        refreshSession();
        setActivity(undefined);
        break;
      case 'tool_start':
        append({id: event.call.id, kind: 'tool', name: event.call.name, detail: toolDetail(event.call), state: 'running', startedAt: Date.now()});
        setActivity({label: `Running ${event.call.name}`, startedAt: Date.now()});
        break;
      case 'tool_result':
        if (event.result.ok && ['apply_patch', 'write_file', 'shell', 'git'].includes(event.result.name)) {
          invalidateMentionPathIndex(runner.workspace.roots);
        }
        setTimeline((items) => updateTool(items, event.result));
        refreshSession();
        setActivity({label: 'Reviewing the latest tool result', startedAt: Date.now()});
        break;
      case 'permission':
        setActivity(undefined);
        break;
      case 'tasks':
        setTasks(event.tasks.map((task) => ({...task})));
        break;
      case 'contract': {
        setTimeline((items) => updateContractProgress(items, event.contract, separator));
        refreshSession();
        break;
      }
      case 'skill':
        append({id: nextId(), kind: 'skill', name: event.name, description: event.description});
        break;
      case 'memory':
        append({id: nextId(), kind: 'memory', count: event.count, scope: event.scope});
        break;
      case 'agent_queued':
        setTimeline((items) => updateAgentQueued(items, event));
        break;
      case 'agent_cancelled':
        setTimeline((items) => cancelAgent(items, event));
        break;
      case 'agent_start':
        setTimeline((items) => startAgent(items, event));
        setTeamWorkbenchIndex(0);
        break;
      case 'agent_message':
        append({id: event.id, kind: 'agent-message', from: event.from, to: event.to, text: event.content});
        break;
      case 'agent_update':
        setTimeline((items) => updateAgentTelemetry(items, event));
        break;
      case 'team_start':
        setTeamRun({id: event.id, objective: event.objective, startedAt: Date.now()});
        append({id: nextId(), kind: 'notice', tone: 'info', text: `Team run ${event.id.slice(0, 8)} started${separator}${event.objective.slice(0, 180)}`});
        break;
      case 'team_done':
        setTeamRun((current) => ({
          ...current,
          id: current?.id ?? event.id,
          accepted: event.accepted,
          needsReview: event.needsReview ?? false,
          unresolvedCriteria: event.unresolvedCriteria ?? [],
          reviewRounds: event.reviewRounds,
          ...(event.review ? {review: event.review} : {}),
        }));
        append({
          id: nextId(),
          kind: 'notice',
          tone: event.needsReview ? 'warning' : event.accepted ? 'success' : 'error',
          text: `Team run ${event.id.slice(0, 8)} ${event.needsReview ? 'needs review' : event.accepted ? 'accepted' : 'rejected'}${separator}${event.reviewRounds} revision round${event.reviewRounds === 1 ? '' : 's'}${event.unresolvedCriteria?.length ? `${separator}${event.unresolvedCriteria.length} unresolved` : ''}${event.review ? `${separator}judge ${event.review.decision} ${event.review.pass} pass ${event.review.fail} fail ${event.review.unknown} unknown` : ''}`,
        });
        break;
      case 'writer_lane':
        append({
          id: nextId(),
          kind: 'notice',
          tone: event.status === 'ready' || event.status === 'integrated'
            ? 'success'
            : event.status === 'needs_review'
              ? 'warning'
              : 'error',
          text: `Writer ${event.id.slice(0, 8)} ${event.status}${separator}${event.detail}${event.status === 'conflict' || event.status === 'failed' || event.status === 'cancelled' ? `${separator}Run /recover before retrying or restoring.` : ''}`,
        });
        break;
      case 'agent_done':
        setTimeline((items) => updateAgent(items, event));
        break;
      case 'workflow':
        append({id: nextId(), kind: 'workflow', name: event.name, step: event.step, status: event.status});
        break;
      case 'context_compacted':
        append({id: nextId(), kind: 'compaction', messages: event.omittedMessages, tokens: event.summaryTokens});
        refreshSession();
        break;
      case 'context_epoch':
        append({
          id: nextId(),
          kind: 'notice',
          tone: 'info',
          text: `Context epoch ${event.previousIndex} → ${event.index}${separator}${event.reason.replace('_', ' ')}${separator}${event.inputTokens + event.outputTokens} tokens preserved in the lifetime ledger.`,
        });
        refreshSession();
        break;
      case 'needs_input':
        append({id: nextId(), kind: 'clarification', pending: event.pending});
        refreshSession();
        break;
      case 'input_resolved':
        append({id: nextId(), kind: 'notice', tone: 'success', text: `Clarification resolved${separator}${event.answer}`});
        refreshSession();
        break;
      case 'provider_activity':
        append({
          id: nextId(),
          kind: 'notice',
          tone: 'info',
          text: `Provider search${separator}${event.hostedTools.length} call${event.hostedTools.length === 1 ? '' : 's'}${separator}${event.sources.length} source${event.sources.length === 1 ? '' : 's'}`,
        });
        break;
      case 'intent':
        refreshSession();
        break;
      case 'usage':
        refreshSession();
        break;
      case 'error':
        lastEventError.current = event.error.message;
        setTimeline(endStreamingAssistants);
        append({
          id: nextId(), kind: 'notice', tone: 'error', wrapWidth: contentWidth,
          text: `${event.error.message}${separator}/recover for details and safe retry`,
        });
        setActivity(undefined);
        break;
      case 'done':
        setTimeline(endStreamingAssistants);
        setActivity(undefined);
        refreshSession();
        if (event.completion && event.completion.status !== 'no_changes') {
          const checks = event.completion.checks.map((check) => check.command).join(` ${separator} `);
          const duplication = event.completion.duplication;
          const duplicateDetail = duplication
            ? `${separator} duplication ${duplication.status} (${duplication.warningCount} warning, ${duplication.unresolvedCount} incomplete, ${duplication.suppressedCount} suppressed)`
            : '';
          append({
            id: nextId(),
            kind: 'notice',
            wrapWidth: contentWidth,
            tone: event.completion.status === 'verified'
              ? 'success'
              : event.completion.status === 'unverified'
                ? 'warning'
                : 'error',
            text: event.completion.status === 'verified'
              ? `Verified${separator}${event.completion.detail}${checks ? `${separator}${checks}` : ''}${duplicateDetail}`
              : event.completion.status === 'verification_failed'
                ? `Verification failed${separator}${event.completion.detail}${checks ? `${separator}${checks}` : ''}${duplicateDetail}`
                : `Unverified${separator}${event.completion.detail}${duplicateDetail}`,
          });
        }
        if (event.reason !== 'completed' &&
          event.reason !== 'unverified' && event.reason !== 'verification_failed') {
          append({
            id: nextId(),
            kind: 'notice',
            tone: event.reason === 'aborted' ? 'info' : 'error',
            text: event.reason === 'aborted'
              ? 'Run interrupted. Use /recover to inspect changes or resume safely.'
              : event.reason === 'max_turns'
                ? 'Stopped at the configured turn limit. Use /recover resume after adjusting the limit.'
                : event.reason === 'token_budget'
                  ? 'Stopped at the configured token budget. Use /recover to inspect state before resuming with a larger budget.'
                  : event.reason,
          });
        }
        break;
      default:
        break;
    }
  }, [append, contentWidth, refreshSession, runner.workspace.roots]);

  const appendList = useCallback((title: string, entries: ListEntry[]) => {
    append({id: nextId(), kind: 'list', title, entries});
  }, [append]);

  const openExternalEditor = useCallback(async (initial: string) => {
    if (processing.current || permission || editing) {
      append({id: nextId(), kind: 'notice', tone: 'error', text: 'External editor is unavailable while another interaction is active.'});
      return;
    }
    setEditing(true);
    append({id: nextId(), kind: 'notice', tone: 'info', text: 'Opening external editor. Save and close it to return to Skein.'});
    setRawMode(false);
    try {
      const draft = await editComposerDraft(initial, {workspace: runner.workspace.primaryRoot});
      setInput(draft);
      setCursorRequest({value: draft, offset: draft.length});
      append({id: nextId(), kind: 'notice', tone: 'success', text: draft.trim() ? 'External editor draft loaded.' : 'External editor returned an empty draft.'});
    } catch (error) {
      append({id: nextId(), kind: 'notice', tone: 'error', text: error instanceof Error ? error.message : String(error)});
    } finally {
      setRawMode(true);
      setEditing(false);
    }
  }, [append, editing, permission, runner.workspace.primaryRoot, setRawMode]);

  const runLocalCommand = useCallback(async (value: string): Promise<LocalCommandResult> => {
    if (!value.startsWith('/')) return false;
    const [rawCommand = '', ...rest] = value.slice(1).trim().split(/\s+/);
    let command = rawCommand.toLocaleLowerCase();
    let argument = rest.join(' ').trim();
    if (!command) return true;

    if (command === 'recover') {
      const [action = '', ...actionRest] = argument.split(/\s+/u);
      if (action === 'diff' || action === 'audit' || action === 'rollback') {
        command = action;
        argument = actionRest.join(' ').trim();
      }
    }

    if (command === 'exit' || command === 'quit') {
      exit();
      return true;
    }
    if (command === 'clear') {
      setTimeline([]);
      return true;
    }
    if (command === 'help' || command === '?') {
      appendList('Commands', commandDefinitions.map((definition) => ({
        label: `/${definition.name}${definition.usage ? `  ${definition.usage}` : ''}`,
        detail: definition.description,
      })));
      if (customCommands.length) {
        appendList('Workspace commands (.agents/commands)', customCommands.map((entry) => ({
          label: `/${entry.name}`,
          detail: entry.description || entry.path,
        })));
      }
      return true;
    }
    if (command === 'hotkeys') {
      appendList('Keyboard', [
        {label: 'Enter', detail: busy ? 'steer the next model turn' : 'send request'},
        {label: 'Alt+Enter', detail: 'queue a follow-up while a run is active'},
        {label: '/queue', detail: 'inspect, drop, or clear queued follow-ups'},
        {label: 'Ctrl+J', detail: 'insert a newline'},
        {label: 'Ctrl+R', detail: 'search prompt history'},
        {label: 'Ctrl+O', detail: 'toggle the latest tool result'},
        {label: 'Ctrl+T', detail: 'open the Team Workbench'},
        {label: 'Ctrl+L', detail: 'clear the visible transcript'},
        {label: 'Alt+E', detail: 'edit the current draft with VISUAL or EDITOR'},
        {label: 'Esc', detail: busy ? 'interrupt the active run' : 'clear the composer'},
        {label: 'Ctrl+C', detail: 'interrupt or clear; press twice on an empty composer to exit'},
      ]);
      return true;
    }
    if (command === 'editor') {
      await openExternalEditor(argument);
      return true;
    }
    if (command === 'queue') {
      const [rawAction = 'list', rawPosition = ''] = argument.split(/\s+/u);
      const action = rawAction.toLocaleLowerCase();
      if (action === 'list' || !action) {
        appendList('Queued follow-ups', queued.current.length
          ? queued.current.map((item, index) => ({
            label: `${index + 1}  ${item.kind === 'local' ? 'command' : 'follow-up'}`,
            detail: item.display,
          }))
          : [{label: 'Queue is empty.'}]);
        return true;
      }
      if (action === 'clear') {
        const removed = queued.current.length;
        queued.current = [];
        setQueue([]);
        append({
          id: nextId(),
          kind: 'notice',
          tone: 'info',
          text: removed
            ? `Cleared ${removed} queued follow-up${removed === 1 ? '' : 's'}.`
            : 'Queue is already empty.',
        });
        return true;
      }
      if (action === 'drop') {
        const position = Number(rawPosition);
        if (!Number.isInteger(position) || position < 1 || position > queued.current.length) {
          throw new Error(`Usage: /queue drop <1-${Math.max(1, queued.current.length)}>`);
        }
        const [removed] = queued.current.splice(position - 1, 1);
        setQueue([...queued.current]);
        append({
          id: nextId(),
          kind: 'notice',
          tone: 'info',
          text: `Removed queued ${removed?.kind === 'local' ? 'command' : 'follow-up'} ${position}: ${removed?.display ?? ''}`,
        });
        return true;
      }
      throw new Error('Usage: /queue [list|drop|clear] [number]');
    }
    if (command === 'transcript') {
      const normalized = argument.toLocaleLowerCase();
      const next = normalized === 'on' || normalized === 'full'
        ? true
        : normalized === 'off' || normalized === 'compact'
          ? false
          : !showToolOutput;
      setShowToolOutput(next);
      append({
        id: nextId(),
        kind: 'notice',
        tone: 'info',
        text: next ? 'Full tool output is visible.' : 'Tool output is collapsed.',
      });
      return true;
    }
    if (command === 'review') {
      const scope = parseReviewScope(argument);
      const bundle = buildRedactedReviewBundle(runner.getSession(), runner.workspace.primaryRoot, scope);
      return {
        kind: 'agent',
        display: `/review ${scope.kind}${scope.kind === 'working-tree' ? '' : ` ${scope.ref}`}`,
        runInput: reviewRequest(scope),
        turnInstructions: reviewTurnInstructions(bundle),
        readOnly: true,
      };
    }
    if (command === 'recover') {
      const action = argument.toLocaleLowerCase();
      const currentSession = runner.getSession();
      const lastRun = currentSession.lastRun;
      const lastFailure = (currentSession.audit ?? []).findLast((event) =>
        event.type === 'tool' && event.outcome === 'failure');
      const failure = recoveryFailure(lastFailure?.metadata?.failure);
      if (action === 'retry') {
        if (currentSession.pendingInput) throw new Error('Answer the pending clarification before retrying an operation.');
        if (!lastFailure) throw new Error('No failed operation is available to retry.');
        return {
          kind: 'agent',
          display: '/recover retry',
          runInput: `Retry the most recent failed ${lastFailure.tool} operation after inspecting the current workspace state.`,
          turnInstructions: 'Resume the existing session. Use the recorded failure receipt and current files as authority. Apply its repair hint before one targeted retry; do not replay a circuit-open or non-retryable operation unchanged.',
        };
      }
      if (action === 'resume') {
        if (currentSession.pendingInput) throw new Error('Answer the pending clarification in the composer to resume the same logical run.');
        if (!lastRun || lastRun.reason === 'completed') throw new Error('The latest run is already complete.');
        return {
          kind: 'agent',
          display: '/recover resume',
          runInput: 'Resume the most recent incomplete run from its persisted state.',
          turnInstructions: 'Resume the existing session from its Task Contract, changed-file set, last-run receipt, and unresolved failures. Inspect current state before acting, keep prior successful evidence, and run only missing verification.',
        };
      }
      if (action) throw new Error('Usage: /recover [retry|resume|diff|rollback|audit]');
      const checkpoints = await runner.checkpointStore.list(currentSession.id);
      const latestCheckpoint = checkpoints[0];
      appendList('Recovery Center', [
        {
          label: `Last run  ${lastRun?.status ?? 'none'}${lastRun ? `${separator}${lastRun.reason}` : ''}`,
          detail: lastRun?.detail ?? 'No completed or interrupted run has been recorded.',
          tone: lastRun?.status === 'verified' || lastRun?.status === 'no_changes' ? 'success'
            : lastRun ? 'warning' : 'normal',
        },
        ...(lastFailure ? [{
          label: `Failure  ${lastFailure.tool}${failure?.class ? `${separator}${failure.class}` : ''}`,
          detail: failure?.repairHint ?? 'Inspect the audit timeline before retrying.',
          tone: 'error' as const,
        }] : []),
        {
          label: `Workspace  ${currentSession.changedFiles.length} changed file${currentSession.changedFiles.length === 1 ? '' : 's'}`,
          detail: currentSession.changedFiles.length ? '/diff inspects the current patch.' : 'No tracked session changes.',
        },
        {
          label: `Checkpoint  ${latestCheckpoint ? latestCheckpoint.id.slice(0, 12) : 'none'}`,
          detail: latestCheckpoint
            ? `${latestCheckpoint.reason}${separator}${latestCheckpoint.entries.length} files${separator}/recover rollback`
            : 'No pre-mutation snapshot is available for this session.',
        },
        {label: '/recover retry', detail: lastFailure ? 'Apply the repair hint, then retry the latest failure once.' : 'Unavailable until an operation fails.'},
        {label: '/recover resume', detail: currentSession.pendingInput
          ? 'Unavailable: answer the pending clarification in the composer.'
          : lastRun && lastRun.reason !== 'completed' ? 'Continue the incomplete logical run.' : 'No incomplete run to resume.'},
        {label: '/recover diff', detail: 'Inspect the current workspace patch.'},
        {label: '/recover audit', detail: 'Review permission and tool evidence.'},
        {label: '/recover rollback', detail: 'Choose a checkpoint to restore.'},
      ]);
      return true;
    }
    if (command === 'changes') {
      const changed = runner.getSession().changedFiles;
      appendList('Changed files', changed.length
        ? changed.map((path) => ({
          label: relative(runner.workspace.primaryRoot, path) || '.',
          detail: path,
        }))
        : [{label: 'No recorded changes.'}]);
      return true;
    }
    if (command === 'diff') {
      // A diff receipt is the new primary surface. Close a previously opened
      // context inspector so compact terminals retain the permission result.
      setShowContextInspector(false);
      const tool = runner.tools.get('git');
      if (!tool) throw new Error('The built-in Git tool is unavailable.');
      const id = nextId();
      const call: ToolCall = {id, name: 'git', arguments: {args: ['diff', '--']}};
      const decision = evaluatePermission(config.permissions, call, 'git', {forceAsk: interactionMode !== 'build'});
      if (decision.outcome === 'deny') throw new Error(`Git diff denied: ${decision.reason}`);
      if (decision.outcome === 'ask' && !(await requestPermission(call, 'git'))) {
        append({id: nextId(), kind: 'notice', tone: 'info', text: 'Git diff was not run; permission denied.'});
        return true;
      }
      append({id, kind: 'tool', name: 'git diff', detail: 'workspace changes', state: 'running', startedAt: Date.now()});
      const execution = await tool.execute(call.arguments, {
        config,
        workspace: runner.workspace,
        session: runner.getSession(),
        contextEngine: runner.contextEngine,
      });
      setTimeline((items) => updateTool(items, {
        toolCallId: id,
        name: 'git diff',
        ok: execution.ok !== false,
        content: execution.content,
      }));
      setShowToolOutput(true);
      return true;
    }
    if (command === 'checkpoints') {
      const checkpoints = await runner.checkpointStore.list(runner.getSession().id);
      appendList('Checkpoints', checkpoints.length
        ? checkpoints.slice(0, 20).map((checkpoint) => ({
          label: checkpoint.id.slice(0, 12),
          detail: `${checkpoint.reason}${separator}${checkpoint.entries.length} files${separator}${checkpoint.createdAt}`,
        }))
        : [{label: 'No checkpoints for this session.'}]);
      return true;
    }
    if (command === 'audit') {
      const events = runner.getSession().audit ?? [];
      appendList('Audit timeline', events.length
        ? events.slice(-24).reverse().map((event) => ({
          label: `${event.outcome === 'success' || event.outcome === 'allow' ? glyphs.success : event.outcome === 'failure' || event.outcome === 'deny' ? glyphs.error : glyphs.pending}  ${event.tool}${event.category ? `${separator}${event.category}` : ''}`,
          detail: `${event.type}${separator}${event.outcome}${event.reason ? `${separator}${event.reason.slice(0, 80)}` : ''}${separator}${event.createdAt.slice(11, 19)}`,
          tone: event.outcome === 'failure' || event.outcome === 'deny' ? 'error' as const
            : event.outcome === 'success' || event.outcome === 'allow' ? 'success' as const : 'normal' as const,
        }))
        : [{label: 'No audited actions yet.', detail: 'Tool calls and permission decisions are recorded here.'}]);
      return true;
    }
    if (command === 'rollback') {
      const checkpoints = await runner.checkpointStore.list(runner.getSession().id);
      if (!checkpoints.length) {
        append({id: nextId(), kind: 'notice', tone: 'error', text: 'No checkpoints to roll back to.'});
        return true;
      }
      if (!argument) {
        appendList('Rollback — choose a checkpoint', checkpoints.slice(0, 20).map((checkpoint) => ({
          label: checkpoint.id.slice(0, 12),
          detail: `${checkpoint.reason}${separator}${checkpoint.entries.length} files${separator}${checkpoint.createdAt.slice(0, 19)}`,
        })).concat([{label: 'Run /rollback <id> to restore', detail: 'the workspace files captured before that change.'}]));
        return true;
      }
      const match = checkpoints.find((checkpoint) => checkpoint.id === argument || checkpoint.id.startsWith(argument));
      if (!match) {
        append({id: nextId(), kind: 'notice', tone: 'error', text: `No checkpoint matched: ${argument}`});
        return true;
      }
      const restored = await runner.checkpointStore.restore(runner.getSession().id, match.id);
      append({id: nextId(), kind: 'notice', tone: 'success', text: `Rolled back ${restored.length} file${restored.length === 1 ? '' : 's'} to checkpoint ${match.id.slice(0, 12)}${separator}${match.reason}.`});
      return true;
    }
    if (command === 'tasks') {
      appendList('Plan', tasks.length
        ? tasks.map((task) => ({
          label: `${task.status === 'completed' ? 'done' : task.status === 'in_progress' ? 'active' : 'queued'}  ${task.title}`,
          tone: task.status === 'completed' ? 'success' : task.status === 'in_progress' ? 'warning' : 'normal',
        }))
        : [{label: 'No active plan.', tone: 'normal'}]);
      return true;
    }
    if (command === 'context') {
      const [sub = '', ...subRest] = argument.split(/\s+/);
      const subcommand = sub.toLocaleLowerCase();
      const target = subRest.join(' ').trim();
      if (subcommand === 'compact') {
        const result = await runner.compactContext();
        refreshSession();
        append({id: nextId(), kind: 'compaction', messages: result.omittedMessages, tokens: result.summaryTokens});
        setShowContextInspector(true);
        return true;
      }
      if (subcommand === 'pin') {
        if (!target) throw new Error('Usage: /context pin <path>');
        const source = await runner.pinContextSource(target);
        refreshSession();
        append({id: nextId(), kind: 'notice', tone: 'success', text: `Pinned ${source.path}${separator}~${source.tokens} tokens${separator}re-read every turn, survives compaction.`});
        setShowContextInspector(true);
        return true;
      }
      if (subcommand === 'unpin') {
        if (!target) throw new Error('Usage: /context unpin <path>');
        const removed = await runner.unpinContextSource(target);
        refreshSession();
        append({id: nextId(), kind: 'notice', tone: removed ? 'success' : 'error', text: removed ? `Unpinned ${removed}.` : `No pinned source matched: ${target}`});
        return true;
      }
      if (subcommand === 'mute') {
        if (!target) throw new Error('Usage: /context mute <path>');
        const source = await runner.toggleMuteContextSource(target);
        refreshSession();
        append({id: nextId(), kind: 'notice', tone: source ? 'success' : 'error', text: source ? `${source.state === 'muted' ? 'Muted' : 'Unmuted'} ${source.path}.` : `No source matched: ${target}`});
        return true;
      }
      if (subcommand === 'list') {
        const list = runner.listContextSources();
        appendList('Pinned context', list.length
          ? list.map((source) => ({
            label: `${source.state === 'muted' ? 'muted ' : 'pinned'}  ${source.path}`,
            detail: `~${source.tokens} tokens${separator}added ${source.addedAt.slice(0, 10)}`,
            tone: source.state === 'muted' ? 'warning' as const : 'success' as const,
          }))
          : [{label: 'No pinned sources.', detail: 'Pin one with /context pin <path>'}]);
        return true;
      }
      if (subcommand && subcommand !== 'toggle') {
        throw new Error('Usage: /context [pin|unpin|mute|list|compact] [path]');
      }
      setShowContextInspector((visible) => !visible);
      return true;
    }
    if (command === 'workbench') {
      setTeamWorkbenchOpen((visible) => !visible);
      setTeamWorkbenchNotice(undefined);
      return true;
    }
    if (command === 'compact') {
      const result = await runner.compactContext(argument || undefined);
      refreshSession();
      append({id: nextId(), kind: 'compaction', messages: result.omittedMessages, tokens: result.summaryTokens});
      return true;
    }
    if (command === 'memory') {
      return runMemoryCommand(argument);
    }
    if (command === 'remember') {
      if (!argument) {
        append({id: nextId(), kind: 'notice', tone: 'error', text: 'Usage: /remember <non-secret fact or preference>'});
      } else {
        const record = extensions?.remember(argument, runner.getSession());
        append({id: nextId(), kind: record ? 'notice' : 'notice', tone: record ? 'success' : 'error', text: record ? `Remembered ${record.id.slice(0, 8)} for this workspace.` : 'Memory is disabled.'});
      }
      return true;
    }
    if (command === 'skills') {
      const skills = extensions?.listSkills() ?? [];
      appendList('Skills', skills.length
        ? [
          ...skills.map((skill) => ({
            label: skill.name,
            detail: `${skill.effect}${separator}${skill.trust}${separator}${skill.scope}${separator}` +
              `${skill.fingerprint.slice(0, 12)}${separator}${skill.description}${separator}` +
              `${relative(runner.workspace.primaryRoot, skill.path) || skill.path}`,
            tone: skill.trusted ? 'normal' as const : 'warning' as const,
          })),
          ...(skills.some((skill) => !skill.trusted) ? [{
            label: `Review trust with ${PRODUCT_COMMAND} skills inspect/trust`,
            detail: 'Trust is bound to the exact workspace, source path, and content fingerprint.',
            tone: 'warning' as const,
          }] : []),
        ]
        : [{label: 'No skills discovered.', detail: 'Add SKILL.md playbooks under .agents/skills, .claude/skills, or a configured directory.'},
          {label: `Trust workspace skills with ${PRODUCT_COMMAND} skills inspect/trust`, detail: 'Trust is bound to the exact source and content fingerprint.'}]);
      return true;
    }
    if (command === 'mcp') {
      const [action = 'list', server = '', ...tail] = argument.split(/\s+/u).filter(Boolean);
      if (action === 'search') {
        const results = extensions?.mcpSearch([server, ...tail].filter(Boolean).join(' ')) ?? [];
        appendList('MCP capability search', results.length ? results.map((result) => ({
          label: `${result.name}  ${result.trust}${result.required ? `${separator}required` : ''}`,
          detail: `${result.description}${separator}${result.version}${separator}${result.declaredTools || 'dynamic'} tools`,
          tone: result.trust === 'trusted' ? 'success' : result.trust === 'revoked' ? 'error' : 'warning',
        })) : [{label: 'No configured MCP capability matched.'}]);
        return true;
      }
      if (action === 'inspect' || action === 'trust') {
        if (!server) {
          append({id: nextId(), kind: 'notice', tone: 'error', text: `Usage: /mcp ${action} <server>${action === 'trust' ? ' [--confirm]' : ''}`});
          return true;
        }
        const manifest = extensions?.mcpInspect(server);
        if (!manifest) {
          append({id: nextId(), kind: 'notice', tone: 'error', text: 'MCP is disabled or unavailable.'});
          return true;
        }
        appendList(`MCP trust review · ${manifest.name}`, [
          {label: `${manifest.source.kind}:${manifest.name}  ${manifest.version}`, detail: `${manifest.transport}${separator}${manifest.target}${manifest.required ? `${separator}required` : ''}`},
          ...(manifest.tools.length ? manifest.tools.flatMap((tool) => {
            const tone = tool.permissions.some((category) => category !== 'read' && category !== 'network')
              ? 'warning' as const : 'normal' as const;
            return [
              {label: `${tool.name}  ${tool.permissions.join('+')}`, detail: `completion evidence ${tool.completionEvidence}`, tone},
              {label: 'network scopes', detail: tool.network.join(', ') || 'unspecified', tone},
              {label: 'command scopes', detail: tool.commands.join(', ') || 'none', tone},
              {label: 'path scopes', detail: tool.paths.join(', ') || 'none', tone},
              {label: `sensitive fields  ${tool.sensitiveFields.join(', ') || 'none'}`, detail: `${tool.background ? 'background' : 'foreground'}${separator}${tool.processTree ? 'process-tree' : 'single-process'}`, tone},
            ];
          }) : [{label: 'Dynamic remote tools', detail: 'Undeclared tools stay network-only and do not receive Skein completion-evidence protection.', tone: 'warning' as const}]),
        ]);
        if (action === 'trust') {
          if (manifest.dynamicTools) {
            append({id: nextId(), kind: 'notice', tone: 'error', text: `Declare tools and effects for ${server} in user-owned config before trust can be granted.`});
            return true;
          }
          if (!tail.includes('--confirm')) {
            append({id: nextId(), kind: 'notice', tone: 'warning', text: `Review complete. Run /mcp trust ${server} --confirm to trust this exact manifest fingerprint.`});
          } else {
            const status = await extensions?.mcpTrust(server);
            append({id: nextId(), kind: 'notice', tone: status ? 'success' : 'error', text: status ? `Trusted MCP capability ${server}. Activation remains explicit.` : 'MCP is unavailable.'});
          }
        }
        return true;
      }
      if (action === 'activate') {
        const query = tail.join(' ').trim();
        if (!server || !query) {
          append({id: nextId(), kind: 'notice', tone: 'error', text: 'Usage: /mcp activate <server> <capability query>'});
          return true;
        }
        const result = await extensions?.mcpActivate(server, query);
        append({
          id: nextId(),
          kind: 'notice',
          tone: result?.ok ? 'success' : 'error',
          text: result?.ok
            ? `Activated ${server}; loaded ${result.registeredTools.length} of ${result.availableTools} schemas.`
            : `Could not activate ${server}: ${result?.status.error ?? result?.status.trust ?? 'MCP unavailable'}`,
        });
        return true;
      }
      if (action === 'disable') {
        if (!server) {
          append({id: nextId(), kind: 'notice', tone: 'error', text: 'Usage: /mcp disable <server>'});
          return true;
        }
        const status = await extensions?.mcpDisable(server);
        append({id: nextId(), kind: 'notice', tone: status ? 'success' : 'error', text: status ? `Disabled MCP capability ${server}.` : 'MCP is unavailable.'});
        return true;
      }
      if (action === 'revoke') {
        if (!server || !tail.includes('--confirm')) {
          append({id: nextId(), kind: 'notice', tone: 'warning', text: `Revocation removes persisted trust. Run /mcp revoke ${server || '<server>'} --confirm to continue.`});
          return true;
        }
        const status = await extensions?.mcpRevoke(server);
        append({id: nextId(), kind: 'notice', tone: status ? 'success' : 'error', text: status ? `Revoked MCP capability ${server}. Re-inspection and trust are required before reuse.` : 'MCP is unavailable.'});
        return true;
      }
      if (action !== 'list') {
        append({id: nextId(), kind: 'notice', tone: 'error', text: 'Usage: /mcp [search|inspect|trust|activate|disable|revoke] [...]'});
        return true;
      }
      const servers = extensions?.mcpStatus() ?? [];
      appendList('MCP', servers.length
        ? servers.map((item) => ({
          label: `${item.name}  ${item.state}${item.required ? `${separator}required` : ''}${item.serverVersion ? `${separator}v${item.serverVersion}` : ''}`,
          detail: `${item.transport}${separator}${item.trust}${separator}${item.toolCount} tools${item.connectedAt ? `${separator}connected ${item.connectedAt.slice(11, 19)}` : ''}${item.error ? `${separator}${item.error}` : ''}`,
          tone: item.state === 'connected' ? 'success' : item.state === 'error' || item.state === 'revoked' ? 'error' : 'warning',
        }))
        : [{label: 'No MCP servers configured.'}]);
      return true;
    }
    if (command === 'tools') {
      const definitions = runner.tools.definitions();
      appendList('Tools', definitions.map((tool) => ({
        label: `${tool.name}  ${tool.source ?? 'builtin'}${separator}${(tool.permissionCategories ?? [tool.category]).join('+')}`,
        detail: `${tool.activation ?? 'always'}${tool.completionEvidence ? `${separator}evidence ${tool.completionEvidence}` : ''}${separator}${tool.description}`,
        tone: tool.category === 'read' ? 'normal' : tool.category === 'network' ? 'warning' : 'normal',
      })));
      return true;
    }
    if (command === 'permissions') {
      appendList('Permissions', [
        ...(['read', 'write', 'shell', 'git', 'network'] as const).map((category) => ({
          label: `${category}  ${config.permissions[category]}`,
          tone: config.permissions[category] === 'allow' ? 'success' as const
            : config.permissions[category] === 'deny' ? 'error' as const : 'warning' as const,
        })),
        {label: `${config.permissions.allowCommands.length} command allow rules`, detail: config.permissions.allowCommands.join(separator) || 'none'},
        {label: `${config.permissions.denyCommands.length} command deny rules`, detail: config.permissions.denyCommands.join(separator) || 'none'},
      ]);
      return true;
    }
    if (command === 'agents') {
      const profiles = extensions?.listAgents() ?? [];
      appendList('Experts', profiles.map((profile) => {
        const resolved = resolveAgentModelRoute(config.agents, config.model, profile.name);
        const route = resolved.route;
        const connection = route?.connection ? config.agents?.connections?.[route.connection] : undefined;
        const routeLabel = route
          ? `${route.runtime ?? 'api'}:${route.connection ? `@${route.connection}` : route.provider ?? connection?.provider}/${route.model ?? config.model.model} (${resolved.source})`
          : `${config.model.provider}/${config.model.model} (parent)`;
        const limits = `${profile.readOnly ? 'read-only' : 'writer'}${separator}${profile.maxTurns} turns${profile.tools?.length ? `${separator}${profile.tools.length} tools` : ''}`;
        return {
          label: `${profile.name}  ${limits}`,
          detail: `${profile.description}${separator}${profile.source}${separator}${routeLabel}`,
        };
      }));
      return true;
    }
    if (command === 'connections') {
      if (argument === 'setup') {
        append({id: nextId(), kind: 'notice', tone: 'info', text: `Run ${PRODUCT_COMMAND} connections add in a shell to configure a user-owned connection without exposing credentials to the session.`});
        return true;
      }
      const routes = Object.values(config.agents?.routes ?? {});
      const connections = config.connectionCatalog?.profiles ?? [];
      appendList('Model connections', connections.length ? connections.map((connection) => ({
        label: `${connection.id}  ${connection.provider}  ${connection.source}`,
        detail: [
          ...(config.activeConnection?.id === connection.id ? ['active'] : []),
          ...(config.connectionCatalog?.defaultConnection === connection.id ? ['default'] : []),
          `${connection.authType}/${connection.authStatus}`,
          connection.protocol,
          `inference ${connection.endpoint}`,
          `models ${connection.modelsEndpoint}`,
          `${routes.filter((route) => route.connection === connection.id).length} explicit routes`,
        ].join(separator),
        tone: connection.complete ? 'success' as const : 'warning' as const,
      })) : [{label: 'No named model connections configured.', detail: `Run ${PRODUCT_COMMAND} connections add before starting another session.`}]);
      return true;
    }
    if (command === 'team') {
      if (!argument) {
        appendList('Team routing', (extensions?.listAgents() ?? []).map((profile) => {
          const resolved = resolveAgentModelRoute(config.agents, config.model, profile.name);
          const route = resolved.route;
          const connection = route?.connection ? config.agents?.connections?.[route.connection] : undefined;
          return {
            label: `${profile.name}  ${route ? `${route.runtime ?? 'api'}:${route.connection ? `@${route.connection}` : route.provider ?? connection?.provider}/${route.model ?? config.model.model} (${resolved.source})` : `${config.model.provider}/${config.model.model} (parent)`}`,
            detail: profile.description,
          };
        }));
        return true;
      }
      if (!config.agents?.enabled || !runner.tools.has('team_run')) {
        append({id: nextId(), kind: 'notice', tone: 'error', text: 'Multi-model teams are disabled or unavailable.'});
        return true;
      }
      const turnInstructions = `Team cockpit mode is active. Use the team_run tool for the user's objective. Decompose it into two to four independent read-only specialist assignments chosen from the available profiles. State measurable acceptance criteria in the team objective. Let configured profile routes choose models. Keep all workspace mutations in the main agent under the normal permission policy. If the objective requires implementation, run a planning council, implement as the single writer, run deterministic checks, then run a second acceptance council over the resulting diff with reviewer/tester participation. Do not claim delivery until checks pass and the acceptance council returns ACCEPT.`;
      append({id: nextId(), kind: 'notice', tone: 'success', text: `Team cockpit queued${separator}specialists will share reports and review acceptance.`});
      return {kind: 'agent', display: value, runInput: argument, turnInstructions};
    }
    if (command === 'workflow') {
      const [name = '', ...taskParts] = argument.split(/\s+/);
      if (!name) {
        appendList('Workflows', workflows.map((workflow) => ({
          label: `${workflow.name}${separator}${workflow.source}${separator}trusted`,
          detail: `${workflow.catalogAccess} catalog${separator}${workflow.execution} execution${separator}${workflow.description}`,
        })));
        return true;
      }
      const task = taskParts.join(' ').trim();
      if (!task) {
        append({id: nextId(), kind: 'notice', tone: 'error', text: `Usage: /workflow ${name} <task>`});
        return true;
      }
      const prompt = extensions?.workflowPrompt(name, task);
      if (!prompt) throw new Error('Workflows are unavailable.');
      append({id: nextId(), kind: 'notice', tone: 'success', text: `Workflow ${name} queued${separator}one writer${separator}bounded expert steps.`});
      return {kind: 'agent', display: value, runInput: value, turnInstructions: prompt};
    }
    if (command === 'theme') {
      if (argument.toLocaleLowerCase() === 'reload') {
        const result = await reloadUserThemes();
        setThemeCatalogRevision((value) => value + 1);
        const refreshed = resolveThemeWithColor(theme.name, colorEnabled);
        setTheme(refreshed);
        append({
          id: nextId(),
          kind: 'notice',
          tone: result.errors.length ? 'error' : 'success',
          text: result.errors.length
            ? `Theme reload found ${result.errors.length} invalid file${result.errors.length === 1 ? '' : 's'}: ${result.errors[0]}`
            : result.loaded.length
              ? `Loaded ${result.loaded.join(', ')} from ${result.directory}.`
              : `No user themes found in ${result.directory}.`,
        });
        return true;
      }
      if (argument.toLocaleLowerCase() === 'list') {
        appendList('Themes', [{
          label: 'auto',
          detail: 'match COLORFGBG or use a dark-safe default',
          tone: 'normal' as const,
        }, ...Object.values(themes).map((candidate) => ({
          label: candidate.name,
          detail: candidate.name === theme.name ? 'active' : 'available',
          tone: candidate.name === theme.name ? 'success' as const : 'normal' as const,
        }))]);
        return true;
      }
      const selectedName = argument ? argument.toLocaleLowerCase() : undefined;
      const selected = selectedName
        ? (selectedName === 'auto' || themes[selectedName]
          ? resolveThemeWithColor(selectedName, colorEnabled)
          : undefined)
        : nextTheme(theme.name, {color: colorEnabled});
      if (!selected) throw new Error(`Unknown theme. Available: auto, ${Object.keys(themes).join(', ')}`);
      setTheme(selected);
      await saveUiPreference({theme: selectedName === 'auto' ? 'auto' : selected.name});
      append({id: nextId(), kind: 'theme', name: selected.name});
      return true;
    }
    if (command === 'resume') {
      if (!argument) {
        const summaries = (await runner.sessionStore.list()).slice(0, 8);
        appendList('Recent sessions', summaries.length
          ? summaries.map((summary) => ({
            label: `${summary.id.slice(0, 8)}${summary.id === session.id ? '  (current)' : ''}`,
            detail: `${summary.title} · ${summary.messageCount} messages · ${summary.updatedAt.slice(0, 16).replace('T', ' ')}`,
          }))
          : [{label: 'No saved sessions in this workspace.'}]);
        if (summaries.length > 1) {
          append({id: nextId(), kind: 'notice', tone: 'info', text: 'Switch with /resume <session-id prefix>.'});
        }
        return true;
      }
      const selector = argument.trim();
      const summaries = await runner.sessionStore.list();
      const matches = summaries.filter((summary) => summary.id.startsWith(selector));
      if (!matches.length) throw new Error(`No session id starts with ${selector}. Use /resume to list sessions.`);
      if (matches.length > 1) throw new Error(`Session prefix ${selector} is ambiguous (${matches.length} matches). Add more characters.`);
      const target = matches[0] as (typeof matches)[number];
      if (target.id === session.id) {
        append({id: nextId(), kind: 'notice', tone: 'info', text: 'That session is already active.'});
        return true;
      }
      const loaded = await runner.sessionStore.load(target.id);
      runner.switchSession(loaded);
      const snapshot = snapshotSession(loaded);
      setSession(snapshot);
      setTasks(snapshot.tasks.map((task) => ({...task})));
      setTimeline(initialTimeline(loaded, {
        engine: 'local',
        status: 'ready',
        version: packageJson.version,
      }));
      setHistory(initialHistory(loaded));
      queued.current = [];
      clarificationBacklog.current = [];
      setQueue([]);
      append({
        id: nextId(),
        kind: 'notice',
        tone: 'success',
        text: `Resumed session ${target.id.slice(0, 8)} · ${target.title}. Session approvals were reset.`,
      });
      return true;
    }
    if (command === 'model') {
      const routeLabel = `${config.model.provider}/${config.model.model}`;
      const connectionLabel = config.activeConnection && config.activeConnection.source !== 'legacy'
        ? `@${config.activeConnection.id}`
        : undefined;
      const namedConnection = connectionLabel
        ? config.agents?.connections?.[config.activeConnection?.id ?? '']
        : undefined;
      if (!argument) {
        appendList('Model route', [
          {label: routeLabel, detail: connectionLabel ? `connection ${connectionLabel}` : 'legacy configuration'},
          {label: 'Switch', detail: '/model <model-id> switches within this connection; /model list shows the catalog'},
        ]);
        return true;
      }
      if (argument.toLocaleLowerCase() === 'list') {
        if (!namedConnection) {
          throw new Error('Model discovery needs a named connection; the legacy route has no catalog endpoint.');
        }
        const models = await listConnectionModels(namedConnection);
        appendList(`Models ${connectionLabel}`, models.length
          ? models.slice(0, 20).map((model) => ({
            label: model.id === config.model.model ? `${model.id}  (active)` : model.id,
            ...(model.ownedBy ? {detail: model.ownedBy} : {}),
          }))
          : [{label: 'The connection returned no models.'}]);
        return true;
      }
      const requested = argument.trim();
      if (namedConnection) {
        const models = await listConnectionModels(namedConnection).catch(() => []);
        if (models.length && !models.some((model) => model.id === requested)) {
          throw new Error(`Model ${requested} is not in the ${connectionLabel} catalog. Use /model list.`);
        }
      }
      await runner.switchModel(requested);
      setSession(snapshotSession(runner.getSession()));
      append({
        id: nextId(),
        kind: 'notice',
        tone: 'success',
        text: `Model switched to ${config.model.provider}/${requested}${connectionLabel ? ` on ${connectionLabel}` : ''}. The next turn uses it.`,
      });
      return true;
    }
    if (command === 'mode') {
      const normalized = argument.toLocaleLowerCase();
      const next = normalized === 'ask' || normalized === 'plan' || normalized === 'build'
        ? normalized
        : normalized === '' || normalized === 'toggle'
          ? interactionMode === 'ask' ? 'plan' : interactionMode === 'plan' ? 'build' : 'ask'
          : undefined;
      if (!next) throw new Error('Usage: /mode [ask|plan|build]');
      setInteractionMode(next);
      append({
        id: nextId(),
        kind: 'notice',
        tone: 'success',
        text: next === 'ask'
          ? 'Ask mode enabled. Mutating tools are unavailable.'
          : next === 'plan'
            ? 'Plan mode enabled. Read-only implementation planning is active.'
            : 'Build mode enabled. The configured permission policy is active.',
      });
      return true;
    }
    if (command === 'density') {
      const normalized = argument.toLocaleLowerCase();
      const next = normalized === 'compact'
        ? true
        : normalized === 'comfortable' || normalized === 'normal'
          ? false
          : normalized === '' || normalized === 'toggle'
            ? !compact
            : undefined;
      if (next === undefined) throw new Error('Usage: /density [compact|comfortable]');
      setCompact(next);
      await saveUiPreference({compact: next});
      append({id: nextId(), kind: 'notice', tone: 'success', text: `${next ? 'Compact' : 'Comfortable'} density enabled.`});
      return true;
    }
    if (command === 'status' || command === 'about') {
      const usage = runner.getSession().usage;
      const status = runner.getContextStatus();
      const mcpServers = extensions?.mcpStatus() ?? [];
      const connection = config.activeConnection && config.activeConnection.source !== 'legacy'
        ? `@${config.activeConnection.id} ${config.model.provider}/${config.model.model}`
        : `${config.model.provider}/${config.model.model}`;
      appendList('Status', [
        {label: runner.workspace.primaryRoot, detail: 'workspace'},
        {label: connection, detail: 'active connection and model'},
        {label: `${interactionMode.toUpperCase()} ${separator} ${permissionPosture(config)}`, detail: 'mode and permission posture'},
        {
          label: workspaceReadiness ? `${workspaceReadiness.files ? 'ready' : 'empty'} index` : 'index not reported',
          detail: workspaceReadiness
            ? `${workspaceReadiness.files} files ${separator} ${workspaceReadiness.chunks} chunks ${separator} local context`
            : 'local context readiness is unavailable',
          tone: workspaceReadiness?.files === 0 ? 'warning' : 'normal',
        },
        {
          label: `${runner.tools.definitions().length} tools ${separator} ${extensions?.listSkills().length ?? 0} Skills`,
          detail: `${mcpServers.filter((server) => server.state === 'connected').length}/${mcpServers.length} MCP connected`,
        },
        {label: theme.name, detail: 'terminal theme'},
        {label: config.memory?.enabled ? 'enabled' : 'disabled', detail: 'durable memory'},
        {label: config.agents?.enabled ? `${config.agents.maxConcurrent} concurrent` : 'disabled', detail: 'expert delegation'},
        {
          label: `${usage.inputTokens.toLocaleString()} in ${separator} ${usage.outputTokens.toLocaleString()} out`,
          detail: `session tokens${separator}${(usage.inputTokens + usage.outputTokens).toLocaleString()} total${separator}${usage.source ?? 'unknown source'}`,
        },
        {
          label: `${Math.round(status.pressure * 100)}% context pressure`,
          detail: `${status.messageCount} active messages${separator}~${status.activeTokens.toLocaleString()} tokens${status.compactedMessages ? `${separator}${status.compactedMessages} compacted` : ''}`,
        },
      ]);
      return true;
    }
    // Workspace command templates resolve last so built-ins can never be
    // shadowed; a fresh on-demand discovery keeps newly added files usable
    // without restarting the session.
    let custom = customCommands.find((candidate) => candidate.name === command);
    if (!custom) {
      const discovered = await discoverCustomCommands(runner.workspace.primaryRoot, reservedCommandNames);
      if (discovered.length) setCustomCommands(discovered);
      custom = discovered.find((candidate) => candidate.name === command);
    }
    if (custom) {
      append({
        id: nextId(),
        kind: 'notice',
        tone: 'info',
        text: `Expanded ${custom.path} (${custom.content.length} chars). The full prompt is recorded in the transcript.`,
      });
      return {kind: 'agent', display: value, runInput: expandCustomCommand(custom, argument)};
    }
    append({id: nextId(), kind: 'notice', tone: 'error', text: `Unknown command: /${command}`});
    return true;

    async function runMemoryCommand(argumentText: string): Promise<LocalCommandResult> {
      if (!extensions?.memory) {
        append({id: nextId(), kind: 'notice', tone: 'error', text: 'Memory is disabled.'});
        return true;
      }
      const [subcommand = '', ...parts] = argumentText.split(/\s+/).filter(Boolean);
      const normalized = subcommand.toLocaleLowerCase();
      if (!argumentText || normalized === 'stats') {
        const stats = extensions.memoryStats();
        appendList('Memory', stats ? [
          {label: `${stats.active} active`, detail: 'durable records', tone: 'success'},
          {label: `${stats.archived} archived`, detail: 'superseded or retired'},
          {label: `${stats.candidates} pending`, detail: 'candidate facts awaiting approval', tone: stats.candidates ? 'warning' : 'normal'},
          {label: stats.path, detail: 'local SQLite store'},
        ] : [{label: 'Memory is disabled.', tone: 'error'}]);
        return true;
      }
      if (normalized === 'privacy') {
        const review = await extensions.memoryPrivacyReview();
        if (!review) {
          append({id: nextId(), kind: 'notice', tone: 'error', text: 'Memory privacy review is unavailable.'});
          return true;
        }
        const ownerOnly = review.storage.ownerOnly === null
          ? 'not verifiable'
          : review.storage.ownerOnly ? 'owner-only' : 'permissions need review';
        appendList(`Memory privacy ${separator} content-free`, [
          {
            label: `${review.totals.records} retained records`,
            detail: `${review.totals.active} active${separator}${review.totals.archived} archived${separator}${review.totals.candidates.pending} pending`,
          },
          {
            label: `local SQLite${separator}${ownerOnly}`,
            detail: `not encrypted by Skein${separator}${review.storage.filesChecked} storage files checked`,
            tone: review.storage.ownerOnly === false ? 'error' : 'warning',
          },
          {
            label: `${review.lifecycle.neverExpires} no-expiry${separator}${review.lifecycle.expiring} expiring`,
            detail: `${review.lifecycle.expired} expired${separator}${review.lifecycle.unverified} unverified${separator}${review.lifecycle.directInferred} legacy direct-inferred`,
            tone: review.lifecycle.expired || review.lifecycle.directInferred ? 'warning' : 'normal',
          },
          ...review.findings.map((finding) => ({
            label: `${finding.severity}${separator}${finding.code}${separator}${finding.count}`,
            detail: finding.action,
            tone: finding.severity === 'error' ? 'error' as const
              : finding.severity === 'warning' ? 'warning' as const : 'normal' as const,
          })),
          {
            label: 'No content, tags, scope keys, or database path shown',
            detail: `Use ${PRODUCT_COMMAND} memory export for an explicit owner-only JSON export.`,
            tone: 'success',
          },
        ]);
        return true;
      }
      if (normalized === 'list') {
        const records = extensions.searchMemory('', runner.getSession(), 12);
        appendList('Durable memory', records.map((record) => ({
          label: `${record.id.slice(0, 8)}  ${record.scope}/${record.kind}`,
          detail: `${record.content.replace(/\s+/g, ' ').slice(0, 140)}${record.content.length > 140 ? ellipsis : ''}${separator}confidence ${Math.round(record.confidence * 100)}%${record.tags.length ? `${separator}${record.tags.slice(0, 4).join(', ')}` : ''}${separator}${record.source}`,
        })));
        return true;
      }
      if (normalized === 'candidates') {
        const candidates = extensions.listMemoryCandidates('pending', 12);
        appendList('Memory candidates', candidates.map((candidate) => ({
          label: `${candidate.id.slice(0, 8)}  ${candidate.scope}/${candidate.kind}`,
          detail: `${candidate.content.replace(/\s+/g, ' ').slice(0, 170)}${separator}${candidate.rationale || 'needs review'}`,
          tone: 'warning',
        })));
        return true;
      }
      if (normalized === 'approve' || normalized === 'reject') {
        const id = parts[0];
        if (!id) throw new Error(`Usage: /memory ${normalized} <candidate-id>`);
        const candidate = extensions.listMemoryCandidates('all', 200).find((item) => item.id.startsWith(id));
        if (!candidate) throw new Error(`Memory candidate not found: ${id}`);
        if (normalized === 'approve') {
          const record = extensions.approveMemoryCandidate(candidate.id);
          append({id: nextId(), kind: 'notice', tone: record ? 'success' : 'error', text: record ? `Approved memory ${record.id.slice(0, 8)}.` : 'Candidate could not be approved.'});
        } else {
          const rejected = extensions.rejectMemoryCandidate(candidate.id);
          append({id: nextId(), kind: 'notice', tone: rejected ? 'success' : 'error', text: rejected ? `Rejected candidate ${candidate.id.slice(0, 8)}.` : 'Candidate was already resolved.'});
        }
        return true;
      }
      if (normalized === 'archive' || normalized === 'forget') {
        const id = parts[0];
        if (!id) throw new Error(`Usage: /memory ${normalized} <memory-id>`);
        const record = extensions.searchMemory('', runner.getSession(), 100).find((item) => item.id.startsWith(id));
        if (!record) throw new Error(`Memory not found: ${id}`);
        const changed = normalized === 'archive'
          ? extensions.memory.archive(record.id)
          : extensions.memory.remove(record.id);
        append({id: nextId(), kind: 'notice', tone: changed ? 'success' : 'error', text: changed ? `${normalized === 'archive' ? 'Archived' : 'Forgot'} memory ${record.id.slice(0, 8)}.` : 'Memory was not changed.'});
        return true;
      }
      const records = extensions.searchMemory(argumentText, runner.getSession(), 8);
      appendList(`Memory search${separator}${argumentText}`, records.map((record) => ({
        label: `${record.id.slice(0, 8)}  ${record.scope}/${record.kind}`,
        detail: `${record.content.replace(/\s+/g, ' ').slice(0, 190)}${record.matchReason ? `${separator}${record.matchReason}` : ''}`,
      })));
      return true;
    }
  }, [append, appendList, compact, config, customCommands, ellipsis, exit, extensions, interactionMode, openExternalEditor, refreshSession, requestPermission, runner, separator, showToolOutput, tasks, theme, workflows]);

  const submit = useCallback(async (raw: string, mode: 'steer' | 'follow-up' | 'normal' = 'normal') => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const now = Date.now();
    if (lastSubmitted.current?.value === trimmed && now - lastSubmitted.current.at < 350) return;
    lastSubmitted.current = {value: trimmed, at: now};
    setInput('');
    setHistorySearch(undefined);
    setHistory((items) => [...items.filter((item) => item !== trimmed), trimmed].slice(-100));
    setHistoryIndex(-1);
    historyDraft.current = '';

    if (processing.current && isExitCommand(trimmed)) {
      stopRequested.current = true;
      queued.current = [];
      clarificationBacklog.current = [];
      setQueue([]);
      controller.current?.abort();
      exit();
      return;
    }

    if (trimmed.startsWith('!')) {
      const shellCommand = trimmed.slice(1).trim();
      if (!shellCommand) {
        append({id: nextId(), kind: 'notice', tone: 'info', text: `Usage: !<command> runs one shell command through ${PRODUCT_NAME}'s permission checks.`});
        return;
      }
      if (processing.current) {
        append({id: nextId(), kind: 'notice', tone: 'info', text: 'Shell escape is unavailable while a run is active; wait or press esc to stop it.'});
        return;
      }
      processing.current = true;
      setBusy(true);
      append({id: nextId(), kind: 'user', text: trimmed});
      const abortController = new AbortController();
      controller.current = abortController;
      try {
        await runner.runUserShellCommand(shellCommand, {
          signal: abortController.signal,
          onEvent,
          requestPermission,
          requestHumanApproval,
        });
        setSession(snapshotSession(runner.getSession()));
      } catch (error) {
        append({id: nextId(), kind: 'notice', tone: 'error', text: error instanceof Error ? error.message : String(error)});
      } finally {
        controller.current = undefined;
        processing.current = false;
        setBusy(false);
      }
      return;
    }

    if (processing.current && shouldDeferLocalCommand(trimmed)) {
      const pending: LocalQueueItem = {kind: 'local', display: trimmed, value: trimmed};
      queued.current.push(pending);
      setQueue([...queued.current]);
      append({id: nextId(), kind: 'notice', text: `Queued command ${queued.current.length}.`});
      return;
    }

    let localResult: LocalCommandResult;
    try {
      localResult = await runLocalCommand(trimmed);
    } catch (error) {
      append({id: nextId(), kind: 'notice', tone: 'error', text: error instanceof Error ? error.message : String(error)});
      return;
    }
    if (localResult === true) return;
    const item: AgentQueueItem = localResult || {kind: 'agent', display: trimmed, runInput: trimmed};
    if (processing.current && mode === 'steer' && !item.turnInstructions) {
      if (runner.steer(item.runInput)) {
        append({id: nextId(), kind: 'user', text: item.display});
        append({id: nextId(), kind: 'notice', tone: 'info', text: 'Steer queued for the next model turn.'});
        return;
      }
    }
    if (processing.current) {
      queued.current.push(item);
      setQueue([...queued.current]);
      append({id: nextId(), kind: 'notice', text: `Queued follow-up ${queued.current.length}.`});
      return;
    }

    processing.current = true;
    stopRequested.current = false;
    setBusy(true);
    let current: QueueItem | undefined = item;
    try {
      while (current) {
        if (current.kind === 'local') {
          append({id: nextId(), kind: 'user', text: current.display});
          try {
            const result = await runLocalCommand(current.value);
            if (result && result !== true) {
              current = result;
              continue;
            }
          } catch (error) {
            append({id: nextId(), kind: 'notice', tone: 'error', text: error instanceof Error ? error.message : String(error)});
          }
          if (stopRequested.current) {
            const discarded = queued.current.length;
            queued.current = [];
            setQueue([]);
            append({
              id: nextId(),
              kind: 'notice',
              tone: 'info',
              text: `Command sequence stopped${discarded ? `; discarded ${discarded} queued follow-up${discarded === 1 ? '' : 's'}` : ''}.`,
            });
            break;
          }
          current = queued.current.shift();
          setQueue([...queued.current]);
          continue;
        }
        append({id: nextId(), kind: 'user', text: current.display});
        const abortController = new AbortController();
        controller.current = abortController;
        lastEventError.current = undefined;
        try {
          const nextSession = await runner.run(current.runInput, {
            askMode: current.readOnly === true || interactionMode !== 'build',
            signal: abortController.signal,
            ...((current.turnInstructions || interactionMode === 'plan') ? {
              turnInstructions: [
                ...(interactionMode === 'plan' ? [PLAN_MODE_INSTRUCTIONS] : []),
                ...(current.turnInstructions ? [current.turnInstructions] : []),
              ].join('\n\n'),
            } : {}),
            onEvent,
            requestPermission,
            requestHumanApproval,
          });
          const snapshot = snapshotSession(nextSession);
          setSession(snapshot);
          setTasks(snapshot.tasks.map((task) => ({...task})));
          if (snapshot.pendingInput) {
            const deferred = queued.current.length;
            clarificationBacklog.current.push(...queued.current);
            queued.current = [];
            setQueue([]);
            if (deferred) append({
              id: nextId(),
              kind: 'notice',
              tone: 'info',
              text: `Paused ${deferred} queued follow-up${deferred === 1 ? '' : 's'} for clarification; they will resume after the answer.`,
            });
            break;
          }
          if (clarificationBacklog.current.length) {
            const resumed = clarificationBacklog.current.length;
            queued.current = [...clarificationBacklog.current, ...queued.current];
            clarificationBacklog.current = [];
            setQueue([...queued.current]);
            append({
              id: nextId(),
              kind: 'notice',
              tone: 'success',
              text: `Clarification resolved; resuming ${resumed} queued follow-up${resumed === 1 ? '' : 's'}.`,
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!abortController.signal.aborted && message !== lastEventError.current) {
            append({id: nextId(), kind: 'notice', tone: 'error', text: message});
          }
          if (!abortController.signal.aborted) {
            queued.current = [];
            setQueue([]);
            break;
          }
        }
        if (abortController.signal.aborted || stopRequested.current) {
          const discarded = queued.current.length + clarificationBacklog.current.length;
          queued.current = [];
          clarificationBacklog.current = [];
          setQueue([]);
          if (discarded) append({id: nextId(), kind: 'notice', text: `Discarded ${discarded} queued follow-up${discarded === 1 ? '' : 's'}.`});
          break;
        }
        current = queued.current.shift();
        setQueue([...queued.current]);
      }
    } finally {
      controller.current = undefined;
      processing.current = false;
      setBusy(false);
      setActivity(undefined);
    }
  }, [append, exit, interactionMode, onEvent, requestHumanApproval, requestPermission, runLocalCommand, runner]);

  const submitFromComposer = useCallback((raw: string, mode: 'steer' | 'follow-up' | 'normal' = 'normal') => {
    if (historySearch) {
      const selected = resolveHistorySearch(historySearch, 'select');
      setHistorySearch(undefined);
      setHistoryIndex(-1);
      void submit(selected, mode === 'normal' && processing.current ? 'steer' : mode);
      return;
    }
    if (suggestionMode === 'mention' && selectedSuggestion) {
      const replacement = replaceActiveMentionToken(raw, selectedSuggestion.value, composerCursor);
      if (replacement) {
        setInput(replacement.value);
        setCursorRequest({value: replacement.value, offset: replacement.cursor});
        return;
      }
    }
    const selected = selectedSuggestion;
    const suggestion = selected && !(raw.startsWith(selected.value) && raw.slice(selected.value.length).trim())
      ? selected
      : undefined;
    const normalized = raw.trimEnd();
    if (suggestion && raw.startsWith('/') && suggestion.value !== raw && suggestion.value.endsWith(' ') && suggestion.label !== normalized) {
      setInput(suggestion.value);
      return;
    }
    const value = suggestion && raw.startsWith('/') && suggestion.value !== raw ? suggestion.value : raw;
    void submit(value, mode === 'normal' && processing.current ? 'steer' : mode);
  }, [composerCursor, historySearch, selectedSuggestion, submit, suggestionMode]);

  const requestRunStop = useCallback(() => {
    if (!processing.current || stopRequested.current) return;
    stopRequested.current = true;
    const pending = queued.current.length;
    const activeRun = Boolean(controller.current);
    setActivity({
      label: activeRun ? 'Stopping the active run' : 'Stopping after the active command',
      startedAt: Date.now(),
    });
    append({
      id: nextId(),
      kind: 'notice',
      tone: 'info',
      text: `${activeRun ? 'Interrupt' : 'Stop'} requested${pending ? `; ${pending} queued follow-up${pending === 1 ? '' : 's'} will be discarded` : ''}.`,
    });
    controller.current?.abort();
  }, [append]);

  function settlePermission(grant: PermissionGrant, stop = false): void {
    if (!permission) return;
    const {call, category, resolve} = permission;
    resolve(grant);
    setPermission(undefined);
    if (grant === 'session' && !permission.humanOnly) {
      append({
        id: nextId(),
        kind: 'notice',
        tone: 'success',
        text: `Allowed ${call.name} for this exact ${category} target during the session.`,
      });
    }
    if (grant === false) {
      append({
        id: nextId(),
        kind: 'notice',
        tone: 'info',
        text: `Denied ${call.name}; the requested ${category} action was not run. Use /permissions to inspect policy or /recover to review the run.`,
      });
    }
    if (stop) {
      requestRunStop();
    }
  }

  useInput((inputKey, key) => {
    if (permission) {
      const armed = Date.now() - permission.armedAt >= PERMISSION_ARMING_MS;
      if (key.ctrl && inputKey.toLocaleLowerCase() === 'c') {
        settlePermission(false, true);
      } else if (inputKey.toLocaleLowerCase() === 'y' && armed) {
        settlePermission(true);
      } else if (inputKey.toLocaleLowerCase() === 'a' && !permission.humanOnly && armed) {
        settlePermission('session');
      } else if (inputKey.toLocaleLowerCase() === 'n') {
        settlePermission(false);
      } else if (key.escape) {
        settlePermission(false, true);
      }
      return;
    }
    if (teamWorkbenchOpen) {
      if (key.ctrl && inputKey.toLocaleLowerCase() === 'c') {
        if (busy) {
          requestRunStop();
        } else {
          exit();
        }
        return;
      }
      if (key.escape || (key.ctrl && inputKey.toLocaleLowerCase() === 't')) {
        setTeamWorkbenchOpen(false);
        setTeamWorkbenchExpanded(false);
        setTeamWorkbenchNotice(undefined);
        return;
      }
      if (key.leftArrow || key.rightArrow) {
        const views: TeamWorkbenchView[] = ['agents', 'tasks', 'messages'];
        const current = views.indexOf(teamWorkbenchView);
        const delta = key.leftArrow ? -1 : 1;
        setTeamWorkbenchView(views[(current + delta + views.length) % views.length] ?? 'agents');
        setTeamWorkbenchIndex(0);
        setTeamWorkbenchExpanded(false);
        return;
      }
      if (inputKey.toLocaleLowerCase() === 's' || inputKey.toLocaleLowerCase() === 'r') {
        const agents = timeline.filter((item): item is Extract<TimelineItem, {kind: 'agent'}> => item.kind === 'agent' && !item.superseded);
        const selected = agents[teamWorkbenchIndex];
        if (!selected) return;
        const requested = inputKey.toLocaleLowerCase() === 's'
          ? extensions?.cancelAgent(selected.id)
          : extensions?.retryAgent(selected.id);
        append({
          id: nextId(),
          kind: 'notice',
          tone: requested ? 'info' : 'error',
          text: requested
            ? inputKey.toLocaleLowerCase() === 's' ? `Stop requested for ${selected.profile}.` : `Retry requested for ${selected.profile}.`
            : `No active control is available for ${selected.profile}.`,
        });
        setTeamWorkbenchNotice(requested
          ? inputKey.toLocaleLowerCase() === 's' ? `Stop requested for ${selected.profile}.` : `Retry requested for ${selected.profile}.`
          : `No active control is available for ${selected.profile}.`);
        return;
      }
      const itemCount = teamWorkbenchView === 'agents'
        ? timeline.filter((item) => item.kind === 'agent' && !item.superseded).length
        : teamWorkbenchView === 'tasks'
          ? tasks.length
          : Math.min(12, timeline.filter((item) => item.kind === 'agent-message').length);
      if (key.upArrow || key.downArrow) {
        if (itemCount) {
          setTeamWorkbenchIndex((index) => (index + (key.upArrow ? -1 : 1) + itemCount) % itemCount);
        }
        return;
      }
      if (key.return) {
        setTeamWorkbenchExpanded((expanded) => !expanded);
        return;
      }
      return;
    }
    if (key.ctrl && inputKey.toLocaleLowerCase() === 't') {
      setTeamWorkbenchOpen(true);
      setTeamWorkbenchView('agents');
      setTeamWorkbenchIndex(0);
      setTeamWorkbenchExpanded(false);
      setTeamWorkbenchNotice(undefined);
      return;
    }
    if (key.meta && inputKey.toLocaleLowerCase() === 'e') {
      void openExternalEditor(input);
      return;
    }
    if (key.ctrl && inputKey.toLocaleLowerCase() === 'r') {
      if (!history.length) return;
      setHistorySearch((current) => current
        ? moveHistorySearchSelection(current, 'older')
        : createHistorySearchState(history, input, input));
      setHistoryIndex(-1);
      return;
    }
    if (key.escape) {
      if (historySearch) {
        setInput(resolveHistorySearch(historySearch, 'cancel'));
        setHistorySearch(undefined);
      } else if (suggestionMode !== 'none') {
        setSuggestionsDismissedFor(input);
      } else if (busy) {
        requestRunStop();
      } else if (input) {
        clearDraftRecoverably();
      }
      return;
    }
    if (key.ctrl && inputKey.toLocaleLowerCase() === 'c') {
      if (historySearch) {
        setInput(resolveHistorySearch(historySearch, 'cancel'));
        setHistorySearch(undefined);
      } else if (busy) {
        requestRunStop();
      } else if (input) {
        clearDraftRecoverably();
      } else if (Date.now() - exitArmedAt.current < EXIT_CONFIRM_WINDOW_MS) {
        exit();
      } else {
        exitArmedAt.current = Date.now();
        append({id: nextId(), kind: 'notice', tone: 'info', text: 'Press Ctrl+C again to exit.'});
      }
      return;
    }
    if (key.ctrl && inputKey.toLocaleLowerCase() === 'l') {
      setTimeline([]);
      return;
    }
    if (key.ctrl && inputKey.toLocaleLowerCase() === 'o') {
      const latest = [...timeline].reverse().find((item) => item.kind === 'tool' && item.output);
      if (latest?.kind === 'tool') {
        setShowToolOutput(false);
        setExpandedToolId((current) => current === latest.id ? undefined : latest.id);
      }
      return;
    }
    if (historySearch && key.tab) {
      setInput(resolveHistorySearch(historySearch, 'select'));
      setHistorySearch(undefined);
      setHistoryIndex(-1);
      return;
    }
    if (suggestionMode === 'mention' && selectedSuggestion && key.tab) {
      const replacement = replaceActiveMentionToken(input, selectedSuggestion.value, composerCursor);
      if (replacement) {
        setInput(replacement.value);
        setCursorRequest({value: replacement.value, offset: replacement.cursor});
      }
      return;
    }
    if (suggestions.length && key.tab) {
      setInput(selectedSuggestion?.value ?? input);
      return;
    }
    if (historySearch && key.upArrow) {
      setHistorySearch((current) => current
        ? moveHistorySearchSelection(current, 'newer')
        : current);
      return;
    }
    if (historySearch && key.downArrow) {
      setHistorySearch((current) => current
        ? moveHistorySearchSelection(current, 'older')
        : current);
      return;
    }
    if (suggestions.length && key.upArrow) {
      setSuggestionIndex((index) => (index - 1 + suggestions.length) % suggestions.length);
      return;
    }
    if (suggestions.length && key.downArrow) {
      setSuggestionIndex((index) => (index + 1) % suggestions.length);
      return;
    }
    const historyPrevious = key.upArrow || (key.ctrl && inputKey.toLocaleLowerCase() === 'p');
    const historyNext = key.downArrow || (key.ctrl && inputKey.toLocaleLowerCase() === 'n');
    if (!suggestions.length && !input.includes('\n') && historyPrevious && history.length && (input.length === 0 || historyIndex >= 0)) {
      if (historyIndex < 0) historyDraft.current = input;
      const next = Math.min(history.length - 1, historyIndex + 1);
      setHistoryIndex(next);
      setInput(history[history.length - 1 - next] ?? '');
      return;
    }
    if (!suggestions.length && !input.includes('\n') && historyNext && historyIndex >= 0) {
      const next = historyIndex - 1;
      setHistoryIndex(next);
      setInput(next < 0 ? historyDraft.current : history[history.length - 1 - next] ?? '');
    }
  });

  useEffect(() => {
    if (!initialPrompt || startedInitial.current) return;
    startedInitial.current = true;
    void submit(initialPrompt);
  }, [initialPrompt, submit]);

  const tokenTotal = session.usage.inputTokens + session.usage.outputTokens;
  const contextStatus = runner.getContextStatus();
  const frame = spinnerFrames()[frameIndex % spinnerFrames().length] as string;
  const composerStarterHint = starterHint(starterHintIndex, separator);
  const compactUi = compact || terminalHeight < 28;
  const constrainedHeight = terminalHeight < 18;
  const compactComposer = terminalHeight < 18;
  const minimalInspector = terminalHeight < 22;
  const latestSurface = timeline.at(-1)?.kind;
  const inspectorSurface = latestSurface === 'list' || latestSurface === 'context-inspector' ||
    latestSurface === 'theme' || latestSurface === 'clarification' || latestSurface === 'update';
  const conversationStarted = timeline.some((item) => item.kind === 'user' || item.kind === 'assistant');
  const showHeader = terminalHeight >= 10 && !conversationStarted && !permission && suggestionMode === 'none' &&
    !showContextInspector && !teamWorkbenchOpen && !inspectorSurface;
  const taskLimit = compactUi ? 3 : 6;
  const paletteVisible = suggestions.length > 0 || Boolean(historySearch) || suggestionMode === 'mention';
  const paletteSuggestions = constrainedHeight && suggestions.length
    ? [{...(selectedSuggestion ?? suggestions[0]!), description: ''}]
    : suggestions;
  const paletteSelectedIndex = constrainedHeight ? 0 : selectedIndex;
  const renderContextInspector = showContextInspector && !(constrainedHeight && paletteVisible);
  const showTaskRail = terminalHeight >= 18 && Boolean(tasks.length) && !permission && !paletteVisible && !showContextInspector;
  const showActivity = terminalHeight >= 16 && !permission && Boolean(activity);
  const showFooter = !(constrainedHeight && (paletteVisible || Boolean(permission)));
  const taskRows = showTaskRail
    ? 2 + Math.min(tasks.length, taskLimit) + (tasks.length > taskLimit ? 1 : 0)
    : 0;
  const palettePageSize = contentWidth < 28 ? 3 : contentWidth < 48 ? 4 : 6;
  const paletteRows = paletteVisible
    ? 3 + Math.min(paletteSuggestions.length, palettePageSize) +
      (contentWidth < 64 && paletteSuggestions.some((suggestion) => suggestion.description) ? 1 : 0) +
      (paletteSuggestions.length ? 0 : 1)
    : 0;
  const attachments = composerAttachments(input);
  const visibleAttachments = compactComposer ? [] : attachments;
  const visibleQueuePreview = compactComposer ? undefined : queue[0]?.display;
  const composerPreview = input || (busy ? `follow-up${ellipsis}` : interactionMode === 'ask' ? `trace or explain${ellipsis}` : interactionMode === 'plan' ? `outline the implementation${ellipsis}` : `inspect, change, or verify${ellipsis}`);
  const composerRows = permission
    ? permissionRows(contentWidth, Boolean(typeof permission.call.arguments.cwd === 'string' || runner.workspace.primaryRoot), constrainedHeight)
      + permissionPreviewRows(permission.preview, contentWidth, constrainedHeight)
    : (terminalAccessibility.screenReader ? 2 : 3) + visibleAttachments.length + (visibleQueuePreview ? 1 : 0) + composerValueRows(composerPreview, Math.max(1, contentWidth - 2), compactComposer ? 1 : 4);
  const inspectorRows = renderContextInspector ? contextInspectorRows(session, compactUi, contentWidth, minimalInspector) : 0;
  const footerRows = showFooter ? 1 : 0;
  const activityRows = showActivity && activity ? (contentWidth < 48 && activity.turn ? 3 : 2) : 0;
  const teamItems = timeline.filter((item) => item.kind === 'agent' || item.kind === 'agent-message');
  const showTeamSummary = config.agents?.cockpit !== false && !teamWorkbenchOpen && !permission && !paletteVisible && !showContextInspector && !inspectorSurface &&
    teamItems.some((item) => item.kind === 'agent' && (item.state === 'queued' || item.state === 'running'));
  const teamSummaryRows = showTeamSummary ? (contentWidth >= 64 ? 3 : 2) : 0;
  const headerRows = showHeader ? 2 : 0;
  const chromeRows = headerRows + composerRows + footerRows + taskRows + paletteRows + inspectorRows + activityRows + teamSummaryRows;
  const availableTimelineRows = Math.max(0, terminalHeight - chromeRows);
  const mainTimeline = timeline.filter((item) => item.kind !== 'agent' && item.kind !== 'agent-message');
  const timelineContentRows = mainTimeline.reduce((rows, item) => rows + estimateTimelineItemRows(item, {
    width: contentWidth,
    rows: availableTimelineRows,
    compact: compactUi,
    showToolOutput,
    ...(expandedToolId ? {expandedToolId} : {}),
  }), 0);
  // Keep short sessions inline with the surrounding terminal. The viewport
  // grows only as transcript content needs it, up to the real terminal height.
  const timelineRows = teamWorkbenchOpen
    ? availableTimelineRows
    : Math.min(availableTimelineRows, timelineContentRows);
  const visibleTimeline = fitTimelineToRows(mainTimeline, {
    width: contentWidth,
    rows: timelineRows,
    compact: compactUi,
    showToolOutput,
    ...(expandedToolId ? {expandedToolId} : {}),
  });
  const activeAgents = timeline.filter((item) => item.kind === 'agent' && item.state === 'running').length;
  const mcpServers = extensions?.mcpStatus() ?? [];
  const memoryStats = extensions?.memoryStats();
  if (terminalHeight < 8) {
    return (
      <ThemeProvider theme={theme}>
        <Box paddingX={horizontalPadding} height={terminalHeight} overflowY="hidden">
          <Text color={theme.warning}>{truncateDisplay(`${PRODUCT_NAME}: terminal too short; resize to at least 8 rows.`, contentWidth)}</Text>
        </Box>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider theme={theme}>
      <Box
        flexDirection="column"
        paddingX={horizontalPadding}
        width={contentWidth + horizontalPadding * 2}
        overflowY="hidden"
      >
        {showHeader ? <Header config={config} askMode={interactionMode !== 'build'} planMode={interactionMode === 'plan'} width={contentWidth} glyphMode={glyphMode} /> : null}
        {timelineRows > 0 ? (
          <Box flexDirection="column" height={timelineRows} overflowY="hidden">
            {teamWorkbenchOpen ? (
              <TeamWorkbench
                items={teamItems}
                tasks={tasks}
                width={contentWidth}
                glyphMode={glyphMode}
                view={teamWorkbenchView}
                selectedIndex={teamWorkbenchIndex}
                expanded={teamWorkbenchExpanded}
                {...(teamWorkbenchNotice ? {notice: teamWorkbenchNotice} : {})}
                {...(teamRun ? {run: teamRun} : {})}
              />
            ) : (
              <Box flexDirection="column" width={contentWidth} overflowY="hidden">
                <Timeline
                  items={visibleTimeline}
                  width={contentWidth}
                  glyphMode={glyphMode}
                  showToolOutput={showToolOutput}
                  {...(expandedToolId ? {expandedToolId} : {})}
                  compact={compactUi}
                />
              </Box>
            )}
          </Box>
        ) : null}
        {showTaskRail ? <TaskRail tasks={tasks} width={contentWidth} glyphMode={glyphMode} maxItems={taskLimit} /> : null}
        {showTeamSummary ? <TeamSummary items={teamItems} width={contentWidth} glyphMode={glyphMode} /> : null}
        {renderContextInspector ? (
          <ContextInspector
            status={contextInspectorStatus(contextStatus)}
            working={session.workingMemory}
            summary={session.contextSummary}
            width={contentWidth}
            compact={compactUi}
            minimal={minimalInspector}
            glyphMode={glyphMode}
            memory={memoryStats ? `${memoryStats.active} active${memoryStats.candidates ? `${separator}${memoryStats.candidates} pending` : ''}` : config.memory?.enabled ? 'enabled' : 'disabled'}
            connections={`${runner.tools.definitions().length} tools${separator}${mcpServers.filter((server) => server.state === 'connected').length}/${mcpServers.length} MCP connected`}
            {...(session.contextSources?.length ? {sources: session.contextSources} : {})}
          />
        ) : null}
        <ActivityLine {...(showActivity && activity ? {activity} : {})} frame={frame} width={contentWidth} />
        {!permission ? <>
          <CommandPalette
            suggestions={paletteSuggestions}
            selected={paletteSelectedIndex}
            width={contentWidth}
            glyphMode={glyphMode}
            {...(historySearch ? {
              title: `History search${historySearch.query ? `: ${historySearch.query}` : ''}`,
              hint: `type to filter${separator}up/down select${separator}enter/tab use${separator}esc cancel`,
              emptyText: 'No matching prompts',
            } : suggestionMode === 'mention' ? {
              title: `Files${mentionToken?.query ? `: ${mentionToken.query}` : ''}`,
              hint: `up/down select${separator}enter/tab attach${separator}esc dismiss`,
              emptyText: mentionLoading ? `Searching workspace${ellipsis}` : 'No matching files',
            } : suggestionMode === 'command' ? {
              title: 'Commands',
            } : {})}
          />
          <PromptBar
            busy={busy || editing}
            value={input}
            mode={input.trimStart().startsWith('!') ? 'shell' : 'chat'}
            width={contentWidth}
            placeholder={busy ? `Steer ${PRODUCT_NAME}${separator}alt+enter queues` : composerStarterHint}
            queueCount={queue.length}
            {...(visibleQueuePreview ? {queuePreview: visibleQueuePreview} : {})}
            attachments={visibleAttachments}
            glyphMode={glyphMode}
            showRule={!terminalAccessibility.screenReader}
          >
            <ComposerInput
              value={input}
              onChange={setInput}
              onSubmit={submitFromComposer}
              onCursorChange={setComposerCursor}
              width={Math.max(1, contentWidth - 2)}
              maxVisibleRows={compactComposer ? 1 : 4}
              {...(cursorRequest?.value === input ? {externalCursorOffset: cursorRequest.offset} : {})}
              focus={!editing}
              captureVerticalArrows={suggestionMode === 'mention' || suggestionMode === 'command' || Boolean(historySearch)}
              placeholder={busy ? `follow-up${ellipsis}` : interactionMode === 'ask' ? `trace or explain${ellipsis}` : interactionMode === 'plan' ? `outline the implementation${ellipsis}` : `inspect, change, or verify${ellipsis}`}
            />
          </PromptBar>
        </> : <PermissionCard call={permission.call} category={permission.category} humanOnly={permission.humanOnly ?? false} {...(permission.reason ? {reason: permission.reason} : {})} {...(permission.preview ? {preview: permission.preview} : {})} workspace={runner.workspace.primaryRoot} width={contentWidth} glyphMode={glyphMode} compact={constrainedHeight} />}
        {showFooter ? (
          <Footer
            busy={busy}
            approval={Boolean(permission)}
            tokens={tokenTotal}
            maxTokens={config.agent.maxSessionTokens}
            changedFiles={session.changedFiles.length}
            width={contentWidth}
            contextPressure={contextStatus.pressure}
            themeName={theme.name}
            queueCount={queue.length}
            activeAgents={showTeamSummary ? 0 : activeAgents}
            frame={frame}
            glyphMode={glyphMode}
            mode={interactionMode.toUpperCase()}
            route={config.activeConnection && config.activeConnection.source !== 'legacy'
              ? `@${config.activeConnection.id}/${config.model.model}`
              : `${config.model.provider}/${config.model.model}`}
          />
        ) : null}
      </Box>
    </ThemeProvider>
  );
}

function permissionPosture(config: MosaicConfig): string {
  const values = [config.permissions.write, config.permissions.shell, config.permissions.git];
  if (values.includes('deny')) return 'restricted';
  if (values.includes('ask')) return 'guarded';
  return 'open';
}

export async function runInteractiveTui(options: TuiOptions): Promise<void> {
  await reloadUserThemes();
  const terminalAccessibility = resolveTerminalAccessibility();
  const instance = render(<SkeinApp {...options} />, {
    exitOnCtrlC: false,
    patchConsole: true,
    incrementalRendering: terminalAccessibility.incrementalRendering,
    isScreenReaderEnabled: terminalAccessibility.screenReader,
    maxFps: 30,
    kittyKeyboard: resolveKittyKeyboardConfig(),
  });
  await instance.waitUntilExit();
  if (terminalAccessibility.screenReader) process.stdout.write('\n');
}

function initialTimeline(session: Session, banner: BannerInfo, setupProblem?: string): TimelineItem[] {
  const items: TimelineItem[] = session.messages
    .filter((message) => (message.role === 'user' || message.role === 'assistant') && visibleMessage(message))
    .slice(-20)
    .map((message) => ({id: message.id, kind: message.role as 'user' | 'assistant', text: message.content}));
  // A fresh session opens on the product banner instead of an empty screen; a
  // resumed session keeps its transcript and skips the banner.
  if (!items.length) {
    items.push({
      id: nextId(), kind: 'banner', engine: banner.engine, status: banner.status, version: banner.version,
      ...(banner.files !== undefined ? {files: banner.files} : {}),
      ...(banner.resume ? {resume: banner.resume} : {}),
    });
  }
  if (session.taskContract && session.taskContract.state !== 'satisfied') {
    const required = session.taskContract.acceptanceCriteria.filter((item) => item.required);
    const satisfied = required
      .filter((item) => item.status === 'satisfied').length;
    items.push({
      id: 'task-contract-progress',
      kind: 'notice',
      tone: session.taskContract.state === 'blocked' ? 'error' : 'info',
      text: `Contract ${session.taskContract.state} | ${satisfied}/${required.length} accepted`,
    });
  }
  if (session.pendingInput) {
    items.push({id: `pending-input-${session.pendingInput.id}`, kind: 'clarification', pending: session.pendingInput});
  }
  if (setupProblem && items.length <= 1) items.push({id: nextId(), kind: 'notice', tone: 'error', text: setupProblem});
  return items;
}

interface BannerInfo {
  engine: string;
  status: 'ready' | 'empty' | 'blocked';
  version: string;
  files?: number;
  resume?: {title: string; updatedAt: string};
}

function initialHistory(session: Session): string[] {
  return session.messages
    .filter((message) => message.role === 'user' && visibleMessage(message))
    .map((message) => message.content.trim())
    .filter(Boolean)
    .slice(-100);
}

function visibleMessage(message: ChatMessage): boolean {
  return !message.content.startsWith('<automatic-verification>') &&
    !message.content.startsWith('<runtime-completion-gate') &&
    !message.content.startsWith('<workflow ') &&
    !message.content.startsWith('<retrieved-memory');
}

function snapshotSession(source: Session): Session {
  return {
    ...source,
    messages: source.messages.map((message) => ({
      ...message,
      ...(message.toolCalls ? {
        toolCalls: message.toolCalls.map((call) => ({
          ...call,
          arguments: cloneRecord(call.arguments),
        })),
      } : {}),
    })),
    tasks: source.tasks.map((task) => ({...task})),
    changedFiles: [...source.changedFiles],
    ...(source.lastRun ? {
      lastRun: {
        ...source.lastRun,
        changedFiles: [...source.lastRun.changedFiles],
        checks: source.lastRun.checks.map((check) => ({...check})),
      },
    } : {}),
    ...(source.audit ? {
      audit: source.audit.map((event) => ({
        ...event,
        ...(event.metadata ? {metadata: cloneRecord(event.metadata)} : {}),
      })),
    } : {}),
    ...(source.workingMemory ? {
      workingMemory: {
        ...source.workingMemory,
        constraints: [...source.workingMemory.constraints],
        decisions: [...source.workingMemory.decisions],
        openQuestions: [...source.workingMemory.openQuestions],
        relevantFiles: [...source.workingMemory.relevantFiles],
      },
    } : {}),
    ...(source.contextEpochs ? {
      contextEpochs: source.contextEpochs.map((epoch) => ({
        ...epoch,
        usage: {...epoch.usage},
        ...(epoch.handoff ? {
          handoff: {
            ...epoch.handoff,
            ...(epoch.handoff.contract ? {
              contract: {
                ...epoch.handoff.contract,
                required: epoch.handoff.contract.required.map((criterion) => ({
                  ...criterion,
                  evidenceRefs: [...criterion.evidenceRefs],
                })),
              },
            } : {}),
            unresolvedFailures: epoch.handoff.unresolvedFailures.map((failure) => ({...failure})),
            changedFiles: [...epoch.handoff.changedFiles],
            checks: epoch.handoff.checks.map((check) => ({...check})),
          },
        } : {}),
      })),
    } : {}),
    ...(source.intentAssessment ? {
      intentAssessment: {...source.intentAssessment, reasons: [...source.intentAssessment.reasons]},
    } : {}),
    ...(source.pendingInput ? {
      pendingInput: {...source.pendingInput, options: source.pendingInput.options.map((option) => ({...option}))},
    } : {}),
    usage: {...source.usage},
  };
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]));
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === 'object') return cloneRecord(value as Record<string, unknown>);
  return value;
}

function recoveryFailure(value: unknown): {class?: string; repairHint?: string} | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const receipt = value as Record<string, unknown>;
  return {
    ...(typeof receipt.class === 'string' ? {class: sanitizeTerminalText(receipt.class).slice(0, 40)} : {}),
    ...(typeof receipt.repairHint === 'string'
      ? {repairHint: sanitizeTerminalText(receipt.repairHint).replace(/\s+/gu, ' ').slice(0, 240)}
      : {}),
  };
}

function isExitCommand(value: string): boolean {
  const command = localCommandName(value);
  return command === 'exit' || command === 'quit';
}

function shouldDeferLocalCommand(value: string): boolean {
  const command = localCommandName(value);
  if (!command) return false;
  if (command === 'context') {
    const argument = value.trim().slice('/context'.length).trim().toLocaleLowerCase();
    return argument === 'compact' || argument.startsWith('compact ');
  }
  return new Set([
    'compact',
    'memory',
    'remember',
    'diff',
    'checkpoints',
    'audit',
    'rollback',
    'recover',
    'workflow',
    'model',
    'resume',
    'exit',
    'quit',
  ]).has(command);
}

function localCommandName(value: string): string | undefined {
  const match = value.trim().match(/^\/([^\s]+)/u);
  return match?.[1]?.toLocaleLowerCase();
}

function composerValueRows(value: string, width: number, maxRows: number): number {
  if (!value) return 1;
  const rows = sanitizeTerminalText(value).split('\n').reduce((total, line) =>
    total + Math.max(1, Math.ceil(displayWidth(line || ' ') / Math.max(1, width))), 0);
  return Math.min(maxRows, rows);
}

function composerAttachments(value: string): string[] {
  const paths = [...value.matchAll(/(?:^|\s)@([^\s]+)/g)].map((match) => match[1]).filter((path): path is string => Boolean(path));
  return [...new Set(paths)].slice(-3);
}

function permissionRows(width: number, hasCwd: boolean, compact: boolean): number {
  const content = 5 + (hasCwd ? 1 : 0);
  if (width >= 64) return content + 2;
  if (width >= 28) return content + 3;
  if (compact) return content + 3;
  return content + 5;
}

function contextInspectorRows(session: Session, compact: boolean, width: number, minimal: boolean): number {
  if (minimal) return 2;
  const working = session.workingMemory;
  const entries = 6 + (compact ? 0 : (working?.constraints.length ? 1 : 0) +
    (working?.decisions.length ? 1 : 0) + (working?.openQuestions.length ? 1 : 0) +
    (working?.relevantFiles.length ? 1 : 0));
  return 2 + entries * (width < 52 ? 2 : 1);
}

function contextInspectorStatus(status: ReturnType<AgentRunner['getContextStatus']>): ContextInspectorStatus {
  return {
    pressure: status.pressure,
    messageCount: status.messageCount,
    activeTokens: status.activeTokens,
    summaryTokens: status.summaryTokens,
    toolTokens: status.toolTokens,
    compactedMessages: status.compactedMessages,
    epochIndex: status.epochIndex,
    epochCount: status.epochCount,
    epochTokens: status.epochTokens,
    epochBudget: status.epochBudget,
    lifetimeTokens: status.lifetimeTokens,
    lifetimeBudget: status.lifetimeBudget,
  };
}

function toolDetail(call: ToolCall): string {
  const args = call.arguments;
  for (const key of ['path', 'query', 'command', 'pattern', 'task', 'title']) {
    const value = args[key];
    if (typeof value === 'string') return sanitizeTerminalText(value).replace(/\s+/g, ' ').trim().slice(0, 180);
  }
  const keys = Object.keys(args).filter((key) => !/(?:api[_-]?key|authorization|cookie|password|secret|token)/i.test(key));
  return keys.slice(0, 3).join(', ');
}

function spinnerFrames(): string[] {
  const ascii = resolveTerminalAccessibility().ascii;
  return ascii ? ['.', 'o', 'O', 'o'] : ['◌', '◍', '◎', '◉', '◎', '◍'];
}
