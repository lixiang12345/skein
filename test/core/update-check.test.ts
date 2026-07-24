import {mkdtemp, readFile, writeFile, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  compareVersions,
  isUpdateCheckDisabled,
  readUpdateCache,
  refreshUpdateCache,
  resolveCachedUpdateNotice,
  sanitizeHighlights,
  updateCachePath,
  updateNoticeText,
  upgradeCommand,
  PACKAGE_NAME,
  CHECK_INTERVAL_MS,
  type UpdateCache,
} from '../../src/utils/update-check.js';

/**
 * A home namespace pinned to a temp dir. Setting SKEIN_HOME makes
 * resolveHomeNamespace return that path directly, so each test gets an isolated
 * cache. NODE_ENV is deliberately left unset here (vitest sets it to 'test',
 * which the disabled-guard honours) so the enabled paths are actually exercised.
 */
async function isolatedEnv(extra: Record<string, string> = {}): Promise<{env: NodeJS.ProcessEnv; home: string}> {
  const home = await mkdtemp(join(tmpdir(), 'skein-update-'));
  return {env: {SKEIN_HOME: home, ...extra}, home};
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {status});
}

describe('compareVersions', () => {
  it('orders numeric major/minor/patch', () => {
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
    expect(compareVersions('1.2.0', '1.1.9')).toBe(1);
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
    expect(compareVersions('0.2.2', '0.2.2')).toBe(0);
  });

  it('tolerates a leading v and build metadata', () => {
    expect(compareVersions('v0.2.3', '0.2.2')).toBe(1);
    expect(compareVersions('1.0.0+build.5', '1.0.0+build.9')).toBe(0);
  });

  it('ranks a release above any prerelease of the same core version', () => {
    expect(compareVersions('1.0.0', '1.0.0-beta.1')).toBe(1);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
  });

  it('orders prerelease identifiers by semver precedence', () => {
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.2')).toBe(-1);
    expect(compareVersions('1.0.0-alpha.9', '1.0.0-beta.1')).toBe(-1);
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
    // Numeric identifiers rank below alphanumeric ones.
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1);
  });

  it('degrades to a stable string compare for unparseable input', () => {
    expect(compareVersions('not-a-version', 'not-a-version')).toBe(0);
    expect(compareVersions('1.2', '1.2')).toBe(0);
  });

  it('compares arbitrarily large valid numeric identifiers without precision loss', () => {
    expect(compareVersions('999999999999999999999.0.0', '999999999999999999998.9.9')).toBe(1);
  });
});

describe('release highlight sanitization', () => {
  it('removes ANSI, controls, bidi overrides, blank values, and caps the list', () => {
    expect(sanitizeHighlights([
      '\u001B[31mAdded setup\u001B[0m',
      'line\n two',
      'safe\u202Etext',
      '',
      42,
      'four',
      'five',
    ])).toEqual(['Added setup', 'line two', 'safetext', 'four']);
  });

  it('drops overlong entries instead of presenting a misleading truncation', () => {
    expect(sanitizeHighlights(['x'.repeat(101), 'usable'])).toEqual(['usable']);
  });
});

describe('isUpdateCheckDisabled', () => {
  it('honours the canonical, legacy, and community opt-out knobs', () => {
    expect(isUpdateCheckDisabled({SKEIN_NO_UPDATE_CHECK: '1'})).toBe(true);
    expect(isUpdateCheckDisabled({MOSAIC_NO_UPDATE_CHECK: '1'})).toBe(true);
    expect(isUpdateCheckDisabled({NO_UPDATE_NOTIFIER: '1'})).toBe(true);
  });

  it('skips under test harnesses and CI', () => {
    expect(isUpdateCheckDisabled({NODE_ENV: 'test'})).toBe(true);
    expect(isUpdateCheckDisabled({CI: 'true'})).toBe(true);
    expect(isUpdateCheckDisabled({GITHUB_ACTIONS: 'true'})).toBe(true);
  });

  it('treats empty and falsey strings as not-opted-out', () => {
    expect(isUpdateCheckDisabled({SKEIN_NO_UPDATE_CHECK: ''})).toBe(false);
    expect(isUpdateCheckDisabled({CI: 'false'})).toBe(false);
    expect(isUpdateCheckDisabled({CI: '0'})).toBe(false);
  });

  it('is enabled by default with a clean env', () => {
    expect(isUpdateCheckDisabled({})).toBe(false);
  });
});

describe('upgrade helpers', () => {
  it('derives the upgrade command and notice text from the package name', () => {
    expect(upgradeCommand()).toBe(`npm i -g ${PACKAGE_NAME}`);
    expect(updateNoticeText({current: '0.2.2', latest: '0.2.3', command: upgradeCommand()}))
      .toBe(`Update available 0.2.2 → 0.2.3 · run npm i -g ${PACKAGE_NAME}`);
  });

  it('locates the cache inside the resolved home namespace', async () => {
    const {env, home} = await isolatedEnv();
    expect(updateCachePath(env)).toBe(join(home, 'update-check.json'));
    await rm(home, {recursive: true, force: true});
  });
});

describe('refreshUpdateCache', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fetches the registry latest, writes the cache, and reports a newer version', async () => {
    const {env, home} = await isolatedEnv();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain(encodeURI(PACKAGE_NAME));
      return jsonResponse({version: '0.9.0'});
    });

    const notice = await refreshUpdateCache('0.2.2', {env, fetchImpl: fetchImpl as unknown as typeof fetch});
    expect(notice).toEqual({current: '0.2.2', latest: '0.9.0', command: upgradeCommand()});
    expect(fetchImpl).toHaveBeenCalledOnce();

    const cache = JSON.parse(await readFile(join(home, 'update-check.json'), 'utf8')) as UpdateCache;
    expect(cache.latest).toBe('0.9.0');
    expect(typeof cache.checkedAt).toBe('number');
    await rm(home, {recursive: true, force: true});
  });

  it('binds bounded release highlights to the fetched latest version', async () => {
    const {env, home} = await isolatedEnv();
    const fetchImpl = vi.fn(async () => jsonResponse({
      version: '0.9.0',
      skein: {releaseNotes: ['Guided setup', '\u001B[32mProtocol-aware relay\u001B[0m']},
    }));
    const notice = await refreshUpdateCache('0.2.2', {env, fetchImpl: fetchImpl as unknown as typeof fetch});
    expect(notice?.highlights).toEqual(['Guided setup', 'Protocol-aware relay']);
    const cache = JSON.parse(await readFile(join(home, 'update-check.json'), 'utf8')) as UpdateCache;
    expect(cache).toMatchObject({
      latest: '0.9.0',
      highlightsFor: '0.9.0',
      highlights: ['Guided setup', 'Protocol-aware relay'],
    });
    await rm(home, {recursive: true, force: true});
  });

  it('returns undefined when already on the latest version', async () => {
    const {env, home} = await isolatedEnv();
    const fetchImpl = vi.fn(async () => jsonResponse({version: '0.2.2'}));
    const notice = await refreshUpdateCache('0.2.2', {env, fetchImpl: fetchImpl as unknown as typeof fetch});
    expect(notice).toBeUndefined();
    await rm(home, {recursive: true, force: true});
  });

  it('does not hit the network within the 24h interval', async () => {
    const {env, home} = await isolatedEnv();
    await writeFile(join(home, 'update-check.json'), JSON.stringify({checkedAt: Date.now(), latest: '0.9.0'} satisfies UpdateCache));
    const fetchImpl = vi.fn(async () => jsonResponse({version: '1.0.0'}));

    const notice = await refreshUpdateCache('0.2.2', {env, fetchImpl: fetchImpl as unknown as typeof fetch});
    expect(fetchImpl).not.toHaveBeenCalled();
    // Surfaces the cached latest, not the un-fetched newer one.
    expect(notice?.latest).toBe('0.9.0');
    await rm(home, {recursive: true, force: true});
  });

  it('re-checks once the interval has elapsed', async () => {
    const {env, home} = await isolatedEnv();
    const stale = Date.now() - CHECK_INTERVAL_MS - 1000;
    await writeFile(join(home, 'update-check.json'), JSON.stringify({checkedAt: stale, latest: '0.2.2'} satisfies UpdateCache));
    const fetchImpl = vi.fn(async () => jsonResponse({version: '0.3.0'}));

    const notice = await refreshUpdateCache('0.2.2', {env, fetchImpl: fetchImpl as unknown as typeof fetch});
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(notice?.latest).toBe('0.3.0');
    await rm(home, {recursive: true, force: true});
  });

  it('keeps the previous cached latest when the network fails', async () => {
    const {env, home} = await isolatedEnv();
    const stale = Date.now() - CHECK_INTERVAL_MS - 1000;
    await writeFile(join(home, 'update-check.json'), JSON.stringify({checkedAt: stale, latest: '0.9.0'} satisfies UpdateCache));
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });

    const notice = await refreshUpdateCache('0.2.2', {env, fetchImpl: fetchImpl as unknown as typeof fetch});
    // Falls back to the last known latest and still advances checkedAt.
    expect(notice?.latest).toBe('0.9.0');
    const cache = JSON.parse(await readFile(join(home, 'update-check.json'), 'utf8')) as UpdateCache;
    expect(cache.latest).toBe('0.9.0');
    expect(cache.checkedAt).toBeGreaterThan(stale);
    await rm(home, {recursive: true, force: true});
  });

  it('is inert when opted out and never touches the network', async () => {
    const {env, home} = await isolatedEnv({SKEIN_NO_UPDATE_CHECK: '1'});
    const fetchImpl = vi.fn(async () => jsonResponse({version: '9.9.9'}));
    const notice = await refreshUpdateCache('0.2.2', {env, fetchImpl: fetchImpl as unknown as typeof fetch});
    expect(notice).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    await rm(home, {recursive: true, force: true});
  });

  it('ignores a malformed registry payload rather than surfacing a bogus notice', async () => {
    const {env, home} = await isolatedEnv();
    const fetchImpl = vi.fn(async () => jsonResponse({dist: 'nope'}));
    const notice = await refreshUpdateCache('0.2.2', {env, fetchImpl: fetchImpl as unknown as typeof fetch});
    expect(notice).toBeUndefined();
    await rm(home, {recursive: true, force: true});
  });

  it('rejects malformed semver even when string ordering would call it newer', async () => {
    const {env, home} = await isolatedEnv();
    const fetchImpl = vi.fn(async () => jsonResponse({version: 'z-not-a-version'}));
    expect(await refreshUpdateCache('0.2.2', {env, fetchImpl: fetchImpl as unknown as typeof fetch})).toBeUndefined();
    expect((await readUpdateCache(env))?.latest).toBeNull();
    await rm(home, {recursive: true, force: true});
  });

  it('clears stale highlights when a newer registry document has no release metadata', async () => {
    const {env, home} = await isolatedEnv();
    const stale = Date.now() - CHECK_INTERVAL_MS - 1000;
    await writeFile(join(home, 'update-check.json'), JSON.stringify({
      checkedAt: stale,
      latest: '0.8.0',
      highlightsFor: '0.8.0',
      highlights: ['Old release note'],
    } satisfies UpdateCache));
    const fetchImpl = vi.fn(async () => jsonResponse({version: '0.9.0'}));
    const notice = await refreshUpdateCache('0.2.2', {env, fetchImpl: fetchImpl as unknown as typeof fetch});
    expect(notice?.latest).toBe('0.9.0');
    expect(notice?.highlights).toBeUndefined();
    const cache = JSON.parse(await readFile(join(home, 'update-check.json'), 'utf8')) as UpdateCache;
    expect(cache.highlights).toBeUndefined();
    expect(cache.highlightsFor).toBeUndefined();
    await rm(home, {recursive: true, force: true});
  });
});

describe('resolveCachedUpdateNotice', () => {
  it('reports a cached newer version without any network call', async () => {
    const {env, home} = await isolatedEnv();
    await writeFile(join(home, 'update-check.json'), JSON.stringify({checkedAt: Date.now(), latest: '0.3.0'} satisfies UpdateCache));
    const notice = await resolveCachedUpdateNotice('0.2.2', env);
    expect(notice).toEqual({current: '0.2.2', latest: '0.3.0', command: upgradeCommand()});
    await rm(home, {recursive: true, force: true});
  });

  it('surfaces cached highlights only when their version binding matches latest', async () => {
    const {env, home} = await isolatedEnv();
    await writeFile(join(home, 'update-check.json'), JSON.stringify({
      checkedAt: Date.now(),
      latest: '0.3.0',
      highlightsFor: '0.2.9',
      highlights: ['Wrong release'],
    } satisfies UpdateCache));
    expect((await resolveCachedUpdateNotice('0.2.2', env))?.highlights).toBeUndefined();
    await rm(home, {recursive: true, force: true});
  });

  it('stays silent with no cache (first run never nags)', async () => {
    const {env, home} = await isolatedEnv();
    expect(await resolveCachedUpdateNotice('0.2.2', env)).toBeUndefined();
    await rm(home, {recursive: true, force: true});
  });

  it('stays silent when the cached latest is not newer', async () => {
    const {env, home} = await isolatedEnv();
    await writeFile(join(home, 'update-check.json'), JSON.stringify({checkedAt: Date.now(), latest: '0.2.2'} satisfies UpdateCache));
    expect(await resolveCachedUpdateNotice('0.2.2', env)).toBeUndefined();
    await rm(home, {recursive: true, force: true});
  });
});

describe('readUpdateCache', () => {
  it('returns null for a corrupt cache file', async () => {
    const {env, home} = await isolatedEnv();
    await writeFile(join(home, 'update-check.json'), '{not json');
    expect(await readUpdateCache(env)).toBeNull();
    await rm(home, {recursive: true, force: true});
  });

  it('returns null for non-finite timestamps and invalid cached versions', async () => {
    const {env, home} = await isolatedEnv();
    await writeFile(join(home, 'update-check.json'), JSON.stringify({checkedAt: null, latest: '9.9.9'}));
    expect(await readUpdateCache(env)).toBeNull();
    await writeFile(join(home, 'update-check.json'), JSON.stringify({checkedAt: Date.now(), latest: '01.2.3'}));
    expect(await readUpdateCache(env)).toBeNull();
    await rm(home, {recursive: true, force: true});
  });

  it('ships release metadata in package.json for future registry notices', async () => {
    const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      skein?: {releaseNotes?: unknown};
    };
    expect(sanitizeHighlights(manifest.skein?.releaseNotes)?.length).toBeGreaterThan(0);
  });
});
