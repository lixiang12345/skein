import {relative, resolve, sep} from 'node:path';

export function isInside(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep));
}

/**
 * Stable path labels shared with the local retrieval multi-root contract.
 * Basenames are not sufficient because two workspace roots may have the same
 * directory name; `main` and `workspaceN` remain unambiguous in prompts and
 * can be passed back to WorkspaceAccess by the model.
 */
export function workspaceAliasPath(path: string, roots: string[]): string {
  for (const [index, root] of roots.entries()) {
    if (!isInside(root, path)) continue;
    const suffix = relative(resolve(root), resolve(path)).replaceAll(sep, '/');
    if (roots.length === 1) return suffix || '.';
    const alias = index === 0 ? 'main' : `workspace${index + 1}`;
    return suffix ? `${alias}/${suffix}` : alias;
  }
  return path;
}
