import {mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {ContextEngine} from '../../src/context/context-engine.js';
import {LocalContextIndex} from '../../src/context/local-index.js';
import {defaultConfig} from '../../src/config.js';

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
      expect(hits[0]?.source).toBe('local-bm25+path+symbol');
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
