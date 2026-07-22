import {chmod, lstat, mkdir, realpath} from 'node:fs/promises';
import {join, relative, resolve, sep} from 'node:path';
import {isInside} from './path.js';
import {assertActiveProjectNamespacePath} from './namespace.js';

/**
 * Creates a project-owned storage directory without following symlinks below
 * the workspace root. This keeps `.mosaic` state from being redirected to an
 * arbitrary location by a repository-controlled symlink.
 */
export async function ensureWorkspaceStorageDirectory(
  workspace: string,
  directory: string,
  options: {requireActiveNamespace?: boolean} = {},
): Promise<void> {
  const root = resolve(workspace);
  const target = resolve(directory);
  if (!isInside(root, target)) {
    throw new Error(`Storage directory is outside the workspace: ${target}`);
  }
  if (options.requireActiveNamespace) assertActiveProjectNamespacePath(root, target);

  await assertNoSymlinkPath(root, target);
  await mkdir(target, {recursive: true, mode: 0o700});
  await chmod(target, 0o700);
  await assertNoSymlinkPath(root, target);

  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
  if (!isInside(realRoot, realTarget)) {
    throw new Error(`Storage directory escapes the workspace: ${target}`);
  }
}

export async function assertNoSymlinkPath(root: string, target: string): Promise<void> {
  const suffix = relative(root, target);
  if (!suffix) return;
  let current = root;
  for (const part of suffix.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new Error(`Storage path cannot contain a symbolic link: ${current}`);
      }
      if (!info.isDirectory()) {
        throw new Error(`Storage path component is not a directory: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}
