import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {resolveHomeNamespace} from './namespace.js';

/**
 * Lightweight update notifier, modelled on the GitHub CLI's approach rather
 * than the `update-notifier` package: no `configstore`/`boxen`/`semver`
 * dependency tree, just a bounded fetch, a 24h on-disk cache, and a strict set
 * of opt-out guards. The network request is always fire-and-forget so it can
 * never delay an interactive session — a stale cache surfaces instantly and the
 * refresh only affects the *next* run (or updates the live timeline if it
 * happens to resolve while the TUI is open).
 */

/** npm package this build publishes as; the registry + upgrade command derive from it. */
export const PACKAGE_NAME = '@skein-code/cli';
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const CACHE_FILE = 'update-check.json';
/** Only hit the network once per day; a fresh cache short-circuits everything. */
export const CHECK_INTERVAL_MS = 1000 * 60 * 60 * 24;
/** Keep the request short so a slow registry never lingers in the background. */
const FETCH_TIMEOUT_MS = 3_000;
const MAX_BODY_BYTES = 1_000_000;

export interface UpdateCache {
  /** Epoch ms of the last check attempt (successful or not); drives the interval. */
  checkedAt: number;
  /** Latest version observed on the registry, or null if never resolved. */
  latest: string | null;
}

export interface UpdateNotice {
  current: string;
  latest: string;
  command: string;
}

type FetchImpl = typeof fetch;

interface RefreshOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchImpl;
  /** Skip the interval gate; used by tests and any explicit "check now" path. */
  force?: boolean;
}

function truthyEnv(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== 'false' && value !== '0';
}

function isCi(env: NodeJS.ProcessEnv): boolean {
  return truthyEnv(env.CI)
    || truthyEnv(env.CONTINUOUS_INTEGRATION)
    || truthyEnv(env.GITHUB_ACTIONS)
    || truthyEnv(env.GITLAB_CI)
    || truthyEnv(env.BUILD_NUMBER);
}

/**
 * Never check when the user opted out, when running under a test harness, or in
 * CI. `SKEIN_NO_UPDATE_CHECK` is the canonical knob; `MOSAIC_NO_UPDATE_CHECK`
 * keeps legacy parity and `NO_UPDATE_NOTIFIER` honours the community standard.
 */
export function isUpdateCheckDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (truthyEnv(env.SKEIN_NO_UPDATE_CHECK) || truthyEnv(env.MOSAIC_NO_UPDATE_CHECK) || truthyEnv(env.NO_UPDATE_NOTIFIER)) {
    return true;
  }
  if (env.NODE_ENV === 'test') return true;
  return isCi(env);
}

interface ParsedVersion {
  main: [number, number, number];
  pre: string[];
}

function parseVersion(value: string): ParsedVersion | null {
  const cleaned = value.trim().replace(/^v/iu, '');
  const buildAt = cleaned.indexOf('+');
  const noBuild = buildAt === -1 ? cleaned : cleaned.slice(0, buildAt);
  const dashAt = noBuild.indexOf('-');
  const mainStr = dashAt === -1 ? noBuild : noBuild.slice(0, dashAt);
  const preStr = dashAt === -1 ? '' : noBuild.slice(dashAt + 1);
  const parts = mainStr.split('.');
  if (parts.length !== 3) return null;
  const [major, minor, patch] = parts.map((part) => Number(part));
  if ([major, minor, patch].some((n) => n === undefined || !Number.isInteger(n) || n < 0)) return null;
  return {main: [major as number, minor as number, patch as number], pre: preStr ? preStr.split('.') : []};
}

/**
 * Semantic-version comparison (subset of semver §11) without a dependency:
 * numeric major/minor/patch, then prerelease precedence where a release
 * outranks any prerelease and numeric identifiers rank below alphanumeric
 * ones. Returns -1/0/1; falls back to a deterministic string compare for
 * anything unparseable so a malformed registry reply is inert.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return a === b ? 0 : a < b ? -1 : 1;
  for (let i = 0; i < 3; i++) {
    const x = pa.main[i] as number;
    const y = pb.main[i] as number;
    if (x !== y) return x < y ? -1 : 1;
  }
  // Equal core version: a release (no prerelease) ranks above any prerelease.
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1; // a has fewer identifiers → lower precedence
    if (y === undefined) return 1;
    const xNum = /^\d+$/u.test(x);
    const yNum = /^\d+$/u.test(y);
    if (xNum && yNum) {
      const nx = Number(x);
      const ny = Number(y);
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1; // numeric identifiers have lower precedence than alphanumeric
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export function updateCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveHomeNamespace(env), CACHE_FILE);
}

export function upgradeCommand(): string {
  return `npm i -g ${PACKAGE_NAME}`;
}

export function updateNoticeText(notice: UpdateNotice): string {
  return `Update available ${notice.current} → ${notice.latest} · run ${notice.command}`;
}

function noticeIfNewer(latest: string | null, current: string): UpdateNotice | undefined {
  if (latest && compareVersions(latest, current) > 0) {
    return {current, latest, command: upgradeCommand()};
  }
  return undefined;
}

export async function readUpdateCache(env: NodeJS.ProcessEnv = process.env): Promise<UpdateCache | null> {
  try {
    const raw = await readFile(updateCachePath(env), 'utf8');
    const parsed = JSON.parse(raw) as Partial<UpdateCache>;
    if (typeof parsed?.checkedAt === 'number' && (typeof parsed.latest === 'string' || parsed.latest === null)) {
      return {checkedAt: parsed.checkedAt, latest: parsed.latest};
    }
  } catch {
    // Missing or corrupt cache is expected on first run; treat as no cache.
  }
  return null;
}

async function writeUpdateCache(cache: UpdateCache, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    // resolveHomeNamespace never returns the canonical (.skein) path unless it
    // already exists or SKEIN_HOME is set, so creating this directory can never
    // prematurely flip the namespace phase-gate to canonical.
    const dir = resolveHomeNamespace(env);
    await mkdir(dir, {recursive: true, mode: 0o700});
    await writeFile(updateCachePath(env), JSON.stringify(cache), 'utf8');
  } catch {
    // A read-only or unwritable home is non-fatal; skip persisting.
  }
}

async function fetchLatestVersion(fetchImpl: FetchImpl, url = REGISTRY_URL): Promise<string | null> {
  try {
    const response = await fetchImpl(url, {
      headers: {accept: 'application/json'},
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = await response.text();
    if (body.length > MAX_BODY_BYTES) return null;
    const parsed = JSON.parse(body) as {version?: unknown};
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * Read-only, no network: returns a notice if the cache already knows about a
 * newer version. Called synchronously-ish before the first TUI paint so a known
 * update shows on the very first frame with zero added latency.
 */
export async function resolveCachedUpdateNotice(
  currentVersion: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<UpdateNotice | undefined> {
  if (isUpdateCheckDisabled(env)) return undefined;
  const cache = await readUpdateCache(env);
  return noticeIfNewer(cache?.latest ?? null, currentVersion);
}

/**
 * Refresh the cache from the registry, honouring the 24h interval. Never throws
 * and never blocks meaningfully (bounded 3s fetch); returns a notice when the
 * resolved latest version outranks the current one. Safe to fire-and-forget.
 */
export async function refreshUpdateCache(
  currentVersion: string,
  options: RefreshOptions = {},
): Promise<UpdateNotice | undefined> {
  const env = options.env ?? process.env;
  if (isUpdateCheckDisabled(env)) return undefined;
  const cache = await readUpdateCache(env);
  const now = Date.now();
  if (!options.force && cache && now - cache.checkedAt < CHECK_INTERVAL_MS) {
    // Within the interval: surface the cached result without touching the network.
    return noticeIfNewer(cache.latest, currentVersion);
  }
  const latest = await fetchLatestVersion(options.fetchImpl ?? fetch);
  const effectiveLatest = latest ?? cache?.latest ?? null;
  await writeUpdateCache({checkedAt: now, latest: effectiveLatest}, env);
  return noticeIfNewer(effectiveLatest, currentVersion);
}
