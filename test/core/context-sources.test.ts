import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
  formatPinnedContext,
  pinContextSource,
  resolvePinnedContent,
  toggleMuteContextSource,
  unpinContextSource,
  MAX_CONTEXT_SOURCES,
} from '../../src/context/context-sources.js';
import {createSession} from '../../src/session/store.js';
import {WorkspaceAccess} from '../../src/tools/workspace.js';
import type {Session} from '../../src/types.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

async function fixture(): Promise<{root: string; workspace: WorkspaceAccess; session: Session}> {
  const root = await mkdtemp(join(tmpdir(), 'skein-sources-'));
  roots.push(root);
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'app.ts'), 'export const value = 1;\n');
  await writeFile(join(root, 'README.md'), '# Title\n\nBody paragraph.\n');
  const workspace = new WorkspaceAccess([root]);
  const session = createSession({workspace: root, model: 'm', provider: 'anthropic'});
  return {root, workspace, session};
}

describe('context sources', () => {
  it('pins a file with a workspace-relative alias and a token estimate', async () => {
    const {workspace, session} = await fixture();
    const source = await pinContextSource(session, workspace, 'src/app.ts');
    expect(source.path).toBe('src/app.ts');
    expect(source.state).toBe('pinned');
    expect(source.tokens).toBeGreaterThan(0);
    expect(session.contextSources).toHaveLength(1);
  });

  it('re-pinning a muted source flips it back without duplicating', async () => {
    const {workspace, session} = await fixture();
    await pinContextSource(session, workspace, 'src/app.ts');
    toggleMuteContextSource(session, 'src/app.ts');
    expect(session.contextSources?.[0]?.state).toBe('muted');
    await pinContextSource(session, workspace, 'src/app.ts');
    expect(session.contextSources).toHaveLength(1);
    expect(session.contextSources?.[0]?.state).toBe('pinned');
  });

  it('rejects a path outside the workspace', async () => {
    const {workspace, session} = await fixture();
    await expect(pinContextSource(session, workspace, '../../etc/passwd')).rejects.toThrow();
    expect(session.contextSources ?? []).toHaveLength(0);
  });

  it('injects pinned content read fresh from disk, reflecting edits', async () => {
    const {root, workspace, session} = await fixture();
    await pinContextSource(session, workspace, 'src/app.ts');
    let resolved = await resolvePinnedContent(session, workspace);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.content).toContain('value = 1');

    await writeFile(join(root, 'src', 'app.ts'), 'export const value = 999;\n');
    resolved = await resolvePinnedContent(session, workspace);
    expect(resolved[0]?.content).toContain('value = 999');
  });

  it('skips muted sources entirely so they cost zero tokens', async () => {
    const {workspace, session} = await fixture();
    await pinContextSource(session, workspace, 'src/app.ts');
    await pinContextSource(session, workspace, 'README.md');
    toggleMuteContextSource(session, 'README.md');
    const resolved = await resolvePinnedContent(session, workspace);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.path).toBe('src/app.ts');
  });

  it('silently skips a pinned file that was deleted, keeping it listed', async () => {
    const {root, workspace, session} = await fixture();
    await pinContextSource(session, workspace, 'src/app.ts');
    await rm(join(root, 'src', 'app.ts'));
    const resolved = await resolvePinnedContent(session, workspace);
    expect(resolved).toHaveLength(0);
    // Still listed so the user can unpin it deliberately.
    expect(session.contextSources).toHaveLength(1);
  });

  it('unpins by suffix match and reports the removed alias', async () => {
    const {workspace, session} = await fixture();
    await pinContextSource(session, workspace, 'src/app.ts');
    const removed = unpinContextSource(session, 'app.ts');
    expect(removed).toBe('src/app.ts');
    expect(session.contextSources).toHaveLength(0);
    expect(unpinContextSource(session, 'nothing.ts')).toBeUndefined();
  });

  it('formats pinned content as a trust-scoped section, escaping the path', async () => {
    const {workspace, session} = await fixture();
    await pinContextSource(session, workspace, 'src/app.ts');
    const resolved = await resolvePinnedContent(session, workspace);
    const formatted = formatPinnedContext(resolved);
    expect(formatted).toContain('<pinned-context source="user" authorization="none">');
    expect(formatted).toContain('<pinned-file path="src/app.ts">');
    expect(formatted).toContain('value = 1');
    expect(formatPinnedContext([])).toBe('');
  });

  it('enforces the source count limit', async () => {
    const {root, workspace, session} = await fixture();
    for (let index = 0; index < MAX_CONTEXT_SOURCES; index += 1) {
      const name = `file-${index}.txt`;
      await writeFile(join(root, name), `content ${index}\n`);
      await pinContextSource(session, workspace, name);
    }
    await writeFile(join(root, 'overflow.txt'), 'too many\n');
    await expect(pinContextSource(session, workspace, 'overflow.txt')).rejects.toThrow(/limit/);
  });
});
