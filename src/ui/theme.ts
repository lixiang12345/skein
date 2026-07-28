import {lstat, readdir, readFile} from 'node:fs/promises';
import {basename, join, resolve} from 'node:path';
import React, {createContext, useContext} from 'react';
import {
  defaultTheme as inkUiDefaultTheme,
  extendTheme as extendInkUiTheme,
  ThemeProvider as InkUiThemeProvider,
  type Theme as InkUiTheme,
} from '@inkjs/ui';
import {compactDisplayPath} from './text.js';
import {resolveHomeNamespace} from '../utils/namespace.js';

/**
 * Colour contract. Each token owns exactly one meaning, and a row may claim at
 * most one of them; everything else in the frame is a neutral. Keeping the
 * assignment this narrow is what stops a long transcript from turning into a
 * field of unrelated hues:
 *
 * - `accent`   live and interactive only — the user's prompt glyph, a running
 *              spinner, the composer caret, the selected palette row, the
 *              in-progress plan step. Never used for settled content.
 * - `success`  terminal success *evidence* only — verified completion, a ready
 *              workspace, a finished plan step. An individual tool that simply
 *              worked is silent; it carries no glyph and no colour.
 * - `warning`  needs a decision or degraded — approvals, cancellation,
 *              retrieval degradation, high context pressure.
 * - `error`    failure only.
 * - `code`     every literal: fenced code, inline code, quoted source.
 * - neutrals   `text` / `textStrong` / `muted` / `dim` / `border` carry all
 *              remaining structure, including every receipt row.
 *
 * Syntax highlighting deliberately stays inside `code`, `accent`, and the
 * neutrals. Reusing `success` for strings and `warning` for numbers made every
 * code block compete with real status rows for the same two colours.
 */
export interface SemanticThemeTokens {
  accent: string;
  text: string;
  muted: string;
  success: string;
  warning: string;
  error: string;
  selection: string;
  border: string;
}

export interface TerminalTheme extends SemanticThemeTokens {
  name: string;
  textStrong: string;
  dim: string;
  borderFocus: string;
  selectionText: string;
  code: string;
  /**
   * Literals inside a code block (strings, numbers). Deliberately a neutral
   * step down from `code` rather than its own hue, so syntax highlighting
   * cannot compete with the semantic status colours.
   */
  codeLiteral: string;
  heading: string;
  diffAdded: string;
  diffRemoved: string;

  // Compatibility aliases for extensions built against the original palette.
  accentSoft: string;
  secondary: string;
  info: string;
  user: string;
  assistant: string;
  tool: string;
  memory: string;
  skill: string;
  agent: string;
  selectedBackground: string;
  toolPendingBackground: string;
  toolSuccessBackground: string;
  toolErrorBackground: string;
}

interface ThemeSeed extends SemanticThemeTokens {
  name: string;
  textStrong: string;
  dim: string;
  selectionText: string;
  pendingSurface: string;
  successSurface: string;
  errorSurface: string;
  /**
   * Literal source text. Optional: themes that omit it keep the historical
   * behaviour of reusing the accent, while built-ins give code its own tone so
   * quoted code stops competing with accent-coloured interactive chrome.
   */
  code?: string;
  /** Literal text inside a code block. Defaults to `muted`. */
  codeLiteral?: string;
}

function defineTheme(seed: ThemeSeed): TerminalTheme {
  return {
    ...seed,
    borderFocus: seed.accent,
    code: seed.code ?? seed.accent,
    codeLiteral: seed.codeLiteral ?? seed.muted,
    heading: seed.textStrong,
    diffAdded: seed.success,
    diffRemoved: seed.error,

    // Roles use typography and labels for identity; color stays semantic.
    accentSoft: seed.accent,
    secondary: seed.muted,
    info: seed.accent,
    user: seed.textStrong,
    assistant: seed.text,
    tool: seed.text,
    memory: seed.muted,
    skill: seed.muted,
    agent: seed.muted,
    selectedBackground: seed.selection,
    toolPendingBackground: seed.pendingSurface,
    toolSuccessBackground: seed.successSurface,
    toolErrorBackground: seed.errorSurface,
  };
}

export const themes: Record<string, TerminalTheme> = {
  graphite: defineTheme({
    // Neutral graphite with one cool interaction accent. Status colors only
    // appear when they carry meaning, so long transcripts stay readable.
    name: 'graphite',
    code: '#A9C7E8',
    codeLiteral: '#8FA6BF',
    accent: '#49DCC6',
    text: '#DFE1E5',
    textStrong: '#FFFFFF',
    muted: '#ADB3BC',
    dim: '#80868F',
    border: '#5C626B',
    success: '#4DDB9A',
    warning: '#E5B94D',
    error: '#FF7587',
    selection: '#2C3138',
    selectionText: '#FFFFFF',
    pendingSurface: '#25292F',
    successSurface: '#25332A',
    errorSurface: '#39272B',
  }),
  cinder: defineTheme({
    name: 'cinder',
    code: '#F2D9A8',
    codeLiteral: '#CBB894',
    accent: '#FFC46B',
    text: '#F0E8DE',
    textStrong: '#FFFDF9',
    muted: '#C4B8AA',
    dim: '#918579',
    border: '#726257',
    success: '#7EE787',
    warning: '#FFB95A',
    error: '#FF7B82',
    selection: '#4A392C',
    selectionText: '#FFFFFF',
    pendingSurface: '#3A3026',
    successSurface: '#263A2A',
    errorSurface: '#46282B',
  }),
  mono: defineTheme({
    name: 'mono',
    code: '#C9C9C9',
    codeLiteral: '#A5A5A5',
    accent: '#E7E7E7',
    text: '#D2D2D2',
    textStrong: '#FFFFFF',
    muted: '#A5A5A5',
    dim: '#7D7D7D',
    border: '#484848',
    success: '#E1E1E1',
    warning: '#C5C5C5',
    error: '#F0F0F0',
    selection: '#343434',
    selectionText: '#FFFFFF',
    pendingSurface: '#292929',
    successSurface: '#2D2D2D',
    errorSurface: '#323232',
  }),
  midnight: defineTheme({
    name: 'midnight',
    code: '#D7CBFF',
    codeLiteral: '#B0A6D6',
    accent: '#B9BCFF',
    text: '#EBEAF5',
    textStrong: '#FFFFFF',
    muted: '#BDB9CF',
    dim: '#8E8AA3',
    border: '#6A6480',
    success: '#73E6A2',
    warning: '#FFD166',
    error: '#FF7F91',
    selection: '#3B3856',
    selectionText: '#FFFFFF',
    pendingSurface: '#302E45',
    successSurface: '#243A2D',
    errorSurface: '#45282E',
  }),
  paper: defineTheme({
    name: 'paper',
    code: '#7A3E9D',
    codeLiteral: '#5B5F66',
    accent: '#236B8E',
    text: '#30343A',
    textStrong: '#15181C',
    muted: '#626A73',
    dim: '#69727C',
    border: '#C8CDD3',
    success: '#287A46',
    warning: '#8A621B',
    error: '#AD3942',
    selection: '#DCEAF1',
    selectionText: '#15181C',
    pendingSurface: '#E8EDF0',
    successSurface: '#E1F1E5',
    errorSurface: '#F6E3E5',
  }),
};

const builtInThemeNames = new Set(Object.keys(themes));
const userThemeNames = new Set<string>();
const colorPattern = /^#[0-9a-f]{6}$/i;

export interface ThemeLoadResult {
  directory: string;
  loaded: string[];
  errors: string[];
}

/**
 * Reload user-owned JSON themes. A theme is deliberately data-only: no shell,
 * JavaScript, or workspace files are evaluated as part of terminal styling.
 */
export async function reloadUserThemes(directory = userThemeDirectory()): Promise<ThemeLoadResult> {
  for (const name of userThemeNames) delete themes[name];
  userThemeNames.clear();
  const loaded: string[] = [];
  const errors: string[] = [];
  const resolvedDirectory = resolve(directory);
  let entries: string[];
  try {
    entries = await readdir(resolvedDirectory, {encoding: 'utf8'});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {directory: resolvedDirectory, loaded, errors};
    }
    return {directory: resolvedDirectory, loaded, errors: [error instanceof Error ? error.message : String(error)]};
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const path = join(resolvedDirectory, entry);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 64_000) {
        throw new Error('must be a regular JSON file smaller than 64 KB');
      }
      const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
      const name = themeName(parsed, basename(entry, '.json'));
      if (builtInThemeNames.has(name)) throw new Error(`cannot replace built-in theme \`${name}\``);
      themes[name] = defineTheme(themeSeed(parsed, name));
      userThemeNames.add(name);
      loaded.push(name);
    } catch (error) {
      errors.push(`${entry}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {directory: resolvedDirectory, loaded, errors};
}

export function userThemeDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.SKEIN_THEME_DIR ?? environment.MOSAIC_THEME_DIR ?? join(resolveHomeNamespace(environment), 'themes');
}

const defaultTheme = themes.graphite as TerminalTheme;

export const palette = {
  violet: defaultTheme.accent,
  violetStrong: defaultTheme.accent,
  cyan: defaultTheme.accent,
  green: defaultTheme.success,
  amber: defaultTheme.warning,
  rose: defaultTheme.error,
  text: defaultTheme.text,
  dim: defaultTheme.muted,
  line: defaultTheme.border,
} as const;

const ThemeContext = createContext<TerminalTheme>(defaultTheme);

export function ThemeProvider({theme, children}: {theme: TerminalTheme; children: React.ReactNode}) {
  const inkUiTheme = React.useMemo(() => createInkUiTheme(theme), [theme]);
  return React.createElement(
    ThemeContext.Provider,
    {value: theme},
    React.createElement(InkUiThemeProvider, {theme: inkUiTheme, children}),
  );
}

/** Keep third-party Ink controls inside Skein's restrained semantic palette. */
function createInkUiTheme(theme: TerminalTheme): InkUiTheme {
  return extendInkUiTheme(inkUiDefaultTheme, {
    components: {
      Spinner: {
        styles: {
          container: () => ({gap: 0}),
          frame: () => ({color: theme.accent}),
          label: () => ({color: theme.text}),
        },
      },
    },
  });
}

export function useTheme(): TerminalTheme {
  return useContext(ThemeContext);
}

export function resolveTheme(name?: string, environment: NodeJS.ProcessEnv = process.env): TerminalTheme {
  const requested = name?.toLocaleLowerCase() || 'auto';
  const selectedName = requested === 'auto'
    ? detectTerminalAppearance(environment) === 'light' ? 'paper' : 'graphite'
    : requested;
  return themes[selectedName] ?? defaultTheme;
}

export function nextTheme(name: string, options: {color?: boolean} = {}): TerminalTheme {
  const names = Object.keys(themes);
  const index = names.indexOf(name);
  return withColor(resolveTheme(names[(index + 1) % names.length]), options.color !== false);
}

/** Resolve a palette while respecting NO_COLOR and explicit monochrome mode. */
export function resolveThemeWithColor(name: string | undefined, color = true): TerminalTheme {
  return withColor(resolveTheme(name), color && !process.env.NO_COLOR);
}

export function detectTerminalAppearance(environment: NodeJS.ProcessEnv = process.env): 'dark' | 'light' {
  const explicit = environment.SKEIN_APPEARANCE?.toLocaleLowerCase();
  if (explicit === 'light' || explicit === 'dark') return explicit;
  // COLORFGBG is emitted by several terminal emulators as `foreground;background`.
  // ANSI indexes 0/8 are reliably dark and 7/15 reliably light. Other palette
  // values are colors rather than luminance, so stay with the dark-safe default.
  const background = environment.COLORFGBG?.split(';').at(-1);
  if (background && /^\d+$/.test(background)) {
    const value = Number(background);
    if (value === 7 || value === 15) return 'light';
    if (value === 0 || value === 8) return 'dark';
  }
  return 'dark';
}

function withColor(theme: TerminalTheme, color: boolean): TerminalTheme {
  if (color) return theme;
  const monochrome = '';
  return {
    ...theme,
    accent: monochrome,
    text: monochrome,
    muted: monochrome,
    success: monochrome,
    warning: monochrome,
    error: monochrome,
    selection: monochrome,
    border: monochrome,
    textStrong: monochrome,
    dim: monochrome,
    borderFocus: monochrome,
    selectionText: monochrome,
    code: monochrome,
    codeLiteral: monochrome,
    heading: monochrome,
    diffAdded: monochrome,
    diffRemoved: monochrome,
    accentSoft: monochrome,
    secondary: monochrome,
    info: monochrome,
    user: monochrome,
    assistant: monochrome,
    tool: monochrome,
    memory: monochrome,
    skill: monochrome,
    agent: monochrome,
    selectedBackground: monochrome,
    toolPendingBackground: monochrome,
    toolSuccessBackground: monochrome,
    toolErrorBackground: monochrome,
  };
}

function themeName(value: unknown, fallback: string): string {
  const candidate = isRecord(value) && typeof value.name === 'string' ? value.name : fallback;
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(candidate)) {
    throw new Error('theme name must match [a-z][a-z0-9_-]{0,31}');
  }
  return candidate;
}

function themeSeed(value: unknown, name: string): ThemeSeed {
  if (!isRecord(value)) throw new Error('theme must be a JSON object');
  const fallback = themes.graphite as TerminalTheme;
  return {
    name,
    accent: themeColor(value, 'accent', fallback.accent),
    code: themeColor(value, 'code', fallback.code),
    codeLiteral: themeColor(value, 'codeLiteral', fallback.codeLiteral),
    text: themeColor(value, 'text', fallback.text),
    textStrong: themeColor(value, 'textStrong', fallback.textStrong),
    muted: themeColor(value, 'muted', fallback.muted),
    dim: themeColor(value, 'dim', fallback.dim),
    border: themeColor(value, 'border', fallback.border),
    success: themeColor(value, 'success', fallback.success),
    warning: themeColor(value, 'warning', fallback.warning),
    error: themeColor(value, 'error', fallback.error),
    selection: themeColor(value, 'selection', fallback.selection),
    selectionText: themeColor(value, 'selectionText', fallback.selectionText),
    pendingSurface: themeColor(value, 'pendingSurface', fallback.toolPendingBackground),
    successSurface: themeColor(value, 'successSurface', fallback.toolSuccessBackground),
    errorSurface: themeColor(value, 'errorSurface', fallback.toolErrorBackground),
  };
}

function themeColor(value: Record<string, unknown>, key: string, fallback: string): string {
  const candidate = value[key];
  if (candidate === undefined) return fallback;
  if (typeof candidate !== 'string' || !colorPattern.test(candidate)) {
    throw new Error(`${key} must be a #RRGGBB color`);
  }
  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function formatTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

export function formatPercent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

export function elapsed(startedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** @deprecated Use compactDisplayPath from ui/text for terminal-width-aware output. */
export function compactPath(path: string, max = 54): string {
  return compactDisplayPath(path, max);
}
