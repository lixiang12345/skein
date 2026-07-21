import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {afterEach, describe, expect, it} from 'vitest';
import {MemoryStore} from '../../src/memory/store.js';
import {ExtensionRuntime} from '../../src/runtime/extensions.js';
import {createSession} from '../../src/session/store.js';
import {ToolRegistry} from '../../src/tools/registry.js';
import {WorkspaceAccess} from '../../src/tools/workspace.js';
import type {MosaicConfig} from '../../src/types.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

describe('MemoryStore', () => {
  it('persists, deduplicates, ranks, scopes, and archives durable memory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-memory-'));
    roots.push(root);
    const store = await new MemoryStore(join(root, 'memory.sqlite')).open();
    try {
      const first = store.remember({
        scope: 'workspace', scopeKey: '/repo/a', content: 'Use npm run check before release.',
        tags: ['release'], importance: 0.7, source: 'interactive:test', revision: 'abc123',
      });
      const duplicate = store.remember({
        scope: 'workspace', scopeKey: '/repo/a', content: 'Use npm run check before release.',
        tags: ['verification'], importance: 0.9,
      });
      const inferred = store.remember({
        scope: 'workspace', scopeKey: '/repo/b', content: 'Use pnpm in repository B.', source: 'session:model-1',
      });
      expect(inferred.expiresAt).toBeTruthy();

      expect(duplicate.id).toBe(first.id);
      expect(duplicate.importance).toBe(0.9);
      expect(duplicate.confidence).toBe(1);
      expect(duplicate.lastVerifiedAt).toBeTruthy();
      expect(duplicate.revision).toBe('abc123');
      expect(duplicate.tags).toEqual(expect.arrayContaining(['release', 'verification']));
      const results = store.search('release check', {
        scopes: [{scope: 'workspace', scopeKey: '/repo/a'}],
      });
      expect(results).toHaveLength(1);
      expect(results[0]?.content).toContain('npm run check');
      expect(store.archive(first.id)).toBe(true);
      expect(store.search('release check', {
        scopes: [{scope: 'workspace', scopeKey: '/repo/a'}],
      })).toHaveLength(0);
      expect(store.stats()).toMatchObject({active: 1, archived: 1});
    } finally {
      store.close();
    }
  });

  it('refuses likely credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-memory-secret-'));
    roots.push(root);
    const store = await new MemoryStore(join(root, 'memory.sqlite')).open();
    try {
      expect(() => store.remember({
        scope: 'user', scopeKey: 'default', content: 'api_key = sk-abcdefghijklmnopqrstuvwxyz123456',
      })).toThrow(/credential|private key/i);
    } finally {
      store.close();
    }
  });

  it('finds CJK phrases and path substrings, and supersedes conflicting facts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-memory-search-'));
    roots.push(root);
    const store = await new MemoryStore(join(root, 'memory.sqlite')).open();
    try {
      const old = store.remember({
        scope: 'workspace', scopeKey: '/repo/a', content: '前端包管理器使用 npm。',
        conflictKey: 'frontend-package-manager', source: 'interactive:test',
      });
      const current = store.remember({
        scope: 'workspace', scopeKey: '/repo/a',
        content: '前端包管理器使用 pnpm，配置位于 packages/web/vite.config.ts。',
        conflictKey: 'frontend-package-manager', source: 'interactive:test', revision: 'def456',
      });

      expect(current.supersedesId).toBe(old.id);
      expect(store.get(old.id)?.status).toBe('archived');
      expect(store.search('包管理器', {
        scopes: [{scope: 'workspace', scopeKey: '/repo/a'}],
      })[0]?.id).toBe(current.id);
      expect(store.search('web/vite.config', {
        scopes: [{scope: 'workspace', scopeKey: '/repo/a'}],
      })[0]?.matchReason).toBeTruthy();
      expect(store.search('包', {
        scopes: [{scope: 'workspace', scopeKey: '/repo/a'}],
      })[0]?.id).toBe(current.id);
      expect(store.search('无', {
        scopes: [{scope: 'workspace', scopeKey: '/repo/a'}],
      })).toHaveLength(0);
      const expiring = store.remember({
        scope: 'workspace', scopeKey: '/repo/a', content: 'Temporary migration note.',
        expiresAt: '2020-01-01T00:00:00.000Z', source: 'model:test',
      });
      expect(store.search('migration note', {
        scopes: [{scope: 'workspace', scopeKey: '/repo/a'}],
      })).toHaveLength(0);
      expect(store.archiveExpired('2021-01-01T00:00:00.000Z')).toBe(1);
      expect(store.get(expiring.id)?.status).toBe('archived');
    } finally {
      store.close();
    }
  });

  it('keeps inferred memories as reviewable candidates until approved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-memory-candidate-'));
    roots.push(root);
    const store = await new MemoryStore(join(root, 'memory.sqlite')).open();
    try {
      const previous = store.remember({
        scope: 'workspace', scopeKey: '/repo/a', content: 'The release branch is develop.',
        conflictKey: 'release-branch', source: 'interactive:test',
      });
      const candidate = store.propose({
        scope: 'workspace', scopeKey: '/repo/a', content: 'The release branch is usually main.',
        source: 'model:session-1', rationale: 'Observed in two release commands.', confidence: 0.72,
        conflictKey: 'release-branch',
      });
      expect(store.search('usually main')).toHaveLength(0);
      expect(store.listCandidates()).toHaveLength(1);
      const approved = store.approveCandidate(candidate.id);
      expect(approved?.source).toBe('approved:model:session-1');
      expect(approved?.expiresAt).toBeUndefined();
      expect(approved?.supersedesId).toBe(previous.id);
      expect(store.get(previous.id)?.status).toBe('archived');
      expect(store.getCandidate(candidate.id)?.approvedMemoryId).toBe(approved?.id);
      expect(store.search('release branch')[0]?.id).toBe(approved?.id);
      expect(store.stats().candidates).toBe(0);
      const repeated = store.propose({
        scope: 'workspace', scopeKey: '/repo/a', content: 'The release branch is usually main.',
        source: 'model:session-2', rationale: 'Observed again in a later command.',
        conflictKey: 'release-branch',
      });
      expect(repeated.status).toBe('approved');
      expect(repeated.approvedMemoryId).toBe(approved?.id);
      expect(store.stats().candidates).toBe(0);
    } finally {
      store.close();
    }
  });

  it('exposes model memory writes as reviewable proposals with a hidden legacy alias', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-memory-tool-'));
    roots.push(root);
    const store = await new MemoryStore(join(root, 'memory.sqlite')).open();
    const config = memoryConfig(root);
    const registry = new ToolRegistry();
    const runtime = await ExtensionRuntime.create(config, registry, {memoryStore: store});
    try {
      const proposalTool = registry.get('memory_propose');
      expect(proposalTool?.definition.description).toContain('user review');
      expect(proposalTool?.definition.inputSchema).toMatchObject({
        required: ['content', 'rationale'],
        additionalProperties: false,
      });
      expect(registry.definitions().map((definition) => definition.name)).toContain('memory_propose');
      expect(registry.definitions().map((definition) => definition.name)).not.toContain('memory_remember');
      expect(registry.get('memory_remember')).toBe(proposalTool);

      const session = createSession({workspace: root, provider: 'compatible', model: 'test'});
      const result = await proposalTool?.execute({
        content: 'Use npm run check before publishing a release.',
        rationale: 'The project release checklist requires this command.',
        scope: 'workspace',
        kind: 'procedural',
        tags: ['release'],
        importance: 0.8,
        confidence: 0.9,
        revision: 'abc123',
        conflictKey: 'release-check-command',
      }, {
        config,
        workspace: new WorkspaceAccess([root]),
        session,
      });
      expect(result?.content).toContain('inactive until the user approves');
      expect(result?.metadata).toMatchObject({
        scope: 'workspace',
        status: 'pending',
        requiresApproval: true,
      });
      expect(result?.metadata?.memoryCandidateId).toEqual(expect.any(String));
      expect(store.search('publishing a release')).toHaveLength(0);
      const candidates = store.listCandidates();
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        kind: 'procedural',
        confidence: 0.9,
        source: `model:session:${session.id}`,
        rationale: 'The project release checklist requires this command.',
        revision: 'abc123',
        conflictKey: 'release-check-command',
      });

      // `/remember` calls this explicit runtime API and remains an immediate,
      // non-expiring write because the user authored the command.
      const explicit = runtime.remember('Prefer focused tests for queue changes.', session);
      expect(explicit.source).toBe(`interactive:${session.id}`);
      expect(explicit.expiresAt).toBeUndefined();
      expect(store.search('focused tests for queue changes')[0]?.id).toBe(explicit.id);
      expect(store.listCandidates()).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it('injects only relevant provenance-marked memories and escapes stored markup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-memory-runtime-'));
    roots.push(root);
    const store = await new MemoryStore(join(root, 'memory.sqlite')).open();
    store.remember({
      scope: 'workspace', scopeKey: root,
      content: 'Release verification command is npm run check; literal <memory> text is data.',
      source: 'interactive:test', confidence: 1,
    });
    store.remember({
      scope: 'workspace', scopeKey: root, content: 'Release happens on Friday.',
      source: 'model:guess', confidence: 0, importance: 0,
    });
    const config = memoryConfig(root);
    const runtime = await ExtensionRuntime.create(config, new ToolRegistry(), {memoryStore: store});
    try {
      const augmentation = await runtime.prepare(
        'release verification command',
        createSession({workspace: root, provider: 'compatible', model: 'test'}),
      );
      expect(augmentation.memoryCount).toBe(1);
      expect(augmentation.text).toContain('source="interactive:test"');
      expect(augmentation.text).toContain('&lt;memory&gt;');
      expect(augmentation.text).not.toContain('happens on Friday');
      expect(augmentation.text).toContain('authorization="none"');
    } finally {
      await runtime.close();
    }
  });

  it('migrates a pre-provenance memory database in place', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-memory-migrate-'));
    roots.push(root);
    const path = join(root, 'memory.sqlite');
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE memories (
        rowid INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        scope TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        importance REAL NOT NULL DEFAULT 0.5,
        source TEXT NOT NULL DEFAULT 'user',
        status TEXT NOT NULL DEFAULT 'active',
        content_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_accessed_at TEXT NOT NULL
      );
    `);
    legacy.prepare(`
      INSERT INTO memories (id, scope, scope_key, content, tags, importance, source,
        status, content_hash, created_at, updated_at, last_accessed_at)
      VALUES (?, 'workspace', ?, ?, '[]', 0.5, 'legacy', 'active', ?, ?, ?, ?)
    `).run('legacy-1', root, 'Legacy release convention', 'legacy-hash',
      new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
    legacy.close();
    const store = await new MemoryStore(path).open();
    try {
      const record = store.get('legacy-1');
      expect(record?.kind).toBe('semantic');
      expect(record?.confidence).toBe(0.7);
      expect(store.search('release convention')[0]?.id).toBe('legacy-1');
    } finally {
      store.close();
    }
  });
});

function memoryConfig(root: string): MosaicConfig {
  return {
    model: {provider: 'compatible', model: 'test'},
    workspaceRoots: [root],
    context: {engine: 'local', maxTokens: 8_000, topK: 4, contextEngineCommand: 'none'},
    permissions: {read: 'allow', write: 'deny', shell: 'deny', git: 'deny', network: 'deny', allowCommands: [], denyCommands: []},
    hooks: {},
    agent: {maxTurns: 2, maxSessionTokens: 20_000, autoVerify: false, verifyCommands: [], checkpointBeforeWrite: false},
    ui: {color: false, compact: false},
    memory: {enabled: true, retrievalLimit: 8, maxPromptTokens: 1_200},
  };
}
