import {readFile, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {BackgroundJobStore, runBackgroundWorker} from '../../src/session/background-jobs.js';
import {createBackgroundJobTools, createDefaultToolRegistry} from '../../src/tools/index.js';
import type {BackgroundJobsConfig} from '../../src/types.js';

const roots: string[] = [];
const workers: Promise<void>[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

describe('durable background jobs', () => {
  it('persists completion and incremental stdout/stderr without provider secrets', async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'must-not-reach-job';
    try {
      const {store, recreate} = await setup();
      const job = await store.start('session-one', {
        command: 'printf "out:${OPENAI_API_KEY:-missing}:"; printf "err" >&2; printf "%0200d" 0',
      });
      await waitForWorkers();

      const restarted = recreate();
      const final = await restarted.get('session-one', job.id);
      expect(final.status).toBe('completed');
      expect(final.commandSha256).toMatch(/^[a-f0-9]{64}$/u);
      const first = await restarted.output('session-one', job.id, {cursor: '0:0', maxBytes: 256});
      expect(first.stdout).toContain('out:missing:');
      expect(first.stdout).not.toContain('must-not-reach-job');
      expect(first.stderr).toBe('err');
      expect(first.cursor).not.toBe('0:0');
      const second = await restarted.output('session-one', job.id, {cursor: first.cursor, maxBytes: 256});
      expect(Buffer.byteLength(first.stdout) + Buffer.byteLength(second.stdout)).toBeGreaterThan(128);
      await expect(restarted.get('another-session', job.id)).rejects.toThrow();
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it('enforces the retained-log quota while draining source output', async () => {
    const {store} = await setup({...configuration(), maxLogBytes: 64_000});
    const command = `${shellQuote(process.execPath)} -e 'process.stdout.write("x".repeat(70000))'`;
    const job = await store.start('quota-session', {command});
    await waitForWorkers();
    const final = await store.get('quota-session', job.id);
    expect(final.status).toBe('completed');
    expect(final.stdoutBytes).toBe(70_000);
    expect(final.retainedBytes).toBe(64_000);
    expect(final.truncated).toBe(true);
  });

  it('does not lose close events from repeated short-lived commands', async () => {
    const {store} = await setup({...configuration(), maxJobsPerSession: 32});
    const jobs = [];
    for (let index = 0; index < 24; index += 1) {
      const job = await store.start('short-session', {command: `printf ${index}`});
      await workers.at(-1);
      jobs.push(await store.get('short-session', job.id));
    }
    expect(jobs).toHaveLength(24);
    expect(jobs.every((job) => job.status === 'completed')).toBe(true);
  });

  it('cancels the process tree through a durable control file', async () => {
    const {store, recreate} = await setup();
    const command = `${shellQuote(process.execPath)} -e 'setInterval(() => process.stdout.write("tick\\n"), 25)'`;
    const job = await store.start('cancel-session', {command, timeoutMs: 10_000});
    expect(['running', 'starting']).toContain(job.status);

    const restarted = recreate();
    const cancelled = await restarted.kill('cancel-session', job.id);
    expect(cancelled.status).toBe('cancelled');
    await waitForWorkers();
    expect((await restarted.get('cancel-session', job.id)).status).toBe('cancelled');
  });

  it('enforces runtime limits and recovers a stale dead worker as failed', async () => {
    const {root, store, recreate} = await setup();
    const command = `${shellQuote(process.execPath)} -e 'setInterval(() => {}, 1000)'`;
    const timed = await store.start('timeout-session', {command, timeoutMs: 1_000});
    await waitForWorkers();
    expect((await store.get('timeout-session', timed.id)).status).toBe('timed_out');

    const metadataPath = join(root, '.jobs', 'timeout-session', timed.id, 'job.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>;
    metadata.status = 'running';
    metadata.workerPid = 2_000_000_000;
    metadata.updatedAt = '2000-01-01T00:00:00.000Z';
    metadata.lastHeartbeatAt = '2000-01-01T00:00:00.000Z';
    await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, {mode: 0o600});
    const recovered = await recreate().get('timeout-session', timed.id);
    expect(recovered.status).toBe('failed');
    expect(recovered.recovery).toContain('heartbeat expired');
  });

  it('rejects a worker descriptor changed after the approved start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-background-integrity-'));
    roots.push(root);
    const store = new BackgroundJobStore(root, configuration(), {
      directory: join(root, '.jobs'),
      launchWorker: async (path, environment) => {
        const descriptor = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
        descriptor.command = 'printf tampered';
        await writeFile(path, `${JSON.stringify(descriptor)}\n`, {mode: 0o600});
        await runBackgroundWorker(path, environment);
        return {pid: process.pid};
      },
    });
    await expect(store.start('integrity-session', {command: 'printf approved'}))
      .rejects.toThrow('launch-integrity');
  });

  it('does not follow a replaced log symlink and evicts old terminal history within its quota', async () => {
    const config = {...configuration(), maxJobsPerSession: 1};
    const {root, store} = await setup(config);
    const first = await store.start('history-session', {command: 'printf first'});
    await waitForWorkers();
    const outside = join(root, 'outside.log');
    await writeFile(outside, 'outside-secret');
    const stdout = join(root, '.jobs', 'history-session', first.id, 'stdout.log');
    await rm(stdout);
    await symlink(outside, stdout);
    await expect(store.output('history-session', first.id)).rejects.toThrow();

    const second = await store.start('history-session', {command: 'printf second'});
    await waitForWorkers();
    expect(second.id).not.toBe(first.id);
    await expect(store.get('history-session', first.id)).rejects.toThrow();
    expect((await store.get('history-session', second.id)).status).toBe('completed');
  });

  it('registers only when enabled and makes start and kill live-human actions', () => {
    expect(createDefaultToolRegistry({backgroundJobs: {...configuration(), enabled: false}}).has('background_start')).toBe(false);
    const registry = createDefaultToolRegistry({backgroundJobs: configuration()});
    expect(registry.has('background_start')).toBe(true);
    expect(registry.has('background_list')).toBe(true);
    expect(registry.has('background_output')).toBe(true);
    expect(registry.has('background_kill')).toBe(true);
    const tools = createBackgroundJobTools(configuration());
    expect(tools.find((tool) => tool.definition.name === 'background_start')?.definition.humanApproval).toBe(true);
    expect(tools.find((tool) => tool.definition.name === 'background_kill')?.definition.humanApproval).toBe(true);
  });
});

async function setup(config = configuration()) {
  const root = await mkdtemp(join(tmpdir(), 'skein-background-'));
  roots.push(root);
  const directory = join(root, '.jobs');
  const options = {
    directory,
    launchWorker: async (path: string, environment: NodeJS.ProcessEnv) => {
      const worker = runBackgroundWorker(path, environment);
      workers.push(worker);
      return {pid: process.pid};
    },
  };
  return {
    root,
    store: new BackgroundJobStore(root, config, options),
    recreate: () => new BackgroundJobStore(root, config, options),
  };
}

function configuration(): BackgroundJobsConfig {
  return {
    enabled: true,
    maxConcurrent: 2,
    maxJobsPerSession: 8,
    maxLogBytes: 64_000,
    maxRuntimeMs: 30_000,
  };
}

async function waitForWorkers(): Promise<void> {
  await Promise.all(workers.map((worker) => worker));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}
