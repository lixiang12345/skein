import type {Command} from 'commander';
import {resolve} from 'node:path';
import {
  homeNamespacePaths,
  projectNamespacePaths,
} from '../utils/namespace.js';
import {
  acquireNamespaceLease,
  type NamespaceLease,
} from '../utils/namespace-lease.js';

export type CliNamespaceLeaseScope = 'project' | 'home';

export function cliNamespaceLeaseScopes(actionCommand: Command): CliNamespaceLeaseScope[] {
  const names = commandNames(actionCommand);
  const topLevel = names[1];
  const leaf = names[2];
  const options = actionCommand.opts() as {yes?: boolean; home?: boolean};
  if (topLevel === 'migrate') {
    if (options.yes) return [];
    return [options.home ? 'home' : 'project'];
  }
  if (topLevel === 'tools' || topLevel === 'workflow') return [];
  if (topLevel === 'session' || topLevel === 'checkpoint') return ['project'];
  if (topLevel === 'config' && leaf === 'path') return ['project'];
  if (topLevel === 'agents' && (leaf === 'runs' || leaf === 'show' || leaf === 'delete')) {
    return ['project'];
  }
  return ['project', 'home'];
}

export async function acquireCliNamespaceLeases(actionCommand: Command): Promise<NamespaceLease[]> {
  const scopes = cliNamespaceLeaseScopes(actionCommand);
  const localOptions = actionCommand.opts() as {workspace?: string};
  // Commander lets global defaults overwrite local values in optsWithGlobals().
  const globalOptions = actionCommand.optsWithGlobals() as {workspace?: string};
  const workspace = resolve(localOptions.workspace ?? globalOptions.workspace ?? process.cwd());
  const targets = scopes.map((scope) => scope === 'project'
    ? projectNamespacePaths(workspace).canonical
    : homeNamespacePaths().canonical);
  const leases: NamespaceLease[] = [];
  try {
    for (const target of [...new Set(targets)].sort()) {
      leases.push(await acquireNamespaceLease(target, 'shared'));
    }
    return leases;
  } catch (error) {
    releaseCliNamespaceLeases(leases);
    throw error;
  }
}

export function releaseCliNamespaceLeases(leases: NamespaceLease[]): void {
  for (const lease of [...leases].reverse()) lease.release();
  leases.length = 0;
}

function commandNames(command: Command): string[] {
  const names: string[] = [];
  let current: Command | null = command;
  while (current) {
    names.unshift(current.name());
    current = current.parent;
  }
  return names;
}
