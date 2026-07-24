import {createHash} from 'node:crypto';
import {lstat, mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute, join, resolve} from 'node:path';
import {runIsolatedGit} from '../tools/git.js';
import {WorkspaceAccess} from '../tools/workspace.js';
import {acquireNamespaceLease} from '../utils/namespace-lease.js';
import {resolveExecutableRuntime, type ExecutableRuntime} from '../utils/process.js';

export interface WriterDraft<T> {
  baseCommit: string;
  patch: string;
  patchSha256: string;
  files: string[];
  worktreeCleaned: boolean;
  value: T;
}

export interface WriterIntegrationCheck {
  status: 'ready' | 'conflict';
  detail: string;
  files: string[];
}

export class WriterLaneApplyError extends Error {
  constructor(message: string, readonly attempted: boolean, cause?: unknown) {
    super(message, cause === undefined ? undefined : {cause});
    this.name = 'WriterLaneApplyError';
  }
}

interface RepositoryContext {
  root: string;
  commonDirectory: string;
  runtime: ExecutableRuntime;
}

export class WriterLane {
  private readonly workspace: WorkspaceAccess;

  constructor(workspace: string, workspaceRoots: string[]) {
    this.workspace = new WorkspaceAccess([
      resolve(workspace),
      ...workspaceRoots.map((root) => resolve(root)),
    ]);
  }

  async createDraft<T>(
    maxPatchBytes: number,
    operation: (worktree: string, baseCommit: string) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<WriterDraft<T>> {
    const repository = await this.repository();
    const baseCommit = await this.head(repository);
    const lease = await acquireNamespaceLease(
      join(repository.commonDirectory, 'skein-writer-lane'),
      'exclusive',
    );
    const worktree = await mkdtemp(join(tmpdir(), 'skein-writer-'));
    let added = false;
    let value: T | undefined;
    let patch = '';
    let files: string[] = [];
    let failure: unknown;
    let worktreeCleaned = false;
    try {
      const addedResult = await runIsolatedGit(repository.runtime, [
        'worktree', 'add', '--detach', worktree, baseCommit,
      ], repository.root, {timeoutMs: 60_000, ...(signal ? {signal} : {})});
      if (addedResult.exitCode !== 0 || addedResult.timedOut) {
        throw new Error(`Unable to create writer worktree: ${processDetail(addedResult)}`);
      }
      added = true;
      value = await operation(worktree, baseCommit);
      const staged = await runIsolatedGit(repository.runtime, ['add', '-A', '--'], worktree, {
        timeoutMs: 60_000,
      });
      if (staged.exitCode !== 0 || staged.timedOut) {
        throw new Error(`Unable to stage writer changes: ${processDetail(staged)}`);
      }
      const [diff, names] = await Promise.all([
        runIsolatedGit(repository.runtime, [
          'diff', '--cached', '--no-renames', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', 'HEAD', '--',
        ], worktree, {timeoutMs: 60_000, maxOutputBytes: 600_000}),
        runIsolatedGit(repository.runtime, [
          'diff', '--cached', '--no-renames', '--name-only', '-z', 'HEAD', '--',
        ], worktree, {timeoutMs: 30_000, maxOutputBytes: 2_000_000}),
      ]);
      if (diff.exitCode !== 0 || diff.timedOut) {
        throw new Error(`Unable to capture writer patch: ${processDetail(diff)}`);
      }
      if (names.exitCode !== 0 || names.timedOut) {
        throw new Error(`Unable to list writer changes: ${processDetail(names)}`);
      }
      patch = diff.stdout;
      files = unique(names.stdout.split('\0').filter(Boolean));
      const patchBytes = Buffer.byteLength(patch, 'utf8');
      if (patchBytes > maxPatchBytes) {
        throw new Error(`Writer patch is ${patchBytes} bytes; limit is ${maxPatchBytes} bytes.`);
      }
    } catch (error) {
      failure = error;
    } finally {
      worktreeCleaned = await this.cleanupWorktree(repository, worktree, added);
      lease.release();
    }
    if (failure) throw failure;
    if (value === undefined) throw new Error('Writer worktree completed without a result.');
    return {
      baseCommit,
      patch,
      patchSha256: createHash('sha256').update(patch).digest('hex'),
      files,
      worktreeCleaned,
      value,
    };
  }

  async inspectPatch(patch: string, expectedFiles?: string[]): Promise<string[]> {
    const repository = await this.repository();
    return this.inspectPatchWithRepository(repository, patch, expectedFiles);
  }

  async checkIntegration(input: {
    baseCommit: string;
    patch: string;
    expectedFiles?: string[];
  }): Promise<WriterIntegrationCheck> {
    const repository = await this.repository();
    return this.checkIntegrationWithRepository(repository, input);
  }

  async apply(input: {
    baseCommit: string;
    patch: string;
    expectedFiles?: string[];
    signal?: AbortSignal;
  }): Promise<WriterIntegrationCheck & {applied: boolean; attempted: boolean}> {
    let attempted = false;
    try {
      const repository = await this.repository();
      const lease = await acquireNamespaceLease(
        join(repository.commonDirectory, 'skein-writer-lane'),
        'exclusive',
      );
      try {
        const preflight = await this.checkIntegrationWithRepository(repository, input);
        if (preflight.status === 'conflict') return {...preflight, applied: false, attempted: false};
        attempted = true;
        const applied = await runIsolatedGit(repository.runtime, [
          'apply', '--binary', '--whitespace=nowarn', '-',
        ], repository.root, {
          stdin: input.patch,
          timeoutMs: 60_000,
          ...(input.signal ? {signal: input.signal} : {}),
        });
        if (applied.exitCode !== 0 || applied.timedOut) {
          return {
            status: 'conflict',
            detail: `Git apply failed: ${processDetail(applied)}`,
            files: preflight.files,
            applied: false,
            attempted: true,
          };
        }
        return {
          status: 'ready',
          detail: `Applied ${preflight.files.length} reviewed file(s).`,
          files: preflight.files,
          applied: true,
          attempted: true,
        };
      } finally {
        lease.release();
      }
    } catch (error) {
      if (error instanceof WriterLaneApplyError) throw error;
      throw new WriterLaneApplyError(error instanceof Error ? error.message : String(error), attempted, error);
    }
  }

  private async checkIntegrationWithRepository(
    repository: RepositoryContext,
    input: {baseCommit: string; patch: string; expectedFiles?: string[]},
  ): Promise<WriterIntegrationCheck> {
    const files = await this.inspectPatchWithRepository(repository, input.patch, input.expectedFiles);
    const currentHead = await this.head(repository);
    if (currentHead !== input.baseCommit) {
      return {
        status: 'conflict',
        detail: `Main HEAD moved from ${input.baseCommit} to ${currentHead}; regenerate or review the patch.`,
        files,
      };
    }
    for (let index = 0; index < files.length; index += 100) {
      const selected = files.slice(index, index + 100);
      const status = await runIsolatedGit(repository.runtime, [
        'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...selected,
      ], repository.root, {timeoutMs: 30_000, maxOutputBytes: 2_000_000});
      if (status.exitCode !== 0 || status.timedOut) {
        throw new Error(`Unable to inspect integration targets: ${processDetail(status)}`);
      }
      if (status.stdout) {
        return {
          status: 'conflict',
          detail: 'One or more integration targets have uncommitted main-workspace changes.',
          files,
        };
      }
    }
    const check = await runIsolatedGit(repository.runtime, [
      'apply', '--check', '--binary', '--whitespace=nowarn', '-',
    ], repository.root, {stdin: input.patch, timeoutMs: 60_000});
    if (check.exitCode !== 0 || check.timedOut) {
      return {
        status: 'conflict',
        detail: `Patch does not apply cleanly: ${processDetail(check)}`,
        files,
      };
    }
    return {status: 'ready', detail: `Patch is ready for ${files.length} file(s).`, files};
  }

  private async inspectPatchWithRepository(
    repository: RepositoryContext,
    patch: string,
    expectedFiles?: string[],
  ): Promise<string[]> {
    if (!patch || Buffer.byteLength(patch, 'utf8') > 500_000) {
      throw new Error('Writer patch is empty or exceeds the persisted artifact limit.');
    }
    const numstat = await runIsolatedGit(repository.runtime, [
      'apply', '--numstat', '-z', '--binary', '-',
    ], repository.root, {stdin: patch, timeoutMs: 30_000, maxOutputBytes: 2_000_000});
    if (numstat.exitCode !== 0 || numstat.timedOut) {
      throw new Error(`Writer patch is invalid: ${processDetail(numstat)}`);
    }
    const files = unique(parseNumstatPaths(numstat.stdout));
    if (!files.length) throw new Error('Writer patch contains no file changes.');
    for (const file of files) {
      if (isAbsolute(file) || file === '.git' || file.startsWith('.git/') || file.includes('\0')) {
        throw new Error(`Writer patch contains an unsafe path: ${file}`);
      }
      await this.workspace.resolvePath(join(repository.root, file), {allowMissing: true});
    }
    if (expectedFiles && !sameSet(files, expectedFiles)) {
      throw new Error('Writer patch paths do not match the persisted file manifest.');
    }
    return files;
  }

  private async repository(): Promise<RepositoryContext> {
    const root = this.workspace.primaryRoot;
    const runtime = await resolveExecutableRuntime('git', root, this.workspace.roots);
    if (!runtime) throw new Error('Git executable was not found outside the configured workspace roots.');
    const topLevel = await runIsolatedGit(runtime, ['rev-parse', '--show-toplevel'], root);
    if (topLevel.exitCode !== 0 || !topLevel.stdout.trim()) {
      throw new Error('The primary workspace must be a Git repository root for writer lanes.');
    }
    const discoveredRoot = resolve(topLevel.stdout.trim());
    if (await realpath(discoveredRoot) !== await realpath(root)) {
      throw new Error('The primary workspace must be the Git repository root for writer lanes.');
    }
    // Keep the configured lexical root (for example /var/... on macOS) after
    // validating its physical identity. WorkspaceAccess intentionally enforces
    // that lexical boundary, while Git may print the /private/var/... alias.
    const repositoryRoot = root;
    const common = await runIsolatedGit(runtime, ['rev-parse', '--git-common-dir'], repositoryRoot);
    if (common.exitCode !== 0 || !common.stdout.trim()) {
      throw new Error(`Unable to resolve the Git common directory: ${processDetail(common)}`);
    }
    const commonDirectory = await realpath(isAbsolute(common.stdout.trim())
      ? common.stdout.trim()
      : resolve(repositoryRoot, common.stdout.trim()));
    return {root: repositoryRoot, commonDirectory, runtime};
  }

  private async head(repository: RepositoryContext): Promise<string> {
    const head = await runIsolatedGit(repository.runtime, ['rev-parse', '--verify', 'HEAD'], repository.root);
    const value = head.stdout.trim();
    if (head.exitCode !== 0 || !/^[a-f0-9]{40,64}$/u.test(value)) {
      throw new Error('Writer lanes require a repository with a valid HEAD commit.');
    }
    return value;
  }

  private async cleanupWorktree(
    repository: RepositoryContext,
    worktree: string,
    added: boolean,
  ): Promise<boolean> {
    const physicalWorktree = await realpath(worktree).catch(() => resolve(worktree));
    if (added) {
      await runIsolatedGit(repository.runtime, [
        'worktree', 'remove', '--force', worktree,
      ], repository.root, {timeoutMs: 60_000}).catch(() => undefined);
    }
    await rm(worktree, {recursive: true, force: true}).catch(() => undefined);
    await runIsolatedGit(repository.runtime, [
      'worktree', 'prune', '--expire', 'now',
    ], repository.root, {timeoutMs: 30_000}).catch(() => undefined);
    const listed = await runIsolatedGit(repository.runtime, ['worktree', 'list', '--porcelain'], repository.root)
      .catch(() => undefined);
    return !(await pathExists(worktree)) &&
      listed !== undefined && listed.exitCode === 0 &&
      !listed.stdout.split(/\r?\n/u).some((line) =>
        line === `worktree ${worktree}` || line === `worktree ${physicalWorktree}`,
      );
  }
}

function parseNumstatPaths(output: string): string[] {
  const fields = output.split('\0');
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index] ?? '';
    if (!record) continue;
    const first = record.indexOf('\t');
    const second = first < 0 ? -1 : record.indexOf('\t', first + 1);
    if (second < 0) throw new Error('Git returned malformed patch path metadata.');
    const path = record.slice(second + 1);
    if (path) {
      paths.push(path);
      continue;
    }
    const oldPath = fields[index + 1] ?? '';
    const newPath = fields[index + 2] ?? '';
    if (!oldPath || !newPath) throw new Error('Git returned malformed rename metadata.');
    paths.push(oldPath, newPath);
    index += 2;
  }
  return paths;
}

function sameSet(left: string[], right: string[]): boolean {
  const first = new Set(left);
  const second = new Set(right);
  return first.size === second.size && [...first].every((value) => second.has(value));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function processDetail(result: {exitCode: number; stderr: string; stdout: string; timedOut: boolean}): string {
  const detail = (result.stderr || result.stdout || `exit ${result.exitCode}`).trim();
  return `${detail.slice(0, 2_000)}${result.timedOut ? ' (timed out)' : ''}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
