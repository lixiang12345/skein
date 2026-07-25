import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {runIsolatedGit} from '../utils/git.js';
import {isInside} from '../utils/path.js';
import {resolveExecutableRuntime, type ExecutableRuntime} from '../utils/process.js';

const MAX_COMMITS = 128;
const MAX_OUTPUT_BYTES = 1_000_000;
const TIMEOUT_MS = 2_000;
const MAX_RECENCY_SCORE = 0.001;
const commitHashPattern = /^(?:[a-f\d]{40}|[a-f\d]{64})$/u;

export interface GitRecencySnapshot {
  generation: string;
  scores: ReadonlyMap<string, number>;
}

interface RootRecencySnapshot extends GitRecencySnapshot {
  root: string;
}

interface RootRecencyState {
  runtime: ExecutableRuntime | undefined;
  runtimeResolved: boolean;
  head: string | undefined;
  snapshot: RootRecencySnapshot | undefined;
}

export class GitRecencyCollector {
  private readonly roots: string[];
  private readonly states = new Map<string, RootRecencyState>();

  constructor(roots: readonly string[]) {
    this.roots = roots.map((root) => resolve(root));
  }

  async collect(): Promise<GitRecencySnapshot> {
    const snapshots = await Promise.all(this.roots.map((root) => this.collectRoot(root)));
    const scores = new Map<string, number>();
    for (const snapshot of snapshots) {
      for (const [path, score] of snapshot.scores) {
        scores.set(path, Math.max(score, scores.get(path) ?? 0));
      }
    }
    return {
      generation: digest(snapshots.map(({root, generation}) => `${root}\u0000${generation}`).join('\n')),
      scores,
    };
  }

  private async collectRoot(root: string): Promise<RootRecencySnapshot> {
    const state = this.states.get(root) ?? {
      runtime: undefined,
      runtimeResolved: false,
      head: undefined,
      snapshot: undefined,
    };
    this.states.set(root, state);
    try {
      if (!state.runtimeResolved) {
        state.runtime = await resolveExecutableRuntime('git', root, this.roots);
        state.runtimeResolved = true;
      }
      if (!state.runtime) return unavailableSnapshot(root, 'missing');
      const headResult = await runIsolatedGit(
        state.runtime,
        ['rev-parse', '--verify', 'HEAD'],
        root,
        {timeoutMs: TIMEOUT_MS, maxOutputBytes: 256, stopOnOutputLimit: true},
      );
      const head = headResult.stdout.trim();
      if (headResult.exitCode !== 0 || headResult.timedOut || headResult.stdoutTruncated ||
        headResult.stderrTruncated || !commitHashPattern.test(head)) {
        state.head = undefined;
        state.snapshot = unavailableSnapshot(root, 'no-head');
        return state.snapshot;
      }
      if (state.head === head && state.snapshot) return state.snapshot;
      state.head = head;
      state.snapshot = await collectRootGitLog(root, state.runtime);
      return state.snapshot;
    } catch {
      state.head = undefined;
      state.snapshot = unavailableSnapshot(root, 'error');
      return state.snapshot;
    }
  }
}

async function collectRootGitLog(
  root: string,
  runtime: ExecutableRuntime,
): Promise<RootRecencySnapshot> {
  try {
    const result = await runIsolatedGit(runtime, [
      '--no-pager',
      'log',
      '--topo-order',
      `--max-count=${MAX_COMMITS}`,
      '--format=%x00%H',
      '--name-only',
      '-z',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      '--relative',
      '--',
      '.',
    ], root, {
      timeoutMs: TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      stopOnOutputLimit: true,
    });
    if (result.exitCode !== 0 || result.timedOut || result.stdoutTruncated || result.stderrTruncated) {
      const reason = result.timedOut
        ? 'timeout'
        : result.stdoutTruncated || result.stderrTruncated
          ? 'output-limit'
          : `exit-${result.exitCode}`;
      return unavailableSnapshot(root, reason);
    }
    return {
      root,
      generation: digest(result.stdout),
      scores: parseGitLog(root, result.stdout),
    };
  } catch {
    return unavailableSnapshot(root, 'error');
  }
}

function parseGitLog(root: string, output: string): ReadonlyMap<string, number> {
  const scores = new Map<string, number>();
  const records = output.split('\u0000');
  let commitRank = -1;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? '';
    if (!record) {
      const commit = records[index + 1]?.trim() ?? '';
      if (commitHashPattern.test(commit)) {
        commitRank += 1;
        index += 1;
      }
      continue;
    }
    if (commitRank < 0) continue;
    const path = record.startsWith('\n') ? record.slice(1) : record;
    if (!path) continue;
    const absolutePath = resolve(root, path);
    if (!isInside(root, absolutePath) || scores.has(absolutePath)) continue;
    scores.set(absolutePath, MAX_RECENCY_SCORE / (commitRank + 1));
  }
  return scores;
}

function unavailableSnapshot(root: string, reason: string): RootRecencySnapshot {
  return {root, generation: digest(`unavailable\u0000${reason}`), scores: new Map()};
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}
