import type {WorkflowDefinition} from '../workflows/index.js';

export interface CommandDefinition {
  name: string;
  description: string;
  usage?: string;
  aliases?: string[];
}

export interface CommandSuggestion {
  value: string;
  label: string;
  description: string;
}

export const commandDefinitions: CommandDefinition[] = [
  command('team', 'Launch a routed specialist council with peer review', '/team <delivery objective>'),
  command('workbench', 'Focus the multi-agent Team Workbench', '/workbench'),
  command('workflow', 'Run a typed implementation, debug, review, or refactor flow', '/workflow <name> <task>'),
  command('context', 'Inspect context; pin/unpin/mute files that survive compaction', '/context [pin|unpin|mute|list|compact] [path]'),
  command('compact', 'Compact older session context', '/compact [instructions]'),
  command('memory', 'Search durable memory, review privacy, or manage proposed facts', '/memory [query|list|privacy|candidates|approve|reject|archive|forget]'),
  command('remember', 'Save a non-secret workspace memory', '/remember <fact or preference>'),
  command('skills', 'List discovered task playbooks'),
  command('agents', 'List built-in and installed expert profiles'),
  command('connections', 'Inspect shared model endpoints and setup status', '/connections [setup]'),
  command('mcp', 'Search, inspect, trust, activate, disable, or revoke MCP capabilities', '/mcp [search|inspect|trust|activate|disable|revoke] [...]'),
  command('tools', 'List built-in and MCP tools with permission categories'),
  command('permissions', 'Inspect the active permission policy'),
  command('changes', 'List files changed in the active session'),
  command('diff', 'Open the current workspace diff in the transcript'),
  command('review', 'Run a read-only review with a fixed, redacted scope', '/review [working-tree|commit <ref>|branch <base-ref>]'),
  command('recover', 'Open recovery actions for the last incomplete run', '/recover [retry|resume|diff|rollback|audit]'),
  command('checkpoints', 'List recoverable pre-mutation snapshots'),
  command('audit', 'Review the hash-chained tool and permission timeline'),
  command('rollback', 'Restore workspace files from a checkpoint', '/rollback [checkpoint-id]'),
  command('transcript', 'Expand or collapse complete tool output', '/transcript [on|off]'),
  command('queue', 'Inspect or remove follow-ups waiting behind the active run', '/queue [list|drop|clear] [number]'),
  command('hotkeys', 'Show terminal editing and run controls'),
  command('editor', 'Edit the next prompt with VISUAL or EDITOR', '/editor [initial draft]'),
  command('model', 'Show the active route, list connection models, or switch', '/model [list|<model-id>]'),
  command('resume', 'List recent sessions or switch this terminal to one', '/resume [session-id]'),
  command('mode', 'Switch between read-only Ask, Plan, and action-capable Build modes', '/mode [ask|plan|build]'),
  command('density', 'Switch between compact and comfortable terminal rhythm', '/density [compact|comfortable]'),
  command('theme', 'Preview, select, or cycle terminal themes', '/theme [name|list]'),
  command('tasks', 'Show the current execution plan'),
  command('clear', 'Clear the visible transcript'),
  command('status', 'Inspect workspace, route, mode, context, and extensions', undefined, ['about']),
  command('help', 'Show commands and keyboard controls', undefined, ['?']),
  command('exit', 'Exit Skein', undefined, ['quit']),
];

/** Built-in names and aliases that workspace command templates cannot shadow. */
export const reservedCommandNames: ReadonlySet<string> = new Set(
  commandDefinitions.flatMap((definition) => [definition.name, ...(definition.aliases ?? [])]),
);

export function commandSuggestions(
  input: string,
  options: {themes?: string[]; workflows?: WorkflowDefinition[]; custom?: Array<{name: string; description: string}>} = {},
): CommandSuggestion[] {
  if (!input.startsWith('/')) return [];
  const raw = input.slice(1);
  const firstSpace = raw.indexOf(' ');
  const commandName = (firstSpace < 0 ? raw : raw.slice(0, firstSpace)).toLocaleLowerCase();
  const argument = firstSpace < 0 ? '' : raw.slice(firstSpace + 1);

  if (firstSpace >= 0 && commandName === 'theme') {
    const query = argument.trim().toLocaleLowerCase();
    return ['list', 'reload', ...(options.themes ?? [])]
      .filter((name) => name.includes(query))
      .slice(0, 6)
      .map((name) => ({
        value: `/theme ${name}`,
        label: name,
        description: name === 'list' ? 'Preview available themes' : 'Use this terminal palette',
      }));
  }

  if (firstSpace >= 0 && commandName === 'workflow') {
    const query = argument.trim().toLocaleLowerCase();
    return (options.workflows ?? [])
      .filter((workflow) => workflow.name.includes(query))
      .slice(0, 6)
      .map((workflow) => ({
        value: `/workflow ${workflow.name} `,
        label: workflow.name,
        description: workflow.description,
      }));
  }

  if (firstSpace >= 0 && commandName === 'mode') {
    const query = argument.trim().toLocaleLowerCase();
    return [
      {name: 'ask', description: 'Inspect and explain without approving mutations'},
      {name: 'plan', description: 'Create a read-only implementation plan for approval'},
      {name: 'build', description: 'Allow edits and commands under the permission policy'},
    ].filter((item) => item.name.includes(query)).map((item) => ({
      value: `/mode ${item.name}`,
      label: item.name,
      description: item.description,
    }));
  }

  if (firstSpace >= 0 && commandName === 'mcp') {
    const query = argument.trim().toLocaleLowerCase();
    return [
      {name: 'search', description: 'Search redacted local capability manifests'},
      {name: 'inspect', description: 'Review one manifest before trust'},
      {name: 'trust', description: 'Trust the current manifest after confirmation'},
      {name: 'activate', description: 'Connect a trusted server and load relevant schemas'},
      {name: 'disable', description: 'Persistently disable a capability'},
      {name: 'revoke', description: 'Revoke trust after confirmation'},
    ].filter((item) => item.name.includes(query)).map((item) => ({
      value: `/mcp ${item.name} `,
      label: item.name,
      description: item.description,
    }));
  }

  if (firstSpace >= 0 && commandName === 'connections') {
    return [{
      value: '/connections setup',
      label: 'setup',
      description: 'Show the secure shared-connection setup command',
    }].filter((item) => item.label.includes(argument.trim().toLocaleLowerCase()));
  }

  if (firstSpace >= 0 && commandName === 'review') {
    const query = argument.trim().toLocaleLowerCase();
    return [
      {value: '/review working-tree', label: 'working-tree', description: 'Review only the current working tree'},
      {value: '/review commit ', label: 'commit', description: 'Review exactly one Git commit'},
      {value: '/review branch ', label: 'branch', description: 'Review the current branch against one base ref'},
    ].filter((item) => item.label.includes(query) || item.value.slice('/review '.length).startsWith(query));
  }

  if (firstSpace >= 0 && commandName === 'recover') {
    const query = argument.trim().toLocaleLowerCase();
    return [
      {name: 'retry', description: 'Repair and retry the latest failed operation once'},
      {name: 'resume', description: 'Continue the most recent incomplete logical run'},
      {name: 'diff', description: 'Inspect the current workspace patch'},
      {name: 'audit', description: 'Review permission and tool evidence'},
      {name: 'rollback', description: 'Choose a checkpoint to restore'},
    ].filter((item) => item.name.includes(query)).map((item) => ({
      value: `/recover ${item.name}`,
      label: item.name,
      description: item.description,
    }));
  }

  if (firstSpace >= 0 && commandName === 'memory') {
    const query = argument.trim().toLocaleLowerCase();
    return [
      {name: 'stats', description: 'Show active, archived, and pending memory counts'},
      {name: 'privacy', description: 'Show a content-free retention and storage privacy review'},
      {name: 'list', description: 'Show recent durable memories'},
      {name: 'candidates', description: 'Review memory facts waiting for approval'},
      {name: 'approve', description: 'Approve a memory candidate by id'},
      {name: 'reject', description: 'Reject a memory candidate by id'},
      {name: 'archive', description: 'Archive a memory by id'},
      {name: 'forget', description: 'Permanently remove a memory by id'},
    ].filter((item) => item.name.includes(query)).map((item) => ({
      value: `/memory ${item.name}${['stats', 'privacy', 'list', 'candidates'].includes(item.name) ? '' : ' '}`,
      label: item.name,
      description: item.description,
    }));
  }

  if (firstSpace >= 0 && commandName === 'queue') {
    const query = argument.trim().toLocaleLowerCase();
    return [
      {name: 'list', description: 'Show queued commands and follow-ups'},
      {name: 'drop', description: 'Remove one queued item by number'},
      {name: 'clear', description: 'Remove every queued item'},
    ].filter((item) => item.name.includes(query)).map((item) => ({
      value: `/queue ${item.name}${item.name === 'drop' ? ' ' : ''}`,
      label: item.name,
      description: item.description,
    }));
  }

  return commandDefinitions
    .filter((definition) => definition.name.includes(commandName) ||
      definition.aliases?.some((alias) => alias.includes(commandName)))
    .sort((left, right) => {
      const leftPrefix = left.name.startsWith(commandName) ? 0 : 1;
      const rightPrefix = right.name.startsWith(commandName) ? 0 : 1;
      return leftPrefix - rightPrefix || commandDefinitions.indexOf(left) - commandDefinitions.indexOf(right);
    })
    .slice(0, 6)
    .map((definition) => ({
      value: `/${definition.name}${definition.usage?.includes('<') || definition.usage?.includes('[') ? ' ' : ''}`,
      label: `/${definition.name}`,
      description: definition.description,
    }))
    .concat((options.custom ?? [])
      .filter((custom) => custom.name.includes(commandName))
      .slice(0, 4)
      .map((custom) => ({
        value: `/${custom.name} `,
        label: `/${custom.name}`,
        description: `${custom.description || 'Workspace command'} · .agents/commands`,
      })))
    .slice(0, 8);
}

export function findCommand(name: string): CommandDefinition | undefined {
  const normalized = name.toLocaleLowerCase();
  return commandDefinitions.find((definition) => definition.name === normalized ||
    definition.aliases?.includes(normalized));
}

function command(
  name: string,
  description: string,
  usage?: string,
  aliases?: string[],
): CommandDefinition {
  return {name, description, ...(usage ? {usage} : {}), ...(aliases ? {aliases} : {})};
}
