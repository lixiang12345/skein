import {createHash} from 'node:crypto';
import {chmod, lstat, mkdir, realpath} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';

const LEASE_SCHEMA_VERSION = 1;
const INITIALIZE_ATTEMPTS = 20;
const INITIALIZE_RETRY_MS = 25;

export type NamespaceLeaseMode = 'shared' | 'exclusive';

export interface NamespaceLease {
  target: string;
  path: string;
  mode: NamespaceLeaseMode;
  release(): void;
}

export class NamespaceLeaseBusyError extends Error {
  readonly code = 'SKEIN_NAMESPACE_BUSY';

  constructor(readonly target: string, readonly mode: NamespaceLeaseMode) {
    super(mode === 'exclusive'
      ? `Namespace storage is in use by another Skein process: ${target}. Stop active sessions and retry.`
      : `A namespace migration is already running for ${target}. Retry after it finishes.`);
    this.name = 'NamespaceLeaseBusyError';
  }
}

export async function acquireNamespaceLease(
  target: string,
  mode: NamespaceLeaseMode,
): Promise<NamespaceLease> {
  const normalizedTarget = await resolvePhysicalPath(target);
  const path = await namespaceLeasePath(normalizedTarget);
  const {DatabaseSync} = await import('node:sqlite');
  await initializeLeaseDatabase(DatabaseSync, path, normalizedTarget, mode);
  const database = new DatabaseSync(path);
  try {
    database.exec('PRAGMA busy_timeout = 0;');
    if (mode === 'exclusive') database.exec('BEGIN EXCLUSIVE;');
    else database.exec('BEGIN;');
    const row = database.prepare(
      'SELECT version FROM namespace_lease WHERE id = 1',
    ).get() as {version?: number} | undefined;
    if (row?.version !== LEASE_SCHEMA_VERSION) {
      throw new Error(`Namespace lease database is invalid: ${path}`);
    }
  } catch (error) {
    database.close();
    if (isSqliteBusy(error)) throw new NamespaceLeaseBusyError(normalizedTarget, mode);
    throw error;
  }

  let released = false;
  return {
    target: normalizedTarget,
    path,
    mode,
    release() {
      if (released) return;
      released = true;
      try {
        database.exec('ROLLBACK;');
      } finally {
        database.close();
      }
    },
  };
}

export async function withNamespaceLease<T>(
  target: string,
  mode: NamespaceLeaseMode,
  operation: () => Promise<T>,
): Promise<T> {
  const lease = await acquireNamespaceLease(target, mode);
  try {
    return await operation();
  } finally {
    lease.release();
  }
}

export async function namespaceLeasePath(target: string): Promise<string> {
  const directory = await ensureLeaseDirectory();
  const normalized = await resolvePhysicalPath(target);
  const key = createHash('sha256').update(normalized).digest('hex');
  return join(directory, `${key}.sqlite`);
}

async function initializeLeaseDatabase(
  Database: typeof DatabaseSync,
  path: string,
  target: string,
  mode: NamespaceLeaseMode,
): Promise<void> {
  for (let attempt = 0; attempt < INITIALIZE_ATTEMPTS; attempt += 1) {
    await assertLeaseFile(path, true);
    const database = new Database(path);
    try {
      database.exec('PRAGMA busy_timeout = 0;');
      const table = database.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'namespace_lease'",
      ).get() as {name?: string} | undefined;
      if (!table) {
        const journal = database.prepare('PRAGMA journal_mode = DELETE').get() as
          {journal_mode?: string} | undefined;
        if (journal?.journal_mode?.toLocaleLowerCase() !== 'delete') {
          throw new Error(`Namespace lease database must use rollback-journal mode: ${path}`);
        }
        database.exec('BEGIN EXCLUSIVE;');
        try {
          database.exec(`
            CREATE TABLE namespace_lease (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              version INTEGER NOT NULL CHECK (version = ${LEASE_SCHEMA_VERSION})
            );
            INSERT INTO namespace_lease (id, version) VALUES (1, ${LEASE_SCHEMA_VERSION});
          `);
          database.exec('COMMIT;');
        } catch (error) {
          database.exec('ROLLBACK;');
          throw error;
        }
      } else {
        const journal = database.prepare('PRAGMA journal_mode').get() as
          {journal_mode?: string} | undefined;
        const row = database.prepare(
          'SELECT version FROM namespace_lease WHERE id = 1',
        ).get() as {version?: number} | undefined;
        if (journal?.journal_mode?.toLocaleLowerCase() !== 'delete' ||
          row?.version !== LEASE_SCHEMA_VERSION) {
          throw new Error(`Namespace lease database is invalid: ${path}`);
        }
      }
      database.close();
      await chmod(path, 0o600);
      await assertLeaseFile(path, false);
      return;
    } catch (error) {
      try { database.close(); } catch { /* The original error is more useful. */ }
      if (!isSqliteBusy(error)) throw error;
      if (attempt === INITIALIZE_ATTEMPTS - 1) {
        throw new NamespaceLeaseBusyError(target, mode);
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, INITIALIZE_RETRY_MS));
    }
  }
}

async function ensureLeaseDirectory(): Promise<string> {
  const owner = typeof process.getuid === 'function'
    ? String(process.getuid())
    : createHash('sha256').update(homedir()).digest('hex').slice(0, 16);
  const runtimeRoot = process.platform === 'win32' ? tmpdir() : '/tmp';
  const directory = join(runtimeRoot, `skein-${owner}-namespace-leases`);
  try {
    await mkdir(directory, {mode: 0o700});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() ||
    (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    throw new Error(`Namespace lease directory is not private: ${directory}`);
  }
  await chmod(directory, 0o700);
  return directory;
}

async function assertLeaseFile(path: string, allowMissing: boolean): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
      throw new Error(`Namespace lease path is not a private regular file: ${path}`);
    }
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

async function resolvePhysicalPath(path: string): Promise<string> {
  let current = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(current), ...missing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

function isSqliteBusy(error: unknown): boolean {
  const sqlite = error as {errcode?: number; errstr?: string; message?: string};
  return sqlite.errcode === 5 || sqlite.errcode === 6 ||
    /database is (?:locked|busy)/iu.test(sqlite.errstr ?? sqlite.message ?? '');
}
