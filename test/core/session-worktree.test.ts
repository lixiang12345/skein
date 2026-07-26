import {spawnSync} from 'node:child_process';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {createSessionWorktree} from '../../src/session/worktree.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

describe('isolated session worktrees', () => {
  it('creates an explicit sibling branch worktree without a shell', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'skein-session-worktree-'));
    roots.push(parent);
    const repository = join(parent, 'repository');
    const target = join(parent, 'forked');
    git(['init', repository], parent);
    git(['-C', repository, 'config', 'user.email', 'skein@example.com'], parent);
    git(['-C', repository, 'config', 'user.name', 'Skein Test'], parent);
    git(['-C', repository, 'commit', '--allow-empty', '-m', 'base'], parent);

    const worktree = await createSessionWorktree({
      workspace: repository,
      path: target,
      branch: 'skein/session-fork',
    });

    expect(worktree).toMatchObject({path: await realpath(target), branch: 'skein/session-fork'});
    expect(worktree.baseCommit).toMatch(/^[a-f0-9]{40}$/u);
    expect(git(['-C', target, 'branch', '--show-current'], parent).trim()).toBe('skein/session-fork');
  });

  it('rejects an in-repository target before mutation', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'skein-session-worktree-inside-'));
    roots.push(parent);
    const repository = join(parent, 'repository');
    git(['init', repository], parent);
    git(['-C', repository, 'config', 'user.email', 'skein@example.com'], parent);
    git(['-C', repository, 'config', 'user.name', 'Skein Test'], parent);
    git(['-C', repository, 'commit', '--allow-empty', '-m', 'base'], parent);
    await expect(createSessionWorktree({
      workspace: repository,
      path: join(repository, 'forked'),
      branch: 'skein/inside',
    })).rejects.toThrow('outside the source repository');
  });
});

function git(args: string[], cwd: string): string {
  const result = spawnSync('git', args, {cwd, encoding: 'utf8'});
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}
