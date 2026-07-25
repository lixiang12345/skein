import {createHash} from 'node:crypto';
import {lstat, readFile, readdir, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {z} from 'zod';
import {atomicWrite} from '../tools/write.js';
import type {ToolArtifactReference} from '../types.js';
import {
  assertActiveProjectNamespacePath,
  projectNamespacePaths,
  resolveProjectNamespaceSync,
} from '../utils/namespace.js';
import {withNamespaceLease} from '../utils/namespace-lease.js';
import {assertNoSymlinkPath, ensureWorkspaceStorageDirectory} from '../utils/storage.js';

const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

const sessionIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const toolCallIdSchema = z.string().min(1).max(512).refine((value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value), {
  message: 'Tool call id cannot contain control characters.',
});

const artifactSchema = z.object({
  version: z.literal(1),
  sessionId: sessionIdSchema,
  toolCallId: toolCallIdSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  bytes: z.number().int().nonnegative().max(MAX_ARTIFACT_BYTES),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  redacted: z.boolean(),
  content: z.string(),
}).strict();

type StoredArtifact = z.infer<typeof artifactSchema>;

export interface ToolArtifactPage extends ToolArtifactReference {
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  startByte: number;
  endByte: number;
  hasMore: boolean;
  nextStartLine?: number;
  nextStartByte?: number;
}

export type ToolArtifactArchiveResult =
  | {stored: true; artifact: ToolArtifactReference}
  | {stored: false; reason: 'too_large' | 'total_limit' | 'conflict' | 'storage_error'};

export interface ToolArtifactStoreOptions {
  directory?: string;
  now?: () => Date;
  maxArtifactBytes?: number;
  maxTotalBytes?: number;
  retentionMs?: number;
}

/**
 * Stores oversize tool results outside the model transcript. File names are
 * hashes of the session and tool-call identities, so model-supplied ids never
 * become filesystem paths. Every read validates the session binding and hash.
 */
export class ToolArtifactStore {
  readonly workspace: string;
  readonly directory: string;
  private readonly managedDirectory: boolean;
  private readonly now: () => Date;
  private readonly maxArtifactBytes: number;
  private readonly maxTotalBytes: number;
  private readonly retentionMs: number;
  private writes: Promise<void> = Promise.resolve();

  constructor(workspace: string, options: ToolArtifactStoreOptions = {}) {
    this.workspace = resolve(workspace);
    this.managedDirectory = options.directory === undefined;
    this.directory = options.directory
      ? resolve(options.directory)
      : join(resolveProjectNamespaceSync(this.workspace).active, 'tool-artifacts');
    this.now = options.now ?? (() => new Date());
    this.maxArtifactBytes = options.maxArtifactBytes ?? MAX_ARTIFACT_BYTES;
    this.maxTotalBytes = options.maxTotalBytes ?? MAX_TOTAL_BYTES;
    this.retentionMs = options.retentionMs ?? RETENTION_MS;
    if (!Number.isSafeInteger(this.maxArtifactBytes) || this.maxArtifactBytes < 1 ||
      this.maxArtifactBytes > MAX_ARTIFACT_BYTES) {
      throw new Error(`maxArtifactBytes must be between 1 and ${MAX_ARTIFACT_BYTES}.`);
    }
    if (!Number.isSafeInteger(this.maxTotalBytes) || this.maxTotalBytes < this.maxArtifactBytes) {
      throw new Error('maxTotalBytes must be at least maxArtifactBytes.');
    }
    if (!Number.isSafeInteger(this.retentionMs) || this.retentionMs < 1) {
      throw new Error('retentionMs must be a positive integer.');
    }
  }

  async archive(
    sessionId: string,
    toolCallId: string,
    content: string,
    options: {redacted: boolean},
  ): Promise<ToolArtifactArchiveResult> {
    sessionIdSchema.parse(sessionId);
    toolCallIdSchema.parse(toolCallId);
    const bytes = Buffer.byteLength(content);
    if (bytes > this.maxArtifactBytes) return {stored: false, reason: 'too_large'};
    return this.enqueue(() => this.withManagedLease(async () => {
      await this.ensureDirectory();
      const now = this.now();
      const artifacts = await this.loadArtifacts();
      await this.removeExpired(artifacts, now);
      const active = artifacts.filter((artifact) => artifact.expiresAt > now.toISOString());
      const sha256 = hash(content);
      const existing = active.find((artifact) => artifact.sessionId === sessionId && artifact.toolCallId === toolCallId);
      if (existing) {
        if (existing.sha256 === sha256 && existing.bytes === bytes && existing.redacted === options.redacted) {
          return {stored: true, artifact: reference(existing)};
        }
        return {stored: false, reason: 'conflict'};
      }
      const artifact: StoredArtifact = {
        version: 1,
        sessionId,
        toolCallId,
        sha256,
        bytes,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.retentionMs).toISOString(),
        redacted: options.redacted,
        content,
      };
      const storageBytes = storedBytes(artifact);
      let retainedBytes = active.reduce((total, retained) => total + storedBytes(retained), 0);
      const evictable = active.slice().sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      );
      while (retainedBytes + storageBytes > this.maxTotalBytes && evictable.length) {
        const oldest = evictable.shift() as StoredArtifact;
        await this.removeArtifact(oldest);
        retainedBytes -= storedBytes(oldest);
      }
      if (retainedBytes + storageBytes > this.maxTotalBytes) return {stored: false, reason: 'total_limit'};
      const path = this.pathFor(sessionId, toolCallId);
      await ensureWorkspaceStorageDirectory(this.workspace, resolve(path, '..'), {
        requireActiveNamespace: this.managedDirectory,
      });
      await atomicWrite(path, `${JSON.stringify(artifact)}\n`, 0o600);
      return {stored: true, artifact: reference(artifact)};
    }));
  }

  async read(
    sessionId: string,
    toolCallId: string,
    options: {startLine?: number; startByte?: number; maxLines?: number; maxBytes?: number} = {},
  ): Promise<ToolArtifactPage> {
    sessionIdSchema.parse(sessionId);
    toolCallIdSchema.parse(toolCallId);
    const startLine = options.startLine ?? 1;
    const startByte = options.startByte;
    const maxLines = options.maxLines ?? 200;
    const maxBytes = options.maxBytes ?? 3_000;
    if (startByte !== undefined && options.startLine !== undefined) {
      throw new Error('Use either startLine or startByte, not both.');
    }
    if (!Number.isInteger(startLine) || startLine < 1) throw new Error('startLine must be a positive integer.');
    if (startByte !== undefined && (!Number.isInteger(startByte) || startByte < 0)) {
      throw new Error('startByte must be a non-negative integer.');
    }
    if (!Number.isInteger(maxLines) || maxLines < 1 || maxLines > 1_000) {
      throw new Error('maxLines must be between 1 and 1000.');
    }
    if (!Number.isInteger(maxBytes) || maxBytes < 256 || maxBytes > 32_000) {
      throw new Error('maxBytes must be between 256 and 32000.');
    }
    await this.writes;
    return this.withManagedLease(async () => {
      const artifact = await this.readArtifact(sessionId, toolCallId);
      const now = this.now();
      if (artifact.expiresAt <= now.toISOString()) {
        await this.removeArtifact(artifact);
        throw new Error('The retained tool output has expired. Re-run the tool if it is still needed.');
      }
      const page = startByte === undefined
        ? readLinePage(artifact.content, startLine, maxLines, maxBytes)
        : readBytePage(artifact.content, startByte, maxBytes);
      return {
        ...reference(artifact),
        ...page,
      };
    });
  }

  /** Remove expired output and return the still-valid receipts for one session. */
  async prune(sessionId: string): Promise<ToolArtifactReference[]> {
    sessionIdSchema.parse(sessionId);
    return this.enqueue(() => this.withManagedLease(async () => {
      const artifacts = await this.loadArtifacts();
      const now = this.now();
      await this.removeExpired(artifacts, now);
      return artifacts
        .filter((artifact) => artifact.sessionId === sessionId && artifact.expiresAt > now.toISOString())
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map(reference);
    }));
  }

  /** Delete every retained result owned by a removed session. */
  async removeSession(sessionId: string): Promise<void> {
    sessionIdSchema.parse(sessionId);
    await this.enqueue(() => this.withManagedLease(async () => {
      if (!(await this.directoryAvailable())) return;
      const directory = this.sessionDirectoryFor(sessionId);
      try {
        const info = await lstat(directory);
        if (info.isSymbolicLink() || !info.isDirectory()) {
          throw new Error(`Tool artifact session storage is not a regular directory: ${directory}`);
        }
        await assertNoSymlinkPath(this.workspace, directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      await rm(directory, {recursive: true, force: true});
    }));
  }

  private async readArtifact(sessionId: string, toolCallId: string): Promise<StoredArtifact> {
    const path = this.pathFor(sessionId, toolCallId);
    await this.assertRegularFile(path);
    let artifact: StoredArtifact;
    try {
      artifact = artifactSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown);
    } catch {
      throw new Error('Retained tool output is unreadable or corrupt.');
    }
    if (artifact.sessionId !== sessionId || artifact.toolCallId !== toolCallId) {
      throw new Error('Retained tool output does not belong to this session.');
    }
    if (artifact.bytes !== Buffer.byteLength(artifact.content) || artifact.sha256 !== hash(artifact.content)) {
      throw new Error('Retained tool output failed its integrity check.');
    }
    return artifact;
  }

  private async loadArtifacts(): Promise<StoredArtifact[]> {
    if (!(await this.directoryAvailable())) return [];
    const artifacts: StoredArtifact[] = [];
    for (const entry of await readdir(this.directory, {withFileTypes: true})) {
      const sessionDirectory = join(this.directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Tool artifact storage contains a symbolic link: ${sessionDirectory}`);
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/u.test(entry.name)) continue;
      await assertNoSymlinkPath(this.workspace, sessionDirectory);
      for (const file of await readdir(sessionDirectory, {withFileTypes: true})) {
        const path = join(sessionDirectory, file.name);
        if (file.isSymbolicLink()) throw new Error(`Tool artifact storage contains a symbolic link: ${path}`);
        if (!file.isFile() || !/^[a-f0-9]{64}\.json$/u.test(file.name)) continue;
        await this.assertRegularFile(path);
        try {
          const artifact = artifactSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown);
          if (artifact.bytes !== Buffer.byteLength(artifact.content) || artifact.sha256 !== hash(artifact.content)) {
            throw new Error('integrity');
          }
          if (sessionDirectory !== this.sessionDirectoryFor(artifact.sessionId) ||
            path !== this.pathFor(artifact.sessionId, artifact.toolCallId)) {
            throw new Error('identity');
          }
          artifacts.push(artifact);
        } catch {
          throw new Error(`Tool artifact is unreadable or corrupt: ${path}`);
        }
      }
    }
    return artifacts;
  }

  private async removeExpired(artifacts: StoredArtifact[], now: Date): Promise<void> {
    for (const artifact of artifacts) {
      if (artifact.expiresAt <= now.toISOString()) await this.removeArtifact(artifact);
    }
  }

  private async removeArtifact(artifact: StoredArtifact): Promise<void> {
    await rm(this.pathFor(artifact.sessionId, artifact.toolCallId), {force: true});
  }

  private pathFor(sessionId: string, toolCallId: string): string {
    return join(this.sessionDirectoryFor(sessionId), `${hash(`call\0${toolCallId}`)}.json`);
  }

  private sessionDirectoryFor(sessionId: string): string {
    return join(this.directory, hash(`session\0${sessionId}`));
  }

  private async ensureDirectory(): Promise<void> {
    await ensureWorkspaceStorageDirectory(this.workspace, this.directory, {
      requireActiveNamespace: this.managedDirectory,
    });
  }

  private async directoryAvailable(): Promise<boolean> {
    if (this.managedDirectory) await assertNoSymlinkPath(this.workspace, this.directory);
    try {
      const info = await lstat(this.directory);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`Tool artifact storage is not a regular directory: ${this.directory}`);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private async assertRegularFile(path: string): Promise<void> {
    await assertNoSymlinkPath(this.workspace, resolve(path, '..'));
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error(`Tool artifact cannot be a symbolic link or non-regular file: ${path}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('No retained tool output matches this tool call in the current session.');
      }
      throw error;
    }
  }

  private async withManagedLease<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.managedDirectory) return operation();
    return withNamespaceLease(projectNamespacePaths(this.workspace).canonical, 'shared', async () => {
      assertActiveProjectNamespacePath(this.workspace, this.directory);
      return operation();
    });
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writes.then(operation);
    this.writes = next.then(() => undefined, () => undefined);
    return next;
  }
}

function reference(artifact: StoredArtifact): ToolArtifactReference {
  return {
    toolCallId: artifact.toolCallId,
    sha256: artifact.sha256,
    bytes: artifact.bytes,
    createdAt: artifact.createdAt,
    expiresAt: artifact.expiresAt,
    redacted: artifact.redacted,
  };
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function storedBytes(artifact: StoredArtifact): number {
  return Buffer.byteLength(JSON.stringify(artifact)) + 1;
}

interface ArtifactContentPage {
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  startByte: number;
  endByte: number;
  hasMore: boolean;
  nextStartLine?: number;
  nextStartByte?: number;
}

function readLinePage(content: string, startLine: number, maxLines: number, maxBytes: number): ArtifactContentPage {
  const ranges = lineRanges(content);
  const startIndex = startLine - 1;
  if (startIndex >= ranges.length) {
    const totalBytes = Buffer.byteLength(content);
    return {
      content: '', startLine, endLine: startLine - 1, totalLines: ranges.length,
      startByte: totalBytes, endByte: totalBytes, hasMore: false,
    };
  }
  const endIndex = Math.min(ranges.length - 1, startIndex + maxLines - 1);
  const startCharacter = ranges[startIndex]?.start ?? content.length;
  const endCharacter = ranges[endIndex]?.end ?? content.length;
  const startByte = Buffer.byteLength(content.slice(0, startCharacter));
  const selected = Buffer.from(content.slice(startCharacter, endCharacter));
  if (selected.length > maxBytes) {
    const page = sliceUtf8Buffer(selected, 0, maxBytes);
    const pageContent = page.content;
    return {
      content: pageContent,
      startLine,
      endLine: startLine + countNewlines(pageContent),
      totalLines: ranges.length,
      startByte,
      endByte: startByte + page.bytes,
      hasMore: true,
      nextStartByte: startByte + page.bytes,
    };
  }
  const endLine = endIndex + 1;
  const hasMore = endLine < ranges.length;
  return {
    content: selected.toString('utf8'), startLine, endLine, totalLines: ranges.length,
    startByte, endByte: startByte + selected.length, hasMore,
    ...(hasMore ? {nextStartLine: endLine + 1} : {}),
  };
}

function readBytePage(content: string, requestedStart: number, maxBytes: number): ArtifactContentPage {
  const buffer = Buffer.from(content);
  const startByte = Math.min(requestedStart, buffer.length);
  if (startByte < buffer.length && isUtf8Continuation(buffer[startByte] ?? 0)) {
    throw new Error('startByte must be an exact UTF-8 boundary shown by a previous page.');
  }
  const page = sliceUtf8Buffer(buffer, startByte, maxBytes);
  const prefix = buffer.subarray(0, startByte).toString('utf8');
  const startLine = countNewlines(prefix) + 1;
  const endByte = startByte + page.bytes;
  const hasMore = endByte < buffer.length;
  return {
    content: page.content,
    startLine,
    endLine: startLine + countNewlines(page.content),
    totalLines: countNewlines(content) + 1,
    startByte,
    endByte,
    hasMore,
    ...(hasMore ? {nextStartByte: endByte} : {}),
  };
}

function sliceUtf8Buffer(buffer: Buffer, start: number, maxBytes: number): {content: string; bytes: number} {
  let end = Math.min(buffer.length, start + maxBytes);
  while (end > start && isUtf8Continuation(buffer[end] ?? 0)) end -= 1;
  return {content: buffer.subarray(start, end).toString('utf8'), bytes: end - start};
}

function lineRanges(content: string): Array<{start: number; end: number}> {
  const ranges: Array<{start: number; end: number}> = [];
  const expression = /\r?\n/gu;
  let start = 0;
  for (const match of content.matchAll(expression)) {
    ranges.push({start, end: match.index});
    start = match.index + match[0].length;
  }
  ranges.push({start, end: content.length});
  return ranges;
}

function countNewlines(value: string): number {
  return value.match(/\n/gu)?.length ?? 0;
}

function isUtf8Continuation(byte: number): boolean {
  return byte >= 0x80 && byte < 0xc0;
}
