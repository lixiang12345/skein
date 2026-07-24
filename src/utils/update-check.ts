import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import stripAnsi from 'strip-ansi';
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

/** Hard caps on the optional release-highlight metadata so a hostile or bloated
 * registry reply can never grow the cache, the timeline, or a status line
 * without bound. Highlights are purely cosmetic; anything that fails these
 * limits is dropped rather than truncated into something misleading. */
const MAX_HIGHLIGHTS = 4;
const MAX_HIGHLIGHT_LENGTH = 100;
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

export interface UpdateCache {
  /** Epoch ms of the last check attempt (successful or not); drives the interval. */
  checkedAt: number;
  /** Latest version observed on the registry, or null if never resolved. */
  latest: string | null;
  /** Sanitised, bounded release highlights for the latest version, if any. */
  highlights?: string[];
  /** Version the optional highlights describe. They are ignored unless it matches `latest`. */
  highlightsFor?: string;
}

export interface UpdateNotice {
  current: string;
  latest: string;
  command: string;
  /** 0-4 short, sanitised highlight lines; absent when the registry omits them. */
  highlights?: string[];
}

interface LatestMeta {
  version: string | null;
  highlights?: string[];
}

/**
 * Coerce an arbitrary registry field into at most {@link MAX_HIGHLIGHTS} short,
 * single-line strings. Non-arrays, non-strings, control characters, and blank
 * or over-long entries are discarded; the result is `undefined` when nothing
 * survives so the caller can cleanly fall back to the plain version notice.
 */
export function sanitizeHighlights(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const cleaned: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    // Collapse whitespace and strip C0/C1 control characters so a highlight can
    // never inject newlines, ANSI escapes, or cursor moves into the terminal.
    const flattened = stripAnsi(entry)
      .replace(BIDI_CONTROLS, '')
      .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
    if (!flattened || flattened.length > MAX_HIGHLIGHT_LENGTH) continue;
    cleaned.push(flattened);
    if (cleaned.length >= MAX_HIGHLIGHTS) break;
  }
  return cleaned.length ? cleaned : undefined;
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
  main: [bigint, bigint, bigint];
  pre: string[];
}

function parseVersion(value: string): ParsedVersion | null {
  const cleaned = value.trim().replace(/^v/u, '');
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(cleaned);
  if (!match) return null;
  const pre = match[4]?.split('.') ?? [];
  // SemVer forbids leading zeroes in numeric prerelease identifiers.
  if (pre.some((part) => /^\d+$/u.test(part) && part.length > 1 && part.startsWith('0'))) return null;
  return {
    main: [BigInt(match[1] as string), BigInt(match[2] as string), BigInt(match[3] as string)],
    pre,
  };
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
    const x = pa.main[i] as bigint;
    const y = pb.main[i] as bigint;
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
      const nx = BigInt(x);
      const ny = BigInt(y);
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

function noticeIfNewer(
  latest: string | null,
  current: string,
  highlights?: string[],
): UpdateNotice | undefined {
  // Registry and cache data are untrusted. A malformed version must never fall
  // through to compareVersions' deterministic string ordering and create a
  // bogus upgrade prompt.
  if (latest && parseVersion(latest) && parseVersion(current) && compareVersions(latest, current) > 0) {
    const clean = sanitizeHighlights(highlights);
    return {current, latest, command: upgradeCommand(), ...(clean ? {highlights: clean} : {})};
  }
  return undefined;
}

export async function readUpdateCache(env: NodeJS.ProcessEnv = process.env): Promise<UpdateCache | null> {
  try {
    const raw = await readFile(updateCachePath(env), 'utf8');
    const parsed = JSON.parse(raw) as Partial<UpdateCache>;
    if (typeof parsed?.checkedAt === 'number' && Number.isFinite(parsed.checkedAt) && parsed.checkedAt >= 0 &&
        (parsed.latest === null || (typeof parsed.latest === 'string' && parseVersion(parsed.latest)))) {
      const latest = typeof parsed.latest === 'string' ? parsed.latest : null;
      // Re-sanitise on read so a hand-edited or legacy cache can never smuggle
      // unbounded or control-laden highlights into the live UI.
      const highlights = latest && parsed.highlightsFor === latest
        ? sanitizeHighlights(parsed.highlights)
        : undefined;
      return {
        checkedAt: parsed.checkedAt,
        latest,
        ...(highlights && latest ? {highlights, highlightsFor: latest} : {}),
      };
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

async function fetchLatestMeta(fetchImpl: FetchImpl, url = REGISTRY_URL): Promise<LatestMeta> {
  try {
    const response = await fetchImpl(url, {
      headers: {accept: 'application/json'},
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return {version: null};
    const body = await response.text();
    if (body.length > MAX_BODY_BYTES) return {version: null};
    // Read highlights from a bespoke `skein.releaseNotes` field so we never
    // depend on npm's own schema; the registry's `/latest` document echoes any
    // custom top-level package key. Sanitisation is the real guard — the field
    // name is only a convention.
    const parsed = JSON.parse(body) as {version?: unknown; skein?: {releaseNotes?: unknown}};
    const version = typeof parsed.version === 'string' && parseVersion(parsed.version)
      ? parsed.version
      : null;
    const highlights = sanitizeHighlights(parsed.skein?.releaseNotes);
    return {version, ...(highlights ? {highlights} : {})};
  } catch {
    return {version: null};
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
  return noticeIfNewer(cache?.latest ?? null, currentVersion, cache?.highlights);
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
    return noticeIfNewer(cache.latest, currentVersion, cache.highlights);
  }
  const meta = await fetchLatestMeta(options.fetchImpl ?? fetch);
  const effectiveLatest = meta.version ?? cache?.latest ?? null;
  // Only keep highlights that describe the version we're actually surfacing:
  // fresh highlights when the fetch resolved, otherwise the cached ones that
  // belong to the retained cached version. A version with no highlights clears
  // any stale ones rather than pairing them with the wrong release.
  const highlights = meta.version
    ? meta.highlights
    : cache?.latest === effectiveLatest ? cache?.highlights : undefined;
  await writeUpdateCache({
    checkedAt: now,
    latest: effectiveLatest,
    ...(highlights && effectiveLatest ? {highlights, highlightsFor: effectiveLatest} : {}),
  }, env);
  return noticeIfNewer(effectiveLatest, currentVersion, highlights);
}
