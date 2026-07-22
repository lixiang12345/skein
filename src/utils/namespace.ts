import {createHash, randomUUID} from 'node:crypto';
import {constants, lstatSync} from 'node:fs';
import {chmod, lstat, mkdir, open, readdir, realpath, rename, rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {isInside} from './path.js';

export const CANONICAL_PROJECT_NAMESPACE = '.skein';
export const LEGACY_PROJECT_NAMESPACE = '.mosaic';
export const CANONICAL_HOME_NAMESPACE = '.skein';
export const LEGACY_HOME_NAMESPACE = '.mosaic';
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MIGRATION_MANIFEST_NAME = 'migration-manifest.json';

export type NamespaceKind = 'canonical' | 'legacy' | 'none';

export interface NamespaceResolution {
  workspace: string;
  canonical: string;
  legacy: string;
  active: string;
  activeKind: NamespaceKind;
  canonicalExists: boolean;
  legacyExists: boolean;
  conflict: boolean;
}

export interface NamespaceFileEntry {
  relativePath: string;
  size: number;
  sha256?: string;
  kind: 'file' | 'directory' | 'symlink';
}

export interface NamespaceMigrationManifest {
  version: 1;
  workspace: string;
  source: string;
  destination: string;
  sourceKind: 'legacy';
  destinationKind: 'canonical';
  sourceExists: boolean;
  destinationExists: boolean;
  createdAt: string;
  status: 'ready' | 'complete' | 'conflict' | 'rolled_back' | 'not_available';
  entries: NamespaceFileEntry[];
  conflicts: string[];
  migrationId?: string;
  snapshotSha256?: string;
}

export interface NamespaceRollbackInspection {
  manifest: NamespaceMigrationManifest;
  ready: boolean;
  detail: string;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function isDirectorySync(path: string): boolean {
  try {
    const info = lstatSync(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function resolveProjectNamespace(workspace: string): Promise<NamespaceResolution> {
  const root = resolve(workspace);
  const canonical = join(root, CANONICAL_PROJECT_NAMESPACE);
  const legacy = join(root, LEGACY_PROJECT_NAMESPACE);
  const [canonicalExists, legacyExists] = await Promise.all([isDirectory(canonical), isDirectory(legacy)]);
  // Keep installations on the legacy location until the user opts in to
  // migration. This compatibility release deliberately avoids silently
  // creating a second namespace for a project with no durable state.
  const activeKind: NamespaceKind = canonicalExists ? 'canonical' : legacyExists ? 'legacy' : 'legacy';
  return {
    workspace: root,
    canonical,
    legacy,
    active: activeKind === 'canonical' ? canonical : legacy,
    activeKind,
    canonicalExists,
    legacyExists,
    conflict: canonicalExists && legacyExists,
  };
}

export function resolveProjectNamespaceSync(workspace: string): NamespaceResolution {
  const root = resolve(workspace);
  const canonical = join(root, CANONICAL_PROJECT_NAMESPACE);
  const legacy = join(root, LEGACY_PROJECT_NAMESPACE);
  const canonicalExists = isDirectorySync(canonical);
  const legacyExists = isDirectorySync(legacy);
  const activeKind: NamespaceKind = canonicalExists ? 'canonical' : 'legacy';
  return {
    workspace: root,
    canonical,
    legacy,
    active: activeKind === 'canonical' ? canonical : legacy,
    activeKind,
    canonicalExists,
    legacyExists,
    conflict: canonicalExists && legacyExists,
  };
}

export function resolveHomeNamespace(environment: NodeJS.ProcessEnv = process.env): string {
  const explicit = environment.SKEIN_HOME?.trim() || environment.MOSAIC_HOME?.trim();
  if (explicit) return resolve(explicit);
  // Prefer the canonical directory once it exists; otherwise retain the
  // historical default so upgrades never strand existing state.
  const canonical = join(homedir(), CANONICAL_HOME_NAMESPACE);
  return isDirectorySync(canonical) ? resolve(canonical) : resolve(join(homedir(), LEGACY_HOME_NAMESPACE));
}

export async function resolveHomeStorageNamespace(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<NamespaceResolution> {
  const configuredSkein = environment.SKEIN_HOME?.trim();
  const configuredMosaic = environment.MOSAIC_HOME?.trim();
  const canonical = configuredSkein
    ? resolve(configuredSkein)
    : configuredMosaic
      ? join(dirname(resolve(configuredMosaic)), CANONICAL_HOME_NAMESPACE)
    : join(homedir(), CANONICAL_HOME_NAMESPACE);
  const legacy = configuredMosaic
    ? resolve(configuredMosaic)
    : join(dirname(canonical), LEGACY_HOME_NAMESPACE);
  const root = dirname(canonical);
  const [canonicalExists, legacyExists] = await Promise.all([isDirectory(canonical), isDirectory(legacy)]);
  const activeKind: NamespaceKind = canonicalExists ? 'canonical' : 'legacy';
  return {
    workspace: root,
    canonical,
    legacy,
    active: activeKind === 'canonical' ? canonical : legacy,
    activeKind,
    canonicalExists,
    legacyExists,
    conflict: canonicalExists && legacyExists,
  };
}

export async function inspectProjectNamespace(workspace: string): Promise<NamespaceMigrationManifest> {
  const resolution = await resolveProjectNamespace(workspace);
  return inspectNamespacePaths(resolution.workspace, resolution.legacy, resolution.canonical);
}

export async function inspectHomeNamespace(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<NamespaceMigrationManifest> {
  const resolution = await resolveHomeStorageNamespace(environment);
  return inspectNamespacePaths(resolution.workspace, resolution.legacy, resolution.canonical);
}

async function inspectNamespacePaths(
  workspace: string,
  source: string,
  destination: string,
): Promise<NamespaceMigrationManifest> {
  const entries: NamespaceFileEntry[] = [];
  const conflicts: string[] = [];
  const sourceInfo = await lstatIfExists(source);
  const destinationInfo = await lstatIfExists(destination);
  const sourceExists = Boolean(sourceInfo?.isDirectory() && !sourceInfo.isSymbolicLink());
  const destinationExists = Boolean(destinationInfo?.isDirectory() && !destinationInfo.isSymbolicLink());
  if (sourceInfo && !sourceExists) conflicts.push(`${relative(dirname(source), source)} (invalid namespace path)`);
  if (destinationInfo && !destinationExists) conflicts.push(`${relative(dirname(destination), destination)} (invalid namespace path)`);
  if (sourceExists) await collectEntries(source, '', entries);
  for (const entry of entries) {
    if (entry.kind === 'symlink' || entry.relativePath === MIGRATION_MANIFEST_NAME) conflicts.push(entry.relativePath);
  }
  if (destinationExists) {
    const destinationEntries: NamespaceFileEntry[] = [];
    await collectEntries(destination, '', destinationEntries);
    if (sourceExists && !destinationEntries.some((entry) =>
      entry.relativePath === MIGRATION_MANIFEST_NAME && entry.kind === 'file')) {
      conflicts.push(`${MIGRATION_MANIFEST_NAME} (missing)`);
    }
    const expected = new Map(entries.map((entry) => [entry.relativePath, entryFingerprint(entry)]));
    const observed = new Map(destinationEntries
      .filter((entry) => entry.relativePath !== MIGRATION_MANIFEST_NAME)
      .map((entry) => [entry.relativePath, entryFingerprint(entry)]));
    const paths = new Set([...expected.keys(), ...observed.keys()]);
    for (const path of paths) {
      if (expected.get(path) !== observed.get(path)) conflicts.push(path);
    }
  }
  return {
    version: 1,
    workspace,
    source,
    destination,
    sourceKind: 'legacy',
    destinationKind: 'canonical',
    sourceExists,
    destinationExists,
    createdAt: new Date().toISOString(),
    status: conflicts.length ? 'conflict' : sourceExists && !destinationExists ? 'ready' : 'complete',
    entries,
    conflicts,
  };
}

export async function migrateProjectNamespace(workspace: string): Promise<NamespaceMigrationManifest> {
  const manifest = await inspectProjectNamespace(workspace);
  return migrateNamespace(manifest);
}

export async function migrateHomeNamespace(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<NamespaceMigrationManifest> {
  const manifest = await inspectHomeNamespace(environment);
  return migrateNamespace(manifest);
}

async function migrateNamespace(manifest: NamespaceMigrationManifest): Promise<NamespaceMigrationManifest> {
  if (manifest.status === 'complete') return manifest;
  if (manifest.status === 'conflict') throw new Error(`Namespace migration has conflicts: ${manifest.conflicts.join(', ')}`);
  const parent = dirname(manifest.destination);
  await mkdir(parent, {recursive: true, mode: 0o700});
  const temporary = `${manifest.destination}.migrating-${randomUUID()}`;
  const completed: NamespaceMigrationManifest = {
    ...manifest,
    status: 'complete',
    destinationExists: true,
    migrationId: randomUUID(),
    snapshotSha256: snapshotDigest(manifest.entries),
  };
  try {
    await mkdir(temporary, {recursive: true, mode: 0o700});
    await copyTree(manifest.source, temporary);
    const expected = new Map(manifest.entries.map((entry) => [entry.relativePath, entryFingerprint(entry)]));
    const copiedEntries: NamespaceFileEntry[] = [];
    const currentSourceEntries: NamespaceFileEntry[] = [];
    await Promise.all([
      collectEntries(temporary, '', copiedEntries),
      collectEntries(manifest.source, '', currentSourceEntries),
    ]);
    assertEntriesMatch(expected, copiedEntries, 'migration copy', 'migrate');
    assertEntriesMatch(expected, currentSourceEntries, 'legacy namespace', 'migrate');
    await writeManifest(temporary, completed);
    await rename(temporary, manifest.destination);
  } catch (error) {
    await rm(temporary, {recursive: true, force: true}).catch(() => undefined);
    throw error;
  }
  return completed;
}

export async function rollbackProjectNamespace(workspace: string): Promise<NamespaceMigrationManifest> {
  return rollbackNamespace(await inspectProjectNamespace(workspace));
}

export async function inspectProjectRollback(workspace: string): Promise<NamespaceRollbackInspection> {
  return inspectRollback(await inspectProjectNamespace(workspace));
}

export async function rollbackHomeNamespace(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<NamespaceMigrationManifest> {
  return rollbackNamespace(await inspectHomeNamespace(environment));
}

export async function inspectHomeRollback(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<NamespaceRollbackInspection> {
  return inspectRollback(await inspectHomeNamespace(environment));
}

async function rollbackNamespace(manifest: NamespaceMigrationManifest): Promise<NamespaceMigrationManifest> {
  const inspection = await inspectRollback(manifest);
  const destinationInfo = await lstatIfExists(manifest.destination);
  if (!destinationInfo) {
    return {...manifest, status: 'not_available'};
  }
  if (!inspection.ready) throw new Error(inspection.detail);
  const quarantine = `${manifest.destination}.rollback-${randomUUID()}`;
  await rename(manifest.destination, quarantine);
  try {
    await verifyRollbackManifest(manifest, quarantine);
    await rm(quarantine, {recursive: true, force: false});
  } catch (error) {
    await rename(quarantine, manifest.destination).catch(() => undefined);
    throw error;
  }
  return {...manifest, status: 'rolled_back'};
}

async function inspectRollback(manifest: NamespaceMigrationManifest): Promise<NamespaceRollbackInspection> {
  const destinationInfo = await lstatIfExists(manifest.destination);
  if (!destinationInfo) return {manifest, ready: false, detail: 'No completed migration found.'};
  if (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink()) {
    return {manifest, ready: false, detail: `Cannot roll back a non-directory namespace: ${manifest.destination}`};
  }
  if (!await isDirectory(manifest.source)) {
    return {manifest, ready: false, detail: 'Cannot roll back because the legacy namespace is missing.'};
  }
  if (manifest.status === 'conflict') {
    return {manifest, ready: false, detail: `Namespace rollback has conflicts: ${manifest.conflicts.join(', ')}`};
  }
  try {
    await verifyRollbackManifest(manifest);
    return {manifest, ready: true, detail: 'Rollback snapshot verified.'};
  } catch (error) {
    return {manifest, ready: false, detail: error instanceof Error ? error.message : String(error)};
  }
}

async function verifyRollbackManifest(
  manifest: NamespaceMigrationManifest,
  directory = manifest.destination,
): Promise<void> {
  const manifestPath = join(directory, MIGRATION_MANIFEST_NAME);
  let stored: Partial<NamespaceMigrationManifest>;
  try {
    stored = JSON.parse((await readRegularFile(manifestPath)).data.toString('utf8')) as Partial<NamespaceMigrationManifest>;
  } catch {
    throw new Error('Cannot roll back because the migration manifest is missing or invalid.');
  }
  if (stored.version !== 1 || stored.status !== 'complete' || stored.workspace !== manifest.workspace ||
    stored.source !== manifest.source || stored.destination !== manifest.destination ||
    stored.sourceKind !== 'legacy' || stored.destinationKind !== 'canonical' ||
    stored.sourceExists !== true || stored.destinationExists !== true ||
    typeof stored.createdAt !== 'string' || Number.isNaN(Date.parse(stored.createdAt)) ||
    !Array.isArray(stored.conflicts) || stored.conflicts.length !== 0 ||
    typeof stored.migrationId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(stored.migrationId) ||
    stored.snapshotSha256 !== snapshotDigest(manifest.entries)) {
    throw new Error('Cannot roll back because the migration manifest does not match this namespace.');
  }
  if (!Array.isArray(stored.entries) || stored.entries.some((entry) => !isSafeManifestEntry(entry)) ||
    JSON.stringify(stored.entries) !== JSON.stringify(manifest.entries)) {
    throw new Error('Cannot roll back because the migration manifest was modified.');
  }
  const expected = new Map(manifest.entries.map((entry) => [entry.relativePath, entryFingerprint(entry)]));
  const sourceEntries: NamespaceFileEntry[] = [];
  await collectEntries(manifest.source, '', sourceEntries);
  assertEntriesMatch(expected, sourceEntries, 'legacy namespace');
  const destinationEntries: NamespaceFileEntry[] = [];
  await collectEntries(directory, '', destinationEntries);
  assertEntriesMatch(expected, destinationEntries.filter((entry) => entry.relativePath !== MIGRATION_MANIFEST_NAME), 'canonical namespace');
}

function assertEntriesMatch(
  expected: Map<string, string>,
  actual: NamespaceFileEntry[],
  label: string,
  operation: 'migrate' | 'roll back' = 'roll back',
): void {
  const observed = new Map(actual.map((entry) => [entry.relativePath, entryFingerprint(entry)]));
  if (observed.size !== expected.size || [...expected].some(([path, fingerprint]) => observed.get(path) !== fingerprint)) {
    throw new Error(operation === 'migrate'
      ? `Migration aborted because ${label} did not match the inspected snapshot.`
      : `Cannot roll back because ${label} changed after migration.`);
  }
}

function entryFingerprint(entry: NamespaceFileEntry): string {
  return `${entry.kind}:${entry.size}:${entry.sha256 ?? ''}`;
}

function snapshotDigest(entries: NamespaceFileEntry[]): string {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

function isSafeManifestEntry(value: unknown): value is NamespaceFileEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<NamespaceFileEntry>;
  if (typeof entry.relativePath !== 'string' || !isSafeRelativePath(entry.relativePath)) return false;
  if (entry.kind !== 'file' && entry.kind !== 'directory' && entry.kind !== 'symlink') return false;
  if (typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 0) return false;
  if (entry.kind === 'file') return typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(entry.sha256);
  return entry.size === 0 && entry.sha256 === undefined;
}

function isSafeRelativePath(path: string): boolean {
  return Boolean(path) && !isAbsolute(path) && !path.startsWith('\\') && !path.includes('\0') &&
    !path.split(/[\\/]/u).includes('..');
}

async function lstatIfExists(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function collectEntries(
  root: string,
  prefix: string,
  output: NamespaceFileEntry[],
  realRoot?: string,
): Promise<void> {
  const boundary = realRoot ?? await realpath(root);
  const entries = (await readdir(join(root, prefix), {withFileTypes: true}))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    const relativePath = prefix ? join(prefix, entry.name) : entry.name;
    const path = join(root, relativePath);
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      output.push({relativePath, size: 0, kind: 'symlink'});
      continue;
    }
    await assertRealPathInside(boundary, path);
    if (info.isDirectory()) {
      output.push({relativePath, size: 0, kind: 'directory'});
      await collectEntries(root, relativePath, output, boundary);
      continue;
    }
    if (!info.isFile()) throw new Error(`Unsupported namespace entry: ${relativePath}`);
    const file = await hashRegularFile(path);
    output.push({relativePath, size: file.size, sha256: file.sha256, kind: 'file'});
  }
}

async function copyTree(source: string, destination: string): Promise<void> {
  await copyTreeWithin(source, destination, await realpath(source));
}

async function copyTreeWithin(source: string, destination: string, realRoot: string): Promise<void> {
  const entries = (await readdir(source, {withFileTypes: true}))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    const info = await lstat(from);
    if (info.isSymbolicLink()) throw new Error(`Cannot migrate symbolic link: ${relative(source, from)}`);
    await assertRealPathInside(realRoot, from);
    if (info.isDirectory()) {
      await mkdir(to, {recursive: true, mode: 0o700});
      await copyTreeWithin(from, to, realRoot);
    } else if (info.isFile()) {
      await copyRegularFile(from, to);
    } else throw new Error(`Unsupported namespace entry: ${relative(source, from)}`);
  }
}

async function assertRealPathInside(realRoot: string, path: string): Promise<void> {
  const resolved = await realpath(path);
  if (!isInside(realRoot, resolved)) throw new Error(`Namespace entry escapes its root: ${path}`);
}

async function readRegularFile(path: string): Promise<{data: Buffer; size: number}> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`Namespace entry is not a regular file: ${path}`);
    if (info.size > MAX_MANIFEST_BYTES) {
      throw new Error(`Migration manifest exceeds ${MAX_MANIFEST_BYTES} bytes: ${path}`);
    }
    return {data: await handle.readFile(), size: info.size};
  } finally {
    await handle.close();
  }
}

async function hashRegularFile(path: string): Promise<{sha256: string; size: number}> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`Namespace entry is not a regular file: ${path}`);
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const {bytesRead} = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return {sha256: hash.digest('hex'), size: position};
  } finally {
    await handle.close();
  }
}

async function copyRegularFile(source: string, destination: string): Promise<void> {
  const sourceHandle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let destinationHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const sourceInfo = await sourceHandle.stat();
    if (!sourceInfo.isFile()) throw new Error(`Namespace entry is not a regular file: ${source}`);
    destinationHandle = await open(destination, 'wx', 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const {bytesRead} = await sourceHandle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(buffer, written, bytesRead - written, position + written);
        if (!result.bytesWritten) throw new Error(`Failed to copy namespace file: ${source}`);
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    await destinationHandle.sync();
  } finally {
    try {
      await destinationHandle?.close();
    } finally {
      await sourceHandle.close();
    }
  }
  await chmod(destination, 0o600);
}

async function writeManifest(directory: string, manifest: NamespaceMigrationManifest): Promise<void> {
  const path = join(directory, MIGRATION_MANIFEST_NAME);
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'); await handle.sync(); } finally { await handle.close(); }
}
