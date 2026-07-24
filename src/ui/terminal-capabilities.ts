type TerminalEnvironment = Readonly<Record<string, string | undefined>>;

export interface KittyKeyboardConfig {
  mode: 'enabled' | 'disabled';
  flags: ['disambiguateEscapeCodes'];
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
