import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
  activeMentionToken,
  buildMentionPathIndex,
  contextHitMentionSuggestions,
  getMentionPathIndex,
  invalidateMentionPathIndex,
  mapMentionCandidatePath,
  mentionSuggestions,
  rankMentionSuggestions,
  replaceActiveMentionToken,
} from '../../src/context/mentions.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  invalidateMentionPathIndex();
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, {recursive: true, force: true}),
  ));
});

describe('file mention suggestions', () => {
  it('recognizes and replaces the active mention at the cursor', () => {
    expect(activeMentionToken('Explain @src/ut')).toEqual({
      start: 8,
      end: 15,
      cursor: 15,
      query: 'src/ut',
    });
    expect(activeMentionToken('email user@example.com')).toBeUndefined();
    expect(activeMentionToken('done @src/a.ts, next')).toBeUndefined();

    const input = 'Compare @src/ol.ts with main';
    const cursor = input.indexOf('ol.ts') + 2;
    expect(activeMentionToken(input, cursor)).toMatchObject({
      start: 8,
      end: input.indexOf(' with'),
      query: 'src/ol',
    });
    expect(replaceActiveMentionToken(input, 'src/new.ts', cursor)).toEqual({
      value: 'Compare @src/new.ts with main',
      cursor: 'Compare @src/new.ts'.length,
    });
    expect(replaceActiveMentionToken('Read @src/ol', '@src/new.ts')).toEqual({
      value: 'Read @src/new.ts ',
      cursor: 'Read @src/new.ts '.length,
    });
  });

  it('builds one reusable index across workspace roots with stable aliases', async () => {
    const main = await mkdtemp(join(tmpdir(), 'skein-mention-main-'));
    const extra = await mkdtemp(join(tmpdir(), 'skein-mention-extra-'));
    temporaryRoots.push(main, extra);
    await mkdir(join(main, 'src'));
    await mkdir(join(extra, 'shared'));
    await writeFile(join(main, 'src', 'index.ts'), 'export {}');
    await writeFile(join(extra, 'shared', 'index.ts'), 'export {}');
    await writeFile(join(extra, 'README.md'), '# extra');

    const index = await buildMentionPathIndex([main, extra]);
    expect(index.paths).toEqual(expect.arrayContaining([
      'main/src/index.ts',
      'workspace2/shared/index.ts',
      'workspace2/README.md',
    ]));
    expect(index.suggest('index')).toEqual([
      'main/src/index.ts',
      'workspace2/shared/index.ts',
    ]);

    const cached = await getMentionPathIndex([main, extra]);
    expect(await getMentionPathIndex([main, extra])).toBe(cached);
    await writeFile(join(main, 'new-file.ts'), 'export {}');
    expect((await mentionSuggestions('new-file', [main, extra]))).toEqual([]);
    invalidateMentionPathIndex([main, extra]);
    expect(await mentionSuggestions('new-file', [main, extra])).toEqual(['main/new-file.ts']);
  });

  it('maps safe ContextEngine hit paths, rejects escapes, deduplicates, and ranks', () => {
    const main = join(tmpdir(), 'skein-context-main');
    const extra = join(tmpdir(), 'skein-context-extra');
    const roots = [main, extra];
    expect(mapMentionCandidatePath(join(extra, 'src', 'button.tsx'), roots))
      .toBe('workspace2/src/button.tsx');
    expect(mapMentionCandidatePath('workspace2/src/button.tsx', roots))
      .toBe('workspace2/src/button.tsx');
    expect(mapMentionCandidatePath('workspace3/secret.ts', roots)).toBeUndefined();
    expect(mapMentionCandidatePath('main/../../secret.ts', roots)).toBeUndefined();
    expect(mapMentionCandidatePath(join(tmpdir(), 'outside', 'secret.ts'), roots)).toBeUndefined();

    const hits = [
      {path: join(main, 'src', 'button.test.tsx')},
      {path: join(extra, 'src', 'button.tsx')},
      {path: join(extra, 'src', 'button.tsx')},
      {path: join(tmpdir(), 'outside', 'button.tsx')},
    ];
    expect(contextHitMentionSuggestions(hits, roots, 'button')).toEqual([
      'workspace2/src/button.tsx',
      'main/src/button.test.tsx',
    ]);
  });

  it('uses deterministic basename-first ranking and rejects invalid candidates', () => {
    expect(rankMentionSuggestions([
      'src/my-button.tsx',
      'button.tsx',
      'src/button.test.tsx',
      'docs/about-button.md',
      'src/my-button.tsx',
      'bad path.ts',
    ], '@button', 3)).toEqual([
      'button.tsx',
      'src/button.test.tsx',
      'src/my-button.tsx',
    ]);
    expect(rankMentionSuggestions(['src/a.ts'], 'a', 0)).toEqual([]);
  });
});
