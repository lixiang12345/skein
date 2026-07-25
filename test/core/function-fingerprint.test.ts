import {describe, expect, it} from 'vitest';
import {
  extractFunctionFingerprints,
  fingerprintSimilarity,
} from '../../src/context/function-fingerprint.js';
import {auditChangedFunctions} from '../../src/agent/duplication-audit.js';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const body = (name: string, variable: string, literal: number, extra = '') => `
export function ${name}(input: number[]) {
  const ${variable} = [];
  for (const item of input) {
    if (item > ${literal}) {
      ${variable}.push(item * 2);
    } else {
      ${variable}.push(item + 1);
    }
  }
  const total = ${variable}.reduce((sum, item) => sum + item, 0);
  if (total < 0) throw new Error('invalid total');
  ${extra}
  return {values: ${variable}, total};
}
`;

const expandedBody = (name: string, variable: string) => body(name, variable, 10, `
  const normalized = ${variable}.map((item) => item < 0 ? Math.abs(item) : item);
  const unique = normalized.filter((item, index) => normalized.indexOf(item) === index);
  if (unique.length > 200) {
    unique.sort((left, right) => left - right);
  } else {
    unique.reverse();
  }
  const checksum = unique.reduce((sum, item) => sum + item, 0);
  if (checksum < 0) throw new Error('invalid checksum');
`);

function contentFree(fingerprint: NonNullable<ReturnType<typeof extractFunctionFingerprints>[number]>) {
  const {normalizedTokens: _tokens, ...value} = fingerprint;
  return value;
}

describe('function fingerprints', () => {
  it('normalizes renamed identifiers and literals into the same Type-2 hash', () => {
    const first = extractFunctionFingerprints('/repo/src/first.ts', body('first', 'values', 10))[0];
    const second = extractFunctionFingerprints('/repo/src/second.ts', body('second', 'output', 99))[0];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first?.exactHash).toBe(second?.exactHash);
    expect(fingerprintSimilarity(first!, second!)).toBe(1);
    expect(first?.normalizedTokens).toContain('LIT');
    expect(first?.normalizedTokens).toContain('ID');
  });

  it('finds an inserted-statement Type-3 near clone without promising semantic clones', () => {
    const first = extractFunctionFingerprints('/repo/src/first.ts', body('first', 'values', 10))[0];
    const changed = extractFunctionFingerprints('/repo/src/changed.ts', body(
      'changed', 'output', 12, 'const count = output.length; if (count > 100) return {values: output, total};',
    ))[0];
    const similarity = fingerprintSimilarity(first!, changed!);
    expect(similarity).toBeGreaterThanOrEqual(0.55);
    expect(similarity).toBeLessThan(1);
  });

  it('skips small functions, declarations, and fixture paths', () => {
    expect(extractFunctionFingerprints('/repo/src/small.ts', 'export function small() { return 1; }')).toEqual([]);
    expect(extractFunctionFingerprints('/repo/src/types.d.ts', body('declared', 'values', 1))).toEqual([]);
    expect(extractFunctionFingerprints('/repo/test/fixtures/copy.ts', body('fixture', 'values', 1))).toEqual([]);
  });

  it('extracts class methods without mistaking control flow for functions', () => {
    const source = `class Parser {
  private parseItems(input: number[]) {
    const values = [];
    for (const item of input) { if (item > 10) values.push(item * 2); else values.push(item + 1); }
    const total = values.reduce((sum, item) => sum + item, 0);
    if (total < 0) throw new Error('invalid');
    return {values, total};
  }
}`;
    const functions = extractFunctionFingerprints('/repo/src/parser.ts', source);
    expect(functions.map((item) => item.symbol)).toEqual(['parseItems']);
    expect(functions[0]?.startLine).toBe(2);
  });

  it('extracts block-bodied arrows but not expression arrows or top-level calls followed by blocks', () => {
    const blockArrow = body('transform', 'values', 10)
      .replace('export function transform(input: number[]) {', 'export const transform = (input: number[]) => {');
    const source = `${blockArrow}
const expression = (input: number[]) => input.map((item) => item * 2);
invoke(input)
{
  const values = input.map((item) => item * 2);
  if (values.length > 10) values.reverse();
  for (const item of values) console.log(item);
}
`;
    expect(extractFunctionFingerprints('/repo/src/arrows.ts', source).map((item) => item.symbol))
      .toEqual(['transform']);
  });

  it('reports the declaration line instead of the preceding newline', () => {
    const source = `const before = true;

${body('located', 'values', 10).trimStart()}`;
    expect(extractFunctionFingerprints('/repo/src/located.ts', source)[0]?.startLine).toBe(3);
  });

  it('creates a content-free warning receipt against the pre-write baseline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-duplicate-audit-'));
    try {
      const candidatePath = join(root, 'candidate.ts');
      const changedPath = join(root, 'changed.ts');
      const candidate = extractFunctionFingerprints(candidatePath, body('original', 'values', 10))[0]!;
      await writeFile(changedPath, body('copy', 'renamed', 42));
      const receipt = await auditChangedFunctions({
        baseline: {generation: 'g-before', functions: [contentFree(candidate)]},
        changedFiles: [changedPath],
        changeSequence: 1,
      });
      expect(receipt).toMatchObject({
        status: 'warning', warningOnly: true, baselineGeneration: 'g-before',
        matches: [{
          matchId: expect.stringMatching(/^[a-f0-9]{24}$/),
          kind: 'type-1-or-2', candidateSymbol: 'original', changedSymbol: 'copy',
        }],
      });
      expect(JSON.stringify(receipt)).not.toContain('invalid total');
      expect(JSON.stringify(receipt)).not.toContain('renamed');
      expect(JSON.stringify(receipt)).not.toContain('normalizedTokens');
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('compares a newly added function with an older helper in the same file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-duplicate-same-file-'));
    try {
      const path = join(root, 'helpers.ts');
      const original = body('original', 'values', 10);
      const baseline = extractFunctionFingerprints(path, original).map(contentFree);
      await writeFile(path, `${original}\n${body('parallel', 'output', 44)}`);
      const receipt = await auditChangedFunctions({
        baseline: {generation: 'same-file', functions: baseline},
        changedFiles: [path],
        changeSequence: 2,
      });
      expect(receipt).toMatchObject({
        status: 'warning', checkedFunctions: 1,
        matches: [{changedSymbol: 'parallel', candidateSymbol: 'original', similarity: 1}],
      });
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('keeps a moved original paired when its duplicate is inserted before it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-duplicate-insert-before-'));
    try {
      const path = join(root, 'helpers.ts');
      const original = body('original', 'values', 10);
      const baseline = extractFunctionFingerprints(path, original).map(contentFree);
      await writeFile(path, `${body('insertedCopy', 'output', 44)}\n${original}`);
      const receipt = await auditChangedFunctions({
        baseline: {generation: 'insert-before', functions: baseline},
        changedFiles: [path], changeSequence: 3,
      });
      expect(receipt).toMatchObject({
        status: 'warning', checkedFunctions: 1,
        matches: [{changedSymbol: 'insertedCopy', candidateSymbol: 'original'}],
      });
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('skips ordinary in-place edits and audits significant expansions against other functions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-duplicate-expansion-'));
    try {
      const path = join(root, 'editable.ts');
      const candidatePath = join(root, 'reference.ts');
      const original = body('editable', 'values', 10);
      const reference = expandedBody('reference', 'output');
      const baseline = [
        ...extractFunctionFingerprints(path, original).map(contentFree),
        ...extractFunctionFingerprints(candidatePath, reference).map(contentFree),
      ];

      await writeFile(path, body('editable', 'renamed', 99));
      await expect(auditChangedFunctions({
        baseline: {generation: 'ordinary-edit', functions: baseline},
        changedFiles: [path], changeSequence: 4,
      })).resolves.toBeUndefined();

      await writeFile(path, expandedBody('editable', 'values'));
      const expanded = await auditChangedFunctions({
        baseline: {generation: 'significant-expansion', functions: baseline},
        changedFiles: [path], changeSequence: 5,
      });
      expect(expanded).toMatchObject({
        status: 'warning', checkedFunctions: 1,
        matches: [{changedSymbol: 'editable', candidateSymbol: 'reference', similarity: 1}],
      });
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('does not warn for an in-place rename with an overlapping body', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-duplicate-rename-'));
    try {
      const path = join(root, 'rename.ts');
      const original = body('beforeRename', 'values', 10);
      const baseline = extractFunctionFingerprints(path, original).map(contentFree);
      await writeFile(path, body('afterRename', 'output', 99));
      await expect(auditChangedFunctions({
        baseline: {generation: 'rename', functions: baseline},
        changedFiles: [path], changeSequence: 6,
      })).resolves.toBeUndefined();
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('returns clear when an active warning path is rechecked after repair', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-duplicate-recheck-'));
    try {
      const path = join(root, 'repair.ts');
      const baseline = extractFunctionFingerprints(path, body('before', 'values', 10)).map(contentFree);
      await writeFile(path, body('before', 'values', 10, `
  const sorted = values.slice().sort((left, right) => left - right);
  const unique = sorted.filter((item, index) => sorted.indexOf(item) === index);
  if (unique.length > 100) unique.reverse();
  return {values: unique, total: unique.length};
`));
      const receipt = await auditChangedFunctions({
        baseline: {generation: 'repair', functions: baseline},
        changedFiles: [path], changeSequence: 11, recheckFunctions: new Set([`${path}\u0000before`]),
      });
      expect(receipt).toMatchObject({status: 'clear', checkedFunctions: 1, matches: []});
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('clears an active warning when its function is deleted or becomes small', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-duplicate-clear-small-'));
    try {
      const path = join(root, 'repair.ts');
      const baseline = extractFunctionFingerprints(path, body('before', 'values', 10)).map(contentFree);
      await writeFile(path, 'export function before() { return 1; }\n');
      await expect(auditChangedFunctions({
        baseline: {generation: 'small', functions: baseline},
        changedFiles: [path], changeSequence: 12,
        recheckPaths: new Set([path]), recheckFunctions: new Set([`${path}\u0000before`]),
      })).resolves.toMatchObject({status: 'clear', skippedSmallFunctions: 1});
      await rm(path);
      await expect(auditChangedFunctions({
        baseline: {generation: 'deleted', functions: baseline},
        changedFiles: [path], changeSequence: 13,
        recheckPaths: new Set([path]), recheckFunctions: new Set([`${path}\u0000before`]),
      })).resolves.toMatchObject({status: 'clear', checkedFunctions: 0});
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('emits unresolved only for an existing auditable function when the baseline is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-duplicate-unresolved-'));
    try {
      const path = join(root, 'new.ts');
      await writeFile(path, body('newFunction', 'values', 10));
      await expect(auditChangedFunctions({changedFiles: [path], changeSequence: 7}))
        .resolves.toMatchObject({status: 'unresolved', baselineGeneration: 'unavailable'});
      await rm(path);
      await expect(auditChangedFunctions({changedFiles: [path], changeSequence: 8}))
        .resolves.toBeUndefined();
      const small = join(root, 'small.ts');
      await writeFile(small, 'export function small() { return 1; }\n');
      await expect(auditChangedFunctions({changedFiles: [small], changeSequence: 9}))
        .resolves.toBeUndefined();
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('bounds receipts to eight highest-scoring matches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-duplicate-bounded-'));
    try {
      const candidatePath = join(root, 'candidate.ts');
      const changedPath = join(root, 'changed.ts');
      const candidate = contentFree(extractFunctionFingerprints(
        candidatePath, body('candidate', 'values', 10),
      )[0]!);
      await writeFile(changedPath, Array.from({length: 10}, (_, index) =>
        body(`copy${index}`, `values${index}`, index + 20)).join('\n'));
      const receipt = await auditChangedFunctions({
        baseline: {generation: 'bounded', functions: [candidate]},
        changedFiles: [changedPath], changeSequence: 10,
      });
      expect(receipt).toMatchObject({status: 'warning', checkedFunctions: 10});
      expect(receipt?.matches).toHaveLength(8);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('keeps structurally different and Type-4-equivalent fixtures below the Type-3 threshold', () => {
    const security = extractFunctionFingerprints('/repo/src/security.ts', `
export function authorize(records: Array<{owner: string; value: number}>, actor: string) {
  const accepted = [];
  for (const record of records) {
    if (record.owner !== actor) continue;
    if (!Number.isFinite(record.value)) throw new Error('invalid value');
    accepted.push({owner: record.owner, value: Math.max(0, record.value)});
  }
  if (!accepted.length) throw new Error('permission denied');
  return accepted;
}
`)[0]!;
    const formatting = extractFunctionFingerprints('/repo/src/formatting.ts', `
export function formatRows(rows: Array<{label: string; value: number}>) {
  return rows
    .map((row) => ({label: row.label.trim().toUpperCase(), value: String(row.value)}))
    .filter((row) => row.label.length > 0)
    .sort((left, right) => left.label.localeCompare(right.label))
    .reduce((output, row) => output.concat(row.label, row.value), [] as string[]);
}
`)[0]!;
    expect(fingerprintSimilarity(security, formatting)).toBeLessThan(0.55);

    const loop = extractFunctionFingerprints('/repo/src/loop.ts', body('sumLoop', 'values', 10))[0]!;
    const reduce = extractFunctionFingerprints('/repo/src/reduce.ts', `
export function sumReduce(input: number[]) {
  const normalized = input.map((item) => item > 10 ? item * 2 : item + 1);
  const total = normalized.reduce((sum, item) => sum + item, 0);
  const values = total < 0 ? normalized.map((item) => Math.abs(item)) : normalized;
  const stable = values.filter((item, index) => values.indexOf(item) === index);
  return {values: stable, total: stable.reduce((sum, item) => sum + item, 0)};
}
`)[0]!;
    expect(fingerprintSimilarity(loop, reduce)).toBeLessThan(0.55);
  });
});
