import {createHash} from 'node:crypto';
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

export type SkillTrustState = 'trusted' | 'untrusted' | 'changed' | 'revoked';

interface SkillTrustEntry {
  workspace: string;
  skill: string;
  sourceFingerprint: string;
  fingerprint: string;
  state: 'trusted' | 'revoked';
  updatedAt: string;
}

const trustRegistrySchema = z.object({
  version: z.literal(1),
  entries: z.array(z.object({
    workspace: z.string(),
    skill: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum(['trusted', 'revoked']),
    updatedAt: z.string(),
  }).strict()).max(1_000),
}).strict();

type SkillTrustRegistry = z.infer<typeof trustRegistrySchema>;

export interface SkillTrustStoreOptions {
  path?: string;
}

/** User-owned, content-free decisions bound to a workspace, source path hash, and exact SKILL.md hash. */
export class SkillTrustStore {
  readonly path: string;
  private readonly usesDefaultPath: boolean;

  constructor(options: SkillTrustStoreOptions = {}) {
    this.usesDefaultPath = options.path === undefined;
    this.path = options.path ?? join(resolveHomeNamespace(), 'skill-trust.json');
  }

  async state(
    workspace: string,
    skill: string,
    source: string,
    fingerprint: string,
  ): Promise<SkillTrustState> {
    const states = await this.states(workspace, [{skill, source, fingerprint}]);
    return states.get(skill) ?? 'untrusted';
  }

  async states(
    workspace: string,
    skills: Array<{skill: string; source: string; fingerprint: string}>,
  ): Promise<Map<string, SkillTrustState>> {
    const resolvedWorkspace = await resolvePath(workspace);
    const registry = await this.read();
    const sourceFingerprints = await Promise.all(skills.map(({source}) => pathFingerprint(source)));
    return new Map(skills.map((skill, index) => {
      const entry = [...registry.entries].reverse().find((candidate) =>
        candidate.workspace === resolvedWorkspace && candidate.skill === skill.skill);
      const state: SkillTrustState = !entry
        ? 'untrusted'
        : entry.state === 'revoked'
          ? 'revoked'
          : entry.sourceFingerprint === sourceFingerprints[index] && entry.fingerprint === skill.fingerprint
            ? 'trusted'
            : 'changed';
      return [skill.skill, state];
    }));
  }

  trust(workspace: string, skill: string, source: string, fingerprint: string): Promise<void> {
    return this.writeDecision(workspace, skill, source, fingerprint, 'trusted');
  }

  revoke(workspace: string, skill: string, source: string, fingerprint: string): Promise<void> {
    return this.writeDecision(workspace, skill, source, fingerprint, 'revoked');
  }

  private async writeDecision(
    workspace: string,
    skill: string,
    source: string,
    fingerprint: string,
    state: SkillTrustEntry['state'],
  ): Promise<void> {
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(skill)) throw new Error(`Invalid skill name: ${skill}`);
    if (!/^[a-f0-9]{64}$/u.test(fingerprint)) throw new Error('Invalid skill fingerprint.');
    const operation = async (): Promise<void> => {
      const resolvedWorkspace = await resolvePath(workspace);
      const sourceFingerprint = await pathFingerprint(source);
      const registry = await this.read();
      const entries = registry.entries.filter((entry) =>
        entry.workspace !== resolvedWorkspace || entry.skill !== skill);
      entries.push({
        workspace: resolvedWorkspace,
        skill,
        sourceFingerprint,
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

  private async read(): Promise<SkillTrustRegistry> {
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000_000) {
        return {version: 1, entries: []};
      }
      return trustRegistrySchema.parse(JSON.parse(await readFile(this.path, 'utf8')) as unknown);
    } catch {
      return {version: 1, entries: []};
    }
  }
}

async function resolvePath(path: string): Promise<string> {
  return realpath(resolve(path)).catch(() => resolve(path));
}

async function pathFingerprint(path: string): Promise<string> {
  return createHash('sha256').update(await resolvePath(path)).digest('hex');
}
