import {createHash, createHmac, randomBytes, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {lstat, open, readdir, rm, stat, unlink, writeFile, type FileHandle} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {z} from 'zod';
import type {BackgroundJobsConfig} from '../types.js';
import {atomicWrite} from '../tools/write.js';
import {WorkspaceAccess} from '../tools/workspace.js';
import {
  assertActiveProjectNamespacePath,
  projectNamespacePaths,
  resolveProjectNamespaceSync,
} from '../utils/namespace.js';
import {acquireNamespaceLease, withNamespaceLease} from '../utils/namespace-lease.js';
import {resolveExecutableRuntime} from '../utils/process.js';
import {assertNoSymlinkPath, ensureWorkspaceStorageDirectory} from '../utils/storage.js';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const START_TIMEOUT_MS = 3_000;
const STALE_HEARTBEAT_MS = 15_000;
const sessionIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u);
const jobIdSchema = z.string().uuid();
const statusSchema = z.enum(['starting', 'running', 'cancel_requested', 'completed', 'failed', 'cancelled', 'timed_out']);

const metadataSchema = z.object({
  version: z.literal(1),
  id: jobIdSchema,
  sessionId: sessionIdSchema,
  commandSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  cwd: z.string().min(1).max(8_000),
  status: statusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastHeartbeatAt: z.string().datetime(),
  timeoutMs: z.number().int().min(1_000).max(86_400_000),
  maxLogBytes: z.number().int().min(64_000).max(5_000_000),
  workerPid: z.number().int().positive().optional(),
  processPid: z.number().int().positive().optional(),
  exitCode: z.number().int().nullable().optional(),
  signal: z.string().max(64).nullable().optional(),
  stdoutBytes: z.number().int().nonnegative().default(0),
  stderrBytes: z.number().int().nonnegative().default(0),
  retainedBytes: z.number().int().nonnegative().default(0),
  truncated: z.boolean().default(false),
  recovery: z.string().max(200).optional(),
}).strict();

const descriptorSchema = z.object({
  version: z.literal(1),
  workspace: z.string().min(1).max(8_000),
  managedStorage: z.boolean(),
  jobDirectory: z.string().min(1).max(8_000),
  metadataPath: z.string().min(1).max(8_000),
  stdoutPath: z.string().min(1).max(8_000),
  stderrPath: z.string().min(1).max(8_000),
  cancelPath: z.string().min(1).max(8_000),
  command: z.string().min(1).max(100_000).refine((value) => !value.includes('\u0000')),
  cwd: z.string().min(1).max(8_000),
  shell: z.string().min(1).max(8_000),
  shellPath: z.string().max(100_000),
  timeoutMs: z.number().int().min(1_000).max(86_400_000),
  maxLogBytes: z.number().int().min(64_000).max(5_000_000),
  integrity: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

export type BackgroundJobStatus = z.infer<typeof statusSchema>;
export type BackgroundJob = z.infer<typeof metadataSchema>;
type BackgroundJobDescriptor = z.infer<typeof descriptorSchema>;

export interface BackgroundJobOutput {
  job: BackgroundJob;
  stdout: string;
  stderr: string;
  cursor: string;
  hasMore: boolean;
}

export interface BackgroundJobStoreOptions {
  directory?: string;
  now?: () => Date;
  launchWorker?: (descriptorPath: string, environment: NodeJS.ProcessEnv) => Promise<{pid: number}>;
}

export class BackgroundJobStore {
  readonly workspace: string;
  readonly directory: string;
  private readonly managedDirectory: boolean;
  private readonly now: () => Date;
  private readonly launchWorker: NonNullable<BackgroundJobStoreOptions['launchWorker']>;

  constructor(
    workspace: string,
    private readonly config: BackgroundJobsConfig,
    options: BackgroundJobStoreOptions = {},
  ) {
    this.workspace = resolve(workspace);
    this.managedDirectory = options.directory === undefined;
    this.directory = options.directory
      ? resolve(options.directory)
      : join(resolveProjectNamespaceSync(this.workspace).active, 'background-jobs');
    this.now = options.now ?? (() => new Date());
    this.launchWorker = options.launchWorker ?? launchDetachedWorker;
  }

  async start(sessionId: string, input: {command: string; cwd?: string; timeoutMs?: number}): Promise<BackgroundJob> {
    sessionIdSchema.parse(sessionId);
    const command = z.string().min(1).max(100_000).refine((value) => !value.includes('\u0000')).parse(input.command);
    const timeoutMs = input.timeoutMs ?? this.config.maxRuntimeMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > this.config.maxRuntimeMs) {
      throw new Error(`Background timeout must be between 1000 and ${this.config.maxRuntimeMs} ms.`);
    }
    const workspace = new WorkspaceAccess([this.workspace]);
    const cwd = await workspace.resolveDirectory(input.cwd ?? '.');
    const shellName = process.platform === 'win32'
      ? process.env.COMSPEC ?? 'cmd.exe'
      : process.env.SHELL ?? '/bin/sh';
    const shell = await resolveExecutableRuntime(shellName, this.workspace, [this.workspace]);
    if (!shell) throw new Error('The configured command shell is unavailable or resolves inside the workspace.');

    await this.ensureDirectory(this.directory);
    return this.withStartLock(sessionId, async () => {
      await this.prune(sessionId);
      const jobs = await this.list(sessionId);
      const active = jobs.filter((job) => activeStatus(job.status));
      if (active.length >= this.config.maxConcurrent) {
        throw new Error(`Background job limit reached (${this.config.maxConcurrent} active for this session).`);
      }
      if (jobs.length >= this.config.maxJobsPerSession) {
        throw new Error(`Background job history limit reached (${this.config.maxJobsPerSession}); wait for retention cleanup.`);
      }

      const id = randomUUID();
      const jobDirectory = join(this.sessionDirectory(sessionId), id);
      await this.ensureDirectory(jobDirectory);
      const paths = jobPaths(jobDirectory);
      await Promise.all([
        writeFile(paths.stdout, '', {flag: 'wx', mode: 0o600}),
        writeFile(paths.stderr, '', {flag: 'wx', mode: 0o600}),
      ]);
      const timestamp = this.now().toISOString();
      const metadata: BackgroundJob = {
        version: 1,
        id,
        sessionId,
        commandSha256: sha256(command),
        cwd: workspace.display(cwd),
        status: 'starting',
        createdAt: timestamp,
        updatedAt: timestamp,
        lastHeartbeatAt: timestamp,
        timeoutMs,
        maxLogBytes: this.config.maxLogBytes,
        stdoutBytes: 0,
        stderrBytes: 0,
        retainedBytes: 0,
        truncated: false,
      };
      await writeMetadata(paths.metadata, metadata);
      const descriptorBody: Omit<BackgroundJobDescriptor, 'integrity'> = {
        version: 1,
        workspace: this.workspace,
        managedStorage: this.managedDirectory,
        jobDirectory,
        metadataPath: paths.metadata,
        stdoutPath: paths.stdout,
        stderrPath: paths.stderr,
        cancelPath: paths.cancel,
        command,
        cwd,
        shell: shell.executable,
        shellPath: shell.path,
        timeoutMs,
        maxLogBytes: this.config.maxLogBytes,
      };
      const launchToken = randomBytes(32).toString('hex');
      const descriptor: BackgroundJobDescriptor = {
        ...descriptorBody,
        integrity: descriptorIntegrity(descriptorBody, launchToken),
      };
      await atomicWrite(paths.descriptor, `${JSON.stringify(descriptor)}\n`, 0o600);
      try {
        await this.launchWorker(paths.descriptor, workerEnvironment(shell.path, launchToken));
      } catch (error) {
        await writeMetadata(paths.metadata, {
          ...metadata,
          status: 'failed',
          updatedAt: this.now().toISOString(),
          recovery: 'worker launch failed',
        });
        await unlink(paths.descriptor).catch(() => undefined);
        throw error;
      }
      const started = Date.now();
      while (Date.now() - started < START_TIMEOUT_MS) {
        const current = await readMetadata(paths.metadata);
        if (current.status !== 'starting') return current;
        await delay(25);
      }
      return readMetadata(paths.metadata);
    });
  }

  async list(sessionId: string): Promise<BackgroundJob[]> {
    sessionIdSchema.parse(sessionId);
    const directory = this.sessionDirectory(sessionId);
    if (!(await regularDirectory(directory, this.workspace))) return [];
    const names = await readdir(directory);
    const jobs: BackgroundJob[] = [];
    for (const name of names.sort()) {
      if (!jobIdSchema.safeParse(name).success) continue;
      const path = jobPaths(join(directory, name)).metadata;
      jobs.push(await this.reconcile(await readMetadata(path), path));
    }
    return jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async get(sessionId: string, id: string): Promise<BackgroundJob> {
    sessionIdSchema.parse(sessionId);
    jobIdSchema.parse(id);
    const path = jobPaths(join(this.sessionDirectory(sessionId), id)).metadata;
    const job = await this.reconcile(await readMetadata(path), path);
    if (job.sessionId !== sessionId || job.id !== id) throw new Error('Background job ownership mismatch.');
    return job;
  }

  async output(sessionId: string, id: string, options: {cursor?: string; maxBytes?: number} = {}): Promise<BackgroundJobOutput> {
    const job = await this.get(sessionId, id);
    const [stdoutOffset, stderrOffset] = parseCursor(options.cursor);
    const maxBytes = options.maxBytes ?? 8_000;
    if (!Number.isInteger(maxBytes) || maxBytes < 256 || maxBytes > 32_000) {
      throw new Error('Background output maxBytes must be between 256 and 32000.');
    }
    const paths = jobPaths(join(this.sessionDirectory(sessionId), id));
    const stdoutBudget = Math.ceil(maxBytes / 2);
    const stdout = await readLogPage(paths.stdout, stdoutOffset, stdoutBudget);
    const stderr = await readLogPage(paths.stderr, stderrOffset, maxBytes - Buffer.byteLength(stdout.content));
    return {
      job,
      stdout: stdout.content,
      stderr: stderr.content,
      cursor: `${stdout.next}:${stderr.next}`,
      hasMore: stdout.hasMore || stderr.hasMore,
    };
  }

  async kill(sessionId: string, id: string): Promise<BackgroundJob> {
    const job = await this.get(sessionId, id);
    if (!activeStatus(job.status)) return job;
    const paths = jobPaths(join(this.sessionDirectory(sessionId), id));
    await writeFile(paths.cancel, `${this.now().toISOString()}\n`, {flag: 'wx', mode: 0o600}).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    await writeMetadata(paths.metadata, {
      ...job,
      status: 'cancel_requested',
      updatedAt: this.now().toISOString(),
    });
    const started = Date.now();
    while (Date.now() - started < 3_000) {
      await delay(50);
      const current = await this.get(sessionId, id);
      if (!activeStatus(current.status)) return current;
    }
    return this.get(sessionId, id);
  }

  async removeSession(sessionId: string): Promise<void> {
    const jobs = await this.list(sessionId);
    for (const job of jobs.filter((candidate) => activeStatus(candidate.status))) {
      await this.kill(sessionId, job.id);
    }
    const remaining = (await this.list(sessionId)).filter((job) => activeStatus(job.status));
    if (remaining.length) throw new Error('Cannot delete a session while a background job is still active.');
    await rm(this.sessionDirectory(sessionId), {recursive: true, force: true});
  }

  private async prune(sessionId: string): Promise<void> {
    const cutoff = this.now().getTime() - RETENTION_MS;
    let jobs = await this.list(sessionId);
    for (const job of jobs) {
      if (!activeStatus(job.status) && Date.parse(job.updatedAt) < cutoff) {
        await rm(join(this.sessionDirectory(sessionId), job.id), {recursive: true, force: true});
      }
    }
    jobs = await this.list(sessionId);
    const evictable = jobs.filter((job) => !activeStatus(job.status))
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    while (jobs.length >= this.config.maxJobsPerSession && evictable.length) {
      const oldest = evictable.shift() as BackgroundJob;
      await rm(join(this.sessionDirectory(sessionId), oldest.id), {recursive: true, force: true});
      jobs = jobs.filter((job) => job.id !== oldest.id);
    }
  }

  private async reconcile(job: BackgroundJob, path: string): Promise<BackgroundJob> {
    if (!activeStatus(job.status) || Date.now() - Date.parse(job.lastHeartbeatAt) <= STALE_HEARTBEAT_MS) return job;
    if (job.workerPid && processAlive(job.workerPid)) return job;
    const recovered: BackgroundJob = {
      ...job,
      status: 'failed',
      updatedAt: this.now().toISOString(),
      recovery: 'worker heartbeat expired; recovered as failed',
    };
    await writeMetadata(path, recovered);
    return recovered;
  }

  private sessionDirectory(sessionId: string): string {
    return join(this.directory, sessionId);
  }

  private async ensureDirectory(directory: string): Promise<void> {
    await ensureWorkspaceStorageDirectory(this.workspace, directory, {
      requireActiveNamespace: this.managedDirectory,
    });
  }

  private async withStartLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const sessionDirectory = this.sessionDirectory(sessionId);
    await this.ensureDirectory(sessionDirectory);
    const path = join(sessionDirectory, '.start.lock');
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const handle = await open(path, 'wx', 0o600);
        await handle.close();
        try {
          return await this.withManagedLease(operation);
        } finally {
          await unlink(path).catch(() => undefined);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          if (Date.now() - (await stat(path)).mtimeMs > 10_000) await unlink(path);
        } catch { /* The next attempt rechecks the lock. */ }
        await delay(25);
      }
    }
    throw new Error('Background job start is busy; retry shortly.');
  }

  private async withManagedLease<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.managedDirectory) return operation();
    return withNamespaceLease(projectNamespacePaths(this.workspace).canonical, 'shared', async () => {
      assertActiveProjectNamespacePath(this.workspace, this.directory);
      return operation();
    });
  }
}

export async function runBackgroundWorker(
  descriptorPath: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const launchToken = environment.SKEIN_BACKGROUND_WORKER_TOKEN;
  if (!launchToken || !/^[a-f0-9]{64}$/u.test(launchToken)) {
    throw new Error('Background worker launch token is missing or invalid.');
  }
  const descriptor = await readDescriptor(descriptorPath, launchToken);
  const workspace = new WorkspaceAccess([descriptor.workspace]);
  await workspace.resolveDirectory(descriptor.cwd);
  const jobDirectory = resolve(descriptor.jobDirectory);
  const expected = jobPaths(jobDirectory);
  if (resolve(descriptor.metadataPath) !== expected.metadata ||
    resolve(descriptor.stdoutPath) !== expected.stdout ||
    resolve(descriptor.stderrPath) !== expected.stderr ||
    resolve(descriptor.cancelPath) !== expected.cancel ||
    resolve(descriptorPath) !== expected.descriptor) {
    throw new Error('Background worker descriptor paths do not match the job directory.');
  }
  await assertNoSymlinkPath(descriptor.workspace, jobDirectory);
  if (descriptor.managedStorage) {
    assertActiveProjectNamespacePath(descriptor.workspace, jobDirectory);
  }
  const lease = descriptor.managedStorage
    ? await acquireNamespaceLease(projectNamespacePaths(descriptor.workspace).canonical, 'shared')
    : undefined;
  await unlink(descriptorPath).catch(() => undefined);

  let metadata = await readMetadata(descriptor.metadataPath);
  let child: ReturnType<typeof spawn> | undefined;
  let cancelled = false;
  let timedOut = false;
  let terminationRequested = false;
  let forceKillTimer: NodeJS.Timeout | undefined;
  let retainedBytes = metadata.retainedBytes;
  let stdoutBytes = metadata.stdoutBytes;
  let stderrBytes = metadata.stderrBytes;
  let writeQueue = Promise.resolve();
  let logWriteQueue = Promise.resolve();
  let logWriteError: Error | undefined;
  let stdoutHandle: FileHandle | undefined;
  let stderrHandle: FileHandle | undefined;
  const update = (changes: Partial<BackgroundJob>): Promise<void> => {
    writeQueue = writeQueue.then(async () => {
      const timestamp = new Date().toISOString();
      metadata = metadataSchema.parse({...metadata, ...changes, updatedAt: timestamp, lastHeartbeatAt: timestamp});
      await writeMetadata(descriptor.metadataPath, metadata);
    });
    return writeQueue;
  };
  const append = (chunk: Buffer, channel: 'stdout' | 'stderr'): void => {
    if (channel === 'stdout') stdoutBytes += chunk.length;
    else stderrBytes += chunk.length;
    const remaining = Math.max(0, descriptor.maxLogBytes - retainedBytes);
    const selected = chunk.subarray(0, remaining);
    retainedBytes += selected.length;
    const handle = channel === 'stdout' ? stdoutHandle : stderrHandle;
    if (selected.length && handle) {
      logWriteQueue = logWriteQueue.then(async () => {
        try {
          await handle.write(selected);
        } catch (error) {
          logWriteError = error instanceof Error ? error : new Error(String(error));
        }
      });
    }
  };
  const terminate = (reason: 'cancelled' | 'timed_out'): void => {
    if (terminationRequested) return;
    terminationRequested = true;
    if (reason === 'cancelled') cancelled = true;
    else timedOut = true;
    if (child?.pid) {
      signalProcessTree(child.pid, 'SIGTERM');
      forceKillTimer = setTimeout(() => signalProcessTree(child?.pid, 'SIGKILL'), 1_000);
      forceKillTimer.unref();
    }
  };
  const signalHandler = () => terminate('cancelled');
  process.on('SIGTERM', signalHandler);
  process.on('SIGINT', signalHandler);
  try {
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    const flags = constants.O_WRONLY | constants.O_APPEND | noFollow;
    stdoutHandle = await open(descriptor.stdoutPath, flags);
    stderrHandle = await open(descriptor.stderrPath, flags);
    const args = process.platform === 'win32'
      ? ['/d', '/s', '/c', descriptor.command]
      : ['-lc', descriptor.command];
    child = spawn(descriptor.shell, args, {
      cwd: descriptor.cwd,
      env: jobEnvironment(descriptor.shellPath),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    child.stdout?.on('data', (chunk: Buffer) => append(chunk, 'stdout'));
    child.stderr?.on('data', (chunk: Buffer) => append(chunk, 'stderr'));
    const spawned = new Promise<void>((resolvePromise, reject) => {
      child?.once('spawn', resolvePromise);
      child?.once('error', reject);
    });
    // Bind close before awaiting spawn or metadata I/O: a very short command
    // can otherwise exit between those steps and leave the worker waiting forever.
    const closed = new Promise<{code: number | null; signal: NodeJS.Signals | null}>((resolvePromise) => {
      child?.once('close', (code, signal) => resolvePromise({code, signal}));
    });
    await spawned;
    await update({status: 'running', workerPid: process.pid, ...(child.pid ? {processPid: child.pid} : {})});
    const heartbeat = setInterval(() => {
      void update({stdoutBytes, stderrBytes, retainedBytes, truncated: stdoutBytes + stderrBytes > retainedBytes});
    }, 1_000);
    const cancelPoll = setInterval(() => {
      void lstat(descriptor.cancelPath).then(() => terminate('cancelled')).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') terminate('cancelled');
      });
    }, 100);
    const timeout = setTimeout(() => terminate('timed_out'), descriptor.timeoutMs);
    const result = await closed;
    if (forceKillTimer) clearTimeout(forceKillTimer);
    clearInterval(heartbeat);
    clearInterval(cancelPoll);
    clearTimeout(timeout);
    await logWriteQueue;
    if (logWriteError) throw logWriteError;
    await Promise.all([stdoutHandle.close(), stderrHandle.close()]);
    stdoutHandle = undefined;
    stderrHandle = undefined;
    const status: BackgroundJobStatus = timedOut
      ? 'timed_out'
      : cancelled ? 'cancelled' : result.code === 0 ? 'completed' : 'failed';
    await update({
      status,
      exitCode: result.code,
      signal: result.signal,
      stdoutBytes,
      stderrBytes,
      retainedBytes,
      truncated: stdoutBytes + stderrBytes > retainedBytes,
    });
  } catch (error) {
    if (forceKillTimer) clearTimeout(forceKillTimer);
    if (child?.pid) signalProcessTree(child.pid, 'SIGTERM');
    await logWriteQueue;
    await Promise.all([stdoutHandle?.close(), stderrHandle?.close()]);
    stdoutHandle = undefined;
    stderrHandle = undefined;
    await update({
      status: cancelled ? 'cancelled' : timedOut ? 'timed_out' : 'failed',
      stdoutBytes,
      stderrBytes,
      retainedBytes,
      truncated: stdoutBytes + stderrBytes > retainedBytes,
      recovery: cleanError(error),
    });
  } finally {
    process.off('SIGTERM', signalHandler);
    process.off('SIGINT', signalHandler);
    await unlink(descriptor.cancelPath).catch(() => undefined);
    await Promise.all([stdoutHandle?.close(), stderrHandle?.close()]);
    lease?.release();
  }
}

async function readDescriptor(path: string, launchToken: string): Promise<BackgroundJobDescriptor> {
  const descriptor = descriptorSchema.parse(JSON.parse(
    await readBoundedRegularFile(path, 120_000, 'Background worker descriptor'),
  ) as unknown);
  const {integrity, ...body} = descriptor;
  if (descriptorIntegrity(body, launchToken) !== integrity) {
    throw new Error('Background worker descriptor failed its launch-integrity check.');
  }
  return descriptor;
}

async function readMetadata(path: string): Promise<BackgroundJob> {
  return metadataSchema.parse(JSON.parse(
    await readBoundedRegularFile(path, 32_000, 'Background job metadata'),
  ) as unknown);
}

async function writeMetadata(path: string, metadata: BackgroundJob): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(metadataSchema.parse(metadata))}\n`, 0o600);
}

function jobPaths(directory: string) {
  return {
    metadata: resolve(directory, 'job.json'),
    descriptor: resolve(directory, 'worker.json'),
    stdout: resolve(directory, 'stdout.log'),
    stderr: resolve(directory, 'stderr.log'),
    cancel: resolve(directory, 'cancel'),
  };
}

async function regularDirectory(path: string, workspace: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    await assertNoSymlinkPath(workspace, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function readLogPage(path: string, offset: number, maxBytes: number): Promise<{content: string; next: number; hasMore: boolean}> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Background output cursor is invalid.');
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Background output is not a regular file.');
    const start = Math.min(offset, info.size);
    const length = Math.max(0, Math.min(maxBytes, info.size - start));
    if (!length) return {content: '', next: start, hasMore: start < info.size};
    const buffer = Buffer.alloc(length);
    const {bytesRead} = await handle.read(buffer, 0, length, start);
    return {
      content: buffer.subarray(0, bytesRead).toString('utf8').replace(/\u0000/gu, ''),
      next: start + bytesRead,
      hasMore: start + bytesRead < info.size,
    };
  } finally {
    await handle.close();
  }
}

async function readBoundedRegularFile(path: string, maxBytes: number, label: string): Promise<string> {
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error(`${label} is not a bounded regular file.`);
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

function parseCursor(value?: string): [number, number] {
  if (!value) return [0, 0];
  const match = value.match(/^(\d+):(\d+)$/u);
  if (!match?.[1] || !match[2]) throw new Error('Background cursor must use stdout:stderr byte offsets.');
  const cursor: [number, number] = [Number(match[1]), Number(match[2])];
  if (cursor.some((item) => !Number.isSafeInteger(item) || item < 0)) throw new Error('Background cursor is invalid.');
  return cursor;
}

function activeStatus(status: BackgroundJobStatus): boolean {
  return status === 'starting' || status === 'running' || status === 'cancel_requested';
}

async function launchDetachedWorker(descriptorPath: string, environment: NodeJS.ProcessEnv): Promise<{pid: number}> {
  const entry = process.argv[1];
  if (!entry) throw new Error('Cannot locate the Skein CLI entry point for the background worker.');
  if (!/\.(?:c|m)?js$/u.test(entry)) {
    throw new Error('Durable background jobs require the built Skein CLI entry point.');
  }
  const child = spawn(process.execPath, [entry, '__background-worker', descriptorPath], {
    detached: true,
    stdio: 'ignore',
    env: environment,
  });
  await new Promise<void>((resolvePromise, reject) => {
    child.once('spawn', resolvePromise);
    child.once('error', reject);
  });
  if (!child.pid) throw new Error('Background worker did not return a process id.');
  child.unref();
  return {pid: child.pid};
}

function workerEnvironment(path: string, launchToken: string): NodeJS.ProcessEnv {
  return {
    ...jobEnvironment(path),
    SKEIN_BACKGROUND_WORKER: '1',
    SKEIN_BACKGROUND_WORKER_TOKEN: launchToken,
  };
}

function jobEnvironment(path: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {PATH: path};
  for (const name of [
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
    'XDG_RUNTIME_DIR', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM',
    'NO_COLOR', 'CI', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT',
  ]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

function signalProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, signal);
  } catch { /* The process may already have exited. */ }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function descriptorIntegrity(
  descriptor: Omit<BackgroundJobDescriptor, 'integrity'>,
  launchToken: string,
): string {
  return createHmac('sha256', launchToken).update(JSON.stringify(descriptor)).digest('hex');
}

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 200) || 'background worker failed';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
