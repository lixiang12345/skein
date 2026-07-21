import {lstat, readdir, readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename, join, resolve} from 'node:path';
import React, {createContext, useContext} from 'react';
import {compactDisplayPath} from './text.js';

/** The small semantic palette components should use directly. */
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
}

function defineTheme(seed: ThemeSeed): TerminalTheme {
  return {
    ...seed,
    borderFocus: seed.accent,
    code: seed.accent,
    heading: seed.textStrong,
    diffAdded: seed.success,
    diffRemoved: seed.error,

    // Roles use typography and labels for identity; color stays semantic.
    accentSoft: seed.accent,
    secondary: seed.muted,
    info: seed.accent,
    user: seed.textStrong,
    assistant: seed.accent,
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
    name: 'graphite',
    accent: '#7CC4E4',
    text: '#D6D9DE',
    textStrong: '#F4F5F7',
    muted: '#9AA3AD',
    dim: '#7B8590',
    border: '#3B424A',
    success: '#80C795',
    warning: '#D7B56D',
    error: '#E08585',
    selection: '#25313A',
    selectionText: '#F4F5F7',
    pendingSurface: '#202A31',
    successSurface: '#1E2D24',
    errorSurface: '#302122',
  }),
  cinder: defineTheme({
    name: 'cinder',
    accent: '#D6AD72',
    text: '#DBD7D1',
    textStrong: '#F6F2EC',
    muted: '#AAA39A',
    dim: '#837D76',
    border: '#4A4540',
    success: '#8FC38A',
    warning: '#E0A35E',
    error: '#DF7D82',
    selection: '#3A3128',
    selectionText: '#FFF8EE',
    pendingSurface: '#302922',
    successSurface: '#233027',
    errorSurface: '#342426',
  }),
  mono: defineTheme({
    name: 'mono',
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
    accent: '#B2B9F0',
    text: '#DDDDE5',
    textStrong: '#F6F5F8',
    muted: '#A09FAA',
    dim: '#7E7D8B',
    border: '#42414B',
    success: '#82C79B',
    warning: '#D8B773',
    error: '#E18A91',
    selection: '#2D2D3D',
    selectionText: '#F6F5F8',
    pendingSurface: '#292936',
    successSurface: '#202E26',
    errorSurface: '#322326',
  }),
  paper: defineTheme({
    name: 'paper',
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
  return environment.SKEIN_THEME_DIR ?? environment.MOSAIC_THEME_DIR ?? join(homedir(), '.mosaic', 'themes');
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
  return React.createElement(ThemeContext.Provider, {value: theme}, children);
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
