/**
 * Detect a single-word prompt that is probably a mistyped subcommand.
 *
 * Free text is always a legitimate prompt, so callers must only hint on
 * stderr and never block the run.
 */
export function suggestCommandForPrompt(prompt: string, commands: readonly string[]): string | undefined {
  const token = prompt.trim();
  if (!/^[a-z][a-z0-9-]*$/iu.test(token)) return undefined;
  const lower = token.toLowerCase();
  let best: {command: string; distance: number} | undefined;
  for (const command of commands) {
    const target = command.toLowerCase();
    const limit = Math.max(lower.length, target.length) >= 5 ? 2 : 1;
    const distance = editDistance(lower, target, limit, true);
    if (distance > limit) continue;
    // A three-letter token one substitution away from a command is usually a
    // real word ("map"), not a typo; transpositions and length changes stay.
    if (
      lower.length <= 3 && lower.length === target.length &&
      distance === 1 && editDistance(lower, target, limit, false) === 1
    ) continue;
    if (!best || distance < best.distance) best = {command, distance};
  }
  return best?.command;
}

/** Bounded Damerau-Levenshtein distance; transpositions optional. */
function editDistance(a: string, b: string, limit: number, transpositions: boolean): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let beforePrevious: number[] = [];
  let previous: number[] = Array.from({length: b.length + 1}, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current: number[] = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const deletion = (previous[j] ?? Infinity) + 1;
      const insertion = (current[j - 1] ?? Infinity) + 1;
      const substitution = (previous[j - 1] ?? Infinity) + (a[i - 1] === b[j - 1] ? 0 : 1);
      let value = Math.min(deletion, insertion, substitution);
      if (transpositions && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, (beforePrevious[j - 2] ?? Infinity) + 1);
      }
      current[j] = value;
    }
    if (Math.min(...current) > limit) return limit + 1;
    beforePrevious = previous;
    previous = current;
  }
  return previous[b.length] ?? limit + 1;
}
