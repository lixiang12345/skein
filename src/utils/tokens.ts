/**
 * Portable token estimate for provider-neutral budgeting.
 *
 * This deliberately remains a conservative heuristic: providers do not share
 * one tokenizer, and compatible endpoints often do not expose theirs. The
 * estimate is suitable for local caps and telemetry, never billing claims.
 */
export function estimateTokens(value: string): number {
  let tokens = 0;
  for (const character of value) tokens += estimatedTokenCost(character);
  return Math.ceil(tokens - Number.EPSILON * Math.max(1, value.length) * 32);
}

export function estimatedTokenCost(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0;
  if (codePoint <= 0x7f) return 0.25;
  if (isEmojiOrSupplementarySymbol(character, codePoint)) return 2;
  if (/^[\p{P}\p{S}]$/u.test(character)) return 0.5;
  if (isCjkCharacter(codePoint)) return 1;
  // Accented Latin, Cyrillic, Arabic, and other scripts vary substantially
  // between tokenizers. Two tokens per code point is a conservative ceiling.
  return 2;
}

export function sliceStartByTokens(value: string, budget: number): string {
  if (budget <= 0) return '';
  let used = 0;
  let end = 0;
  for (const character of value) {
    const cost = estimatedTokenCost(character);
    if (used + cost > budget) break;
    used += cost;
    end += character.length;
  }
  return value.slice(0, end);
}

export function sliceEndByTokens(value: string, budget: number): string {
  if (budget <= 0) return '';
  let used = 0;
  let start = value.length;
  while (start > 0) {
    let next = start - 1;
    const code = value.charCodeAt(next);
    if (code >= 0xdc00 && code <= 0xdfff && next > 0) {
      const previous = value.charCodeAt(next - 1);
      if (previous >= 0xd800 && previous <= 0xdbff) next -= 1;
    }
    const character = value.slice(next, start);
    const cost = estimatedTokenCost(character);
    if (used + cost > budget) break;
    used += cost;
    start = next;
  }
  return value.slice(start);
}

function isCjkCharacter(codePoint: number): boolean {
  return (codePoint >= 0x2e80 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x20000 && codePoint <= 0x2fa1f) ||
    (codePoint >= 0x3040 && codePoint <= 0x30ff);
}

function isEmojiOrSupplementarySymbol(character: string, codePoint: number): boolean {
  return codePoint > 0xffff || /\p{Extended_Pictographic}/u.test(character);
}
