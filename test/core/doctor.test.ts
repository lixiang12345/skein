import {chmod, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {checkSqliteFts5, MINIMUM_NODE_VERSION, runDoctor, supportsNodeVersion} from '../../src/cli/doctor.js';
import {defaultConfig} from '../../src/config.js';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

describe('doctor runtime checks', () => {
  it('enforces the first Node release with unflagged node:sqlite', () => {
    expect(MINIMUM_NODE_VERSION).toBe('22.16.0');
    expect(supportsNodeVersion('22.15.1')).toBe(false);
    expect(supportsNodeVersion('v22.15.9')).toBe(false);
    expect(supportsNodeVersion('22.16.0')).toBe(true);
    expect(supportsNodeVersion('22.22.3')).toBe(true);
    expect(supportsNodeVersion('23.0.0')).toBe(true);
    expect(supportsNodeVersion('not-a-version')).toBe(false);
  });

  it('probes the SQLite capability required by durable memory', async () => {
    await expect(checkSqliteFts5()).resolves.toEqual({ok: true, detail: 'available'});
  });

  it('fails once, without duplicate probes, when an explicitly required external index is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-doctor-contextengine-'));
    roots.push(root);
    const executable = join(root, 'contextengine-fixture');
    const source = await readFile(new URL('../fixtures/contextengine-cli.mjs', import.meta.url), 'utf8');
    await writeFile(executable, source);
    await chmod(executable, 0o700);
    const log = join(root, 'contextengine.log');
    const previousMode = process.env.CONTEXTENGINE_FIXTURE_MODE;
    const previousLog = process.env.CONTEXTENGINE_FIXTURE_LOG;
    process.env.CONTEXTENGINE_FIXTURE_MODE = 'unindexed';
    process.env.CONTEXTENGINE_FIXTURE_LOG = log;
    const config = defaultConfig(root);
    config.model = {provider: 'compatible', model: 'fixture', baseUrl: 'http://127.0.0.1:1/v1'};
    config.context.engine = 'contextengine';
    config.context.contextEngineCommand = executable;
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(runDoctor(config, {json: true})).resolves.toBe(false);
      const report = JSON.parse(stdout.mock.calls.map(([chunk]) => String(chunk)).join('')) as {
        checks: Array<{name: string; ok: boolean; required: boolean}>;
      };
      expect(report.checks).toContainEqual(expect.objectContaining({
        name: 'Code index',
        ok: false,
        required: true,
      }));
      expect((await readFile(log, 'utf8')).trim().split('\n')).toHaveLength(5);
    } finally {
      if (previousMode === undefined) delete process.env.CONTEXTENGINE_FIXTURE_MODE;
      else process.env.CONTEXTENGINE_FIXTURE_MODE = previousMode;
      if (previousLog === undefined) delete process.env.CONTEXTENGINE_FIXTURE_LOG;
      else process.env.CONTEXTENGINE_FIXTURE_LOG = previousLog;
    }
  });

  it('reports a missing semantic channel without making lexical retrieval unusable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-doctor-context-channels-'));
    roots.push(root);
    const executable = join(root, 'contextengine-fixture');
    const source = await readFile(new URL('../fixtures/contextengine-cli.mjs', import.meta.url), 'utf8');
    await writeFile(executable, source);
    await chmod(executable, 0o700);
    const previousMode = process.env.CONTEXTENGINE_FIXTURE_MODE;
    process.env.CONTEXTENGINE_FIXTURE_MODE = 'degraded';
    const config = defaultConfig(root);
    config.model = {provider: 'compatible', model: 'fixture', baseUrl: 'http://127.0.0.1:1/v1'};
    config.context.contextEngineCommand = executable;
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(runDoctor(config, {json: true})).resolves.toBe(true);
      const report = JSON.parse(stdout.mock.calls.map(([chunk]) => String(chunk)).join('')) as {
        checks: Array<{name: string; ok: boolean; detail: string; required: boolean}>;
      };
      expect(report.checks).toContainEqual(expect.objectContaining({
        name: 'Context channels',
        ok: false,
        required: false,
        detail: expect.stringContaining('semantic unavailable'),
      }));
    } finally {
      if (previousMode === undefined) delete process.env.CONTEXTENGINE_FIXTURE_MODE;
      else process.env.CONTEXTENGINE_FIXTURE_MODE = previousMode;
    }
  });
});
