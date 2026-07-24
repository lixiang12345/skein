import React, {useCallback, useEffect, useMemo, useReducer, useRef} from 'react';
import {Box, render, Text, useApp, useInput, useWindowSize} from 'ink';
import TextInput from 'ink-text-input';
import {defaultModelForProvider, redactEndpoint, saveUserConfig} from '../config.js';
import {PRODUCT_MARK, PRODUCT_NAME} from '../brand.js';
import type {MosaicConfig, ProviderName} from '../types.js';
import {displayWidth, padDisplay, sanitizeTerminalText, truncateDisplay} from './text.js';
import {resolveThemeWithColor, ThemeProvider, useTheme} from './theme.js';

export type OnboardingMethod = 'official' | 'relay';
export type RelayProtocol = 'openai-compatible' | 'anthropic-compatible';
export type OnboardingStep =
  | 'method'
  | 'official-provider'
  | 'relay-protocol'
  | 'endpoint'
  | 'model'
  | 'api-key'
  | 'confirm'
  | 'saving';

export interface OnboardingDraft {
  method: OnboardingMethod | undefined;
  provider: ProviderName | undefined;
  relayProtocol: RelayProtocol | undefined;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface OnboardingState {
  step: OnboardingStep;
  history: OnboardingStep[];
  selected: number;
  draft: OnboardingDraft;
  error: string | undefined;
}

export interface OnboardingConfigPatch {
  model: {
    provider: ProviderName;
    model: string;
    apiKey?: string;
    baseUrl?: string;
  };
}

export type OnboardingResult =
  | {status: 'saved'; path: string}
  | {status: 'cancelled'};

type EditableField = 'baseUrl' | 'model' | 'apiKey';
export type OnboardingAction =
  | {type: 'MOVE'; delta: -1 | 1; count: number}
  | {type: 'SELECT'}
  | {type: 'INPUT'; field: EditableField; value: string}
  | {type: 'SUBMIT_INPUT'; field: EditableField; value: string}
  | {type: 'BACK'}
  | {type: 'SAVE_START'}
  | {type: 'SAVE_ERROR'};

const officialProviders: Array<{provider: Exclude<ProviderName, 'compatible'>; label: string; detail: string}> = [
  {provider: 'openai', label: 'OpenAI API', detail: 'Native API protocol · API key'},
  {provider: 'anthropic', label: 'Anthropic API', detail: 'Messages API · API key'},
  {provider: 'gemini', label: 'Google Gemini API', detail: 'generateContent API · API key'},
];

const methods: Array<{value: OnboardingMethod; label: string; detail: string}> = [
  {value: 'official', label: 'Provider API key', detail: 'OpenAI, Anthropic, or Gemini · direct billing'},
  {value: 'relay', label: 'Compatible endpoint', detail: 'Local server or relay · protocol chosen explicitly'},
];

const relayProtocols: Array<{value: RelayProtocol; label: string; detail: string}> = [
  {value: 'openai-compatible', label: 'OpenAI-compatible', detail: 'Chat Completions · Bearer key'},
  {value: 'anthropic-compatible', label: 'Anthropic-compatible', detail: 'Messages API · x-api-key'},
];

const forbiddenDirectionControls = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const directionControls = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const inputControl = /[\u0000-\u001f\u007f-\u009f]/u;

export function needsFirstRunOnboarding(config: MosaicConfig): boolean {
  if (config.model.provider === 'compatible') return !config.model.baseUrl;
  return !config.model.apiKey;
}

export function createOnboardingState(config: MosaicConfig): OnboardingState {
  return {
    step: 'method',
    history: [],
    selected: 0,
    draft: {
      method: undefined,
      provider: undefined,
      relayProtocol: undefined,
      baseUrl: config.model.baseUrl ?? '',
      model: config.model.model,
      // Never import a provider environment key into a relay draft. The user
      // must deliberately provide the credential for the selected transport.
      apiKey: '',
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
  if (path.endsWith('/chat/completions') || path.endsWith('/messages')) {
    return {ok: false, error: 'Enter the API base URL, not the final /chat/completions or /messages endpoint.'};
  }
  url.pathname = url.pathname.replace(/\/+$/u, '');
  const normalized = url.toString().replace(/\/+$/u, '');
  return {ok: true, value: normalized, loopback};
}

export function buildOnboardingConfig(state: OnboardingState): OnboardingConfigPatch {
  const provider = state.draft.provider;
  const model = validateModel(state.draft.model);
  if (!provider || !model.ok) throw new Error('Onboarding model configuration is incomplete.');
  const apiKey = validateApiKey(state.draft.apiKey, apiKeyRequired(state));
  if (!apiKey.ok) throw new Error('Onboarding credential configuration is incomplete.');
  if (state.draft.method === 'relay') {
    const endpoint = validateRelayBaseUrl(state.draft.baseUrl);
    if (!endpoint.ok) throw new Error('Onboarding relay configuration is incomplete.');
    return {
      model: {
        provider,
        model: model.value,
        baseUrl: endpoint.value,
        ...(apiKey.value ? {apiKey: apiKey.value} : {}),
      },
    };
  }
  return {model: {provider, model: model.value, apiKey: apiKey.value}};
}

function selectCurrentOption(state: OnboardingState): OnboardingState {
  if (state.step === 'method') {
    const method = methods[state.selected]?.value;
    if (!method) return state;
    if (method === 'official') {
      return advance({...state, draft: {...state.draft, method, relayProtocol: undefined}}, 'official-provider');
    }
    if (method === 'relay') {
      return advance({...state, draft: {...state.draft, method}}, 'relay-protocol');
    }
    return state;
  }
  if (state.step === 'official-provider') {
    const provider = officialProviders[state.selected]?.provider;
    if (!provider) return state;
    return advance({
      ...state,
      draft: {
        ...state.draft,
        method: 'official',
        provider,
        relayProtocol: undefined,
        baseUrl: '',
        model: defaultModelForProvider(provider),
        apiKey: '',
      },
    }, 'model');
  }
  if (state.step === 'relay-protocol') {
    const relayProtocol = relayProtocols[state.selected]?.value;
    if (!relayProtocol) return state;
    const provider: ProviderName = relayProtocol === 'openai-compatible' ? 'compatible' : 'anthropic';
    return advance({
      ...state,
      draft: {
        ...state.draft,
        method: 'relay',
        provider,
        relayProtocol,
        baseUrl: '',
        model: defaultModelForProvider(provider),
        apiKey: '',
      },
    }, 'endpoint');
  }
  return state;
}

function submitInput(state: OnboardingState, field: EditableField, rawValue: string): OnboardingState {
  const value = sanitizeFieldInput(field, rawValue);
  const next = {...state, draft: {...state.draft, [field]: value}, error: undefined};
  if (field === 'baseUrl') {
    const endpoint = validateRelayBaseUrl(value);
    if (!endpoint.ok) return {...next, error: endpoint.error};
    return advance({...next, draft: {...next.draft, baseUrl: endpoint.value}}, 'model');
  }
  if (field === 'model') {
    const model = validateModel(value);
    if (!model.ok) return {...next, error: model.error};
    return advance({...next, draft: {...next.draft, model: model.value}}, 'api-key');
  }
  const apiKey = validateApiKey(value, apiKeyRequired(next));
  if (!apiKey.ok) return {...next, error: apiKey.error};
  return advance({...next, draft: {...next.draft, apiKey: apiKey.value}}, 'confirm');
}

function advance(state: OnboardingState, step: OnboardingStep): OnboardingState {
  return {...state, step, history: [...state.history, state.step], selected: 0, error: undefined};
}

function sanitizeFieldInput(field: EditableField, value: string): string {
  const max = field === 'baseUrl' ? 2_048 : field === 'model' ? 256 : 1_024;
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

function validateApiKey(value: string, required: boolean): {ok: true; value: string} | {ok: false; error: string} {
  const apiKey = value.trim();
  if (!apiKey && required) return {ok: false, error: 'Enter the API key for this provider or relay.'};
  if (/\s/u.test(apiKey) || forbiddenDirectionControls.test(apiKey)) {
    return {ok: false, error: 'The API key contains unsupported whitespace or control characters.'};
  }
  return {ok: true, value: apiKey};
}

function apiKeyRequired(state: OnboardingState): boolean {
  if (state.draft.method !== 'relay') return true;
  const endpoint = validateRelayBaseUrl(state.draft.baseUrl);
  // A local OpenAI-compatible server may be intentionally keyless. Anthropic
  // relays and every remote relay require an explicit relay credential.
  return state.draft.provider === 'anthropic' || !endpoint.ok || !endpoint.loopback;
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
  const colorEnabled = initialConfig.ui.color && !process.env.NO_COLOR;
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
      {summary ? <Text color={theme.dim}>{truncateDisplay(summary, headerWidth)}</Text> : null}
      {!compact ? <Box height={1} /> : null}
      {state.step === 'method' ? <OptionList options={methods} selected={state.selected} marker={marker} width={headerWidth} compact={compact} /> : null}
      {state.step === 'official-provider' ? <OptionList options={officialProviders} selected={state.selected} marker={marker} width={headerWidth} compact={compact} /> : null}
      {state.step === 'relay-protocol' ? <OptionList options={relayProtocols} selected={state.selected} marker={marker} width={headerWidth} compact={compact} /> : null}
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
                {...(inputField.field === 'apiKey' ? {mask: ascii ? '*' : '•'} : {})}
              />
            </Box>
          </Box>
        </Box>
      ) : null}
      {state.step === 'confirm' || state.step === 'saving' ? <Confirmation state={state} width={headerWidth} /> : null}
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
            {(!compact && width >= 36) || active ? (
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

function Confirmation({state, width}: {state: OnboardingState; width: number}) {
  const theme = useTheme();
  const relay = state.draft.method === 'relay';
  const values: Array<[string, string]> = [
    ['Mode', relay ? 'Compatible endpoint' : 'Provider API'],
    ['Protocol', relay ? relayLabel(state.draft.relayProtocol) : providerLabel(state.draft.provider)],
    ...(relay ? [['Base URL', redactEndpoint(state.draft.baseUrl)] as [string, string]] : []),
    ['Model', state.draft.model],
    ['Credential', state.draft.apiKey ? 'configured · masked · owner-only' : 'not required for this loopback endpoint'],
  ];
  const tabular = width >= 36;
  return (
    <Box flexDirection="column">
      {values.map(([label, value]) => (
        <Box key={label} flexDirection={tabular ? 'row' : 'column'}>
          <Box width={tabular ? 12 : undefined}><Text color={theme.dim}>{label}</Text></Box>
          <Text color={theme.text}>{truncateDisplay(value, Math.max(1, width - (tabular ? 12 : 0)))}</Text>
        </Box>
      ))}
      {state.step === 'saving' ? <Text color={theme.accent}>Saving and validating configuration…</Text> : null}
    </Box>
  );
}

function menuCount(step: OnboardingStep): number {
  if (step === 'method') return methods.length;
  if (step === 'official-provider') return officialProviders.length;
  if (step === 'relay-protocol') return relayProtocols.length;
  return 0;
}

function inputFieldForStep(state: OnboardingState): {field: EditableField; label: string; placeholder: string; required: boolean} | undefined {
  if (state.step === 'endpoint') return {field: 'baseUrl', label: 'Base URL', placeholder: 'https://relay.example/v1', required: true};
  if (state.step === 'model') return {field: 'model', label: 'Model identifier', placeholder: 'provider-model-id', required: true};
  if (state.step === 'api-key') return {field: 'apiKey', label: 'API key', placeholder: 'paste key · input is masked', required: apiKeyRequired(state)};
  return undefined;
}

function setupStage(state: OnboardingState): {index: number; name: string; progress: string} {
  const index = state.step === 'endpoint' || state.step === 'model'
    ? 2
    : state.step === 'api-key'
      ? 3
      : state.step === 'confirm' || state.step === 'saving'
        ? 4
        : 1;
  const name = index === 1 ? 'CONNECTION' : index === 2 ? 'MODEL' : index === 3 ? 'CREDENTIAL' : 'REVIEW';
  return {index, name, progress: `SETUP ${index}/4`};
}

function stageDivider(ascii: boolean, width: number): string {
  return (ascii ? '-' : '─').repeat(Math.max(1, width));
}

function connectionSummary(state: OnboardingState): string {
  if (!state.draft.method) return '';
  const parts = [state.draft.method === 'relay' ? 'Compatible endpoint' : 'Provider API'];
  if (state.draft.provider) parts.push(
    state.draft.method === 'relay'
      ? relayLabel(state.draft.relayProtocol)
      : providerLabel(state.draft.provider),
  );
  if (state.draft.baseUrl) parts.push(redactEndpoint(state.draft.baseUrl));
  if (state.draft.model) parts.push(state.draft.model);
  return parts.join('  /  ');
}

function titleForStep(step: OnboardingStep): string {
  if (step === 'method') return 'Choose how Skein reaches the model';
  if (step === 'official-provider') return 'Choose a provider';
  if (step === 'relay-protocol') return 'Choose the endpoint protocol';
  if (step === 'endpoint') return 'Enter the endpoint base URL';
  if (step === 'model') return 'Enter the model identifier';
  if (step === 'api-key') return 'Add the API key';
  if (step === 'confirm') return 'Review and save';
  return 'Saving configuration';
}

function descriptionForStep(state: OnboardingState): string {
  if (state.step === 'method') return 'Pick one connection path. You can change it later with configuration.';
  if (state.step === 'official-provider') return 'Use the API credential issued by the selected provider.';
  if (state.step === 'relay-protocol') return 'The protocol is explicit so requests and credentials are never guessed.';
  if (state.step === 'endpoint') return 'Remote endpoints require HTTPS. Loopback development servers may use HTTP.';
  if (state.step === 'model') return 'Use the exact model identifier accepted by this provider or endpoint.';
  if (state.step === 'api-key') return apiKeyRequired(state)
    ? 'Masked on screen and saved only to your owner-readable user configuration.'
    : 'This loopback endpoint may be keyless. Leave blank if it does not authenticate.';
  if (state.step === 'confirm') return 'The values below are sanitized before Skein saves and validates them.';
  return 'The configuration is saved only after this step succeeds.';
}

function footerForStep(state: OnboardingState, width: number): string {
  if (state.step === 'saving') return 'Saving owner-only configuration · please wait';
  if (width < 28) return menuCount(state.step) ? '↑↓ · Enter · Esc' : 'Enter · Esc';
  if (state.step === 'confirm') return width < 48 ? 'Enter save · Esc back' : 'Enter save · Esc back · Ctrl+C cancel';
  if (menuCount(state.step)) return width < 48
    ? '↑/↓ select · Enter next · Esc back'
    : '↑/↓ or Tab choose · Enter continue · Esc back · Ctrl+C cancel';
  return width < 48 ? 'Enter next · Esc back' : 'Enter continue · Esc back · Ctrl+C cancel';
}

function relayLabel(protocol?: RelayProtocol): string {
  return protocol === 'anthropic-compatible' ? 'Anthropic-compatible' : 'OpenAI-compatible';
}

function providerLabel(provider?: ProviderName): string {
  return officialProviders.find((item) => item.provider === provider)?.label ?? provider ?? 'not selected';
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
      incrementalRendering: true,
      kittyKeyboard: {
        mode: 'auto',
        flags: ['disambiguateEscapeCodes'],
      },
    },
  );
  await instance.waitUntilExit();
  return result ?? {status: 'cancelled'};
}
