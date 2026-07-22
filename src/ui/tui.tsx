import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Box, render, Text, useApp, useInput, useWindowSize} from 'ink';
import {relative} from 'node:path';
import type {AgentRunner} from '../agent/index.js';
import {PLAN_MODE_INSTRUCTIONS} from '../agent/prompt.js';
import {saveUiPreference} from '../config.js';
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
  TeamCockpit,
  Timeline,
  type ActivityState,
  type ContextInspectorStatus,
  type ListEntry,
  type TimelineItem,
} from './components.js';
import {commandDefinitions, commandSuggestions} from './commands.js';
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
import {nextTheme, reloadUserThemes, resolveThemeWithColor, ThemeProvider, themes} from './theme.js';
import {fitTimelineToRows} from './viewport.js';

interface PermissionRequest {
  call: ToolCall;
  category: ToolCategory;
  resolve: (grant: PermissionGrant) => void;
}

interface AgentQueueItem {
  kind: 'agent';
  display: string;
  runInput: string;
  turnInstructions?: string;
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
}

let itemCounter = 0;
const nextId = () => `ui-${Date.now()}-${itemCounter++}`;

export function SkeinApp({runner, config, extensions, initialPrompt, askMode = false, planMode = false}: TuiOptions) {
  const {exit} = useApp();
  const {columns, rows} = useWindowSize();
  const terminalWidth = Math.max(1, columns || 80);
  const terminalHeight = Math.max(1, rows || 24);
  const horizontalPadding = terminalWidth >= 24 ? 1 : 0;
  const contentWidth = Math.max(1, terminalWidth - horizontalPadding * 2);
  const glyphMode = process.env.SKEIN_GLYPHS === 'ascii' || process.env.MOSAIC_GLYPHS === 'ascii' ? 'ascii' as const : 'auto' as const;
  const glyphs = resolveGlyphs(glyphMode);
  const separator = ` ${glyphs.separator} `;
  const ellipsis = terminalEllipsis();
  const initialSession = runner.getSession();
  const setupProblem = config.model.provider !== 'compatible' && !config.model.apiKey
    ? `No ${config.model.provider} API key configured. Run ${PRODUCT_COMMAND} doctor for setup guidance.`
    : config.model.provider === 'compatible' && !config.model.baseUrl
      ? 'No compatible model endpoint configured. Set model.baseUrl or pass --base-url.'
      : undefined;
  const colorEnabled = config.ui.color && !process.env.NO_COLOR;
  const [theme, setTheme] = useState(() => resolveThemeWithColor(config.ui.theme, colorEnabled));
  const [themeCatalogRevision, setThemeCatalogRevision] = useState(0);
  const [compact, setCompact] = useState(config.ui.compact);
  const [interactionMode, setInteractionMode] = useState<'ask' | 'plan' | 'build'>(planMode ? 'plan' : askMode ? 'ask' : 'build');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [timeline, setTimeline] = useState<TimelineItem[]>(() => initialTimeline(initialSession, setupProblem));
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
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [suggestionsDismissedFor, setSuggestionsDismissedFor] = useState<string>();
  const [frameIndex, setFrameIndex] = useState(0);
  const controller = useRef<AbortController | undefined>(undefined);
  const processing = useRef(false);
  const queued = useRef<QueueItem[]>([]);
  const stopRequested = useRef(false);
  const startedInitial = useRef(false);
  const lastSubmitted = useRef<{value: string; at: number} | undefined>(undefined);
  const lastEventError = useRef<string | undefined>(undefined);
  const historyDraft = useRef('');
  const mentionRequest = useRef(0);

  const workflows = useMemo(() => extensions?.listWorkflows() ?? [], [extensions]);
  const commandMatches = useMemo(() => commandSuggestions(input, {
    themes: ['auto', ...Object.keys(themes)],
    workflows,
  }), [input, themeCatalogRevision, workflows]);
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
        let semantic: string[] = [];
        if (query.trim().length >= 2) {
          try {
            const hits = await runner.contextEngine.search(query, 12);
            semantic = contextHitMentionSuggestions(hits, runner.workspace.roots, query, 8);
          } catch {
            // A missing external index should not make file completion unavailable.
          }
        }
        try {
          const index = await getMentionPathIndex(runner.workspace.roots);
          const paths = rankMentionSuggestions([
            ...semantic,
            ...index.suggest(query, 12),
          ], query, 6);
          if (request === mentionRequest.current) setMentionMatches(paths);
        } catch {
          if (request === mentionRequest.current) setMentionMatches(semantic);
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
    if (!busy || reducedMotion()) {
      setFrameIndex(0);
      return undefined;
    }
    const timer = setInterval(() => setFrameIndex((value) => (value + 1) % spinnerFrames().length), 120);
    return () => clearInterval(timer);
  }, [busy]);

  const requestPermission = useCallback((call: ToolCall, category: ToolCategory) => {
    return new Promise<PermissionGrant>((resolve) => setPermission({call, category, resolve}));
  }, []);

  const onEvent = useCallback((event: AgentEvent) => {
    switch (event.type) {
      case 'thinking':
        setActivity({label: event.turn > 1 ? 'Reviewing the latest tool result' : 'Thinking', startedAt: Date.now(), turn: event.turn});
        break;
      case 'context':
        refreshSession();
        append({id: nextId(), kind: 'context', engine: event.packed.engine, hits: event.packed.hits.length, tokens: event.packed.estimatedTokens});
        setActivity({label: 'Assembling relevant context', startedAt: Date.now()});
        break;
      case 'prompt':
        append({id: nextId(), kind: 'prompt', intent: event.intent, sections: event.sections, tokens: event.estimatedTokens});
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
      case 'skill':
        append({id: nextId(), kind: 'skill', name: event.name, description: event.description});
        break;
      case 'memory':
        append({id: nextId(), kind: 'memory', count: event.count, scope: event.scope});
        break;
      case 'agent_start':
        append({
          id: event.id,
          kind: 'agent',
          profile: event.profile,
          task: event.task,
          state: 'running',
          startedAt: Date.now(),
          ...(event.provider ? {provider: event.provider} : {}),
          ...(event.model ? {model: event.model} : {}),
          ...(event.phase ? {phase: event.phase} : {}),
        });
        break;
      case 'agent_message':
        append({id: event.id, kind: 'agent-message', from: event.from, to: event.to, text: event.content});
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
      case 'usage':
        refreshSession();
        break;
      case 'error':
        lastEventError.current = event.error.message;
        setTimeline(endStreamingAssistants);
        append({id: nextId(), kind: 'notice', tone: 'error', text: event.error.message});
        setActivity(undefined);
        break;
      case 'done':
        setTimeline(endStreamingAssistants);
        setActivity(undefined);
        refreshSession();
        if (event.reason !== 'completed') {
          append({
            id: nextId(),
            kind: 'notice',
            tone: event.reason === 'aborted' ? 'info' : 'error',
            text: event.reason === 'aborted'
              ? 'Run interrupted.'
              : event.reason === 'max_turns'
                ? 'Stopped at the configured turn limit.'
                : event.reason === 'token_budget'
                  ? 'Stopped at the configured token budget.'
                  : event.reason,
          });
        }
        break;
      default:
        break;
    }
  }, [append, refreshSession, runner.workspace.roots]);

  const appendList = useCallback((title: string, entries: ListEntry[]) => {
    append({id: nextId(), kind: 'list', title, entries});
  }, [append]);

  const runLocalCommand = useCallback(async (value: string): Promise<LocalCommandResult> => {
    if (!value.startsWith('/')) return false;
    const [rawCommand = '', ...rest] = value.slice(1).trim().split(/\s+/);
    const command = rawCommand.toLocaleLowerCase();
    const argument = rest.join(' ').trim();
    if (!command) return true;

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
      return true;
    }
    if (command === 'hotkeys') {
      appendList('Keyboard', [
        {label: 'Enter', detail: busy ? 'steer the next model turn' : 'send request'},
        {label: 'Alt+Enter', detail: 'queue a follow-up while a run is active'},
        {label: 'Ctrl+J', detail: 'insert a newline'},
        {label: 'Ctrl+R', detail: 'search prompt history'},
        {label: 'Ctrl+O', detail: 'toggle the latest tool result'},
        {label: 'Ctrl+L', detail: 'clear the visible transcript'},
        {label: 'Esc', detail: busy ? 'interrupt the active run' : 'clear the composer'},
        {label: 'Ctrl+C', detail: 'interrupt, clear, then exit'},
      ]);
      return true;
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
      const tool = runner.tools.get('git');
      if (!tool) throw new Error('The built-in Git tool is unavailable.');
      const id = nextId();
      const call: ToolCall = {id, name: 'git', arguments: {args: ['diff', '--']}};
      const decision = evaluatePermission(config.permissions, call, 'git', {forceAsk: interactionMode !== 'build'});
      if (decision.outcome === 'deny') throw new Error(`Git diff denied: ${decision.reason}`);
      if (decision.outcome === 'ask' && !(await requestPermission(call, 'git'))) {
        append({id: nextId(), kind: 'notice', tone: 'info', text: 'Git diff was not approved.'});
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
      if (argument.toLocaleLowerCase() === 'compact') {
        const result = await runner.compactContext();
        refreshSession();
        append({id: nextId(), kind: 'compaction', messages: result.omittedMessages, tokens: result.summaryTokens});
        setShowContextInspector(true);
      } else {
        setShowContextInspector((visible) => !visible);
      }
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
      appendList('Skills', skills.map((skill) => ({
        label: `${skill.name}  ${skill.scope}${skill.trusted ? '' : `${separator}untrusted`}`,
        detail: skill.description,
        tone: skill.trusted ? 'normal' : 'warning',
      })));
      return true;
    }
    if (command === 'mcp') {
      const servers = extensions?.mcpStatus() ?? [];
      appendList('MCP', servers.length
        ? servers.map((server) => ({
          label: `${server.name}  ${server.state}`,
          detail: `${server.transport}${separator}${server.toolCount} tools${server.error ? `${separator}${server.error}` : ''}`,
          tone: server.state === 'connected' ? 'success' : server.state === 'error' ? 'error' : 'warning',
        }))
        : [{label: 'No MCP servers configured.'}]);
      return true;
    }
    if (command === 'tools') {
      const definitions = runner.tools.definitions();
      appendList('Tools', definitions.map((tool) => ({
        label: `${tool.name}  ${tool.category}`,
        detail: tool.description,
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
      appendList('Experts', profiles.map((profile) => ({
        label: `${profile.name}  ${profile.readOnly ? 'read-only' : 'writer'}`,
        detail: `${profile.description}${separator}${profile.source}${separator}${config.agents?.routes?.[profile.name]
          ? `${config.agents.routes[profile.name]?.runtime ?? 'api'}:${config.agents.routes[profile.name]?.provider}/${config.agents.routes[profile.name]?.model}`
          : `inherits ${config.model.provider}/${config.model.model}`}`,
      })));
      return true;
    }
    if (command === 'team') {
      if (!argument) {
        appendList('Team routing', (extensions?.listAgents() ?? []).map((profile) => {
          const route = config.agents?.routes?.[profile.name];
          return {
            label: `${profile.name}  ${route ? `${route.runtime ?? 'api'}:${route.provider}/${route.model}` : 'inherited model'}`,
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
        appendList('Workflows', workflows.map((workflow) => ({label: workflow.name, detail: workflow.description})));
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
    if (command === 'about') {
      appendList('Skein', [
        {label: `${config.model.provider}/${config.model.model}`, detail: 'model'},
        {label: config.context.engine, detail: 'context engine'},
        {label: theme.name, detail: 'terminal theme'},
        {label: config.memory?.enabled ? 'enabled' : 'disabled', detail: 'durable memory'},
        {label: config.agents?.enabled ? `${config.agents.maxConcurrent} concurrent` : 'disabled', detail: 'expert delegation'},
      ]);
      return true;
    }
    append({id: nextId(), kind: 'notice', tone: 'error', text: `Unknown command: /${command}`});
    return true;

    function runMemoryCommand(argumentText: string): LocalCommandResult {
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
      if (normalized === 'list') {
        const records = extensions.searchMemory('', runner.getSession(), 12);
        appendList('Durable memory', records.map((record) => ({
          label: `${record.id.slice(0, 8)}  ${record.scope}/${record.kind}`,
          detail: `${record.content.replace(/\s+/g, ' ').slice(0, 180)}${record.content.length > 180 ? ellipsis : ''}${separator}confidence ${Math.round(record.confidence * 100)}%`,
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
  }, [append, appendList, compact, config, ellipsis, exit, extensions, interactionMode, refreshSession, requestPermission, runner, separator, showToolOutput, tasks, theme, workflows]);

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
      setQueue([]);
      controller.current?.abort();
      exit();
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
            askMode: interactionMode !== 'build',
            signal: abortController.signal,
            ...((current.turnInstructions || interactionMode === 'plan') ? {
              turnInstructions: [
                ...(interactionMode === 'plan' ? [PLAN_MODE_INSTRUCTIONS] : []),
                ...(current.turnInstructions ? [current.turnInstructions] : []),
              ].join('\n\n'),
            } : {}),
            onEvent,
            requestPermission,
          });
          const snapshot = snapshotSession(nextSession);
          setSession(snapshot);
          setTasks(snapshot.tasks.map((task) => ({...task})));
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
          const discarded = queued.current.length;
          queued.current = [];
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
  }, [append, exit, interactionMode, onEvent, requestPermission, runLocalCommand, runner]);

  const submitFromComposer = useCallback((raw: string, mode: 'steer' | 'follow-up' | 'normal' = 'normal') => {
    if (historySearch) {
      setInput(resolveHistorySearch(historySearch, 'select'));
      setHistorySearch(undefined);
      setHistoryIndex(-1);
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
    const suggestion = selectedSuggestion;
    const normalized = raw.trimEnd();
    if (suggestion && raw.startsWith('/') && suggestion.value !== raw && suggestion.value.endsWith(' ') && suggestion.label !== normalized) {
      setInput(suggestion.value);
      return;
    }
    const value = suggestion && raw.startsWith('/') && suggestion.value !== raw ? suggestion.value : raw;
    void submit(value, mode === 'normal' && processing.current ? 'steer' : mode);
  }, [composerCursor, historySearch, selectedSuggestion, submit, suggestionMode]);

  function settlePermission(grant: PermissionGrant, stop = false): void {
    if (!permission) return;
    const {call, category, resolve} = permission;
    resolve(grant);
    setPermission(undefined);
    append({
      id: nextId(),
      kind: 'notice',
      tone: grant ? 'success' : 'info',
      text: grant === 'session'
        ? `Allowed ${call.name} for this exact ${category} target during the session.`
        : grant
          ? `Allowed ${call.name} once.`
          : `Denied ${call.name}.`,
    });
    if (stop) {
      stopRequested.current = true;
      controller.current?.abort();
    }
  }

  useInput((inputKey, key) => {
    if (permission) {
      if (key.ctrl && inputKey.toLocaleLowerCase() === 'c') {
        settlePermission(false, true);
      } else if (inputKey.toLocaleLowerCase() === 'y') {
        settlePermission(true);
      } else if (inputKey.toLocaleLowerCase() === 'a') {
        settlePermission('session');
      } else if (inputKey.toLocaleLowerCase() === 'n') {
        settlePermission(false);
      } else if (key.escape) {
        settlePermission(false, true);
      }
      return;
    }
    if (key.ctrl && inputKey.toLocaleLowerCase() === 'r') {
      if (!history.length) return;
      if (historySearch) {
        setHistorySearch((current) => current
          ? moveHistorySearchSelection(current, 'older')
          : current);
      } else {
        setHistorySearch(createHistorySearchState(history, input, input));
        setHistoryIndex(-1);
      }
      return;
    }
    if (key.escape) {
      if (historySearch) {
        setInput(resolveHistorySearch(historySearch, 'cancel'));
        setHistorySearch(undefined);
      } else if (busy) {
        stopRequested.current = true;
        controller.current?.abort();
      } else if (suggestionMode !== 'none') {
        setSuggestionsDismissedFor(input);
      } else if (input) {
        setInput('');
      }
      return;
    }
    if (key.ctrl && inputKey.toLocaleLowerCase() === 'c') {
      if (historySearch) {
        setInput(resolveHistorySearch(historySearch, 'cancel'));
        setHistorySearch(undefined);
      } else if (busy) {
        stopRequested.current = true;
        controller.current?.abort();
      } else if (input) {
        setInput('');
      } else {
        exit();
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
  const compactUi = compact || terminalHeight < 28;
  const constrainedHeight = terminalHeight < 18;
  const compactComposer = terminalHeight < 18;
  const minimalInspector = terminalHeight < 22;
  const showHeader = terminalHeight >= 14;
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
  const composerPreview = input || (busy ? `follow-up${ellipsis}` : interactionMode === 'ask' ? `trace or explain${ellipsis}` : interactionMode === 'plan' ? `outline the implementation${ellipsis}` : `inspect, change, or verify${ellipsis}`);
  const composerRows = permission
    ? permissionRows(contentWidth, Boolean(typeof permission.call.arguments.cwd === 'string' || runner.workspace.primaryRoot), constrainedHeight)
    : 3 + visibleAttachments.length + composerValueRows(composerPreview, Math.max(1, contentWidth - 2), compactComposer ? 1 : 4);
  const inspectorRows = renderContextInspector ? contextInspectorRows(session, compactUi, contentWidth, minimalInspector) : 0;
  const footerRows = showFooter ? (contentWidth < 48 ? 2 : 1) : 0;
  const activityRows = showActivity && activity ? (contentWidth < 48 && activity.turn ? 3 : 2) : 0;
  const headerRows = showHeader ? 2 : 0;
  const chromeRows = headerRows + composerRows + footerRows + taskRows + paletteRows + inspectorRows + activityRows;
  const timelineRows = Math.max(0, terminalHeight - chromeRows);
  const teamItems = timeline.filter((item) => item.kind === 'agent' || item.kind === 'agent-message');
  const showTeamCockpit = config.agents?.cockpit !== false && contentWidth >= 100 &&
    timelineRows >= 7 && teamItems.some((item) => item.kind === 'agent');
  const cockpitWidth = showTeamCockpit ? Math.min(38, Math.max(30, Math.floor(contentWidth * 0.32))) : 0;
  const timelineWidth = Math.max(1, contentWidth - cockpitWidth - (showTeamCockpit ? 1 : 0));
  const visibleTimeline = fitTimelineToRows(timeline, {
    width: timelineWidth,
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
      <Box flexDirection="column" paddingX={horizontalPadding} height={terminalHeight} overflowY="hidden">
        {showHeader ? <Header config={config} askMode={interactionMode !== 'build'} planMode={interactionMode === 'plan'} width={contentWidth} glyphMode={glyphMode} /> : null}
        {timelineRows > 0 ? (
          <Box flexDirection="row" height={timelineRows} overflowY="hidden">
            <Box flexDirection="column" width={timelineWidth} overflowY="hidden">
              <Timeline
                items={visibleTimeline}
                width={timelineWidth}
                glyphMode={glyphMode}
                showToolOutput={showToolOutput}
                {...(expandedToolId ? {expandedToolId} : {})}
                compact={compactUi}
              />
            </Box>
            {showTeamCockpit ? (
              <Box marginLeft={1}>
                <TeamCockpit items={teamItems} width={cockpitWidth} glyphMode={glyphMode} />
              </Box>
            ) : null}
          </Box>
        ) : null}
        {showTaskRail ? <TaskRail tasks={tasks} width={contentWidth} glyphMode={glyphMode} maxItems={taskLimit} /> : null}
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
            busy={busy}
            value={input}
            width={contentWidth}
            placeholder={busy ? `Steer ${PRODUCT_NAME}${separator}alt+enter queues` : `Type a request${separator}@file${separator}/command`}
            queueCount={queue.length}
            attachments={visibleAttachments}
            glyphMode={glyphMode}
          >
            <ComposerInput
              value={input}
              onChange={setInput}
              onSubmit={submitFromComposer}
              onCursorChange={setComposerCursor}
              width={Math.max(1, contentWidth - 2)}
              maxVisibleRows={compactComposer ? 1 : 4}
              {...(cursorRequest?.value === input ? {externalCursorOffset: cursorRequest.offset} : {})}
              focus
              captureVerticalArrows={suggestionMode === 'mention' || suggestionMode === 'command' || Boolean(historySearch)}
              placeholder={busy ? `follow-up${ellipsis}` : interactionMode === 'ask' ? `trace or explain${ellipsis}` : interactionMode === 'plan' ? `outline the implementation${ellipsis}` : `inspect, change, or verify${ellipsis}`}
            />
          </PromptBar>
        </> : <PermissionCard call={permission.call} category={permission.category} workspace={runner.workspace.primaryRoot} width={contentWidth} glyphMode={glyphMode} compact={constrainedHeight} />}
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
            activeAgents={activeAgents}
            frame={frame}
            glyphMode={glyphMode}
          />
        ) : null}
      </Box>
    </ThemeProvider>
  );
}

export async function runInteractiveTui(options: TuiOptions): Promise<void> {
  await reloadUserThemes();
  const instance = render(<SkeinApp {...options} />, {
    exitOnCtrlC: false,
    patchConsole: true,
    incrementalRendering: true,
    maxFps: 30,
    kittyKeyboard: {
      mode: 'auto',
      flags: ['disambiguateEscapeCodes'],
    },
  });
  await instance.waitUntilExit();
}

function initialTimeline(session: Session, setupProblem?: string): TimelineItem[] {
  const items: TimelineItem[] = session.messages
    .filter((message) => (message.role === 'user' || message.role === 'assistant') && visibleMessage(message))
    .slice(-20)
    .map((message) => ({id: message.id, kind: message.role as 'user' | 'assistant', text: message.content}));
  if (setupProblem && !items.length) items.push({id: nextId(), kind: 'notice', tone: 'error', text: setupProblem});
  return items;
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
    !message.content.startsWith('<workflow ') &&
    !message.content.startsWith('<retrieved-memory');
}

function updateTool(items: TimelineItem[], result: {toolCallId: string; name: string; ok: boolean; content: string}): TimelineItem[] {
  const output = sanitizeTerminalText(result.content).slice(0, 100_000);
  const found = items.some((item) => item.kind === 'tool' && item.id === result.toolCallId);
  if (!found) {
    return [...items, {
      id: result.toolCallId,
      kind: 'tool' as const,
      name: result.name,
      detail: result.ok ? '' : firstLine(result.content),
      state: result.ok ? 'ok' as const : 'error' as const,
      output,
      ...(result.ok ? {} : {errorDetail: firstLine(result.content)}),
    }].slice(-100);
  }
  return items.map((item) => {
    if (item.kind !== 'tool' || item.id !== result.toolCallId) return item;
    return {
      ...item,
      state: result.ok ? 'ok' as const : 'error' as const,
      output,
      ...(item.startedAt ? {durationMs: Date.now() - item.startedAt} : {}),
      ...(result.ok ? {} : {errorDetail: firstLine(result.content)}),
    };
  });
}

function updateAssistantDelta(items: TimelineItem[], id: string, content: string): TimelineItem[] {
  const found = items.some((item) => item.kind === 'assistant' && item.id === id);
  if (!found) {
    return [...items, {id, kind: 'assistant' as const, text: content, streaming: true}].slice(-500);
  }
  return items.map((item) => item.kind === 'assistant' && item.id === id
    ? {...item, text: `${item.text}${content}`, streaming: true}
    : item);
}

function finalizeAssistant(items: TimelineItem[], id: string | undefined, content: string): TimelineItem[] {
  if (!id) return [...items, {id: nextId(), kind: 'assistant' as const, text: content}].slice(-500);
  const found = items.some((item) => item.kind === 'assistant' && item.id === id);
  if (!found) return [...items, {id, kind: 'assistant' as const, text: content}].slice(-500);
  return items.map((item) => item.kind === 'assistant' && item.id === id
    ? {...item, text: content, streaming: false}
    : item);
}

function endStreamingAssistants(items: TimelineItem[]): TimelineItem[] {
  return items.map((item) => item.kind === 'assistant' && item.streaming
    ? {...item, streaming: false}
    : item);
}

function updateAgent(items: TimelineItem[], event: Extract<AgentEvent, {type: 'agent_done'}>): TimelineItem[] {
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
    }].slice(-100);
  }
  return items.map((item) => item.kind === 'agent' && item.id === event.id
    ? {...item, state: event.ok ? 'ok' as const : 'error' as const, summary: event.summary, ...(item.startedAt ? {durationMs: Date.now() - item.startedAt} : {})}
    : item);
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
    'workflow',
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
  const content = 3 + (hasCwd ? 1 : 0);
  if (width >= 64) return content + 2;
  if (width >= 28) return content + 3;
  if (compact) return content + 3;
  return content + 5;
}

function contextInspectorRows(session: Session, compact: boolean, width: number, minimal: boolean): number {
  if (minimal) return 2;
  const working = session.workingMemory;
  const entries = 5 + (compact ? 0 : (working?.constraints.length ? 1 : 0) +
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
  };
}

function firstLine(value: string): string {
  return sanitizeTerminalText(value).split('\n').find((line) => line.trim())?.trim().slice(0, 180) ?? 'No details';
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
  const ascii = process.env.SKEIN_GLYPHS === 'ascii' || process.env.MOSAIC_GLYPHS === 'ascii';
  return ascii ? ['.', 'o', 'O', 'o'] : ['◌', '◍', '◎', '◉', '◎', '◍'];
}

function reducedMotion(): boolean {
  return process.env.SKEIN_REDUCE_MOTION === '1' ||
    process.env.SKEIN_REDUCE_MOTION === 'true' ||
    process.env.INK_SCREEN_READER === 'true' ||
    process.env.TERM === 'dumb';
}
