import React, {useEffect, useRef, useState} from 'react';
import {Box, render, Text, useApp, useInput, useWindowSize} from 'ink';
import type {ContextEngine} from '../context/context-engine.js';
import type {IndexPreparationResult, IndexProgress} from '../context/local-index.js';
import {PRODUCT_MARK, PRODUCT_NAME} from '../brand.js';
import type {MosaicConfig} from '../types.js';
import {compactDisplayPath, displayWidth, sanitizeTerminalText, truncateDisplay} from './text.js';
import {resolveKittyKeyboardConfig} from './terminal-capabilities.js';
import {resolveThemeWithColor, ThemeProvider, useTheme} from './theme.js';

export interface WorkspaceReadiness extends IndexPreparationResult {
  engine: 'local';
  preparedAt: string;
}

export type WorkspacePreparationResult =
  | {status: 'ready'; readiness: WorkspaceReadiness}
  | {status: 'cancelled'};

interface PreparationEngine {
  prepare(onProgress?: (progress: IndexProgress) => void, forceBuild?: boolean): Promise<IndexPreparationResult>;
}

export async function prepareWorkspace(
  engine: PreparationEngine,
  onProgress?: (progress: IndexProgress) => void,
  forceBuild = false,
): Promise<WorkspaceReadiness> {
  const result = await engine.prepare(onProgress, forceBuild);
  if (!result.validated) throw new Error('The local context index was not validated.');
  return {...result, engine: 'local', preparedAt: new Date().toISOString()};
}

export function WorkspacePreparationView({
  progress,
  readiness,
  error,
  workspace,
  model,
  width,
  height = 24,
  frame = 0,
}: {
  progress: IndexProgress;
  readiness?: WorkspaceReadiness;
  error?: string;
  workspace: string;
  model: string;
  width: number;
  height?: number;
  frame?: number;
}) {
  const theme = useTheme();
  const safeWidth = Math.max(1, Math.floor(width));
  const innerWidth = Math.max(1, safeWidth - (safeWidth >= 24 ? 4 : 0));
  const compact = safeWidth < 48;
  const constrained = height < 14;
  const ascii = process.env.SKEIN_GLYPHS === 'ascii' || process.env.MOSAIC_GLYPHS === 'ascii';
  const spinner = (ascii ? ['.', 'o', 'O', 'o'] : ['◜', '◠', '◝', '◞', '◡', '◟'])[frame % (ascii ? 4 : 6)] as string;
  const separator = ascii ? '|' : '·';
  const brand = ascii ? '*' : PRODUCT_MARK;
  const phase = readiness ? 'ready' : error ? 'error' : progress.phase;
  const phaseLabel = preparationLabel(phase, progress, readiness, compact);
  const detail = preparationDetail(phase, progress, readiness, error);
  const modelLine = `model ${sanitizeTerminalText(model)}`;
  const workspaceLine = `workspace ${compactDisplayPath(sanitizeTerminalText(workspace), Math.max(1, innerWidth - 10))}`;
  const steps = preparationSteps(phase, progress, readiness, error, {ascii, spinner});

  return (
    <Box flexDirection="column" paddingX={safeWidth >= 24 ? 2 : 0}>
      <Box>
        <Text bold color={theme.accent}>{brand}  {PRODUCT_NAME.toUpperCase()}</Text>
        {!compact && !constrained ? <Text color={theme.dim}>  {separator}  LOCAL CONTEXT</Text> : null}
      </Box>
      {!constrained ? <Text color={theme.muted}>{truncateDisplay('Ground the workspace before the first request.', innerWidth)}</Text> : null}
      {!constrained && !compact ? <Text color={theme.dim}>{truncateDisplay(`${modelLine}  ${separator}  ${workspaceLine}`, innerWidth)}</Text> : !constrained ? (
        <>
          <Text color={theme.dim}>{truncateDisplay(modelLine, innerWidth)}</Text>
          <Text color={theme.dim}>{truncateDisplay(workspaceLine, innerWidth)}</Text>
        </>
      ) : <Text color={theme.dim}>{truncateDisplay(workspaceLine, innerWidth)}</Text>}
      <Box marginTop={1} flexDirection={constrained ? 'row' : 'column'}>
        {steps.map((step) => constrained ? (
          <Text key={step.id} color={step.state === 'active' ? theme.accent : step.state === 'complete' ? theme.success : step.state === 'error' ? theme.error : theme.dim}>
            {step.glyph} {step.id === 'persist' ? 'save' : step.id}{step.id === 'verify' ? '' : ' '}
          </Text>
        ) : (
          <Box key={step.id} height={1} overflowY="hidden">
            <Text bold color={step.state === 'active' ? theme.accent : step.state === 'complete' ? theme.success : step.state === 'error' ? theme.error : theme.border}>
              {step.glyph}{' '}
            </Text>
            <Text bold={step.state === 'active'} color={step.state === 'pending' ? theme.dim : theme.textStrong}>
              {truncateDisplay(step.label, compact ? 8 : 10)}
            </Text>
            <Text color={step.state === 'active' ? theme.muted : theme.dim}>
              {'  '}{truncateDisplay(step.detail, Math.max(1, innerWidth - displayWidth(step.glyph) - (compact ? 12 : 14)))}
            </Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text bold color={error ? theme.error : readiness ? theme.success : theme.accent}>
          {readiness ? (ascii ? '[ok]' : '✓') : error ? (ascii ? '[x]' : '×') : spinner}{' '}
        </Text>
        <Text bold color={theme.textStrong}>{truncateDisplay(phaseLabel, Math.max(1, innerWidth - 5))}</Text>
      </Box>
      <Text color={error ? theme.error : theme.muted} wrap="truncate">{truncateDisplay(detail, innerWidth)}</Text>
      {error ? <Text color={theme.dim}>{truncateDisplay(`Enter retry  ${separator}  Esc exit`, innerWidth)}</Text> : !constrained ? (
        <Text color={theme.dim}>{truncateDisplay(`local only  ${separator}  no source code uploaded`, innerWidth)}</Text>
      ) : null}
    </Box>
  );
}

type PreparationStepState = 'complete' | 'active' | 'pending' | 'error';

interface PreparationStep {
  id: 'inspect' | 'build' | 'persist' | 'verify';
  label: string;
  detail: string;
  state: PreparationStepState;
  glyph: string;
}

function preparationSteps(
  phase: IndexProgress['phase'] | 'ready' | 'error',
  progress: IndexProgress,
  readiness: WorkspaceReadiness | undefined,
  error: string | undefined,
  glyphs: {ascii: boolean; spinner: string},
): PreparationStep[] {
  const runtimePhase = phase === 'error' ? progress.phase : phase;
  const current = runtimePhase === 'scan' || runtimePhase === 'index'
    ? 'build'
    : runtimePhase === 'write'
      ? 'persist'
      : runtimePhase === 'validate'
        ? 'verify'
        : 'inspect';
  const order: PreparationStep['id'][] = ['inspect', 'build', 'persist', 'verify'];
  const currentIndex = phase === 'ready' ? order.length : order.indexOf(current);
  const activeDetail = runtimePhase === 'inspect'
    ? 'manifest and workspace boundaries'
    : runtimePhase === 'scan'
      ? `${progress.total} source files discovered`
      : runtimePhase === 'index'
        ? `${progress.completed}/${progress.total} source files`
        : runtimePhase === 'write'
          ? 'atomic local index write'
          : runtimePhase === 'validate'
            ? progress.total ? `${progress.completed}/${progress.total} content hashes` : 'generation and content hashes'
            : '';
  const readyDetails: Record<PreparationStep['id'], string> = {
    inspect: 'workspace boundaries checked',
    build: readiness?.rebuilt ? `${readiness.files} files · ${readiness.chunks} chunks` : 'existing index is current',
    persist: readiness?.rebuilt ? 'local artifact committed' : 'local artifact loaded',
    verify: 'content and generation matched',
  };
  const pendingDetails: Record<PreparationStep['id'], string> = {
    inspect: 'manifest and workspace boundaries',
    build: 'source files and code chunks',
    persist: 'atomic local index write',
    verify: 'generation and content hashes',
  };

  return order.map((id, index) => {
    const state: PreparationStepState = error && index === currentIndex
      ? 'error'
      : index < currentIndex || phase === 'ready'
        ? 'complete'
        : index === currentIndex
          ? 'active'
          : 'pending';
    const glyph = state === 'complete'
      ? (glyphs.ascii ? '[x]' : '●')
      : state === 'error'
        ? (glyphs.ascii ? '[!]' : '×')
        : state === 'active'
          ? glyphs.spinner
          : (glyphs.ascii ? '[ ]' : '○');
    return {
      id,
      label: id === 'persist' ? 'Persist' : `${id[0]?.toUpperCase()}${id.slice(1)}`,
      detail: phase === 'ready' ? readyDetails[id] : state === 'active' || state === 'error' ? activeDetail : pendingDetails[id],
      state,
      glyph,
    };
  });
}

function WorkspacePreparationApp({
  engine,
  config,
  workspace,
  forceBuild,
  readyDelayMs,
  onFinish,
}: {
  engine: PreparationEngine;
  config: MosaicConfig;
  workspace: string;
  forceBuild: boolean;
  readyDelayMs: number;
  onFinish: (result: WorkspacePreparationResult) => void;
}) {
  const {exit} = useApp();
  const {columns, rows} = useWindowSize();
  const [attempt, setAttempt] = useState(0);
  const [frame, setFrame] = useState(0);
  const [progress, setProgress] = useState<IndexProgress>({phase: 'inspect', completed: 0, total: 0});
  const [readiness, setReadiness] = useState<WorkspaceReadiness>();
  const [error, setError] = useState<string>();
  const finished = useRef(false);

  const finish = (result: WorkspacePreparationResult) => {
    if (finished.current) return;
    finished.current = true;
    onFinish(result);
    exit();
  };

  useEffect(() => {
    if (readiness || error) return;
    const timer = setInterval(() => setFrame((value) => value + 1), 90);
    return () => clearInterval(timer);
  }, [error, readiness]);

  useEffect(() => {
    let active = true;
    setError(undefined);
    setReadiness(undefined);
    setProgress({phase: 'inspect', completed: 0, total: 0});
    void prepareWorkspace(engine, (next) => {
      if (active) setProgress(next);
    }, forceBuild && attempt === 0).then((next) => {
      if (!active) return;
      setReadiness(next);
      setProgress({phase: 'done', completed: next.files, total: next.files});
      setTimeout(() => {
        if (active) finish({status: 'ready', readiness: next});
      }, readyDelayMs);
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { active = false; };
  }, [attempt, engine, forceBuild, readyDelayMs]);

  useInput((_input, key) => {
    if (error && key.return) setAttempt((value) => value + 1);
    else if (key.escape || (key.ctrl && _input === 'c')) finish({status: 'cancelled'});
  });

  return (
    <WorkspacePreparationView
      progress={progress}
      {...(readiness ? {readiness} : {})}
      {...(error ? {error} : {})}
      workspace={workspace}
      model={`${config.model.provider}/${config.model.model}`}
      width={Math.max(1, columns || 80)}
      height={Math.max(1, rows || 24)}
      frame={frame}
    />
  );
}

export async function runWorkspacePreparation(
  engine: ContextEngine,
  config: MosaicConfig,
  options: {
    workspace?: string;
    forceBuild?: boolean;
    readyDelayMs?: number;
    stdin?: NodeJS.ReadStream;
    stdout?: NodeJS.WriteStream;
    stderr?: NodeJS.WriteStream;
  } = {},
): Promise<WorkspacePreparationResult> {
  let result: WorkspacePreparationResult | undefined;
  const colorEnabled = config.ui.color && !process.env.NO_COLOR;
  const theme = resolveThemeWithColor(config.ui.theme, colorEnabled);
  const instance = render(
    <ThemeProvider theme={theme}>
      <WorkspacePreparationApp
        engine={engine}
        config={config}
        workspace={options.workspace ?? config.workspaceRoots[0] ?? process.cwd()}
        forceBuild={options.forceBuild ?? false}
        readyDelayMs={options.readyDelayMs ?? 320}
        onFinish={(next) => { result = next; }}
      />
    </ThemeProvider>,
    {
      ...(options.stdin ? {stdin: options.stdin} : {}),
      ...(options.stdout ? {stdout: options.stdout} : {}),
      ...(options.stderr ? {stderr: options.stderr} : {}),
      exitOnCtrlC: false,
      patchConsole: false,
      incrementalRendering: true,
      kittyKeyboard: resolveKittyKeyboardConfig(),
    },
  );
  await instance.waitUntilExit();
  return result ?? {status: 'cancelled'};
}

function preparationLabel(
  phase: IndexProgress['phase'] | 'ready' | 'error',
  progress: IndexProgress,
  readiness?: WorkspaceReadiness,
  compact = false,
): string {
  if (phase === 'ready') {
    if (compact) return 'Index verified';
    return readiness?.rebuilt ? 'Workspace index created and verified' : 'Workspace index verified';
  }
  if (phase === 'error') return 'Workspace preparation failed';
  if (phase === 'inspect') return 'Inspecting the local index';
  if (phase === 'scan') return 'Scanning workspace files';
  if (phase === 'index') return `Indexing ${progress.completed}/${progress.total} files`;
  if (phase === 'write') return 'Writing the local index';
  if (phase === 'validate') return 'Validating the persisted index';
  return 'Finalizing workspace context';
}

function preparationDetail(
  phase: IndexProgress['phase'] | 'ready' | 'error',
  progress: IndexProgress,
  readiness?: WorkspaceReadiness,
  error?: string,
): string {
  if (error) return sanitizeTerminalText(error);
  if (readiness) {
    const source = readiness.rebuilt ? `${readiness.reused} files reused` : 'existing index reused';
    const separator = process.env.SKEIN_GLYPHS === 'ascii' || process.env.MOSAIC_GLYPHS === 'ascii' ? '|' : '·';
    return `${readiness.files} files  ${separator}  ${readiness.chunks} chunks  ${separator}  ${source}`;
  }
  if (progress.path) return compactDisplayPath(sanitizeTerminalText(progress.path), 72);
  if (phase === 'inspect') return 'Checking freshness and workspace boundaries';
  if (phase === 'validate') return 'Reloading the persisted artifact and matching its generation';
  return 'Local-only context; no external service or model download';
}
