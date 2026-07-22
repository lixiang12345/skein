import {access, chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {ContextEngine, mapExternalPath} from '../../src/context/context-engine.js';
import {LocalContextIndex} from '../../src/context/local-index.js';
import {defaultConfig} from '../../src/config.js';
import {runProcess} from '../../src/utils/process.js';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

describe('LocalContextIndex', () => {
  it('maps ContextEngine multi-root aliases to their configured roots', () => {
    const main = '/tmp/mosaic-main';
    const extra = '/tmp/mosaic-extra';
    const third = '/tmp/mosaic-third';
    const configured = [main, extra, third];
    expect(mapExternalPath('main/src/index.ts', configured)).toBe(join(main, 'src/index.ts'));
    expect(mapExternalPath('workspace2/lib/util.ts', configured)).toBe(join(extra, 'lib/util.ts'));
    expect(mapExternalPath('workspace3/pkg/api.ts', configured)).toBe(join(third, 'pkg/api.ts'));
    expect(mapExternalPath('mosaic-extra/lib/util.ts', configured)).toBeUndefined();
    expect(mapExternalPath('relative.ts', configured)).toBeUndefined();
    expect(mapExternalPath('main/../../secret.ts', configured)).toBeUndefined();
    expect(mapExternalPath('/tmp/not-a-mosaic-root/secret.ts', configured)).toBeUndefined();
    expect(mapExternalPath('workspace4/stale.ts', configured)).toBeUndefined();
    expect(mapExternalPath('main/src/index.ts', [main])).toBe(join(main, 'main/src/index.ts'));
    expect(mapExternalPath('workspace2/lib/util.ts', [main])).toBe(join(main, 'workspace2/lib/util.ts'));
  });

  it('uses the current ContextEngine CLI contract for index, search, and packing', async () => {
    const main = await mkdtemp(join(tmpdir(), 'mosaic-external-main-'));
    const extra = await mkdtemp(join(tmpdir(), 'mosaic-external-extra-'));
    const outside = await mkdtemp(join(tmpdir(), 'mosaic-external-outside-'));
    roots.push(main, extra, outside);
    await mkdir(join(extra, 'lib'));
    await writeFile(join(extra, 'lib', 'util.ts'), 'export const useful = true;\n');
    await writeFile(join(outside, 'secret.ts'), 'do not expose this\n');
    const log = join(main, 'contextengine-args.txt');
    const executable = await installContextEngineFixture(main);
    const config = defaultConfig(main);
    config.workspaceRoots = [main, extra];
    config.context.engine = 'contextengine';
    config.context.contextEngineCommand = executable;
    const previous = captureFixtureEnvironment();
    process.env.CONTEXTENGINE_FIXTURE_LOG = log;
    process.env.CONTEXTENGINE_FIXTURE_HIT_PATH = 'workspace2/lib/util.ts';
    process.env.CONTEXTENGINE_FIXTURE_HIT_ROOT = extra;
    try {
      const engine = new ContextEngine(config);
      const progress: string[] = [];
      await expect(engine.index((event) => progress.push(event.phase))).resolves.toMatchObject({
        engine: 'contextengine', ok: true, filesScanned: 2,
      });
      expect(progress).toContain('scan');
      expect(progress).toContain('done');
      expect(await readFile(log, 'utf8')).toContain(`index ${main} --extra workspace2:${extra}`);
      await expect(engine.search('useful', 7)).resolves.toEqual([
        expect.objectContaining({path: join(extra, 'lib/util.ts'), startLine: 1, symbol: 'fixtureSymbol'}),
      ]);
      expect(await readFile(log, 'utf8')).toContain(`search --top-k 7 --json --root ${main} -- useful`);
      await expect(engine.search('--help', 1)).resolves.toHaveLength(1);
      expect(await readFile(log, 'utf8')).toContain(`search --top-k 1 --json --root ${main} -- --help`);
      await expect(engine.pack('find useful')).resolves.toMatchObject({
        engine: 'contextengine',
        hits: [expect.objectContaining({path: join(extra, 'lib/util.ts')})],
      });
      expect(await readFile(log, 'utf8')).toContain(`context --top-k 12 --max-tokens 12000 --json --root ${main} -- find useful`);
    } finally {
      restoreFixtureEnvironment(previous);
    }
  });

  it('falls back to the local index when auto external indexing fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-context-fallback-'));
    roots.push(root);
    await writeFile(join(root, 'source.ts'), 'export const fallbackValue = true;\n');
    const executable = await installContextEngineFixture(root);
    const config = defaultConfig(root);
    config.context.engine = 'auto';
    config.context.contextEngineCommand = executable;
    const previous = captureFixtureEnvironment();
    process.env.CONTEXTENGINE_FIXTURE_MODE = 'index-fail';
    try {
      const result = await new ContextEngine(config).index();
      expect(result.engine).toBe('local');
      expect(result.fallback).toBe('contextengine-index-failed');
      expect(result.files).toBe(1);

      config.context.engine = 'contextengine';
      await expect(new ContextEngine(config).index()).rejects.toThrow('PostgreSQL + pgvector is required');
    } finally {
      restoreFixtureEnvironment(previous);
    }
  });

  it('does not pass packed context from out-of-workspace external hits to the model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-context-pack-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'mosaic-context-pack-outside-'));
    roots.push(root, outside);
    await writeFile(join(root, 'safe.ts'), 'export const safeContextValue = true;\n');
    const executable = await installContextEngineFixture(root);
    await writeFile(join(outside, 'secret.ts'), 'OUTSIDE_SECRET\n');
    await symlink(outside, join(root, 'linked-outside'));
    const config = defaultConfig(root);
    config.context.engine = 'auto';
    config.context.contextEngineCommand = executable;

    const previous = captureFixtureEnvironment();
    process.env.CONTEXTENGINE_FIXTURE_HIT_PATH = 'linked-outside/secret.ts';
    try {
      const packed = await new ContextEngine(config).pack('safeContextValue');
      expect(packed.engine).toBe('local');
      expect(packed.text).toContain('safeContextValue');
      expect(packed.text).not.toContain('OUTSIDE_SECRET');
      expect(packed.degradation?.code).toBe('contextengine-stale-result');

      config.context.engine = 'contextengine';
      await expect(new ContextEngine(config).pack('safeContextValue'))
        .rejects.toThrow('stale or invalid workspace context');
    } finally {
      restoreFixtureEnvironment(previous);
    }
  });

  it('does not auto-discover a ContextEngine executable from the workspace PATH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-context-path-root-'));
    roots.push(root);
    const bin = join(root, 'bin');
    const marker = join(root, 'executed');
    const executable = join(bin, 'mosaic-contextengine-path-test');
    await mkdir(bin);
    await writeFile(executable, '#!/bin/sh\nprintf ran > "$MOSAIC_CONTEXT_MARKER"\n');
    await chmod(executable, 0o700);
    const previousPath = process.env.PATH;
    const previousMarker = process.env.MOSAIC_CONTEXT_MARKER;
    try {
      process.env.PATH = `${bin}${delimiter}${previousPath ?? ''}`;
      process.env.MOSAIC_CONTEXT_MARKER = marker;
      const config = defaultConfig(root);
      config.context.contextEngineCommand = 'mosaic-contextengine-path-test';
      expect(await new ContextEngine(config).canUseExternal()).toBe(false);
      await expect(access(marker)).rejects.toMatchObject({code: 'ENOENT'});
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousMarker === undefined) delete process.env.MOSAIC_CONTEXT_MARKER;
      else process.env.MOSAIC_CONTEXT_MARKER = previousMarker;
    }
  });

  it('treats an unindexed external workspace as local-fallback only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-context-unindexed-'));
    roots.push(root);
    await writeFile(join(root, 'source.ts'), 'export const fallbackValue = true;\n');
    const executable = await installContextEngineFixture(root);
    const config = defaultConfig(root);
    config.context.contextEngineCommand = executable;
    const previous = captureFixtureEnvironment();
    process.env.CONTEXTENGINE_FIXTURE_MODE = 'unindexed';
    try {
      const engine = new ContextEngine(config);
      const hits = await engine.search('fallbackValue');
      expect(hits[0]?.path).toBe(join(root, 'source.ts'));
      expect(engine.lastDegradation()?.code).toBe('contextengine-not-indexed');

      config.context.engine = 'contextengine';
      await expect(new ContextEngine(config).search('fallbackValue'))
        .rejects.toThrow('workspace is not indexed');
      await expect(new ContextEngine(config).status()).resolves.toMatchObject({
        configuredEngine: 'contextengine',
        selected: 'unindexed',
      });

      config.context.engine = 'auto';
      process.env.CONTEXTENGINE_FIXTURE_MODE = 'db-down';
      const unavailable = await new ContextEngine(config).inspectExternal({refresh: true});
      expect(unavailable).toMatchObject({
        installed: true,
        available: false,
        reason: 'health-check-failed',
      });
      expect(unavailable.detail).toContain('CONTEXTENGINE_DATABASE_URL is required');
    } finally {
      restoreFixtureEnvironment(previous);
    }
  });

  it('validates external chunk freshness and preserves degraded channels', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-context-contract-'));
    roots.push(root);
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'index.ts'), 'export const currentValue = true;\n');
    const executable = await installContextEngineFixture(root);
    const config = defaultConfig(root);
    config.context.contextEngineCommand = executable;
    const previous = captureFixtureEnvironment();
    process.env.CONTEXTENGINE_FIXTURE_MODE = 'healthy';
    process.env.CONTEXTENGINE_FIXTURE_HIT_PATH = 'src/index.ts';
    process.env.CONTEXTENGINE_FIXTURE_CONTENT = 'export const oldValue = true;';
    try {
      const stale = await new ContextEngine(config).search('currentValue');
      expect(stale[0]?.content).toContain('currentValue');
      const staleEngine = new ContextEngine(config);
      await staleEngine.search('currentValue');
      expect(staleEngine.lastDegradation()?.code).toBe('contextengine-stale-result');

      delete process.env.CONTEXTENGINE_FIXTURE_CONTENT;
      process.env.CONTEXTENGINE_FIXTURE_MODE = 'degraded';
      const packed = await new ContextEngine(config).pack('currentValue');
      expect(packed.engine).toBe('contextengine');
      expect(packed.degradation?.code).toBe('contextengine-channels-degraded');
    } finally {
      restoreFixtureEnvironment(previous);
    }
  });

  it('isolates external execution from workspace dotenv and generic model credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-context-env-'));
    roots.push(root);
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'index.ts'), 'export const envSafe = true;\n');
    await writeFile(join(root, '.env'), 'CONTEXTENGINE_FIXTURE_MODE=query-fail\nOPENAI_API_KEY=repo-secret\n');
    const executable = await installContextEngineFixture(root);
    const config = defaultConfig(root);
    config.context.contextEngineCommand = executable;
    const previous = captureFixtureEnvironment();
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.CONTEXTENGINE_FIXTURE_MODE = 'healthy';
    process.env.CONTEXTENGINE_FIXTURE_HIT_PATH = 'src/index.ts';
    process.env.CONTEXTENGINE_FIXTURE_ENV_LOG = join(root, 'env.log');
    process.env.OPENAI_API_KEY = 'parent-secret';
    try {
      const hits = await new ContextEngine(config).search('envSafe');
      expect(hits[0]?.content).toContain('envSafe');
      const envLog = await readFile(join(root, 'env.log'), 'utf8');
      expect(envLog).not.toContain('parent-secret');
      expect(envLog).not.toContain('repo-secret');
      expect(envLog).toContain('"openai":null');
      expect(envLog).not.toContain(root);
    } finally {
      restoreFixtureEnvironment(previous);
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
    }
  });

  it('does not probe the external runtime when local mode is explicit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-context-local-only-'));
    roots.push(root);
    const executable = await installContextEngineFixture(root);
    const log = join(root, 'contextengine.log');
    const config = defaultConfig(root);
    config.context.engine = 'local';
    config.context.contextEngineCommand = executable;
    const previous = captureFixtureEnvironment();
    process.env.CONTEXTENGINE_FIXTURE_LOG = log;
    try {
      await expect(new ContextEngine(config).status()).resolves.toMatchObject({
        selected: 'local',
        externalAvailable: false,
      });
      await expect(access(log)).rejects.toMatchObject({code: 'ENOENT'});
    } finally {
      restoreFixtureEnvironment(previous);
    }
  });

  it('rejects incompatible and over-budget external contracts with explicit telemetry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-context-incompatible-'));
    roots.push(root);
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'index.ts'), 'export const budgetValue = true;\n');
    const executable = await installContextEngineFixture(root);
    const config = defaultConfig(root);
    config.context.contextEngineCommand = executable;
    const previous = captureFixtureEnvironment();
    try {
      process.env.CONTEXTENGINE_FIXTURE_MODE = 'incompatible';
      const incompatible = await new ContextEngine(config).pack('budgetValue');
      expect(incompatible.engine).toBe('local');
      expect(incompatible.degradation?.code).toBe('contextengine-incompatible-version');

      process.env.CONTEXTENGINE_FIXTURE_MODE = 'over-budget';
      process.env.CONTEXTENGINE_FIXTURE_HIT_PATH = 'src/index.ts';
      const overBudget = await new ContextEngine(config).pack('budgetValue');
      expect(overBudget.engine).toBe('local');
      expect(overBudget.estimatedTokens).toBeLessThanOrEqual(config.context.maxTokens);
      expect(overBudget.degradation?.code).toBe('contextengine-query-failed');

      process.env.CONTEXTENGINE_FIXTURE_MODE = 'indexing';
      const capability = await new ContextEngine(config).inspectExternal({refresh: true});
      expect(capability).toMatchObject({available: true, indexed: true, freshness: 'indexing'});
    } finally {
      restoreFixtureEnvironment(previous);
    }
  });

  it('requires successful help probes and an indexed status for the configured root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-context-probe-contract-'));
    roots.push(root);
    const executable = await installContextEngineFixture(root);
    const config = defaultConfig(root);
    config.context.contextEngineCommand = executable;
    const previous = captureFixtureEnvironment();
    try {
      for (const [mode, reason] of [
        ['help-fail', 'incompatible-version'],
        ['malformed-status', 'invalid-status'],
        ['unindexed-exit-zero', 'invalid-status'],
        ['wrong-root', 'invalid-status'],
      ] as const) {
        process.env.CONTEXTENGINE_FIXTURE_MODE = mode;
        await expect(new ContextEngine(config).inspectExternal({refresh: true})).resolves.toMatchObject({
          available: false,
          reason,
        });
      }
    } finally {
      restoreFixtureEnvironment(previous);
    }
  });

  it('falls back on malformed query and index schemas and strips unknown index fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-context-malformed-contract-'));
    roots.push(root);
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'index.ts'), 'export const schemaValue = true;\n');
    const executable = await installContextEngineFixture(root);
    const config = defaultConfig(root);
    config.context.contextEngineCommand = executable;
    const previous = captureFixtureEnvironment();
    process.env.CONTEXTENGINE_FIXTURE_HIT_PATH = 'src/index.ts';
    try {
      process.env.CONTEXTENGINE_FIXTURE_MODE = 'malformed-search';
      const searchEngine = new ContextEngine(config);
      expect((await searchEngine.search('schemaValue'))[0]?.content).toContain('schemaValue');
      expect(searchEngine.lastDegradation()?.code).toBe('contextengine-query-failed');

      process.env.CONTEXTENGINE_FIXTURE_MODE = 'malformed-context';
      const packed = await new ContextEngine(config).pack('schemaValue');
      expect(packed).toMatchObject({engine: 'local', degradation: {code: 'contextengine-query-failed'}});

      process.env.CONTEXTENGINE_FIXTURE_MODE = 'malformed-index';
      const malformedIndex = await new ContextEngine(config).index();
      expect(malformedIndex).toMatchObject({engine: 'local', fallback: 'contextengine-index-failed'});

      config.context.engine = 'contextengine';
      process.env.CONTEXTENGINE_FIXTURE_MODE = 'malformed-search';
      await expect(new ContextEngine(config).search('schemaValue')).rejects.toThrow();
      process.env.CONTEXTENGINE_FIXTURE_MODE = 'malformed-context';
      await expect(new ContextEngine(config).pack('schemaValue')).rejects.toThrow();
      process.env.CONTEXTENGINE_FIXTURE_MODE = 'malformed-index';
      await expect(new ContextEngine(config).index()).rejects.toThrow();

      process.env.CONTEXTENGINE_FIXTURE_MODE = 'index-extra';
      const safeIndex = await new ContextEngine(config).index();
      expect(safeIndex).toMatchObject({engine: 'contextengine', filesScanned: 2});
      expect(safeIndex).not.toHaveProperty('apiKey');
      expect(safeIndex).not.toHaveProperty('databaseUrl');
    } finally {
      restoreFixtureEnvironment(previous);
    }
  });

  it('keeps the final index result after oversized progress and emits done only after validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-context-long-progress-'));
    roots.push(root);
    const executable = await installContextEngineFixture(root);
    const config = defaultConfig(root);
    config.context.engine = 'contextengine';
    config.context.contextEngineCommand = executable;
    const previous = captureFixtureEnvironment();
    process.env.CONTEXTENGINE_FIXTURE_MODE = 'long-progress';
    try {
      const phases: string[] = [];
      await expect(new ContextEngine(config).index((event) => phases.push(event.phase)))
        .resolves.toMatchObject({engine: 'contextengine', filesScanned: 2});
      expect(phases.filter((phase) => phase === 'done')).toHaveLength(1);
    } finally {
      restoreFixtureEnvironment(previous);
    }
  });

  it('ignores terminal-control and warning progress text and uses validated totals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-context-noisy-progress-'));
    roots.push(root);
    const executable = await installContextEngineFixture(root);
    const config = defaultConfig(root);
    config.context.engine = 'contextengine';
    config.context.contextEngineCommand = executable;
    const previous = captureFixtureEnvironment();
    process.env.CONTEXTENGINE_FIXTURE_MODE = 'noisy-progress';
    try {
      const events: Array<{
        phase: string;
        completed: number;
        total: number;
        path?: string;
      }> = [];
      await expect(new ContextEngine(config).index((event) => events.push({
        phase: event.phase,
        completed: event.completed,
        total: event.total,
        ...(event.path ? {path: event.path} : {}),
      }))).resolves.toMatchObject({engine: 'contextengine', filesScanned: 2});
      expect(events.at(-1)).toMatchObject({phase: 'done', completed: 2, total: 2});
      expect(events.some((event) => event.path?.includes('warning'))).toBe(false);
      expect(JSON.stringify(events)).not.toContain('\u001b');
    } finally {
      restoreFixtureEnvironment(previous);
    }
  });

  it('rebuilds model context from current file bytes while accepting valid Context prefixes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-context-current-bytes-'));
    roots.push(root);
    await mkdir(join(root, 'src'));
    const path = join(root, 'src', 'index.ts');
    await writeFile(path, 'export const currentBytes = true;\n');
    const executable = await installContextEngineFixture(root);
    const config = defaultConfig(root);
    config.context.engine = 'contextengine';
    config.context.contextEngineCommand = executable;
    const previous = captureFixtureEnvironment();
    process.env.CONTEXTENGINE_FIXTURE_HIT_PATH = 'src/index.ts';
    process.env.CONTEXTENGINE_FIXTURE_PREFIX = 'external synthetic metadata';
    try {
      const engine = new ContextEngine(config);
      const packed = await engine.pack('currentBytes');
      expect(packed.text).toContain('export const currentBytes');
      expect(packed.text).not.toContain('external synthetic metadata');

      delete process.env.CONTEXTENGINE_FIXTURE_PREFIX;
      await writeFile(path, '// Context: legitimate source comment\nexport const currentBytes = true;\n');
      const hits = await engine.search('currentBytes');
      expect(hits[0]?.content).toContain('// Context: legitimate source comment');

      for (const literalPath of ['main/literal.ts', 'workspace2/literal.ts']) {
        await mkdir(join(root, literalPath.split('/')[0] ?? ''), {recursive: true});
        await writeFile(join(root, literalPath), `export const literalPath = '${literalPath}';\n`);
        process.env.CONTEXTENGINE_FIXTURE_HIT_PATH = literalPath;
        const literalHits = await engine.search('literalPath');
        expect(literalHits[0]?.path).toBe(join(root, literalPath));
      }
    } finally {
      restoreFixtureEnvironment(previous);
    }
  });

  it('redacts external credentials in fallback and explicit-mode errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-context-redaction-'));
    roots.push(root);
    await writeFile(join(root, 'source.ts'), 'export const redactionValue = true;\n');
    const executable = await installContextEngineFixture(root);
    const config = defaultConfig(root);
    config.context.contextEngineCommand = executable;
    const previous = captureFixtureEnvironment();
    try {
      process.env.CONTEXTENGINE_FIXTURE_MODE = 'secret-error';
      const packed = await new ContextEngine(config).pack('redactionValue');
      const detail = packed.degradation?.detail ?? '';
      expect(detail).toContain('<redacted>');
      expect(detail).not.toMatch(/fixture-(?:bearer|json|bare|db)-secret/u);

      config.context.engine = 'contextengine';
      process.env.CONTEXTENGINE_FIXTURE_MODE = 'malformed-secret-context';
      const message = await new ContextEngine(config).pack('redactionValue').then(
        () => '',
        (error: unknown) => error instanceof Error ? error.message : String(error),
      );
      expect(message).toContain('<redacted>');
      expect(message).not.toContain('fixture-json-secret');
    } finally {
      restoreFixtureEnvironment(previous);
    }
  });

  it('coalesces capability probes and recovers when the executable appears after the TTL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-context-capability-cache-'));
    roots.push(root);
    const executable = join(root, 'contextengine-fixture');
    const log = join(root, 'contextengine.log');
    const config = defaultConfig(root);
    config.context.contextEngineCommand = executable;
    const previous = captureFixtureEnvironment();
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const engine = new ContextEngine(config);
      await expect(engine.inspectExternal()).resolves.toMatchObject({reason: 'not-installed'});
      await installContextEngineFixture(root);
      process.env.CONTEXTENGINE_FIXTURE_LOG = log;

      await expect(engine.inspectExternal()).resolves.toMatchObject({reason: 'not-installed'});
      await expect(access(log)).rejects.toMatchObject({code: 'ENOENT'});

      now += 10_001;
      await expect(engine.inspectExternal()).resolves.toMatchObject({available: true, indexed: true});
      expect((await readFile(log, 'utf8')).trim().split('\n')).toHaveLength(5);

      await writeFile(log, '');
      const coalesced = new ContextEngine(config);
      const capabilities = await Promise.all([
        coalesced.inspectExternal(),
        coalesced.inspectExternal(),
        coalesced.inspectExternal(),
      ]);
      expect(capabilities.every((capability) => capability.available)).toBe(true);
      expect((await readFile(log, 'utf8')).trim().split('\n')).toHaveLength(5);
    } finally {
      restoreFixtureEnvironment(previous);
    }
  });

  it('cross-checks empty auto results against the current local index', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-context-empty-cross-check-'));
    roots.push(root);
    await writeFile(join(root, 'recent.ts'), 'export const recentlyAddedValue = true;\n');
    const executable = await installContextEngineFixture(root);
    const config = defaultConfig(root);
    config.context.contextEngineCommand = executable;
    const previous = captureFixtureEnvironment();
    process.env.CONTEXTENGINE_FIXTURE_MODE = 'empty';
    try {
      const searchEngine = new ContextEngine(config);
      const hits = await searchEngine.search('recentlyAddedValue');
      expect(hits[0]?.path).toBe(join(root, 'recent.ts'));
      expect(searchEngine.lastDegradation(), JSON.stringify(searchEngine.lastDegradation())).toMatchObject({
        code: 'contextengine-empty-result',
      });

      const packed = await new ContextEngine(config).pack('recentlyAddedValue');
      expect(packed).toMatchObject({
        engine: 'local',
        degradation: {code: 'contextengine-empty-result'},
      });

      config.context.engine = 'contextengine';
      await expect(new ContextEngine(config).search('recentlyAddedValue')).resolves.toEqual([]);
    } finally {
      restoreFixtureEnvironment(previous);
    }
  });

  it('verifies ContextEngine commit-lineage chunks against the current Git repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-context-commit-lineage-'));
    roots.push(root);
    await expect(runGit(root, ['init', '-q'])).resolves.toBeDefined();
    await writeFile(join(root, 'tracked.ts'), 'export const historicalValue = true;\n');
    await runGit(root, ['add', 'tracked.ts']);
    await runGit(root, [
      '-c', 'user.name=Fixture User',
      '-c', 'user.email=fixture@example.test',
      'commit', '-q', '-m', 'Add historical context',
    ], {
      GIT_AUTHOR_DATE: '2026-01-02T12:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-02T12:00:00Z',
    });
    const shortHash = (await runGit(root, ['rev-parse', '--short', 'HEAD'])).stdout.trim();
    const expected = [
      `commit ${shortHash} 2026-01-02`,
      'author: Fixture User',
      'subject: Add historical context',
      'files:',
      '- tracked.ts',
    ].join('\n');
    const executable = await installContextEngineFixture(root);
    const config = defaultConfig(root);
    config.context.engine = 'contextengine';
    config.context.contextEngineCommand = executable;
    const previous = captureFixtureEnvironment();
    process.env.CONTEXTENGINE_FIXTURE_HIT_PATH = `.git/commits/${shortHash}`;
    process.env.CONTEXTENGINE_FIXTURE_CONTENT = expected;
    try {
      const hits = await new ContextEngine(config).search('historical context');
      expect(hits[0]).toMatchObject({
        path: join(root, '.git', 'commits', shortHash),
        content: expected,
        symbol: 'Add historical context',
      });

      const extra = await mkdtemp(join(tmpdir(), 'mosaic-context-commit-extra-'));
      roots.push(extra);
      config.workspaceRoots = [root, extra];
      const multiRootHits = await new ContextEngine(config).search('historical context');
      expect(multiRootHits[0]?.path).toBe(join(root, '.git', 'commits', shortHash));

      process.env.CONTEXTENGINE_FIXTURE_CONTENT = expected.replace('Add historical context', 'Tampered subject');
      await expect(new ContextEngine(config).search('historical context'))
        .rejects.toThrow('stale or invalid workspace context');
    } finally {
      restoreFixtureEnvironment(previous);
    }
  });

  it('rejects files that grow beyond the bounded freshness-validation limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-context-bounded-read-'));
    roots.push(root);
    const path = join(root, 'large.ts');
    await writeFile(path, Buffer.alloc(4_000_001, 'x'));
    const executable = await installContextEngineFixture(root);
    const config = defaultConfig(root);
    config.context.contextEngineCommand = executable;
    const previous = captureFixtureEnvironment();
    process.env.CONTEXTENGINE_FIXTURE_HIT_PATH = 'large.ts';
    process.env.CONTEXTENGINE_FIXTURE_CONTENT = 'x';
    try {
      const engine = new ContextEngine(config);
      await engine.search('large');
      expect(engine.lastDegradation()?.code).toBe('contextengine-stale-result');
    } finally {
      restoreFixtureEnvironment(previous);
    }
  });

  it('indexes symbols and ranks identifier matches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-context-'));
    roots.push(root);
    await writeFile(join(root, 'payments.ts'), [
      'export function processPayment(input: PaymentInput) {',
      '  return chargeGateway(input);',
      '}',
      '',
      'export function unrelated() { return null; }',
    ].join('\n'));
    await writeFile(join(root, 'README.md'), 'The payment service retries a webhook.\n');
    const interrupted = join(root, '.skein.rollback-00000000-0000-4000-8000-000000000010');
    await mkdir(interrupted);
    await writeFile(join(interrupted, 'private-session.json'), '{"secret":"do-not-index"}\n');
    const index = new LocalContextIndex([root]);
    const stats = await index.build();
    expect(stats.files).toBe(2);
    expect((await stat(index.indexPath)).mode & 0o777).toBe(0o600);
    const hits = await index.search('processPayment', 3);
    expect(hits[0]?.path).toBe(join(root, 'payments.ts'));
    expect(hits[0]?.symbol).toBe('processPayment');
  });

  it('keeps status reads side-effect free and emits stable multi-root aliases', async () => {
    const main = await mkdtemp(join(tmpdir(), 'mosaic-context-main-'));
    const extra = await mkdtemp(join(tmpdir(), 'mosaic-context-extra-'));
    roots.push(main, extra);
    const index = new LocalContextIndex([main, extra]);
    expect(await index.load()).toBe(false);
    await expect(access(join(main, '.mosaic'))).rejects.toMatchObject({code: 'ENOENT'});

    await writeFile(join(extra, 'useful.ts'), 'export const multiRootValue = true;\n');
    await index.build();
    const packed = await index.pack('multiRootValue', 3, 200);
    expect(packed.text).toContain('path="workspace2/useful.ts"');
    expect(packed.text).not.toContain('../');
  });

  it('does not load a local index through a symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-index-symlink-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'mosaic-index-symlink-outside-'));
    roots.push(root, outside);
    await mkdir(join(root, '.mosaic'), {recursive: true});
    const outsideIndex = join(outside, 'index.json');
    await writeFile(outsideIndex, '{"version":1,"createdAt":"now","roots":[],"files":[]}\n');
    const index = new LocalContextIndex([root]);
    await symlink(outsideIndex, index.indexPath);
    expect(await index.load()).toBe(false);
  });

  it('packs under a token budget and reports truncation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-pack-'));
    roots.push(root);
    await writeFile(join(root, 'large.ts'), `${'export const importantValue = 1;\n'.repeat(80)}`);
    const index = new LocalContextIndex([root]);
    await index.build();
    const packed = await index.pack('importantValue', 5, 20);
    expect(packed.engine).toBe('local');
    expect(packed.truncated).toBe(true);
    expect(packed.estimatedTokens).toBeLessThanOrEqual(20);
  });

  it('drops out-of-workspace entries from a tampered local index', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-index-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'mosaic-index-outside-'));
    roots.push(root, outside);
    await writeFile(join(root, 'inside.ts'), 'export const insideValue = 1;\n');
    await writeFile(join(outside, 'secret.ts'), 'export const secretValue = 2;\n');
    const first = new LocalContextIndex([root]);
    await first.build();
    const raw = JSON.parse(await readFile(first.indexPath, 'utf8')) as {
      files: Array<{absolutePath: string; chunks: Array<{absolutePath: string}>}>;
    };
    const file = raw.files[0];
    if (!file) throw new Error('Expected an indexed file.');
    file.absolutePath = join(outside, 'secret.ts');
    for (const chunk of file.chunks) chunk.absolutePath = file.absolutePath;
    await writeFile(first.indexPath, `${JSON.stringify(raw)}\n`);
    const reloaded = new LocalContextIndex([root]);
    expect(await reloaded.load()).toBe(true);
    expect(reloaded.status().files).toBe(0);
  });
});

async function runGit(
  root: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
) {
  const result = await runProcess('git', args, {cwd: root, env});
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return result;
}

const fixtureEnvironmentNames = [
  'CONTEXTENGINE_FIXTURE_MODE',
  'CONTEXTENGINE_FIXTURE_LOG',
  'CONTEXTENGINE_FIXTURE_HIT_PATH',
  'CONTEXTENGINE_FIXTURE_HIT_ROOT',
  'CONTEXTENGINE_FIXTURE_CONTENT',
  'CONTEXTENGINE_FIXTURE_ENV_LOG',
  'CONTEXTENGINE_FIXTURE_PREFIX',
  'CONTEXTENGINE_FIXTURE_MULTI_ROOT',
] as const;

async function installContextEngineFixture(root: string): Promise<string> {
  const executable = join(root, 'contextengine-fixture');
  const source = await readFile(new URL('../fixtures/contextengine-cli.mjs', import.meta.url), 'utf8');
  await writeFile(executable, source);
  await chmod(executable, 0o700);
  return executable;
}

function captureFixtureEnvironment(): Record<(typeof fixtureEnvironmentNames)[number], string | undefined> {
  return Object.fromEntries(fixtureEnvironmentNames.map((name) => [name, process.env[name]])) as
    Record<(typeof fixtureEnvironmentNames)[number], string | undefined>;
}

function restoreFixtureEnvironment(
  previous: Record<(typeof fixtureEnvironmentNames)[number], string | undefined>,
): void {
  for (const name of fixtureEnvironmentNames) {
    const value = previous[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
