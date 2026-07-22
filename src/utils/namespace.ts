import {createHash, randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {chmod, lstat, mkdir, open, readdir, readFile, rename, rm, stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';

export const CANONICAL_PROJECT_NAMESPACE = '.skein';
export const LEGACY_PROJECT_NAMESPACE = '.mosaic';
export const CANONICAL_HOME_NAMESPACE = '.skein';
export const LEGACY_HOME_NAMESPACE = '.mosaic';

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
  createdAt: string;
  status: 'ready' | 'complete' | 'conflict';
  entries: NamespaceFileEntry[];
  conflicts: string[];
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
  const canonicalExists = existsSync(canonical);
  const legacyExists = existsSync(legacy);
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
  return existsSync(canonical) ? resolve(canonical) : resolve(join(homedir(), LEGACY_HOME_NAMESPACE));
}

export async function inspectProjectNamespace(workspace: string): Promise<NamespaceMigrationManifest> {
  const resolution = await resolveProjectNamespace(workspace);
  const entries: NamespaceFileEntry[] = [];
  const conflicts: string[] = [];
  if (resolution.legacyExists) await collectEntries(resolution.legacy, '', entries);
  for (const entry of entries) {
    if (entry.kind === 'symlink') conflicts.push(entry.relativePath);
  }
  if (resolution.canonicalExists) {
    const destinationEntries: NamespaceFileEntry[] = [];
    await collectEntries(resolution.canonical, '', destinationEntries);
    const destinationByPath = new Map(destinationEntries.map((entry) => [entry.relativePath, entry]));
    for (const entry of entries) {
      const existing = destinationByPath.get(entry.relativePath);
      if (existing && (existing.sha256 !== entry.sha256 || existing.size !== entry.size)) conflicts.push(entry.relativePath);
    }
  }
  return {
    version: 1,
    workspace: resolution.workspace,
    source: resolution.legacy,
    destination: resolution.canonical,
    sourceKind: 'legacy',
    destinationKind: 'canonical',
    createdAt: new Date().toISOString(),
    status: conflicts.length ? 'conflict' : resolution.legacyExists && !resolution.canonicalExists ? 'ready' : 'complete',
    entries,
    conflicts,
  };
}

export async function migrateProjectNamespace(workspace: string): Promise<NamespaceMigrationManifest> {
  const manifest = await inspectProjectNamespace(workspace);
  if (manifest.status === 'complete') return manifest;
  if (manifest.status === 'conflict') throw new Error(`Namespace migration has conflicts: ${manifest.conflicts.join(', ')}`);
  const parent = dirname(manifest.destination);
  await mkdir(parent, {recursive: true, mode: 0o700});
  const temporary = `${manifest.destination}.migrating-${randomUUID()}`;
  try {
    await mkdir(temporary, {recursive: true, mode: 0o700});
    await copyTree(manifest.source, temporary);
    await writeManifest(temporary, {...manifest, status: 'complete'});
    await rename(temporary, manifest.destination);
  } catch (error) {
    await rm(temporary, {recursive: true, force: true}).catch(() => undefined);
    throw error;
  }
  return {...manifest, status: 'complete'};
}

async function collectEntries(root: string, prefix: string, output: NamespaceFileEntry[]): Promise<void> {
  const entries = await readdir(join(root, prefix), {withFileTypes: true});
  for (const entry of entries) {
    const relativePath = prefix ? join(prefix, entry.name) : entry.name;
    const path = join(root, relativePath);
    if (entry.isSymbolicLink()) {
      output.push({relativePath, size: 0, kind: 'symlink'});
      continue;
    }
    if (entry.isDirectory()) {
      output.push({relativePath, size: 0, kind: 'directory'});
      await collectEntries(root, relativePath, output);
      continue;
    }
    const info = await stat(path);
    const hash = createHash('sha256').update(await readFile(path)).digest('hex');
    output.push({relativePath, size: info.size, sha256: hash, kind: 'file'});
  }
}

async function copyTree(source: string, destination: string): Promise<void> {
  const entries = await readdir(source, {withFileTypes: true});
  for (const entry of entries) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Cannot migrate symbolic link: ${relative(source, from)}`);
    if (entry.isDirectory()) {
      await mkdir(to, {recursive: true, mode: 0o700});
      await copyTree(from, to);
    } else {
      const data = await readFile(from);
      const handle = await open(to, 'wx', 0o600);
      try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      await chmod(to, 0o600);
    }
  }
}

async function writeManifest(directory: string, manifest: NamespaceMigrationManifest): Promise<void> {
  const path = join(directory, 'migration-manifest.json');
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'); await handle.sync(); } finally { await handle.close(); }
}
