import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {
  DuplicationAuditReceipt,
  DuplicationBaseline,
  FunctionFingerprint,
} from '../types.js';
import {
  extractFunctionFingerprintReport,
  extractFunctionFingerprints,
  fingerprintSimilarity,
  supportsFunctionFingerprintPath,
} from '../context/function-fingerprint.js';

const NEAR_CLONE_THRESHOLD = 0.55;
const MAX_MATCHES = 8;

export async function auditChangedFunctions(input: {
  baseline?: DuplicationBaseline;
  changedFiles: string[];
  changeSequence: number;
  recheckFunctions?: ReadonlySet<string>;
  recheckPaths?: ReadonlySet<string>;
}): Promise<DuplicationAuditReceipt | undefined> {
  const auditableFiles = input.changedFiles.filter(supportsFunctionFingerprintPath);
  if (!auditableFiles.length) return undefined;
  const reports: ReturnType<typeof extractFunctionFingerprintReport>[] = [];
  let skippedSmallFunctions = 0;
  try {
    for (const path of auditableFiles) {
      let content: string;
      try {
        content = await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const report = extractFunctionFingerprintReport(path, content);
      skippedSmallFunctions += report.skippedSmallFunctions;
      reports.push(report);
    }
  } catch {
    return unresolved(input.changeSequence, input.baseline?.generation);
  }

  const currentFunctions = reports.flatMap((report) => report.functions.map(withoutTokens));
  if (!currentFunctions.length) {
    return auditableFiles.some((path) => input.recheckPaths?.has(path)) && input.baseline
      ? clear(input.baseline.generation, input.changeSequence, skippedSmallFunctions)
      : undefined;
  }
  if (!input.baseline) return unresolved(input.changeSequence);
  const lookup = createBaselineLookup(input.baseline.functions);
  const previousByCurrent = matchCurrentFunctions(input.baseline.functions, currentFunctions);
  const added = currentFunctions.flatMap((current) => {
    const previous = previousByCurrent.get(locationIdentity(current));
    const recheck = input.recheckFunctions?.has(identity(current)) ||
      (previous !== undefined && input.recheckFunctions?.has(identity(previous)));
    return !previous || current.tokenCount >= previous.tokenCount * 1.5 || recheck
      ? [{current, previous}]
      : [];
  });

  if (!added.length) return undefined;
  const matches: DuplicationAuditReceipt['matches'] = [];
  for (const {current: item, previous} of added) {
    let best: {candidate: FunctionFingerprint; similarity: number} | undefined;
    for (const candidate of findCandidateFunctions(lookup, item)) {
      if (previous && locationIdentity(candidate) === locationIdentity(previous)) continue;
      const similarity = fingerprintSimilarity(item, candidate);
      if (similarity < NEAR_CLONE_THRESHOLD || (best && best.similarity >= similarity)) continue;
      best = {candidate, similarity};
    }
    if (!best) continue;
    matches.push({
      matchId: matchId(input.baseline.generation, input.changeSequence, item, best.candidate, best.similarity),
      changedPath: item.path,
      changedSymbol: item.symbol,
      candidatePath: best.candidate.path,
      candidateSymbol: best.candidate.symbol,
      kind: best.similarity === 1 ? 'type-1-or-2' : 'type-3',
      similarity: round(best.similarity),
    });
  }
  matches.sort((left, right) => right.similarity - left.similarity ||
    left.changedPath.localeCompare(right.changedPath));
  const bounded = matches.slice(0, MAX_MATCHES);
  return {
    baselineGeneration: input.baseline.generation,
    changeSequence: input.changeSequence,
    status: bounded.length ? 'warning' : 'clear',
    warningOnly: true,
    checkedFunctions: added.length,
    skippedSmallFunctions,
    matches: bounded,
    rationale: bounded.length
      ? `${bounded.length} deterministic duplicate candidate${bounded.length === 1 ? '' : 's'} found; review for reuse.`
      : 'No deterministic duplicate candidate exceeded the warning threshold.',
  };
}

function clear(
  baselineGeneration: string,
  changeSequence: number,
  skippedSmallFunctions: number,
): DuplicationAuditReceipt {
  return {
    baselineGeneration,
    changeSequence,
    status: 'clear',
    warningOnly: true,
    checkedFunctions: 0,
    skippedSmallFunctions,
    matches: [],
    rationale: 'No active deterministic duplicate candidate remains on the rechecked path.',
  };
}

function withoutTokens(value: ReturnType<typeof extractFunctionFingerprints>[number]): FunctionFingerprint {
  const {normalizedTokens: _tokens, ...fingerprint} = value;
  return fingerprint;
}

function identity(value: Pick<FunctionFingerprint, 'path' | 'symbol'>): string {
  return `${value.path}\u0000${value.symbol}`;
}

function locationIdentity(value: FunctionFingerprint): string {
  return `${identity(value)}\u0000${value.startLine}\u0000${value.endLine}`;
}

interface BaselineLookup {
  byIdentity: Map<string, FunctionFingerprint[]>;
  byPath: Map<string, FunctionFingerprint[]>;
  byExactHash: Map<string, FunctionFingerprint[]>;
  byFingerprint: Map<string, FunctionFingerprint[]>;
}

function createBaselineLookup(functions: FunctionFingerprint[]): BaselineLookup {
  const lookup: BaselineLookup = {
    byIdentity: new Map(),
    byPath: new Map(),
    byExactHash: new Map(),
    byFingerprint: new Map(),
  };
  for (const item of functions) {
    appendLookup(lookup.byIdentity, identity(item), item);
    appendLookup(lookup.byPath, item.path, item);
    appendLookup(lookup.byExactHash, item.exactHash, item);
    for (const fingerprint of new Set(item.fingerprints)) {
      appendLookup(lookup.byFingerprint, fingerprint, item);
    }
  }
  return lookup;
}

function appendLookup(
  lookup: Map<string, FunctionFingerprint[]>,
  key: string,
  item: FunctionFingerprint,
): void {
  const values = lookup.get(key);
  if (values) values.push(item);
  else lookup.set(key, [item]);
}

function findCandidateFunctions(
  lookup: BaselineLookup,
  current: FunctionFingerprint,
): FunctionFingerprint[] {
  const exact = lookup.byExactHash.get(current.exactHash);
  if (exact?.length) return exact;
  const candidates = new Map<string, FunctionFingerprint>();
  for (const fingerprint of new Set(current.fingerprints)) {
    for (const candidate of lookup.byFingerprint.get(fingerprint) ?? []) {
      candidates.set(locationIdentity(candidate), candidate);
    }
  }
  return [...candidates.values()];
}

function matchCurrentFunctions(
  baseline: FunctionFingerprint[],
  current: FunctionFingerprint[],
): Map<string, FunctionFingerprint> {
  const matches = new Map<string, FunctionFingerprint>();
  const available = new Map(baseline.map((item) => [locationIdentity(item), item]));
  assignMatches(current, matches, available, (item) => [...available.values()].filter((candidate) =>
    identity(candidate) === identity(item) && linesOverlap(candidate, item)), false);
  assignMatches(current, matches, available, (item) => [...available.values()].filter((candidate) =>
    identity(candidate) === identity(item)), true);
  assignMatches(current, matches, available, (item) => [...available.values()].filter((candidate) =>
    candidate.path === item.path && linesOverlap(candidate, item)), true);
  return matches;
}

function assignMatches(
  current: FunctionFingerprint[],
  matches: Map<string, FunctionFingerprint>,
  available: Map<string, FunctionFingerprint>,
  candidatesFor: (item: FunctionFingerprint) => FunctionFingerprint[],
  requireSimilarity: boolean,
): void {
  for (const item of current) {
    const currentId = locationIdentity(item);
    if (matches.has(currentId)) continue;
    let best: {candidate: FunctionFingerprint; similarity: number} | undefined;
    for (const candidate of candidatesFor(item)) {
      const similarity = fingerprintSimilarity(candidate, item);
      if (!best || similarity > best.similarity) best = {candidate, similarity};
    }
    if (!best || (requireSimilarity && best.similarity < NEAR_CLONE_THRESHOLD)) continue;
    matches.set(currentId, best.candidate);
    available.delete(locationIdentity(best.candidate));
  }
}

function linesOverlap(left: FunctionFingerprint, right: FunctionFingerprint): boolean {
  return Math.max(left.startLine, right.startLine) <= Math.min(left.endLine, right.endLine);
}

function unresolved(changeSequence: number, generation = 'unavailable'): DuplicationAuditReceipt {
  return {
    baselineGeneration: generation,
    changeSequence,
    status: 'unresolved',
    warningOnly: true,
    checkedFunctions: 0,
    skippedSmallFunctions: 0,
    matches: [],
    rationale: 'Duplication evidence is incomplete; the write remains allowed in warning-only mode.',
  };
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function matchId(
  generation: string,
  changeSequence: number,
  changed: FunctionFingerprint,
  candidate: FunctionFingerprint,
  similarity: number,
): string {
  return createHash('sha256').update([
    generation,
    String(changeSequence),
    changed.path,
    changed.symbol,
    candidate.path,
    candidate.symbol,
    similarity === 1 ? 'type-1-or-2' : 'type-3',
  ].join('\u0000')).digest('hex').slice(0, 24);
}
