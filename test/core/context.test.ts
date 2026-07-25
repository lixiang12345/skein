import {chmod, mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {ContextEngine, formatContextHits} from '../../src/context/context-engine.js';
import {LocalContextIndex} from '../../src/context/local-index.js';
import {defaultConfig} from '../../src/config.js';
import {runProcess} from '../../src/utils/process.js';

describe('local context engine', () => {
  it('indexes multilingual source and ranks exact symbols and paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-local-context-'));
    try {
      await mkdir(join(root, 'src'), {recursive: true});
      await writeFile(join(root, 'src', 'auth.ts'), 'export function verifySessionToken(token: string) { return Boolean(token); }\n');
      await writeFile(join(root, 'src', '配置.py'), 'def 验证会话(token):\n    return bool(token)\n');
      const config = defaultConfig(root);
      const engine = new ContextEngine(config);
      const hits = await engine.search('verifySessionToken');

      expect(hits[0]).toMatchObject({path: join(root, 'src', 'auth.ts'), symbol: 'verifySessionToken'});
      expect(hits[0]?.source).toBe('local-bm25+path+symbol+graph+recency+diagnostic');
      const chinese = await engine.search('验证会话');
      expect(chinese.some((hit) => hit.path.endsWith('配置.py'))).toBe(true);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('uses declaration-aware chunks for Unicode Python symbols', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-local-structure-'));
    try {
      await mkdir(join(root, 'src'), {recursive: true});
      const preamble = Array.from({length: 20}, (_, index) => `setting_${index} = ${index}`).join('\n');
      await writeFile(join(root, 'src', 'orders.py'), `${preamble}\n\ndef 处理订单(order):\n    return order\n`);
      const index = new LocalContextIndex([root]);
      const hits = await index.search('处理订单');

      expect(hits[0]).toMatchObject({
        path: join(root, 'src', 'orders.py'),
        symbol: '处理订单',
        startLine: 22,
      });
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('uses TypeScript AST import adjacency and exposes content-free score provenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-local-graph-'));
    try {
      await mkdir(join(root, 'src', 'security'), {recursive: true});
      await writeFile(join(root, 'src', 'security', 'token.ts'), [
        'export default function resolveCredentialEnvelope(value: string) {',
        "  return value.startsWith('credential_');",
        '}',
        '',
      ].join('\n'));
      await writeFile(join(root, 'src', 'middleware.ts'), [
        "import validate from './security/token.js';",
        'export function authorizeRequest(value: string) {',
        '  return validate(value);',
        '}',
        '',
      ].join('\n'));
      await writeFile(join(root, 'src', 'unrelated.ts'), 'export const unrelated = true;\n');
      const index = new LocalContextIndex([root]);

      const hits = await index.search('resolveCredentialEnvelope', 10);
      const definition = hits.find((hit) => hit.path.endsWith('/security/token.ts'));
      const caller = hits.find((hit) => hit.path.endsWith('/middleware.ts'));

      expect(definition?.provenance).toMatchObject({
        generation: expect.any(String),
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        score: {
          bm25: expect.any(Number), graph: expect.any(Number), recency: expect.any(Number),
          diagnostic: expect.any(Number),
          total: expect.any(Number),
        },
      });
      expect(caller?.provenance?.score.graph).toBeGreaterThan(0);
      expect(caller?.provenance?.matchedTerms).toEqual([]);
      expect(caller?.source).toBe('local-bm25+path+symbol+graph+recency+diagnostic');
      expect(formatContextHits(hits, [root])).toContain('graph=');
      expect(formatContextHits(hits, [root])).toContain('recency=');
      expect(formatContextHits(hits, [root])).toContain('diagnostic=');
      expect(formatContextHits(hits, [root])).toContain('hash=');

      if (definition?.provenance) definition.provenance.score.total = 0;
      const cached = await index.search('resolveCredentialEnvelope', 10);
      expect(cached.find((hit) => hit.path.endsWith('/security/token.ts'))?.provenance?.score.total)
        .toBeGreaterThan(0);
      expect(index.status()).toMatchObject({queryCacheEntries: 1, queryCacheHits: 1, queryCacheMisses: 1});

      await writeFile(join(root, 'src', 'security', 'token.ts'), [
        'export default function parseOpaqueInput(value: string) {',
        "  return value.startsWith('credential_');",
        '}',
        '',
      ].join('\n'));
      const refreshed = await index.search('resolveCredentialEnvelope', 10);
      expect(refreshed.every((hit) => !hit.path.endsWith('/middleware.ts'))).toBe(true);
      await expect(index.search('parseOpaqueInput', 10)).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({path: join(root, 'src', 'security', 'token.ts')}),
        expect.objectContaining({path: join(root, 'src', 'middleware.ts'), provenance: expect.objectContaining({
          score: expect.objectContaining({graph: expect.any(Number)}),
        })}),
      ]));
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('links Python module imports to matching definitions with a bounded graph score', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-local-python-graph-'));
    try {
      await mkdir(join(root, 'app', 'security'), {recursive: true});
      await writeFile(join(root, 'app', 'security', 'token.py'), [
        'def resolve_credential_envelope(value):',
        '    return value.startswith("credential_")',
        '',
      ].join('\n'));
      await writeFile(join(root, 'app', 'middleware.py'), [
        'from .security.token import resolve_credential_envelope as resolver',
        '',
        'def authorize_request(value):',
        '    return resolver(value)',
        '',
      ].join('\n'));
      const index = new LocalContextIndex([root]);

      const hits = await index.search('resolve credential envelope', 10);

      expect(hits).toEqual(expect.arrayContaining([
        expect.objectContaining({path: join(root, 'app', 'security', 'token.py')}),
        expect.objectContaining({
          path: join(root, 'app', 'middleware.py'),
          provenance: expect.objectContaining({score: expect.objectContaining({graph: expect.any(Number)})}),
        }),
      ]));
      expect(hits.find((hit) => hit.path.endsWith('/middleware.py'))?.provenance?.score.graph)
        .toBeGreaterThan(0);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('uses bounded Git recency only to break near-equal retrieval scores', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-local-recency-'));
    try {
      const older = join(root, 'a-older.ts');
      const recent = join(root, 'z-recent.ts');
      const content = 'export const recencyNeedle = true;\n';
      await runGit(root, ['init', '--quiet']);
      await writeFile(older, content);
      await runGit(root, ['add', 'a-older.ts']);
      await commit(root, 'older');
      await writeFile(recent, content);
      await runGit(root, ['add', 'z-recent.ts']);
      await commit(root, 'recent');
      const index = new LocalContextIndex([root]);

      const first = await index.search('recencyNeedle', 10);
      expect(first.map((hit) => hit.path)).toEqual([recent, older]);
      expect(first[0]?.provenance?.score.recency).toBe(0.001);
      expect(first[1]?.provenance?.score.recency).toBe(0.0005);
      await index.search('recencyNeedle', 10);
      expect(index.status()).toMatchObject({queryCacheHits: 1, queryCacheMisses: 1});

      await writeFile(join(root, '.gitignore'), 'ignored/\n');
      await runGit(root, ['add', '.gitignore']);
      await commit(root, 'ranking generation');
      const afterHeadChange = await index.search('recencyNeedle', 10);
      expect(afterHeadChange[0]?.provenance?.score.recency).toBeLessThan(0.001);
      expect(index.status()).toMatchObject({queryCacheHits: 1, queryCacheMisses: 2});
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('preserves lexical retrieval outside Git worktrees', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-local-recency-fallback-'));
    try {
      await writeFile(join(root, 'source.ts'), 'export const fallbackNeedle = true;\n');
      const index = new LocalContextIndex([root]);

      const hits = await index.search('fallbackNeedle');

      expect(hits).toHaveLength(1);
      expect(hits[0]?.provenance?.score.recency).toBe(0);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('never returns a Git-recent file for a query with no lexical or graph match', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-local-recency-noise-'));
    try {
      await runGit(root, ['init', '--quiet']);
      const recent = join(root, 'recent.ts');
      await writeFile(recent, 'export const unrelatedRecent = true;\n');
      await runGit(root, ['add', 'recent.ts']);
      await commit(root, 'recent');
      const index = new LocalContextIndex([root]);
      index.recordDiagnostics({commandKey: 'test', paths: [recent]});

      await expect(index.search('missingQueryTerm')).resolves.toEqual([]);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('ranks a current verification diagnostic without retaining it after that check clears', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-local-diagnostic-'));
    try {
      const ordinary = join(root, 'a-ordinary.ts');
      const diagnostic = join(root, 'z-diagnostic.ts');
      const content = 'export const diagnosticNeedle = true;\n';
      await writeFile(ordinary, content);
      await writeFile(diagnostic, content);
      const index = new LocalContextIndex([root]);
      await index.build();
      index.recordDiagnostics({commandKey: 'typecheck', paths: [diagnostic]});

      const ranked = await index.search('diagnosticNeedle', 10);
      expect(ranked.map((hit) => hit.path)).toEqual([diagnostic, ordinary]);
      expect(ranked[0]?.provenance?.score.diagnostic).toBe(0.05);
      expect(index.status()).toMatchObject({diagnosticHints: 1});

      index.recordDiagnostics({commandKey: 'typecheck', paths: []});
      expect(index.status()).toMatchObject({diagnosticHints: 0, queryCacheEntries: 0});
      const cleared = await index.search('diagnosticNeedle', 10);
      expect(cleared).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ordinary,
          provenance: expect.objectContaining({score: expect.objectContaining({diagnostic: 0})}),
        }),
        expect.objectContaining({
          path: diagnostic,
          provenance: expect.objectContaining({score: expect.objectContaining({diagnostic: 0})}),
        }),
      ]));
      index.resetDiagnostics();
      expect(index.status()).toMatchObject({diagnosticHints: 0});
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('does not execute repository Git helpers while collecting recency', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-local-recency-isolation-'));
    try {
      const marker = join(root, 'helper-ran');
      const helper = join(root, 'malicious-helper.sh');
      await runGit(root, ['init', '--quiet']);
      await writeFile(join(root, 'source.ts'), 'export const isolatedNeedle = true;\n');
      await runGit(root, ['add', 'source.ts']);
      await commit(root, 'initial');
      await writeFile(helper, `#!/bin/sh\nprintf ran > "${marker}"\n`);
      await chmod(helper, 0o700);
      await runGit(root, ['config', 'core.fsmonitor', helper]);
      await runGit(root, ['config', 'diff.skein.textconv', helper]);
      await writeFile(join(root, '.gitattributes'), '*.ts diff=skein\n');
      const index = new LocalContextIndex([root]);

      await expect(index.search('isolatedNeedle')).resolves.toHaveLength(1);
      await expect(stat(marker)).rejects.toMatchObject({code: 'ENOENT'});
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('preserves term frequency so repeated relevant text ranks above a single mention', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-local-frequency-'));
    try {
      await writeFile(join(root, 'a-single.ts'), 'export const value = "needle";\n');
      await writeFile(join(root, 'z-repeated.ts'), 'needle needle needle needle\n');
      const index = new LocalContextIndex([root]);

      const hits = await index.search('needle');
      expect(hits[0]?.path).toBe(join(root, 'z-repeated.ts'));
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('packs within the configured token budget and reports local provenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-local-pack-'));
    try {
      await writeFile(join(root, 'large.ts'), `${'export const value = "context";\n'.repeat(80)}`);
      const config = defaultConfig(root);
      const engine = new ContextEngine({...config, context: {...config.context, maxTokens: 40, topK: 4}});
      const packed = await engine.pack('context value');

      expect(packed.engine).toBe('local');
      expect(packed.estimatedTokens).toBeLessThanOrEqual(40);
      expect(packed.truncated).toBe(true);
      expect(packed.text).toContain('<code path="large.ts"');
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('keeps status local and does not probe an external executable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-local-status-'));
    try {
      const engine = new ContextEngine(defaultConfig(root));
      await expect(engine.status()).resolves.toMatchObject({selected: 'local', local: {available: false}});
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('prepares, reloads, and validates a new multilingual workspace index', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-local-prepare-'));
    try {
      await mkdir(join(root, 'src'), {recursive: true});
      await writeFile(join(root, 'src', 'greeting.ts'), 'export const greeting = "hello";\n');
      await writeFile(join(root, 'src', '问候.py'), '问候 = "你好"\n');
      const engine = new ContextEngine(defaultConfig(root));
      const phases: string[] = [];

      const result = await engine.prepare((progress) => phases.push(progress.phase));

      expect(result).toMatchObject({rebuilt: true, validated: true, files: 2, reused: 0});
      expect(result.chunks).toBeGreaterThanOrEqual(2);
      expect(phases[0]).toBe('inspect');
      expect(phases).toContain('scan');
      expect(phases).toContain('index');
      expect(phases).toContain('write');
      expect(phases).toContain('validate');
      expect(phases.at(-1)).toBe('done');
      await expect(engine.status()).resolves.toMatchObject({
        selected: 'local',
        local: {available: true, files: 2, chunks: result.chunks, generation: result.generation},
      });
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('validates and reuses an existing current index without rebuilding it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-local-prepare-existing-'));
    try {
      await writeFile(join(root, 'existing.ts'), 'export const existing = true;\n');
      const first = new ContextEngine(defaultConfig(root));
      const built = await first.prepare();
      const second = new ContextEngine(defaultConfig(root));
      const phases: string[] = [];

      const verified = await second.prepare((progress) => phases.push(progress.phase));

      expect(verified).toMatchObject({
        rebuilt: false,
        validated: true,
        reused: 1,
        generation: built.generation,
      });
      expect(phases[0]).toBe('inspect');
      expect(phases).not.toContain('scan');
      expect(phases.filter((phase) => phase === 'validate').length).toBeGreaterThanOrEqual(2);
      expect(phases.at(-1)).toBe('done');
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('treats an empty workspace as a valid prepared index', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-local-prepare-empty-'));
    try {
      const engine = new ContextEngine(defaultConfig(root));
      await expect(engine.prepare()).resolves.toMatchObject({
        rebuilt: true,
        validated: true,
        files: 0,
        chunks: 0,
        generation: expect.any(String),
      });
      await expect(engine.search('anything')).resolves.toEqual([]);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('rebuilds an index whose persisted chunks were tampered with', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-local-prepare-tampered-'));
    try {
      await writeFile(join(root, 'safe.ts'), 'export const safe = true;\n');
      const first = new ContextEngine(defaultConfig(root));
      await first.prepare();
      const parsed = JSON.parse(await readFile(first.local.indexPath, 'utf8')) as {
        files: Array<{chunks: Array<{content: string; tokens: string[]}>}>;
      };
      const chunk = parsed.files[0]?.chunks[0];
      expect(chunk).toBeDefined();
      if (!chunk) throw new Error('Expected fixture chunk');
      chunk.content = 'fabricated';
      chunk.tokens = ['fabricated'];
      await writeFile(first.local.indexPath, `${JSON.stringify(parsed)}\n`);

      const second = new ContextEngine(defaultConfig(root));
      const phases: string[] = [];
      const result = await second.prepare((progress) => phases.push(progress.phase));

      expect(result.rebuilt).toBe(true);
      expect(phases).toContain('scan');
      await expect(second.search('fabricated')).resolves.toEqual([]);
      await expect(second.search('safe')).resolves.toEqual([
        expect.objectContaining({content: 'export const safe = true;\n'}),
      ]);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('invalidates cached hits when same-size content changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-local-freshness-'));
    try {
      const path = join(root, 'token.ts');
      const original = 'export function oldToken() { return "old"; }\n';
      const replacement = 'export function newToken() { return "new"; }\n';
      expect(replacement).toHaveLength(original.length);
      await writeFile(path, original);
      const index = new LocalContextIndex([root]);
      await index.build();
      await expect(index.search('oldToken')).resolves.toHaveLength(1);
      expect(index.status().queryCacheEntries).toBe(1);

      const before = await stat(path);
      await writeFile(path, replacement);
      await utimes(path, before.atime, before.mtime);

      const afterChange = await index.search('oldToken');
      expect(afterChange.every((hit) => !hit.content.includes('oldToken'))).toBe(true);
      await expect(index.search('newToken')).resolves.toEqual([
        expect.objectContaining({symbol: 'newToken'}),
      ]);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('reconciles hashes before accepting zero hits with unchanged size and mtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-local-zero-hit-freshness-'));
    try {
      const path = join(root, 'token.ts');
      const original = 'export function oldToken() { return "old"; }\n';
      const replacement = 'export function newToken() { return "new"; }\n';
      expect(replacement).toHaveLength(original.length);
      await writeFile(path, original);
      const index = new LocalContextIndex([root]);
      await index.build();

      const before = await stat(path);
      await writeFile(path, replacement);
      await utimes(path, before.atime, before.mtime);

      await expect(index.search('newToken')).resolves.toEqual([
        expect.objectContaining({path, symbol: 'newToken'}),
      ]);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('flushes known create, update, and delete paths into the persisted index', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-local-targeted-refresh-'));
    try {
      const existing = join(root, 'existing.ts');
      const created = join(root, 'created.ts');
      await writeFile(existing, 'export const beforeRefresh = true;\n');
      const index = new LocalContextIndex([root]);
      await index.build();

      await writeFile(existing, 'export const afterRefreshX = true;\n');
      await writeFile(created, 'export const createdByTool = true;\n');
      index.invalidate([existing, created]);
      expect(index.status()).toMatchObject({refreshState: 'dirty', dirtyPaths: 2});
      await expect(index.flushDirty()).resolves.toMatchObject({paths: 2, generation: expect.any(String)});
      expect(index.status()).toMatchObject({refreshState: 'current', dirtyPaths: 0});
      await expect(index.search('afterRefreshX')).resolves.toEqual([
        expect.objectContaining({path: existing, symbol: 'afterRefreshX'}),
      ]);
      await expect(index.search('createdByTool')).resolves.toEqual([
        expect.objectContaining({path: created, symbol: 'createdByTool'}),
      ]);

      await rm(created);
      index.invalidate([created]);
      await expect(index.flushDirty()).resolves.toMatchObject({paths: 1});
      await expect(index.search('createdByTool')).resolves.toEqual([]);

      const reloaded = new LocalContextIndex([root]);
      await expect(reloaded.load()).resolves.toBe(true);
      await expect(reloaded.search('afterRefreshX')).resolves.toHaveLength(1);
      await expect(reloaded.search('createdByTool')).resolves.toEqual([]);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('builds content-free function fingerprints from the current index generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-local-functions-'));
    try {
      const content = `export function reusable(input: number[]) {
  const values = [];
  for (const item of input) { if (item > 10) values.push(item * 2); else values.push(item + 1); }
  const total = values.reduce((sum, item) => sum + item, 0);
  if (total < 0) throw new Error('secret error text');
  return {values, total};
}\n`;
      const path = join(root, 'reusable.ts');
      await writeFile(path, content);
      const index = new LocalContextIndex([root]);
      const built = await index.build();
      const baseline = await index.functionFingerprints();
      expect(baseline).toMatchObject({
        generation: built.generation,
        functions: [{path, symbol: 'reusable', exactHash: expect.stringMatching(/^[a-f0-9]{64}$/)}],
      });
      expect(JSON.stringify(baseline)).not.toContain('secret error text');
      expect(JSON.stringify(baseline)).not.toContain('const values');
      baseline.functions[0]!.fingerprints.length = 0;
      const cached = await index.functionFingerprints();
      expect(cached.functions[0]?.fingerprints.length).toBeGreaterThan(0);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('reconstructs function baselines across overlapping chunks and trailing newlines', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-local-functions-large-'));
    try {
      const functionBody = Array.from({length: 135}, (_, index) =>
        `  if (input[${index}] !== undefined) values.push(input[${index}] * 2);`).join('\n');
      const content = `export function spanning(input: number[]) {
  const values: number[] = [];
${functionBody}
  return values.reduce((sum, item) => sum + item, 0);
}\n`;
      const path = join(root, 'spanning.ts');
      await writeFile(path, content);
      const index = new LocalContextIndex([root]);
      const built = await index.build();
      expect(built.chunks).toBeGreaterThan(1);
      const baseline = await index.functionFingerprints();
      expect(baseline.functions).toMatchObject([{
        path, symbol: 'spanning', startLine: 1, endLine: 139,
      }]);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('invalidates the fingerprint cache after targeted update and deletion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-local-functions-refresh-'));
    try {
      const path = join(root, 'refresh.ts');
      const source = (symbol: string) => `export function ${symbol}(input: number[]) {
  const values = [];
  for (const item of input) { if (item > 10) values.push(item * 2); else values.push(item + 1); }
  const total = values.reduce((sum, item) => sum + item, 0);
  if (total < 0) throw new Error('invalid total');
  return {values, total};
}\n`;
      await writeFile(path, source('beforeRefresh'));
      const index = new LocalContextIndex([root]);
      const built = await index.build();
      expect((await index.functionFingerprints()).functions.map((item) => item.symbol))
        .toEqual(['beforeRefresh']);

      await writeFile(path, source('afterRefresh'));
      index.invalidate([path]);
      const refreshed = await index.functionFingerprints();
      expect(refreshed.generation).not.toBe(built.generation);
      expect(refreshed.functions.map((item) => item.symbol)).toEqual(['afterRefresh']);

      await rm(path);
      index.invalidate([path]);
      const deleted = await index.functionFingerprints();
      expect(deleted.generation).not.toBe(refreshed.generation);
      expect(deleted.functions).toEqual([]);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('refreshes the manifest when a matching file is added', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-local-manifest-'));
    try {
      await writeFile(join(root, 'existing.ts'), 'export const existing = true;\n');
      const index = new LocalContextIndex([root]);
      await index.build();
      await writeFile(join(root, 'new-feature.ts'), 'export function newlyAddedFeature() { return true; }\n');

      await expect(index.search('newlyAddedFeature')).resolves.toEqual([
        expect.objectContaining({path: join(root, 'new-feature.ts'), symbol: 'newlyAddedFeature'}),
      ]);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('filters out-of-workspace entries from a tampered local index', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-local-boundary-'));
    try {
      await writeFile(join(root, 'safe.ts'), 'export const safe = true;\n');
      const index = new LocalContextIndex([root]);
      await index.build();
      const parsed = JSON.parse(await readFile(index.indexPath, 'utf8')) as {files: unknown[]};
      parsed.files.push({
        path: '../secret.ts',
        root,
        absolutePath: join(root, '..', 'secret.ts'),
        mtimeMs: 0,
        size: 1,
        contentHash: '0'.repeat(64),
        chunks: [],
        definitions: [],
        references: [],
        imports: [],
      });
      await writeFile(index.indexPath, `${JSON.stringify(parsed)}\n`);

      const reloaded = new LocalContextIndex([root]);
      await expect(reloaded.load()).resolves.toBe(true);
      expect(reloaded.status().files).toBe(1);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('rejects fabricated chunk content even when the stored file hash is valid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-local-tampered-chunk-'));
    try {
      await writeFile(join(root, 'safe.ts'), 'export const safe = true;\n');
      const index = new LocalContextIndex([root]);
      await index.build();
      const parsed = JSON.parse(await readFile(index.indexPath, 'utf8')) as {
        files: Array<{chunks: Array<{content: string; tokens: string[]}>}>;
      };
      const chunk = parsed.files[0]?.chunks[0];
      expect(chunk).toBeDefined();
      if (!chunk) throw new Error('Expected fixture chunk');
      chunk.content = 'fabricatedpayload';
      chunk.tokens = ['fabricatedpayload'];
      await writeFile(index.indexPath, `${JSON.stringify(parsed)}\n`);

      const reloaded = new LocalContextIndex([root]);
      await expect(reloaded.search('fabricatedpayload')).resolves.toEqual([]);
      await expect(reloaded.search('safe')).resolves.toEqual([
        expect.objectContaining({content: 'export const safe = true;\n'}),
      ]);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });
});

async function commit(root: string, message: string): Promise<void> {
  await runGit(root, [
    '-c', 'user.name=Skein Test',
    '-c', 'user.email=skein@example.test',
    'commit', '--quiet', '-m', message,
  ]);
}

async function runGit(root: string, args: string[]): Promise<string> {
  const result = await runProcess('git', args, {cwd: root, timeoutMs: 30_000});
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `git exited ${result.exitCode}`);
  }
  return result.stdout;
}
