import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {checkSqliteFts5, MINIMUM_NODE_VERSION, runDoctor, supportsNodeVersion} from '../../src/cli/doctor.js';
import {defaultConfig} from '../../src/config.js';
import {legacyCompatibilityStatus, LEGACY_NAMESPACE_SUPPORTED_UNTIL} from '../../src/utils/namespace.js';

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

  it('warns non-fatally and reports JSON status when legacy aliases are active', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-doctor-legacy-'));
    const home = await mkdtemp(join(tmpdir(), 'skein-doctor-home-'));
    roots.push(root, home);
    await mkdir(join(root, '.mosaic'));
    const previous = {
      SKEIN_HOME: process.env.SKEIN_HOME,
      SKEIN_MODEL: process.env.SKEIN_MODEL,
      MOSAIC_MODEL: process.env.MOSAIC_MODEL,
    };
    process.env.SKEIN_HOME = join(home, '.skein');
    delete process.env.SKEIN_MODEL;
    process.env.MOSAIC_MODEL = 'legacy-model';
    const config = defaultConfig(root);
    config.model = {provider: 'compatible', model: 'fixture', baseUrl: 'http://127.0.0.1:1/v1'};
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(runDoctor(config, {json: true})).resolves.toBe(true);
      const report = JSON.parse(stdout.mock.calls.map(([chunk]) => String(chunk)).join('')) as {
        checks: Array<{name: string; ok: boolean; detail: string; required: boolean}>;
        legacyCompatibility: {
          phase: string;
          deprecatedIn: string;
          removedIn: string;
          inUse: boolean;
          legacyPaths: Array<{scope: string; path: string}>;
          legacyEnvironmentVariables: string[];
        };
      };
      expect(report.legacyCompatibility).toMatchObject({
        phase: 'deprecated',
        deprecatedIn: '0.3.0',
        removedIn: '0.5.0',
        inUse: true,
        legacyPaths: [{scope: 'project', path: join(root, '.mosaic')}],
      });
      expect(report.legacyCompatibility.legacyEnvironmentVariables).toContain('MOSAIC_MODEL');
      expect(report.checks).toContainEqual(expect.objectContaining({
        name: 'Legacy compatibility',
        ok: false,
        required: false,
        detail: expect.stringMatching(/deprecated in 0\.3\.0.*removed in 0\.5\.0.*skein migrate/u),
      }));
    } finally {
      restoreEnvironment('SKEIN_HOME', previous.SKEIN_HOME);
      restoreEnvironment('SKEIN_MODEL', previous.SKEIN_MODEL);
      restoreEnvironment('MOSAIC_MODEL', previous.MOSAIC_MODEL);
    }
  });

  it('warns in human output while project and user storage use the legacy namespace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-doctor-legacy-'));
    const home = await mkdtemp(join(tmpdir(), 'skein-doctor-legacy-home-'));
    roots.push(root, home);
    await mkdir(join(root, '.mosaic'));
    const legacyHome = join(home, '.mosaic');
    await mkdir(legacyHome);
    const previousSkeinHome = process.env.SKEIN_HOME;
    const previousMosaicHome = process.env.MOSAIC_HOME;
    process.env.SKEIN_HOME = join(home, '.skein');
    process.env.MOSAIC_HOME = legacyHome;
    const config = defaultConfig(root);
    config.model = {provider: 'compatible', model: 'fixture', baseUrl: 'http://127.0.0.1:1/v1'};
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(runDoctor(config)).resolves.toBe(true);
      const report = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(report).toContain('! Legacy compatibility');
      expect(report).toContain(`supported through v${LEGACY_NAMESPACE_SUPPORTED_UNTIL}`);
      expect(report).toContain('run skein migrate --yes and skein migrate --home --yes');

      stdout.mockClear();
      await expect(runDoctor(config, {json: true})).resolves.toBe(true);
      const jsonReport = JSON.parse(stdout.mock.calls.map(([chunk]) => String(chunk)).join('')) as {
        checks: Array<{name: string; ok: boolean; detail: string; required: boolean}>;
        legacyCompatibility: {inUse: boolean; supportedUntil: string};
      };
      expect(jsonReport.checks).toContainEqual(expect.objectContaining({
        name: 'Legacy compatibility',
        ok: false,
        required: false,
        detail: expect.stringContaining(`supported through v${LEGACY_NAMESPACE_SUPPORTED_UNTIL}`),
      }));
      expect(jsonReport.legacyCompatibility).toMatchObject({
        inUse: true,
        supportedUntil: LEGACY_NAMESPACE_SUPPORTED_UNTIL,
      });
    } finally {
      if (previousSkeinHome === undefined) delete process.env.SKEIN_HOME;
      else process.env.SKEIN_HOME = previousSkeinHome;
      if (previousMosaicHome === undefined) delete process.env.MOSAIC_HOME;
      else process.env.MOSAIC_HOME = previousMosaicHome;
    }
  });

  it('reports canonical namespaces cleanly in JSON without a legacy advisory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-doctor-canonical-'));
    const home = await mkdtemp(join(tmpdir(), 'skein-doctor-canonical-home-'));
    roots.push(root, home);
    await mkdir(join(root, '.skein'));
    const canonicalHome = join(home, '.skein');
    await mkdir(canonicalHome);
    const previousSkeinHome = process.env.SKEIN_HOME;
    const previousMosaicHome = process.env.MOSAIC_HOME;
    process.env.SKEIN_HOME = canonicalHome;
    delete process.env.MOSAIC_HOME;
    const config = defaultConfig(root);
    config.model = {provider: 'compatible', model: 'fixture', baseUrl: 'http://127.0.0.1:1/v1'};
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(runDoctor(config, {json: true})).resolves.toBe(true);
      const report = JSON.parse(stdout.mock.calls.map(([chunk]) => String(chunk)).join('')) as {
        checks: Array<{name: string; ok: boolean; detail: string}>;
        legacyCompatibility: {inUse: boolean; supportedUntil: string};
      };
      expect(report.checks).toContainEqual(expect.objectContaining({
        name: 'Storage namespace',
        ok: true,
        detail: `canonical .skein namespace active at ${join(root, '.skein')}`,
      }));
      expect(report.checks).toContainEqual(expect.objectContaining({
        name: 'User storage namespace',
        ok: true,
        detail: `canonical .skein namespace active at ${canonicalHome}`,
      }));
      expect(report.checks.some(({name}) => name === 'Legacy compatibility')).toBe(false);
      expect(report.legacyCompatibility).toMatchObject({
        inUse: false,
        supportedUntil: LEGACY_NAMESPACE_SUPPORTED_UNTIL,
      });
    } finally {
      if (previousSkeinHome === undefined) delete process.env.SKEIN_HOME;
      else process.env.SKEIN_HOME = previousSkeinHome;
      if (previousMosaicHome === undefined) delete process.env.MOSAIC_HOME;
      else process.env.MOSAIC_HOME = previousMosaicHome;
    }
  });

  it('reports the phase-selected namespace for a fresh workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-doctor-fresh-'));
    roots.push(root);
    const config = defaultConfig(root);
    config.model = {provider: 'compatible', model: 'fixture', baseUrl: 'http://127.0.0.1:1/v1'};
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(runDoctor(config, {json: true})).resolves.toBe(true);
    const report = JSON.parse(stdout.mock.calls.map(([chunk]) => String(chunk)).join('')) as {
      checks: Array<{name: string; detail: string}>;
    };
    const phase = legacyCompatibilityStatus().phase;
    const expectedNamespace = phase === 'active' ? '.mosaic' : '.skein';
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'Storage namespace',
      detail: `no durable state yet; first write uses ${join(root, expectedNamespace)}`,
    }));
  });

});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
