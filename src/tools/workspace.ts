import {constants} from 'node:fs';
import {access, lstat, mkdir, realpath, stat} from 'node:fs/promises';
import {basename, dirname, isAbsolute, relative, resolve, sep} from 'node:path';
import {isInside, workspaceAliasPath} from '../utils/path.js';

export interface ResolveWorkspacePathOptions {
  allowMissing?: boolean;
  expect?: 'file' | 'directory' | 'any';
}

/**
 * Resolves paths against configured roots and verifies their real filesystem
 * ancestry. The realpath check is important: a lexical `../` check alone can
 * be escaped through a symlink located inside the workspace.
 */
export class WorkspaceAccess {
  readonly roots: string[];

  constructor(roots: string[]) {
    if (!roots.length) throw new Error('At least one workspace root is required.');
    this.roots = [...new Set(roots.map((root) => resolve(root)))];
  }

  get primaryRoot(): string {
    return this.roots[0] as string;
  }

  async resolvePath(
    input: string,
    options: ResolveWorkspacePathOptions = {},
  ): Promise<string> {
    if (!input || input.includes('\0')) throw new Error('Path must be a non-empty string.');
    const candidates = isAbsolute(input)
      ? [resolve(input)]
      : this.relativeCandidates(input);
    const lexical = candidates.find((candidate) =>
      this.roots.some((root) => isInside(root, candidate)),
    );
    if (!lexical) throw new Error(`Path is outside configured workspace roots: ${input}`);

    const existing = await this.nearestExisting(lexical);
    const realExisting = await realpath(existing);
    const allowed = await this.isInsideRealRoot(realExisting);
    if (!allowed) {
      throw new Error(`Path escapes the workspace through a symbolic link: ${input}`);
    }

    const exists = await pathExists(lexical);
    if (!exists && !options.allowMissing) throw new Error(`Path does not exist: ${input}`);
    if (exists && options.expect && options.expect !== 'any') {
      const info = await stat(lexical);
      if (options.expect === 'file' && !info.isFile()) {
        throw new Error(`Expected a file: ${input}`);
      }
      if (options.expect === 'directory' && !info.isDirectory()) {
        throw new Error(`Expected a directory: ${input}`);
      }
    }
    return lexical;
  }

  async resolveDirectory(input = '.'): Promise<string> {
    return this.resolvePath(input, {expect: 'directory'});
  }

  async ensureParent(path: string): Promise<void> {
    const resolved = await this.resolvePath(path, {allowMissing: true});
    const parent = dirname(resolved);
    await this.resolvePath(parent, {allowMissing: true});
    await mkdir(parent, {recursive: true});
    // Re-resolve after creation to close the common symlink-ancestor race.
    await this.resolvePath(parent, {expect: 'directory'});
  }

  async assertWritableFile(path: string): Promise<string> {
    const resolved = await this.resolvePath(path, {allowMissing: true});
    if (await pathExists(resolved)) {
      const info = await lstat(resolved);
      if (info.isDirectory()) throw new Error(`Expected a file, found a directory: ${path}`);
      // Existing symlinks are allowed only if their final target stayed in-root,
      // which resolvePath has already verified.
      await access(resolved, constants.W_OK);
    }
    return resolved;
  }

  display(path: string): string {
    return workspaceAliasPath(path, this.roots) || basename(path);
  }

  contains(path: string): boolean {
    return this.roots.some((root) => isInside(root, path));
  }

  private relativeCandidates(input: string): string[] {
    const normalized = input.replace(/^\.\//, '');
    const contextAlias = normalized.match(/^(main|workspace(\d+))(?:[\\/]|$)/i);
    if (contextAlias) {
      const index = contextAlias[1]?.toLocaleLowerCase() === 'main'
        ? 0
        : Number(contextAlias[2]) - 1;
      const root = Number.isInteger(index) && index >= 0 ? this.roots[index] : undefined;
      if (root) {
        return [resolve(root, normalized.slice(contextAlias[0].length))];
      }
      return [];
    }
    const named = this.roots.find((root) => {
      const name = basename(root);
      return normalized === name || normalized.startsWith(`${name}${sep}`) ||
        normalized.startsWith(`${name}/`);
    });
    if (named) {
      const name = basename(named);
      return [resolve(named, normalized.slice(name.length).replace(/^[/\\]/, ''))];
    }
    return this.roots.map((root) => resolve(root, normalized));
  }

  private async nearestExisting(path: string): Promise<string> {
    let current = path;
    while (!(await pathExists(current))) {
      const parent = dirname(current);
      if (parent === current) throw new Error(`Cannot resolve path ancestry: ${path}`);
      current = parent;
    }
    return current;
  }

  private async isInsideRealRoot(candidate: string): Promise<boolean> {
    for (const root of this.roots) {
      if (!(await pathExists(root))) continue;
      const realRoot = await realpath(root);
      if (isInside(realRoot, candidate)) return true;
    }
    return false;
  }
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

export function relativeToWorkspace(path: string, workspace: WorkspaceAccess): string {
  for (const root of workspace.roots) {
    if (isInside(root, path)) return relative(root, path) || '.';
  }
  return path;
}
