import {lstat, mkdir, readFile, realpath} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {z} from 'zod';
import {atomicWrite} from '../tools/write.js';
import {
  assertActiveHomeNamespacePath,
  homeNamespacePaths,
  resolveHomeNamespace,
} from '../utils/namespace.js';
import {withNamespaceLease} from '../utils/namespace-lease.js';
import {assertNoSymlinkPath} from '../utils/storage.js';

export type McpTrustState = 'trusted' | 'untrusted' | 'disabled' | 'revoked';

interface TrustEntry {
  workspace: string;
  server: string;
  fingerprint: string;
  state: Exclude<McpTrustState, 'untrusted'>;
  updatedAt: string;
}

const trustRegistrySchema = z.object({
  version: z.literal(1),
  entries: z.array(z.object({
    workspace: z.string(),
    server: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum(['trusted', 'disabled', 'revoked']),
    updatedAt: z.string(),
  }).strict()).max(1_000),
}).strict();

type TrustRegistry = z.infer<typeof trustRegistrySchema>;

export interface McpTrustStoreOptions {
  path?: string;
}

/** User-owned, content-free trust decisions keyed by workspace and manifest fingerprint. */
export class McpTrustStore {
  readonly path: string;
  private readonly usesDefaultPath: boolean;

  constructor(options: McpTrustStoreOptions = {}) {
    this.usesDefaultPath = options.path === undefined;
    this.path = options.path ?? join(resolveHomeNamespace(), 'mcp-capability-trust.json');
  }

  async state(workspace: string, server: string, fingerprint: string): Promise<McpTrustState> {
    const resolvedWorkspace = await resolveWorkspace(workspace);
    const registry = await this.read();
    const entry = [...registry.entries].reverse().find((candidate) =>
      candidate.workspace === resolvedWorkspace && candidate.server === server);
    if (!entry) return 'untrusted';
    if (entry.state === 'disabled' || entry.state === 'revoked') return entry.state;
    return entry.fingerprint === fingerprint ? 'trusted' : 'untrusted';
  }

  trust(workspace: string, server: string, fingerprint: string): Promise<void> {
    return this.writeDecision(workspace, server, fingerprint, 'trusted');
  }

  disable(workspace: string, server: string, fingerprint: string): Promise<void> {
    return this.writeDecision(workspace, server, fingerprint, 'disabled');
  }

  revoke(workspace: string, server: string, fingerprint: string): Promise<void> {
    return this.writeDecision(workspace, server, fingerprint, 'revoked');
  }

  private async writeDecision(
    workspace: string,
    server: string,
    fingerprint: string,
    state: TrustEntry['state'],
  ): Promise<void> {
    const operation = async (): Promise<void> => {
      const resolvedWorkspace = await resolveWorkspace(workspace);
      const registry = await this.read();
      const entries = registry.entries.filter((entry) =>
        entry.workspace !== resolvedWorkspace || entry.server !== server);
      entries.push({
        workspace: resolvedWorkspace,
        server,
        fingerprint,
        state,
        updatedAt: new Date().toISOString(),
      });
      if (this.usesDefaultPath) {
        const home = resolveHomeNamespace();
        assertActiveHomeNamespacePath(this.path);
        await assertNoSymlinkPath(dirname(home), home);
      }
      await mkdir(dirname(this.path), {recursive: true, mode: 0o700});
      if (this.usesDefaultPath) {
        const home = resolveHomeNamespace();
        await assertNoSymlinkPath(dirname(home), home);
      }
      await atomicWrite(
        this.path,
        `${JSON.stringify({version: 1, entries: entries.slice(-1_000)}, null, 2)}\n`,
        0o600,
      );
    };
    return this.usesDefaultPath
      ? withNamespaceLease(homeNamespacePaths().canonical, 'shared', operation)
      : operation();
  }

  private async read(): Promise<TrustRegistry> {
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000_000) {
        return {version: 1, entries: []};
      }
      return trustRegistrySchema.parse(JSON.parse(await readFile(this.path, 'utf8')) as unknown);
    } catch {
      // Missing, corrupted, oversized, or redirected registries fail closed.
      return {version: 1, entries: []};
    }
  }
}

async function resolveWorkspace(workspace: string): Promise<string> {
  return realpath(resolve(workspace)).catch(() => resolve(workspace));
}
