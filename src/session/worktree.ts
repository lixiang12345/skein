import {lstat, realpath} from 'node:fs/promises';
import {basename, dirname, join, resolve} from 'node:path';
import {resolveExecutableRuntime} from '../utils/process.js';
import {runIsolatedGit} from '../utils/git.js';
import {isInside} from '../utils/path.js';

export interface SessionWorktree {
  path: string;
  branch: string;
  baseCommit: string;
}

export async function createSessionWorktree(input: {
  workspace: string;
  path: string;
  branch: string;
}): Promise<SessionWorktree> {
  const workspace = resolve(input.workspace);
  const git = await resolveExecutableRuntime('git', workspace, [workspace]);
  if (!git) throw new Error('Git is required for an isolated session worktree.');
  const rootResult = await runIsolatedGit(git, ['rev-parse', '--show-toplevel'], workspace, {timeoutMs: 10_000});
  if (rootResult.exitCode !== 0) throw new Error('Session worktrees require a Git repository.');
  const repository = await realpath(rootResult.stdout.trim());
  const branchResult = await runIsolatedGit(git, ['check-ref-format', '--branch', input.branch], repository, {timeoutMs: 10_000});
  if (branchResult.exitCode !== 0 || branchResult.stdout.trim() !== input.branch) {
    throw new Error('Invalid session worktree branch name.');
  }
  const parent = await realpath(dirname(resolve(input.path)));
  const target = join(parent, basename(resolve(input.path)));
  if (isInside(repository, target)) {
    throw new Error('Session worktree must be outside the source repository.');
  }
  try {
    await lstat(target);
    throw new Error('Session worktree target already exists.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const result = await runIsolatedGit(git, ['worktree', 'add', '-b', input.branch, target, 'HEAD'], repository, {
    timeoutMs: 120_000,
    maxOutputBytes: 200_000,
  });
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).replace(/\s+/gu, ' ').trim().slice(0, 1_000);
    throw new Error(`Could not create session worktree: ${detail || `git exited ${result.exitCode}`}`);
  }
  const commit = await runIsolatedGit(git, ['rev-parse', 'HEAD'], target, {timeoutMs: 10_000});
  if (commit.exitCode !== 0 || !/^[a-f0-9]{40,64}$/u.test(commit.stdout.trim())) {
    throw new Error('Created session worktree has no verifiable base commit.');
  }
  return {path: target, branch: input.branch, baseCommit: commit.stdout.trim()};
}
