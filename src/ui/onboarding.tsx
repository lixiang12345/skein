import React, {useCallback, useEffect, useMemo, useReducer, useRef} from 'react';
import {Box, render, Text, useApp, useInput, useWindowSize} from 'ink';
import TextInput from 'ink-text-input';
import {redactEndpoint, saveUserConfig} from '../config.js';
import {createAgentConnectionSetup, mergeAgentSetup} from '../agent/model-setup.js';
import {PRODUCT_MARK, PRODUCT_NAME} from '../brand.js';
import type {
  AgentTeamConfig,
  ConnectionApiKeyHeader,
  ConnectionAuth,
  ConnectionModelAuth,
  ConnectionProtocol,
  MosaicConfig,
} from '../types.js';
import {displayWidth, padDisplay, sanitizeTerminalText, truncateDisplay} from './text.js';
import {resolveKittyKeyboardConfig, resolveTerminalAccessibility} from './terminal-capabilities.js';
import {resolveThemeWithColor, ThemeProvider, useTheme} from './theme.js';

export type RelayProtocol = Exclude<ConnectionProtocol, 'gemini'>;
export type OnboardingStep =
  | 'relay-protocol'
  | 'endpoint'
  | 'models-endpoint'
  | 'model'
  | 'auth'
  | 'auth-header'
  | 'models-auth'
  | 'api-key-env'
  | 'confirm'
  | 'saving';

export interface OnboardingDraft {
  relayProtocol: RelayProtocol | undefined;
  baseUrl: string;
  modelsBaseUrl: string;
  model: string;
  auth: ConnectionAuth['type'] | undefined;
  authHeader: ConnectionApiKeyHeader;
  modelsAuthHeader: ConnectionModelAuth;
  apiKeyEnv: string;
}

export interface OnboardingState {
  step: OnboardingStep;
  history: OnboardingStep[];
  selected: number;
  draft: OnboardingDraft;
  error: string | undefined;
}

export interface OnboardingConfigPatch {
  agents: Partial<AgentTeamConfig>;
}

export type OnboardingResult =
  | {status: 'saved'; path: string}
  | {status: 'cancelled'};

type EditableField = 'baseUrl' | 'modelsBaseUrl' | 'model' | 'apiKeyEnv';
export type OnboardingAction =
  | {type: 'MOVE'; delta: -1 | 1; count: number}
  | {type: 'SELECT'}
  | {type: 'INPUT'; field: EditableField; value: string}
  | {type: 'SUBMIT_INPUT'; field: EditableField; value: string}
  | {type: 'BACK'}
  | {type: 'SAVE_START'}
  | {type: 'SAVE_ERROR'};

const relayProtocols: Array<{value: RelayProtocol; label: string; detail: string}> = [
  {value: 'openai-responses', label: 'OpenAI Responses', detail: 'Recommended · /responses · stateless history replay'},
  {value: 'openai-chat', label: 'OpenAI Chat Completions', detail: 'Compatibility · /chat/completions'},
  {value: 'anthropic-messages', label: 'Anthropic Messages', detail: 'Compatibility · Anthropic SDK-style base URL'},
];

const authMethods: Array<{value: ConnectionAuth['type']; label: string; detail: string}> = [
  {value: 'env', label: 'Environment variable', detail: 'Recommended · only the variable name is saved'},
  {value: 'none', label: 'No authentication', detail: 'For trusted keyless relays or local servers'},
];

const authHeaders: Array<{value: ConnectionApiKeyHeader; label: string; detail: string}> = [
  {value: 'bearer', label: 'Authorization: Bearer', detail: 'OpenAI SDK style · OpenRouter and most unified relays'},
  {value: 'x-api-key', label: 'x-api-key', detail: 'Anthropic SDK style · Vercel and native Messages relays'},
];

const modelAuthMethods: Array<{value: ConnectionModelAuth; label: string; detail: string}> = [
  {value: 'bearer', label: 'Authorization: Bearer', detail: 'Reuse the relay key with OpenAI-style model catalogs'},
  {value: 'x-api-key', label: 'x-api-key', detail: 'Use the relay key with Anthropic-style model catalogs'},
  {value: 'none', label: 'No model authentication', detail: 'Public catalog · never send the inference key to this endpoint'},
];

const DEFAULT_CONNECTION_NAME = 'primary-relay';

const forbiddenDirectionControls = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const directionControls = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const inputControl = /[\u0000-\u001f\u007f-\u009f]/u;

export function needsFirstRunOnboarding(config: MosaicConfig): boolean {
  if (config.model.provider === 'compatible') return !config.model.baseUrl;
  return !config.model.apiKey;
}

export function createOnboardingState(config: MosaicConfig): OnboardingState {
  return {
    step: 'relay-protocol',
    history: [],
    selected: 0,
    draft: {
      relayProtocol: undefined,
      baseUrl: config.model.baseUrl ?? '',
      modelsBaseUrl: '',
      model: config.model.provider === 'compatible' ? config.model.model : 'default',
      auth: undefined,
      authHeader: 'bearer',
      modelsAuthHeader: 'bearer',
      apiKeyEnv: 'SKEIN_API_KEY',
    },
    error: undefined,
  };
}

export function onboardingReducer(state: OnboardingState, action: OnboardingAction): OnboardingState {
  switch (action.type) {
    case 'MOVE':
      return {...state, selected: (state.selected + action.delta + action.count) % action.count, error: undefined};
    case 'INPUT':
      return {
        ...state,
        draft: {...state.draft, [action.field]: sanitizeFieldInput(action.field, action.value)},
        error: undefined,
      };
    case 'SELECT':
      return selectCurrentOption(state);
    case 'SUBMIT_INPUT':
      return submitInput(state, action.field, action.value);
    case 'BACK': {
      const previous = state.history.at(-1);
      if (!previous) return state;
      return {
        ...state,
        step: previous,
        history: state.history.slice(0, -1),
        selected: 0,
        error: undefined,
      };
    }
    case 'SAVE_START':
      return advance(state, 'saving');
    case 'SAVE_ERROR':
      return {...state, step: 'confirm', history: state.history.slice(0, -1), error: 'Could not save the configuration. Review the values and try again.'};
  }
}

export function validateRelayBaseUrl(value: string): {ok: true; value: string; loopback: boolean} | {ok: false; error: string} {
  const raw = value.trim();
  if (!raw) return {ok: false, error: 'Enter the relay base URL.'};
  if (raw.length > 2_048) return {ok: false, error: 'The relay URL is too long.'};
  if (forbiddenDirectionControls.test(raw) || inputControl.test(raw)) {
    return {ok: false, error: 'The relay URL contains unsupported control characters.'};
  }
  if (raw.includes('?') || raw.includes('#')) {
    return {ok: false, error: 'Use a base URL without query parameters or fragments.'};
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {ok: false, error: 'Enter a complete http:// or https:// URL.'};
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {ok: false, error: 'The relay URL must use http or https.'};
  }
  if (url.username || url.password) {
    return {ok: false, error: 'Do not put credentials in the relay URL.'};
  }
  const loopback = isLoopbackHostname(url.hostname);
  if (url.protocol !== 'https:' && !loopback) {
    return {ok: false, error: 'Remote relays must use HTTPS; HTTP is allowed only for loopback.'};
  }
  const path = url.pathname.replace(/\/+$/u, '').toLocaleLowerCase();
  if (path.endsWith('/responses') || path.endsWith('/chat/completions') || path.endsWith('/messages')) {
    return {ok: false, error: 'Enter the API base URL, not a final inference endpoint.'};
  }
  url.pathname = url.pathname.replace(/\/+$/u, '');
  const normalized = url.toString().replace(/\/+$/u, '');
  return {ok: true, value: normalized, loopback};
}

export function buildOnboardingConfig(state: OnboardingState): OnboardingConfigPatch {
  const protocol = state.draft.relayProtocol;
  const model = validateModel(state.draft.model);
  const endpoint = validateRelayBaseUrl(state.draft.baseUrl);
  const modelsEndpoint = validateModelsBaseUrl(state.draft.modelsBaseUrl, protocol === 'anthropic-messages');
  const auth = state.draft.auth;
  const apiKeyEnv = validateEnvironmentName(state.draft.apiKeyEnv, auth === 'env');
  if (!protocol || !model.ok || !endpoint.ok || !modelsEndpoint.ok || !auth || !apiKeyEnv.ok) {
    throw new Error('Onboarding relay configuration is incomplete.');
  }
  const setup = createAgentConnectionSetup({
    name: DEFAULT_CONNECTION_NAME,
    provider: 'compatible',
    protocol,
    baseUrl: endpoint.value,
    ...(modelsEndpoint.value ? {modelsBaseUrl: modelsEndpoint.value} : {}),
    auth,
    ...(auth === 'env' ? {
      authHeader: state.draft.authHeader,
      modelsAuthHeader: state.draft.modelsAuthHeader,
    } : {}),
    ...(apiKeyEnv.value ? {apiKeyEnv: apiKeyEnv.value} : {}),
    defaultModel: model.value,
  });
  return {agents: mergeAgentSetup(undefined, setup)};
}

function selectCurrentOption(state: OnboardingState): OnboardingState {
  if (state.step === 'relay-protocol') {
    const relayProtocol = relayProtocols[state.selected]?.value;
    if (!relayProtocol) return state;
    return advance({
      ...state,
      draft: {
        ...state.draft,
        relayProtocol,
        baseUrl: '',
        modelsBaseUrl: '',
        model: 'default',
        auth: undefined,
        authHeader: 'bearer',
        modelsAuthHeader: 'bearer',
        apiKeyEnv: 'SKEIN_API_KEY',
      },
    }, 'endpoint');
  }
  if (state.step === 'auth') {
    const auth = authMethods[state.selected]?.value;
    if (!auth) return state;
    const next = {...state, draft: {...state.draft, auth, apiKeyEnv: auth === 'env' ? state.draft.apiKeyEnv : ''}};
    return advance(next, auth === 'env' ? 'auth-header' : 'confirm');
  }
  if (state.step === 'auth-header') {
    const authHeader = authHeaders[state.selected]?.value;
    if (!authHeader) return state;
    return advance({...state, draft: {...state.draft, authHeader, modelsAuthHeader: authHeader}}, 'models-auth');
  }
  if (state.step === 'models-auth') {
    const modelsAuthHeader = modelAuthMethods[state.selected]?.value;
    if (!modelsAuthHeader) return state;
    return advance({...state, draft: {...state.draft, modelsAuthHeader}}, 'api-key-env');
  }
  return state;
}

function submitInput(state: OnboardingState, field: EditableField, rawValue: string): OnboardingState {
  const value = sanitizeFieldInput(field, rawValue);
  const next = {...state, draft: {...state.draft, [field]: value}, error: undefined};
  if (field === 'baseUrl') {
    const endpoint = validateRelayBaseUrl(value);
    if (!endpoint.ok) return {...next, error: endpoint.error};
    return advance({...next, draft: {...next.draft, baseUrl: endpoint.value}}, 'models-endpoint');
  }
  if (field === 'modelsBaseUrl') {
    const endpoint = validateModelsBaseUrl(value, state.draft.relayProtocol === 'anthropic-messages');
    if (!endpoint.ok) return {...next, error: endpoint.error};
    return advance({...next, draft: {...next.draft, modelsBaseUrl: endpoint.value}}, 'model');
  }
  if (field === 'model') {
    const model = validateModel(value);
    if (!model.ok) return {...next, error: model.error};
    return advance({...next, draft: {...next.draft, model: model.value}}, 'auth');
  }
  const apiKeyEnv = validateEnvironmentName(value, true);
  if (!apiKeyEnv.ok) return {...next, error: apiKeyEnv.error};
  if (!process.env[apiKeyEnv.value]) {
    return {...next, error: `Environment variable ${apiKeyEnv.value} is not set. Export it, then restart Skein.`};
  }
  return advance({...next, draft: {...next.draft, apiKeyEnv: apiKeyEnv.value}}, 'confirm');
}

function advance(state: OnboardingState, step: OnboardingStep): OnboardingState {
  return {...state, step, history: [...state.history, state.step], selected: 0, error: undefined};
}

function sanitizeFieldInput(field: EditableField, value: string): string {
  const max = field === 'baseUrl' || field === 'modelsBaseUrl' ? 2_048 : field === 'model' ? 256 : 128;
  return sanitizeTerminalText(value)
    .replace(directionControls, '')
    .replace(/\r?\n/gu, '')
    .slice(0, max);
}

function validateModel(value: string): {ok: true; value: string} | {ok: false; error: string} {
  const model = value.trim();
  if (!model) return {ok: false, error: 'Enter the model identifier used by this provider.'};
  if (model.length > 256 || /\s/u.test(model) || forbiddenDirectionControls.test(model)) {
    return {ok: false, error: 'Use a model identifier without spaces or control characters.'};
  }
  return {ok: true, value: model};
}

function validateModelsBaseUrl(value: string, required: boolean): {ok: true; value: string} | {ok: false; error: string} {
  if (!value.trim() && !required) return {ok: true, value: ''};
  if (!value.trim()) return {ok: false, error: 'Anthropic transport requires an OpenAI-style models base URL.'};
  return validateRelayBaseUrl(value);
}

function validateEnvironmentName(value: string, required: boolean): {ok: true; value: string} | {ok: false; error: string} {
  const name = value.trim();
  if (!name && !required) return {ok: true, value: ''};
  if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(name)) {
    return {ok: false, error: 'Use an uppercase environment variable name, for example RELAY_API_KEY.'};
  }
  return {ok: true, value: name};
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/gu, '').toLocaleLowerCase();
  return normalized === 'localhost' || normalized.endsWith('.localhost') ||
    normalized === '::1' || /^127(?:\.\d{1,3}){3}$/u.test(normalized);
}

interface OnboardingAppProps {
  initialConfig: MosaicConfig;
  saveConfig: (config: OnboardingConfigPatch) => Promise<string>;
  onFinish: (result: OnboardingResult) => void;
}

export function OnboardingApp({initialConfig, saveConfig, onFinish}: OnboardingAppProps) {
  const colorEnabled = initialConfig.ui.color && resolveTerminalAccessibility().color;
  const theme = useMemo(() => resolveThemeWithColor(initialConfig.ui.theme, colorEnabled), [colorEnabled, initialConfig.ui.theme]);
  return (
    <ThemeProvider theme={theme}>
      <OnboardingFlow initialConfig={initialConfig} saveConfig={saveConfig} onFinish={onFinish} />
    </ThemeProvider>
  );
}

function OnboardingFlow({initialConfig, saveConfig, onFinish}: OnboardingAppProps) {
  const {exit} = useApp();
  const {columns, rows} = useWindowSize();
  const width = Math.max(20, Math.min(76, (columns || 80) - 2));
  const compactHeight = (rows || 24) < 24;
  const [state, dispatch] = useReducer(onboardingReducer, initialConfig, createOnboardingState);
  const finished = useRef(false);
  const saving = useRef(false);
  const finish = useCallback((result: OnboardingResult) => {
    if (finished.current) return;
    finished.current = true;
    onFinish(result);
    exit();
  }, [exit, onFinish]);

  useInput((input, key) => {
    // Once the owner-only atomic write starts it cannot be safely aborted. Do
    // not report a cancellation while that write may still commit.
    if (state.step === 'saving') return;
    if (key.ctrl && input.toLocaleLowerCase() === 'c') {
      finish({status: 'cancelled'});
      return;
    }
    if (key.escape) {
      if (state.history.length) dispatch({type: 'BACK'});
      else finish({status: 'cancelled'});
      return;
    }
    const count = menuCount(state.step);
    if (count && (key.upArrow || key.downArrow || key.tab)) {
      dispatch({type: 'MOVE', delta: key.upArrow || (key.tab && key.shift) ? -1 : 1, count});
      return;
    }
    if (!key.return) return;
    if (count) {
      dispatch({type: 'SELECT'});
      return;
    }
    if (state.step === 'confirm') dispatch({type: 'SAVE_START'});
  });

  useEffect(() => {
    if (state.step !== 'saving' || saving.current) return;
    saving.current = true;
    let config: OnboardingConfigPatch;
    try {
      config = buildOnboardingConfig(state);
    } catch {
      saving.current = false;
      dispatch({type: 'SAVE_ERROR'});
      return;
    }
    void saveConfig(config).then(
      (path) => finish({status: 'saved', path}),
      () => {
        saving.current = false;
        dispatch({type: 'SAVE_ERROR'});
      },
    );
  }, [finish, saveConfig, state]);

  return <OnboardingScreen state={state} dispatch={dispatch} width={width} compact={compactHeight} />;
}

export function OnboardingScreen({state, dispatch, width, compact = false}: {
  state: OnboardingState;
  dispatch: React.Dispatch<OnboardingAction>;
  width: number;
  compact?: boolean;
}) {
  const theme = useTheme();
  const ascii = process.env.SKEIN_GLYPHS === 'ascii' || process.env.MOSAIC_GLYPHS === 'ascii';
  const marker = ascii ? '>' : '›';
  const mark = ascii ? '*' : PRODUCT_MARK;
  const inputField = inputFieldForStep(state);
  const stage = setupStage(state);
  const summary = connectionSummary(state);
  const horizontalPadding = width >= 32 ? 1 : 0;
  const headerWidth = Math.max(1, width - horizontalPadding * 2);
  return (
    <Box width={width} paddingX={horizontalPadding} flexDirection="column">
      <Box width={headerWidth} justifyContent="space-between">
        <Text bold color={theme.accent}>{truncateDisplay(`${mark}  ${PRODUCT_NAME.toUpperCase()}`, Math.max(1, headerWidth - displayWidth(stage.progress) - 1))}</Text>
        <Text color={theme.dim}>{stage.progress}</Text>
      </Box>
      <Text color={theme.border}>{truncateDisplay(stageDivider(ascii, headerWidth), headerWidth)}</Text>
      <Text color={theme.dim}>{truncateDisplay(stage.name, headerWidth)}</Text>
      {!compact ? <Box height={1} /> : null}
      <Text color={theme.textStrong} bold>{truncateDisplay(titleForStep(state.step), headerWidth)}</Text>
      {!compact ? <Text color={theme.muted} wrap="wrap">{descriptionForStep(state)}</Text> : null}
      {summary && !(compact && (state.step === 'confirm' || state.step === 'saving'))
        ? <Text color={theme.dim}>{truncateDisplay(summary, headerWidth)}</Text>
        : null}
      {!compact ? <Box height={1} /> : null}
      {state.step === 'relay-protocol' ? <OptionList options={relayProtocols} selected={state.selected} marker={marker} width={headerWidth} compact={compact} /> : null}
      {state.step === 'auth' ? <OptionList options={authMethods} selected={state.selected} marker={marker} width={headerWidth} compact={compact} /> : null}
      {state.step === 'auth-header' ? <OptionList options={authHeaders} selected={state.selected} marker={marker} width={headerWidth} compact={compact} /> : null}
      {state.step === 'models-auth' ? <OptionList options={modelAuthMethods} selected={state.selected} marker={marker} width={headerWidth} compact={compact} /> : null}
      {inputField ? (
        <Box flexDirection="column">
          <Box>
            <Text color={theme.textStrong} bold>{inputField.label}</Text>
            <Text color={theme.dim}>{inputField.required ? '  required' : '  optional'}</Text>
          </Box>
          <Box borderStyle="round" borderColor={state.error ? theme.error : theme.borderFocus} paddingX={1} width={headerWidth}>
            <Text color={theme.accent}>{marker} </Text>
            <Box width={Math.max(1, headerWidth - 6)} height={1} overflow="hidden">
              <TextInput
                value={state.draft[inputField.field]}
                onChange={(value) => dispatch({type: 'INPUT', field: inputField.field, value})}
                onSubmit={(value) => dispatch({type: 'SUBMIT_INPUT', field: inputField.field, value})}
                placeholder={inputField.placeholder}
              />
            </Box>
          </Box>
        </Box>
      ) : null}
      {state.step === 'confirm' || state.step === 'saving'
        ? <Confirmation state={state} width={headerWidth} compact={compact} />
        : null}
      {state.error ? <Text color={theme.error}>! {truncateDisplay(state.error, Math.max(1, headerWidth - 2))}</Text> : null}
      {!compact ? <Box height={1} /> : null}
      <Text color={theme.dim}>{footerForStep(state, headerWidth)}</Text>
    </Box>
  );
}

function OptionList({options, selected, marker, width, compact}: {
  options: Array<{label: string; detail: string}>;
  selected: number;
  marker: string;
  width: number;
  compact: boolean;
}) {
  const theme = useTheme();
  return (
    <Box flexDirection="column">
      {options.map((option, index) => {
        const active = index === selected;
        const prefix = active ? `${marker} ` : '  ';
        const available = Math.max(1, width - displayWidth(prefix) - (active ? 2 : 0));
        const label = `${prefix}${truncateDisplay(option.label, available)}`;
        return (
          <Box key={option.label} flexDirection="column" marginBottom={compact || index === options.length - 1 ? 0 : 1}>
            <Text
              color={active ? theme.selectionText : theme.text}
              bold={active}
              {...(active ? {backgroundColor: theme.selection} : {})}
            >{active ? padDisplay(label, width) : label}</Text>
            {!compact && (width >= 36 || active) ? (
              <Box marginLeft={2} width={Math.max(1, width - 2)}>
                <Text color={active ? theme.muted : theme.dim} wrap="wrap">{option.detail}</Text>
              </Box>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}

function Confirmation({state, width, compact}: {state: OnboardingState; width: number; compact: boolean}) {
  const theme = useTheme();
  const credential = state.draft.auth === 'env' ? `env:${state.draft.apiKeyEnv} · configured` : 'none';
  const values: Array<[string, string]> = compact ? [
    ...(state.draft.modelsBaseUrl ? [['Models', redactEndpoint(state.draft.modelsBaseUrl)] as [string, string]] : []),
    ['Model', state.draft.model],
    ['Credential', state.draft.auth === 'env'
      ? `env:${state.draft.apiKeyEnv} · ${state.draft.authHeader}`
      : 'none'],
    ...(state.draft.auth === 'env' ? [
      ['Models auth', state.draft.modelsAuthHeader] as [string, string],
    ] : []),
  ] : [
    ['Connection', DEFAULT_CONNECTION_NAME],
    ['Protocol', relayLabel(state.draft.relayProtocol)],
    ['Inference', redactEndpoint(state.draft.baseUrl)],
    ['Models', state.draft.modelsBaseUrl ? redactEndpoint(state.draft.modelsBaseUrl) : 'same base as inference'],
    ['Model', state.draft.model],
    ['Credential', credential],
    ...(state.draft.auth === 'env' ? [
      ['Inference auth', state.draft.authHeader] as [string, string],
      ['Models auth', state.draft.modelsAuthHeader] as [string, string],
    ] : []),
  ];
  const tabular = width >= 36;
  const labelWidth = tabular
    ? Math.min(16, Math.max(...values.map(([label]) => displayWidth(label))) + 2)
    : undefined;
  return (
    <Box flexDirection="column">
      {values.map(([label, value]) => (
        <Box key={label} flexDirection={tabular ? 'row' : 'column'}>
          <Box width={labelWidth}><Text color={theme.dim}>{label}</Text></Box>
          <Text color={theme.text}>{truncateDisplay(value, Math.max(1, width - (labelWidth ?? 0)))}</Text>
        </Box>
      ))}
      {state.step === 'saving' && !compact ? <Text color={theme.accent}>Saving and validating configuration…</Text> : null}
    </Box>
  );
}

function menuCount(step: OnboardingStep): number {
  if (step === 'relay-protocol') return relayProtocols.length;
  if (step === 'auth') return authMethods.length;
  if (step === 'auth-header') return authHeaders.length;
  if (step === 'models-auth') return modelAuthMethods.length;
  return 0;
}

function inputFieldForStep(state: OnboardingState): {field: EditableField; label: string; placeholder: string; required: boolean} | undefined {
  if (state.step === 'endpoint') return {field: 'baseUrl', label: 'Inference base URL', placeholder: 'https://relay.example/v1', required: true};
  if (state.step === 'models-endpoint') return {
    field: 'modelsBaseUrl',
    label: 'Models base URL',
    placeholder: state.draft.relayProtocol === 'anthropic-messages' ? 'https://relay.example/v1' : 'blank uses inference base',
    required: state.draft.relayProtocol === 'anthropic-messages',
  };
  if (state.step === 'model') return {field: 'model', label: 'Model identifier', placeholder: 'provider-model-id', required: true};
  if (state.step === 'api-key-env') return {
    field: 'apiKeyEnv', label: 'Credential environment variable', placeholder: 'RELAY_API_KEY', required: true,
  };
  return undefined;
}

function setupStage(state: OnboardingState): {index: number; name: string; progress: string} {
  const index = state.step === 'endpoint' || state.step === 'models-endpoint'
    ? 2
    : state.step === 'model'
      ? 3
      : state.step === 'auth' || state.step === 'auth-header' || state.step === 'models-auth' || state.step === 'api-key-env'
        ? 4
        : state.step === 'confirm' || state.step === 'saving'
          ? 5
          : 1;
  const name = index === 1 ? 'TRANSPORT' : index === 2 ? 'ENDPOINTS' : index === 3 ? 'MODEL' : index === 4 ? 'AUTH' : 'REVIEW';
  return {index, name, progress: `SETUP ${index}/5`};
}

function stageDivider(ascii: boolean, width: number): string {
  return (ascii ? '-' : '─').repeat(Math.max(1, width));
}

function connectionSummary(state: OnboardingState): string {
  if (!state.draft.relayProtocol) return '';
  const parts = ['Relay'];
  parts.push(relayLabel(state.draft.relayProtocol));
  if (state.draft.baseUrl) parts.push(redactEndpoint(state.draft.baseUrl));
  if (state.draft.model) parts.push(state.draft.model);
  return parts.join('  /  ');
}

function titleForStep(step: OnboardingStep): string {
  if (step === 'relay-protocol') return 'Choose the relay protocol';
  if (step === 'endpoint') return 'Enter the inference base URL';
  if (step === 'models-endpoint') return 'Enter the model catalog base URL';
  if (step === 'model') return 'Enter the model identifier';
  if (step === 'auth') return 'Choose relay authentication';
  if (step === 'auth-header') return 'Choose inference authentication';
  if (step === 'models-auth') return 'Choose model catalog authentication';
  if (step === 'api-key-env') return 'Reference the credential environment';
  if (step === 'confirm') return 'Review and save';
  return 'Saving configuration';
}

function descriptionForStep(state: OnboardingState): string {
  if (state.step === 'relay-protocol') return 'Skein connects through third-party relays only. Responses is recommended; Chat Completions and Anthropic Messages remain explicit compatibility transports.';
  if (state.step === 'endpoint') return 'Remote endpoints require HTTPS. Loopback development servers may use HTTP.';
  if (state.step === 'models-endpoint') return state.draft.relayProtocol === 'anthropic-messages'
    ? 'Anthropic inference bases often differ from the OpenAI-style /models directory, so this value is required.'
    : 'Leave blank when GET /models uses the same base as inference.';
  if (state.step === 'model') return 'Use the exact model identifier returned or documented by the relay.';
  if (state.step === 'auth') return 'Credentials are referenced from the environment and are never written to Skein configuration.';
  if (state.step === 'auth-header') return 'Relays disagree here: OpenRouter documents Bearer while Anthropic SDK-compatible gateways commonly use x-api-key. Skein sends only the selected form.';
  if (state.step === 'models-auth') return 'Model catalogs may use a different header or be public. Choose none to guarantee the inference key is not sent to the catalog endpoint.';
  if (state.step === 'api-key-env') return 'Enter the variable name only. It must already exist in this process environment.';
  if (state.step === 'confirm') return 'Only redacted endpoints, model metadata, and the credential variable name are saved.';
  return 'The configuration is saved only after this step succeeds.';
}

function footerForStep(state: OnboardingState, width: number): string {
  if (state.step === 'saving') return width < 48 ? 'Saving · please wait' : 'Saving owner-only configuration · please wait';
  if (width < 28) return menuCount(state.step) ? '↑↓ · Enter · Esc' : 'Enter · Esc';
  if (state.step === 'confirm') return width < 48 ? 'Enter save · Esc back' : 'Enter save · Esc back · Ctrl+C cancel';
  if (menuCount(state.step)) return width < 48
    ? '↑/↓ select · Enter next · Esc back'
    : '↑/↓ or Tab choose · Enter continue · Esc back · Ctrl+C cancel';
  return width < 48 ? 'Enter next · Esc back' : 'Enter continue · Esc back · Ctrl+C cancel';
}

function relayLabel(protocol?: RelayProtocol): string {
  if (protocol === 'anthropic-messages') return 'Anthropic Messages';
  if (protocol === 'openai-chat') return 'OpenAI Chat Completions';
  return 'OpenAI Responses';
}

export async function runFirstRunOnboarding(
  initialConfig: MosaicConfig,
  options: {
    saveConfig?: (config: OnboardingConfigPatch) => Promise<string>;
    stdin?: NodeJS.ReadStream;
    stdout?: NodeJS.WriteStream;
    stderr?: NodeJS.WriteStream;
  } = {},
): Promise<OnboardingResult> {
  let result: OnboardingResult | undefined;
  const terminalAccessibility = resolveTerminalAccessibility();
  const instance = render(
    <OnboardingApp
      initialConfig={initialConfig}
      saveConfig={options.saveConfig ?? ((config) => saveUserConfig(config))}
      onFinish={(next) => { result = next; }}
    />,
    {
      ...(options.stdin ? {stdin: options.stdin} : {}),
      ...(options.stdout ? {stdout: options.stdout} : {}),
      ...(options.stderr ? {stderr: options.stderr} : {}),
      exitOnCtrlC: false,
      patchConsole: false,
      incrementalRendering: terminalAccessibility.incrementalRendering,
      isScreenReaderEnabled: terminalAccessibility.screenReader,
      kittyKeyboard: resolveKittyKeyboardConfig(),
    },
  );
  await instance.waitUntilExit();
  if (terminalAccessibility.screenReader) (options.stdout ?? process.stdout).write('\n');
  return result ?? {status: 'cancelled'};
}
