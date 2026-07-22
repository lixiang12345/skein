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
  command('workflow', 'Run a typed implementation, debug, review, or refactor flow', '/workflow <name> <task>'),
  command('context', 'Inspect active, working, compacted, and retrieved context', '/context [compact]'),
  command('compact', 'Compact older session context', '/compact [instructions]'),
  command('memory', 'Search durable memory or review proposed facts', '/memory [query|list|candidates|approve|reject|archive|forget]'),
  command('remember', 'Save a non-secret workspace memory', '/remember <fact or preference>'),
  command('skills', 'List discovered task playbooks'),
  command('agents', 'List built-in and installed expert profiles'),
  command('mcp', 'Show external MCP server health and tools'),
  command('tools', 'List built-in and MCP tools with permission categories'),
  command('permissions', 'Inspect the active permission policy'),
  command('changes', 'List files changed in the active session'),
  command('diff', 'Open the current workspace diff in the transcript'),
  command('checkpoints', 'List recoverable pre-mutation snapshots'),
  command('transcript', 'Expand or collapse complete tool output', '/transcript [on|off]'),
  command('hotkeys', 'Show terminal editing and run controls'),
  command('mode', 'Switch between read-only Ask, Plan, and action-capable Build modes', '/mode [ask|plan|build]'),
  command('density', 'Switch between compact and comfortable terminal rhythm', '/density [compact|comfortable]'),
  command('theme', 'Preview, select, or cycle terminal themes', '/theme [name|list]'),
  command('tasks', 'Show the current execution plan'),
  command('clear', 'Clear the visible transcript'),
  command('about', 'Show the active model and context stack'),
  command('help', 'Show commands and keyboard controls', undefined, ['?']),
  command('exit', 'Exit Skein', undefined, ['quit']),
];

export function commandSuggestions(
  input: string,
  options: {themes?: string[]; workflows?: WorkflowDefinition[]} = {},
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

  if (firstSpace >= 0 && commandName === 'memory') {
    const query = argument.trim().toLocaleLowerCase();
    return [
      {name: 'stats', description: 'Show active, archived, and pending memory counts'},
      {name: 'list', description: 'Show recent durable memories'},
      {name: 'candidates', description: 'Review memory facts waiting for approval'},
      {name: 'approve', description: 'Approve a memory candidate by id'},
      {name: 'reject', description: 'Reject a memory candidate by id'},
      {name: 'archive', description: 'Archive a memory by id'},
      {name: 'forget', description: 'Permanently remove a memory by id'},
    ].filter((item) => item.name.includes(query)).map((item) => ({
      value: `/memory ${item.name}${['stats', 'list', 'candidates'].includes(item.name) ? '' : ' '}`,
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
    }));
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
