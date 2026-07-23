import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';

const controlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;

// Terminals answer capability probes (device attributes, cursor position, the
// Kitty keyboard protocol) by writing CSI sequences back to stdin — e.g.
// `[?0u`. Two things leak them into text: stripAnsi misses some private
// `?...`-parameter responses, and Ink consumes the leading ESC as an Escape
// key before delivering the `[?0u` tail to the composer. Strip both forms —
// any ESC-introduced CSI sequence, and a stray CSI tail that kept a private
// marker (`?`, `>`, `=`) after losing its ESC — before removing lone control
// characters. The private-marker requirement keeps ordinary text like
// `[note]` or `array[i]` intact.
const escapeSequences = /[[\]][0-9;?=>!]*[ -/]*[@-~]|[[\]][?=>][0-9;?=>!]*[a-zA-Z~]/gu;

/** Remove escape/control sequences before untrusted model or tool text reaches the terminal. */
export function sanitizeTerminalText(value: string): string {
  return stripAnsi(value)
    .replace(escapeSequences, '')
    .replace(/\r\n?/g, '\n')
    .replace(controlCharacters, '');
}

export function terminalEllipsis(): string {
  return process.env.SKEIN_GLYPHS === 'ascii' || process.env.MOSAIC_GLYPHS === 'ascii'
    ? '...'
    : '…';
}

export function displayWidth(value: string): number {
  return stringWidth(value);
}

export function truncateDisplay(value: string, maxWidth: number, ellipsis = terminalEllipsis()): string {
  if (maxWidth <= 0) return '';
  if (displayWidth(value) <= maxWidth) return value;
  const ellipsisWidth = displayWidth(ellipsis);
  if (maxWidth <= ellipsisWidth) return sliceDisplay(ellipsis, maxWidth);
  return `${sliceDisplay(value, maxWidth - ellipsisWidth)}${ellipsis}`;
}

export function sliceDisplay(value: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  let width = 0;
  let output = '';
  for (const segment of graphemes(value)) {
    const segmentWidth = displayWidth(segment);
    if (width + segmentWidth > maxWidth) break;
    output += segment;
    width += segmentWidth;
  }
  return output;
}

export function compactDisplayPath(path: string, maxWidth = 54): string {
  if (displayWidth(path) <= maxWidth) return path;
  const parts = path.split('/').filter(Boolean);
  const name = parts.at(-1) ?? path;
  const parent = parts.at(-2);
  const tail = parent ? `${parent}/${name}` : name;
  const ellipsis = terminalEllipsis();
  const ellipsisWidth = displayWidth(ellipsis);
  if (displayWidth(tail) <= maxWidth - ellipsisWidth - 1) return `${ellipsis}/${tail}`;
  return `${ellipsis}${sliceDisplayFromEnd(tail, maxWidth - ellipsisWidth)}`;
}

/** Bound verbose transcript output without cutting a Unicode grapheme. */
export function limitTerminalText(value: string, maxLines = 80, maxChars = 24_000): {
  text: string;
  truncated: boolean;
} {
  const normalized = sanitizeTerminalText(value);
  const characterLimitedText = sliceCodeUnitsAtGraphemeBoundary(normalized, maxChars);
  const characterLimited = characterLimitedText.length < normalized.length
    ? `${characterLimitedText}\n${terminalEllipsis()}`
    : normalized;
  const lines = characterLimited.split('\n');
  if (lines.length <= maxLines && normalized.length <= maxChars) {
    return {text: characterLimited, truncated: false};
  }
  return {
    text: `${lines.slice(0, maxLines).join('\n')}\n${terminalEllipsis()}`,
    truncated: true,
  };
}

function sliceCodeUnitsAtGraphemeBoundary(value: string, maxCodeUnits: number): string {
  if (maxCodeUnits <= 0) return '';
  let used = 0;
  let output = '';
  for (const segment of graphemes(value)) {
    if (used + segment.length > maxCodeUnits) break;
    output += segment;
    used += segment.length;
  }
  return output;
}

export function sliceDisplayFromEnd(value: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  const segments = graphemes(value);
  let width = 0;
  let output = '';
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index] as string;
    const segmentWidth = displayWidth(segment);
    if (width + segmentWidth > maxWidth) break;
    output = `${segment}${output}`;
    width += segmentWidth;
  }
  return output;
}

function graphemes(value: string): string[] {
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'});
    return [...segmenter.segment(value)].map((item) => item.segment);
  }
  return [...value];
}
