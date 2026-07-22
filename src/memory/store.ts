import {createHash, randomUUID} from 'node:crypto';
import {chmod, lstat, mkdir} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import type {MemoryScope} from '../types.js';
import {resolveHomeNamespace} from '../utils/namespace.js';

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  scopeKey: string;
  content: string;
  tags: string[];
  kind: MemoryKind;
  importance: number;
  confidence: number;
  source: string;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
  lastVerifiedAt?: string;
  revision?: string;
  supersedesId?: string;
  conflictKey?: string;
  expiresAt?: string;
  score?: number;
  relevance?: number;
  matchReason?: string;
}

export type MemoryKind = 'semantic' | 'episodic' | 'procedural';

export interface RememberInput {
  scope: MemoryScope;
  scopeKey: string;
  content: string;
  tags?: string[];
  kind?: MemoryKind;
  importance?: number;
  confidence?: number;
  source?: string;
  lastVerifiedAt?: string;
  revision?: string;
  supersedesId?: string;
  conflictKey?: string;
  expiresAt?: string;
}

export interface MemorySearchOptions {
  scopes?: Array<{scope: MemoryScope; scopeKey: string}>;
  limit?: number;
  includeArchived?: boolean;
  kinds?: MemoryKind[];
  minimumRelevance?: number;
  now?: string;
  touch?: boolean;
}

export interface MemoryCandidate {
  id: string;
  scope: MemoryScope;
  scopeKey: string;
  content: string;
  tags: string[];
  kind: MemoryKind;
  importance: number;
  confidence: number;
  source: string;
  rationale: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  updatedAt: string;
  approvedMemoryId?: string;
  revision?: string;
  conflictKey?: string;
  expiresAt?: string;
}

export interface ProposeMemoryInput extends Omit<RememberInput, 'source'> {
  source?: string;
  rationale?: string;
}

interface MemoryRow {
  id: string;
  scope: MemoryScope;
  scope_key: string;
  content: string;
  tags: string;
  kind: MemoryKind;
  importance: number;
  confidence: number;
  source: string;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
  last_accessed_at: string;
  last_verified_at?: string | null;
  revision?: string | null;
  supersedes_id?: string | null;
  conflict_key?: string | null;
  expires_at?: string | null;
  score?: number;
  relevance?: number;
  matchReason?: string;
}

interface CandidateRow {
  id: string;
  scope: MemoryScope;
  scope_key: string;
  content: string;
  tags: string;
  kind: MemoryKind;
  importance: number;
  confidence: number;
  source: string;
  rationale: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  updated_at: string;
  approved_memory_id?: string | null;
  revision?: string | null;
  conflict_key?: string | null;
  expires_at?: string | null;
  content_hash: string;
}

const MAX_MEMORY_CHARS = 12_000;
const INFERRED_MEMORY_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MEMORY_CANDIDATE_TTL_MS = 14 * 24 * 60 * 60 * 1_000;

export class MemoryStore {
  readonly path: string;
  private database: DatabaseSync | undefined;

  constructor(path = defaultMemoryPath()) {
    this.path = resolve(path);
  }

  async open(): Promise<this> {
    if (this.database) return this;
    // Load node:sqlite lazily so the CLI can install its narrow warning filter
    // before Node evaluates the experimental module.
    const {DatabaseSync} = await import('node:sqlite');
    const directory = dirname(this.path);
    await mkdir(directory, {recursive: true, mode: 0o700});
    await rejectSymlink(directory);
    await rejectSymlink(this.path, true);
    const database = new DatabaseSync(this.path);
    const previousSchemaVersion = (database.prepare('PRAGMA user_version').get() as
      {user_version?: number} | undefined)?.user_version ?? 0;
    database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
    database.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        rowid INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        scope TEXT NOT NULL CHECK(scope IN ('user', 'workspace', 'session', 'agent')),
        scope_key TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        kind TEXT NOT NULL DEFAULT 'semantic',
        importance REAL NOT NULL DEFAULT 0.5,
        confidence REAL NOT NULL DEFAULT 0.7,
        source TEXT NOT NULL DEFAULT 'user',
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
        content_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_accessed_at TEXT NOT NULL,
        last_verified_at TEXT,
        revision TEXT,
        supersedes_id TEXT,
        conflict_key TEXT,
        expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS memories_scope_idx ON memories(scope, scope_key, status);
      CREATE INDEX IF NOT EXISTS memories_updated_idx ON memories(updated_at DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        content,
        tags,
        content='memories',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memory_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, content, tags)
        VALUES ('delete', old.rowid, old.content, old.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, content, tags)
        VALUES ('delete', old.rowid, old.content, old.tags);
        INSERT INTO memory_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
      END;
    `);
    migrateMemoryColumns(database);
    database.exec(`
      CREATE INDEX IF NOT EXISTS memories_conflict_idx
        ON memories(scope, scope_key, conflict_key, status);
      CREATE INDEX IF NOT EXISTS memories_expiry_idx ON memories(expires_at);
      CREATE TABLE IF NOT EXISTS memory_candidates (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK(scope IN ('user', 'workspace', 'session', 'agent')),
        scope_key TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        kind TEXT NOT NULL DEFAULT 'semantic',
        importance REAL NOT NULL DEFAULT 0.5,
        confidence REAL NOT NULL DEFAULT 0.6,
        source TEXT NOT NULL DEFAULT 'model',
        rationale TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'approved', 'rejected')),
        content_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        approved_memory_id TEXT,
        revision TEXT,
        conflict_key TEXT,
        expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS memory_candidates_status_idx
        ON memory_candidates(status, updated_at DESC);
    `);
    migrateCandidateColumns(database);
    if (previousSchemaVersion < 2) {
      database.exec("INSERT INTO memory_fts(memory_fts) VALUES('rebuild');");
      database.exec('PRAGMA user_version = 2;');
    }
    this.database = database;
    await chmod(this.path, 0o600).catch(() => undefined);
    return this;
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }

  remember(input: RememberInput): MemoryRecord {
    const database = this.requireDatabase();
    const content = normalizeContent(input.content);
    rejectSensitiveMemory(content);
    const scopeKey = input.scopeKey.trim();
    if (!scopeKey || scopeKey.length > 4_000) throw new Error('Memory scope key is invalid.');
    const tags = normalizeTags(input.tags ?? []);
    const importance = clamp(input.importance ?? 0.5, 0, 1);
    const source = normalizeOptional(input.source, 240) ?? 'user';
    const explicit = source === 'user' || source.startsWith('interactive:') || source.startsWith('approved:');
    const kind = normalizeKind(input.kind);
    const confidence = clamp(input.confidence ?? (explicit ? 1 : 0.7), 0, 1);
    const revision = normalizeOptional(input.revision, 240);
    const conflictKey = normalizeOptional(input.conflictKey, 240);
    const now = new Date().toISOString();
    const defaultExpiry = !explicit && !input.expiresAt
      ? new Date(Date.now() + INFERRED_MEMORY_TTL_MS).toISOString()
      : undefined;
    const expiresAt = normalizeTimestamp(input.expiresAt ?? defaultExpiry, 'Memory expiration');
    const lastVerifiedAt = normalizeTimestamp(
      input.lastVerifiedAt ?? (explicit ? now : undefined),
      'Memory verification time',
    );
    const hash = createHash('sha256')
      .update(`${input.scope}\0${scopeKey}\0${content.toLocaleLowerCase()}`)
      .digest('hex');
    database.exec('BEGIN IMMEDIATE');
    try {
      const existing = database.prepare(
        'SELECT * FROM memories WHERE content_hash = ?',
      ).get(hash) as MemoryRow | undefined;
      const conflicting = conflictKey
        ? database.prepare(`
          SELECT * FROM memories
          WHERE scope = ? AND scope_key = ? AND conflict_key = ?
            AND status = 'active' AND content_hash <> ?
          ORDER BY updated_at DESC
        `).all(input.scope, scopeKey, conflictKey, hash) as unknown as MemoryRow[]
        : [];
      const supersedesId = normalizeOptional(input.supersedesId, 80) ?? conflicting[0]?.id;
      let id: string;
      if (existing) {
        id = existing.id;
        const mergedTags = normalizeTags([...parseTags(existing.tags), ...tags]);
        database.prepare(`
          UPDATE memories SET
            tags = ?, kind = ?, importance = ?, confidence = ?, source = ?,
            status = 'active', updated_at = ?, last_accessed_at = ?,
            last_verified_at = ?, revision = ?, supersedes_id = ?, conflict_key = ?, expires_at = ?
          WHERE id = ?
        `).run(
          JSON.stringify(mergedTags), input.kind ?? existing.kind ?? kind,
          Math.max(existing.importance, importance), Math.max(existing.confidence ?? 0.7, confidence),
          source, now, now, lastVerifiedAt ?? existing.last_verified_at ?? null,
          revision ?? existing.revision ?? null, supersedesId ?? existing.supersedes_id ?? null,
          conflictKey ?? existing.conflict_key ?? null, expiresAt ?? existing.expires_at ?? null, id,
        );
      } else {
        id = randomUUID();
        database.prepare(`
          INSERT INTO memories (
            id, scope, scope_key, content, tags, kind, importance, confidence, source, status,
            content_hash, created_at, updated_at, last_accessed_at, last_verified_at,
            revision, supersedes_id, conflict_key, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, input.scope, scopeKey, content, JSON.stringify(tags), kind, importance, confidence,
          source, hash, now, now, now, lastVerifiedAt ?? null, revision ?? null,
          supersedesId ?? null, conflictKey ?? null, expiresAt ?? null,
        );
      }
      if (conflicting.length) {
        const archive = database.prepare(
          "UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ?",
        );
        for (const record of conflicting) archive.run(now, record.id);
      }
      database.exec('COMMIT');
      return this.get(id) as MemoryRecord;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  get(id: string): MemoryRecord | undefined {
    const row = this.requireDatabase().prepare(
      'SELECT * FROM memories WHERE id = ?',
    ).get(id) as MemoryRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  search(query: string, options: MemorySearchOptions = {}): MemoryRecord[] {
    const database = this.requireDatabase();
    const limit = clamp(Math.floor(options.limit ?? 8), 1, 100);
    const filters = buildMemoryFilters(options);
    const hasQuery = query.trim().length > 0;
    const ftsQuery = safeFtsQuery(query);
    const candidateLimit = Math.min(200, Math.max(limit * 4, limit));
    let rows: MemoryRow[] = [];
    if (ftsQuery) {
      try {
        rows = database.prepare(`
          SELECT m.*, bm25(memory_fts, 1.0, 0.35) AS score
          FROM memory_fts
          JOIN memories m ON m.rowid = memory_fts.rowid
          WHERE memory_fts MATCH ?${filters.sql}
          ORDER BY bm25(memory_fts, 1.0, 0.35) ASC, m.updated_at DESC
          LIMIT ?
        `).all(ftsQuery, ...filters.parameters, candidateLimit) as unknown as MemoryRow[];
      } catch {
        // FTS syntax or tokenizer support can vary across SQLite builds; the
        // substring fallback below keeps memory search useful in that case.
        rows = [];
      }
    } else if (!hasQuery) {
      rows = database.prepare(`
        SELECT m.*, 0 AS score FROM memories m
        WHERE 1 = 1${filters.sql}
        ORDER BY m.importance DESC, m.confidence DESC, m.updated_at DESC LIMIT ?
      `).all(...filters.parameters, candidateLimit) as unknown as MemoryRow[];
    }

    // unicode61 tokenization does not reliably find CJK phrases, paths, or
    // short identifiers. A bounded substring pass provides a deterministic
    // local fallback without introducing an external embedding service.
    if (hasQuery && rows.length < candidateLimit) {
      const terms = searchTerms(query);
      if (terms.length) {
        const conditions = terms.map(() => "instr(lower(m.content || ' ' || m.tags), lower(?)) > 0");
        const fallback = database.prepare(`
          SELECT m.*, 0 AS score FROM memories m
          WHERE (${conditions.join(' OR ')})${filters.sql}
          ORDER BY m.importance DESC, m.confidence DESC, m.updated_at DESC LIMIT ?
        `).all(...terms, ...filters.parameters, candidateLimit) as unknown as MemoryRow[];
        const seen = new Set(rows.map((row) => row.id));
        for (const row of fallback) {
          if (!seen.has(row.id)) {
            rows.push(row);
            seen.add(row.id);
          }
        }
      }
    }
    const ranked = rows
      .map((row) => rankMemory(row, query))
      .filter((row) => row.relevance >= (options.minimumRelevance ?? 0))
      .sort((left, right) => right.relevance - left.relevance ||
        right.updated_at.localeCompare(left.updated_at))
      .slice(0, limit);
    if (options.touch !== false && ranked.length) {
      const now = new Date().toISOString();
      const update = database.prepare('UPDATE memories SET last_accessed_at = ? WHERE id = ?');
      for (const row of ranked) update.run(now, row.id);
    }
    return ranked.map((row) => toRecord(row));
  }

  list(options: MemorySearchOptions = {}): MemoryRecord[] {
    return this.search('', options);
  }

  propose(input: ProposeMemoryInput): MemoryCandidate {
    const database = this.requireDatabase();
    const content = normalizeContent(input.content);
    rejectSensitiveMemory(content);
    const scopeKey = input.scopeKey.trim();
    if (!scopeKey || scopeKey.length > 4_000) throw new Error('Memory scope key is invalid.');
    const tags = normalizeTags(input.tags ?? []);
    const kind = normalizeKind(input.kind);
    const importance = clamp(input.importance ?? 0.5, 0, 1);
    const confidence = clamp(input.confidence ?? 0.6, 0, 1);
    const source = normalizeOptional(input.source, 240) ?? 'model';
    const rationale = normalizeOptional(input.rationale, 1_000) ?? '';
    const revision = normalizeOptional(input.revision, 240);
    const conflictKey = normalizeOptional(input.conflictKey, 240);
    const candidateDefaultExpiry = !input.expiresAt
      ? new Date(Date.now() + MEMORY_CANDIDATE_TTL_MS).toISOString()
      : undefined;
    const expiresAt = normalizeTimestamp(input.expiresAt ?? candidateDefaultExpiry, 'Memory expiration');
    const hash = createHash('sha256')
      .update(`${input.scope}\0${scopeKey}\0${content.toLocaleLowerCase()}`)
      .digest('hex');
    const existing = database.prepare(
      'SELECT * FROM memory_candidates WHERE content_hash = ?',
    ).get(hash) as CandidateRow | undefined;
    const now = new Date().toISOString();
    if (existing) {
      if (existing.status === 'approved' && existing.approved_memory_id) {
        const approved = database.prepare(
          "SELECT status FROM memories WHERE id = ?",
        ).get(existing.approved_memory_id) as {status?: 'active' | 'archived'} | undefined;
        // Repeated model observations of an already-approved active fact are
        // reinforcement, not a new approval request.
        if (approved?.status === 'active') return this.getCandidate(existing.id) as MemoryCandidate;
      }
      database.prepare(`
        UPDATE memory_candidates SET tags = ?, kind = ?, importance = ?, confidence = ?,
          source = ?, rationale = ?, status = 'pending', updated_at = ?, approved_memory_id = NULL,
          revision = ?, conflict_key = ?, expires_at = ?
        WHERE id = ?
      `).run(
        JSON.stringify(normalizeTags([...parseTags(existing.tags), ...tags])), kind,
        Math.max(existing.importance, importance), Math.max(existing.confidence, confidence),
        source, rationale || existing.rationale, now, revision ?? existing.revision ?? null,
        conflictKey ?? existing.conflict_key ?? null, expiresAt ?? existing.expires_at ?? null, existing.id,
      );
      return this.getCandidate(existing.id) as MemoryCandidate;
    }
    const id = randomUUID();
    database.prepare(`
      INSERT INTO memory_candidates (
        id, scope, scope_key, content, tags, kind, importance, confidence,
        source, rationale, status, content_hash, created_at, updated_at,
        revision, conflict_key, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.scope, scopeKey, content, JSON.stringify(tags), kind, importance,
      confidence, source, rationale, hash, now, now, revision ?? null, conflictKey ?? null,
      expiresAt ?? null,
    );
    return this.getCandidate(id) as MemoryCandidate;
  }

  getCandidate(id: string): MemoryCandidate | undefined {
    const row = this.requireDatabase().prepare(
      'SELECT * FROM memory_candidates WHERE id = ?',
    ).get(id) as CandidateRow | undefined;
    return row ? toCandidate(row) : undefined;
  }

  listCandidates(
    status: MemoryCandidate['status'] | 'all' = 'pending',
    limit = 50,
  ): MemoryCandidate[] {
    const bounded = clamp(Math.floor(limit), 1, 200);
    const rows = status === 'all'
      ? this.requireDatabase().prepare(
        'SELECT * FROM memory_candidates ORDER BY updated_at DESC LIMIT ?',
      ).all(bounded) as unknown as CandidateRow[]
      : this.requireDatabase().prepare(
        status === 'pending'
          ? `SELECT * FROM memory_candidates
             WHERE status = ? AND (expires_at IS NULL OR expires_at > ?)
             ORDER BY updated_at DESC LIMIT ?`
          : 'SELECT * FROM memory_candidates WHERE status = ? ORDER BY updated_at DESC LIMIT ?',
      ).all(...(status === 'pending'
        ? [status, new Date().toISOString(), bounded]
        : [status, bounded])) as unknown as CandidateRow[];
    return rows.map(toCandidate);
  }

  approveCandidate(id: string, overrides: Partial<RememberInput> = {}): MemoryRecord | undefined {
    const candidate = this.getCandidate(id);
    if (!candidate || candidate.status === 'rejected' ||
      (candidate.expiresAt && Date.parse(candidate.expiresAt) <= Date.now())) return undefined;
    const record = this.remember({
      scope: overrides.scope ?? candidate.scope,
      scopeKey: overrides.scopeKey ?? candidate.scopeKey,
      content: overrides.content ?? candidate.content,
      tags: overrides.tags ?? candidate.tags,
      kind: overrides.kind ?? candidate.kind,
      importance: overrides.importance ?? candidate.importance,
      confidence: overrides.confidence ?? candidate.confidence,
      source: overrides.source ?? `approved:${candidate.source}`,
      lastVerifiedAt: overrides.lastVerifiedAt ?? new Date().toISOString(),
      ...(overrides.supersedesId ? {supersedesId: overrides.supersedesId} : {}),
      ...((overrides.revision ?? candidate.revision) ? {revision: overrides.revision ?? candidate.revision} : {}),
      ...((overrides.conflictKey ?? candidate.conflictKey) ? {conflictKey: overrides.conflictKey ?? candidate.conflictKey} : {}),
      ...(overrides.expiresAt ? {expiresAt: overrides.expiresAt} : {}),
    });
    this.requireDatabase().prepare(`
      UPDATE memory_candidates
      SET status = 'approved', approved_memory_id = ?, updated_at = ? WHERE id = ?
    `).run(record.id, new Date().toISOString(), id);
    return record;
  }

  rejectCandidate(id: string): boolean {
    const result = this.requireDatabase().prepare(`
      UPDATE memory_candidates SET status = 'rejected', updated_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(new Date().toISOString(), id);
    return Number(result.changes) > 0;
  }

  archiveExpired(now = new Date().toISOString()): number {
    const timestamp = normalizeTimestamp(now, 'Memory expiration sweep') as string;
    const result = this.requireDatabase().prepare(`
      UPDATE memories SET status = 'archived', updated_at = ?
      WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?
    `).run(timestamp, timestamp);
    this.requireDatabase().prepare(`
      UPDATE memory_candidates SET status = 'rejected', updated_at = ?
      WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?
    `).run(timestamp, timestamp);
    return Number(result.changes);
  }

  archive(id: string): boolean {
    const result = this.requireDatabase().prepare(
      "UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ?",
    ).run(new Date().toISOString(), id);
    return result.changes > 0;
  }

  remove(id: string): boolean {
    const result = this.requireDatabase().prepare('DELETE FROM memories WHERE id = ?').run(id);
    return result.changes > 0;
  }

  stats(): {active: number; archived: number; candidates: number; path: string} {
    const rows = this.requireDatabase().prepare(
      'SELECT status, COUNT(*) AS count FROM memories GROUP BY status',
    ).all() as unknown as Array<{status: 'active' | 'archived'; count: number}>;
    const candidates = this.requireDatabase().prepare(
      "SELECT COUNT(*) AS count FROM memory_candidates WHERE status = 'pending' AND (expires_at IS NULL OR expires_at > ?)",
    ).get(new Date().toISOString()) as {count: number};
    return {
      active: rows.find((row) => row.status === 'active')?.count ?? 0,
      archived: rows.find((row) => row.status === 'archived')?.count ?? 0,
      path: this.path,
      candidates: candidates.count,
    };
  }

  private requireDatabase(): DatabaseSync {
    if (!this.database) throw new Error('MemoryStore.open() must be called before use.');
    return this.database;
  }
}

export function defaultMemoryPath(environment: NodeJS.ProcessEnv = process.env): string {
  // Resolve the canonical home when explicitly configured, while retaining
  // ~/.mosaic for existing installations until they opt into migration.
  return join(resolveHomeNamespace(environment), 'memory.sqlite');
}

function normalizeContent(value: string): string {
  const content = value.trim().replace(/\r\n/g, '\n');
  if (!content) throw new Error('Memory content cannot be empty.');
  if (content.length > MAX_MEMORY_CHARS) {
    throw new Error(`Memory content exceeds ${MAX_MEMORY_CHARS} characters.`);
  }
  return content;
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags
    .map((tag) => tag.trim().toLocaleLowerCase())
    .filter(Boolean)
    .map((tag) => tag.slice(0, 64)))]
    .slice(0, 24);
}

function rejectSensitiveMemory(content: string): void {
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
    /\b(?:sk|rk|pk)-[a-z0-9_-]{20,}\b/i,
    /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*\S{8,}/i,
    /\bgh[opusr]_[A-Za-z0-9_]{20,}\b/,
  ];
  if (patterns.some((pattern) => pattern.test(content))) {
    throw new Error('Memory appears to contain a credential or private key and was not stored.');
  }
}

function safeFtsQuery(query: string): string {
  const tokens = query
    .normalize('NFKC')
    .match(/[\p{L}\p{N}_-]{2,}/gu)
    ?.slice(0, 20) ?? [];
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ');
}

function buildMemoryFilters(options: MemorySearchOptions): {
  sql: string;
  parameters: string[];
} {
  const clauses: string[] = [];
  const parameters: string[] = [];
  if (!options.includeArchived) clauses.push("m.status = 'active'");
  clauses.push('(m.expires_at IS NULL OR m.expires_at > ?)');
  parameters.push(normalizeTimestamp(options.now, 'Search time') ?? new Date().toISOString());
  const scopes = options.scopes ?? [];
  if (scopes.length) {
    clauses.push(`(${scopes.map(() => '(m.scope = ? AND m.scope_key = ?)').join(' OR ')})`);
    parameters.push(...scopes.flatMap((item) => [item.scope, item.scopeKey]));
  }
  const kinds = [...new Set(options.kinds ?? [])];
  if (kinds.length) {
    clauses.push(`m.kind IN (${kinds.map(() => '?').join(', ')})`);
    parameters.push(...kinds.map(normalizeKind));
  }
  return {
    sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '',
    parameters,
  };
}

function toRecord(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    scope: row.scope,
    scopeKey: row.scope_key,
    content: row.content,
    tags: parseTags(row.tags),
    kind: row.kind ?? 'semantic',
    importance: row.importance,
    confidence: row.confidence ?? 0.7,
    source: row.source,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccessedAt: row.last_accessed_at,
    ...(row.last_verified_at ? {lastVerifiedAt: row.last_verified_at} : {}),
    ...(row.revision ? {revision: row.revision} : {}),
    ...(row.supersedes_id ? {supersedesId: row.supersedes_id} : {}),
    ...(row.conflict_key ? {conflictKey: row.conflict_key} : {}),
    ...(row.expires_at ? {expiresAt: row.expires_at} : {}),
    ...(typeof row.score === 'number' ? {score: row.score} : {}),
    ...('relevance' in row && typeof row.relevance === 'number'
      ? {relevance: row.relevance, matchReason: row.matchReason}
      : {}),
  };
}

function toCandidate(row: CandidateRow): MemoryCandidate {
  return {
    id: row.id,
    scope: row.scope,
    scopeKey: row.scope_key,
    content: row.content,
    tags: parseTags(row.tags),
    kind: row.kind,
    importance: row.importance,
    confidence: row.confidence,
    source: row.source,
    rationale: row.rationale,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.approved_memory_id ? {approvedMemoryId: row.approved_memory_id} : {}),
    ...(row.revision ? {revision: row.revision} : {}),
    ...(row.conflict_key ? {conflictKey: row.conflict_key} : {}),
    ...(row.expires_at ? {expiresAt: row.expires_at} : {}),
  };
}

function rankMemory(row: MemoryRow, query: string): MemoryRow & {
  relevance: number;
  matchReason: string;
} {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    const relevance = clamp(row.importance * 0.55 + (row.confidence ?? 0.7) * 0.45, 0, 1);
    return {...row, score: relevance, relevance, matchReason: 'importance and confidence'};
  }
  const corpus = normalizeSearchText(`${row.content} ${parseTags(row.tags).join(' ')}`);
  const terms = searchTerms(normalizedQuery);
  const hits = terms.filter((term) => corpus.includes(normalizeSearchText(term))).length;
  const exact = normalizedQuery.length >= 2 && corpus.includes(normalizedQuery);
  const coverage = terms.length ? hits / terms.length : 0;
  const ftsMatched = typeof row.score === 'number' && row.score !== 0;
  const lexical = exact ? 1 : Math.min(1, coverage * 0.78 + (ftsMatched ? 0.12 : 0));
  const recentlyVerified = row.last_verified_at &&
    Date.now() - Date.parse(row.last_verified_at) < 90 * 24 * 60 * 60 * 1_000;
  const relevance = clamp(
    lexical * 0.72 + row.importance * 0.12 + (row.confidence ?? 0.7) * 0.13 +
      (recentlyVerified ? 0.03 : 0),
    0,
    1,
  );
  const matchReason = exact
    ? 'exact phrase'
    : terms.length ? `${hits}/${terms.length} query terms` : 'lexical match';
  return {...row, score: relevance, relevance, matchReason};
}

function parseTags(value: string): string[] {
  try {
    const tags = JSON.parse(value) as unknown;
    return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [];
  } catch {
    return [];
  }
}

function searchTerms(query: string): string[] {
  const normalized = query.normalize('NFKC').trim();
  const tokens = normalized.match(/[\p{L}\p{N}_.\/@:-]+/gu) ?? [];
  return [...new Set([
    ...(normalized.length >= 1 && normalized.length <= 240 && !/\s/.test(normalized)
      ? [normalized]
      : []),
    ...tokens,
  ])].slice(0, 12);
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().trim().replace(/\s+/g, ' ');
}

function normalizeKind(value?: MemoryKind): MemoryKind {
  if (!value) return 'semantic';
  if (value !== 'semantic' && value !== 'episodic' && value !== 'procedural') {
    throw new Error(`Unknown memory kind: ${String(value)}`);
  }
  return value;
}

function normalizeOptional(value: string | undefined, max: number): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

function normalizeTimestamp(value: string | undefined, label: string): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${label} is invalid.`);
  return new Date(timestamp).toISOString();
}

function migrateMemoryColumns(database: DatabaseSync): void {
  const columns = new Set((database.prepare('PRAGMA table_info(memories)').all() as unknown as
    Array<{name: string}>).map((column) => column.name));
  const additions: Array<[string, string]> = [
    ['kind', "TEXT NOT NULL DEFAULT 'semantic'"],
    ['confidence', 'REAL NOT NULL DEFAULT 0.7'],
    ['last_verified_at', 'TEXT'],
    ['revision', 'TEXT'],
    ['supersedes_id', 'TEXT'],
    ['conflict_key', 'TEXT'],
    ['expires_at', 'TEXT'],
  ];
  for (const [name, definition] of additions) {
    if (!columns.has(name)) database.exec(`ALTER TABLE memories ADD COLUMN ${name} ${definition}`);
  }
}

function migrateCandidateColumns(database: DatabaseSync): void {
  const columns = new Set((database.prepare('PRAGMA table_info(memory_candidates)').all() as unknown as
    Array<{name: string}>).map((column) => column.name));
  const additions: Array<[string, string]> = [
    ['revision', 'TEXT'],
    ['conflict_key', 'TEXT'],
    ['expires_at', 'TEXT'],
  ];
  for (const [name, definition] of additions) {
    if (!columns.has(name)) database.exec(`ALTER TABLE memory_candidates ADD COLUMN ${name} ${definition}`);
  }
}

async function rejectSymlink(path: string, allowMissing = false): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Memory path cannot be a symlink: ${path}`);
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
