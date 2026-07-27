type TerminalEnvironment = Readonly<Record<string, string | undefined>>;

export interface KittyKeyboardConfig {
  mode: 'enabled' | 'disabled';
  flags: ['disambiguateEscapeCodes'];
}

export interface TerminalAccessibilityConfig {
  screenReader: boolean;
  reducedMotion: boolean;
  ascii: boolean;
  color: boolean;
  incrementalRendering: boolean;
}

export type TerminalMouseInput = 'wheel-up' | 'wheel-down' | 'other';

/** Parse SGR mouse reports after Ink has removed their leading Escape byte. */
export function parseTerminalMouseInput(value: string): TerminalMouseInput | undefined {
  const match = value.match(/^\[<(\d+);\d+;\d+[Mm]$/u);
  if (!match?.[1]) return undefined;
  const button = Number(match[1]);
  if (!Number.isInteger(button) || (button & 64) === 0) return 'other';
  return (button & 1) === 0 ? 'wheel-up' : 'wheel-down';
}

/** Resolve deterministic low-capability and assistive terminal behavior. */
export function resolveTerminalAccessibility(
  environment: TerminalEnvironment = process.env,
): TerminalAccessibilityConfig {
  const screenReader = truthy(environment.SKEIN_SCREEN_READER) ||
    environment.INK_SCREEN_READER?.trim().toLowerCase() === 'true';
  const dumb = environment.TERM?.trim().toLowerCase() === 'dumb';
  const reducedMotion = screenReader || dumb || truthy(environment.SKEIN_REDUCE_MOTION);
  const ascii = screenReader || dumb ||
    environment.SKEIN_GLYPHS === 'ascii' || environment.MOSAIC_GLYPHS === 'ascii';
  const color = !screenReader && !dumb && environment.NO_COLOR === undefined;
  return {
    screenReader,
    reducedMotion,
    ascii,
    color,
    incrementalRendering: !screenReader && !dumb,
  };
}

/**
 * Avoid Ink's active capability probe on unknown terminals. Some terminal and
 * PTY combinations echo the probe response into the visible session before
 * raw input is established, so enhanced keys are enabled only when support is
 * known or the user explicitly opts in.
 */
export function resolveKittyKeyboardConfig(
  environment: TerminalEnvironment = process.env,
): KittyKeyboardConfig {
  const override = environment.SKEIN_KITTY_KEYBOARD?.trim().toLowerCase();
  if (override && ['1', 'true', 'yes', 'on', 'enabled'].includes(override)) {
    return enabledKittyKeyboard();
  }
  if (override && ['0', 'false', 'no', 'off', 'disabled'].includes(override)) {
    return disabledKittyKeyboard();
  }

  const term = environment.TERM?.toLowerCase() ?? '';
  const termProgram = environment.TERM_PROGRAM?.toLowerCase() ?? '';
  const supported = Boolean(
    environment.KITTY_WINDOW_ID ||
    environment.WEZTERM_PANE ||
    environment.GHOSTTY_RESOURCES_DIR ||
    ['kitty', 'wezterm', 'ghostty'].includes(termProgram) ||
    /(^|-)kitty($|-)/u.test(term) ||
    /^foot(?:-|$)/u.test(term),
  );
  return supported ? enabledKittyKeyboard() : disabledKittyKeyboard();
}

function enabledKittyKeyboard(): KittyKeyboardConfig {
  return {mode: 'enabled', flags: ['disambiguateEscapeCodes']};
}

function disabledKittyKeyboard(): KittyKeyboardConfig {
  return {mode: 'disabled', flags: ['disambiguateEscapeCodes']};
}

function truthy(value: string | undefined): boolean {
  return value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}
