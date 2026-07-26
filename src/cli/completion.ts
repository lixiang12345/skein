export type CompletionShell = 'bash' | 'zsh' | 'fish';

const topLevelCommands = [
  'init', 'config', 'index', 'search', 'context', 'status', 'doctor', 'update', 'migrate',
  'session', 'jobs', 'checkpoint', 'tools', 'skills', 'agents', 'workflow', 'memory', 'mcp', 'rules',
  'completion',
];

const globalOptions = [
  '--help', '--version', '--print', '--ask', '--plan', '--quiet', '--output-format', '--compact',
  '--yes', '--auto-edit', '--trust-project-config', '--queue', '--workspace', '--add-workspace',
  '--config', '--connection', '--provider', '--model', '--base-url', '--max-turns',
  '--epoch-token-budget', '--token-budget', '--resume', '--continue', '--no-color', '--no-checkpoint',
];

const subcommands: Record<string, string[]> = {
  config: ['show', 'path'],
  session: ['list', 'show', 'delete', 'export', 'fork', 'branch'],
  jobs: ['start', 'list', 'output', 'kill'],
  checkpoint: ['list', 'restore'],
  agents: ['list', 'setup', 'connections', 'models', 'runs', 'show', 'delete', 'arbitrate', 'capability'],
  workflow: ['list', 'show'],
  memory: ['stats', 'privacy', 'list', 'search', 'candidates', 'approve', 'reject', 'archive', 'forget', 'export', 'clear'],
  mcp: ['list', 'search', 'inspect', 'trust', 'activate', 'disable', 'revoke'],
  rules: [],
  completion: ['bash', 'zsh', 'fish'],
};

export function generateShellCompletion(shell: CompletionShell, command = 'skein'): string {
  if (shell === 'bash') return bashCompletion(command);
  if (shell === 'zsh') return zshCompletion(command);
  return fishCompletion(command);
}

function bashCompletion(command: string): string {
  const cases = Object.entries(subcommands)
    .filter(([, values]) => values.length)
    .map(([parent, values]) => `    ${parent}) COMPREPLY=( $(compgen -W '${values.join(' ')}' -- "$cur") ); return ;;`)
    .join('\n');
  return `# bash completion for ${command}\n` +
    `_${command}_completion() {\n` +
    `  local cur prev\n` +
    `  cur="\${COMP_WORDS[COMP_CWORD]}"\n` +
    `  prev="\${COMP_WORDS[COMP_CWORD-1]}"\n` +
    `  case "$prev" in\n${cases}\n  esac\n` +
    `  if [[ "$cur" == -* ]]; then\n` +
    `    COMPREPLY=( $(compgen -W '${globalOptions.join(' ')}' -- "$cur") )\n` +
    `  elif [[ $COMP_CWORD -eq 1 ]]; then\n` +
    `    COMPREPLY=( $(compgen -W '${topLevelCommands.join(' ')}' -- "$cur") )\n` +
    `  fi\n` +
    `}\n` +
    `complete -F _${command}_completion ${command}\n`;
}

function zshCompletion(command: string): string {
  const commands = topLevelCommands.map((name) => `      '${name}:${description(name)}'`).join('\n');
  const cases = Object.entries(subcommands)
    .filter(([, values]) => values.length)
    .map(([parent, values]) => `    ${parent}) _values 'subcommand' ${values.map((value) => `'${value}'`).join(' ')} ;;`)
    .join('\n');
  return `#compdef ${command}\n` +
    `_${command}() {\n` +
    `  local context state line\n` +
    `  local -a commands\n` +
    `  typeset -A opt_args\n` +
    `  _arguments -C '*::arg:->args'\n` +
    `  if (( CURRENT == 2 )); then\n` +
    `    commands=(\n${commands}\n    )\n` +
    `    _describe 'command' commands\n` +
    `    return\n` +
    `  fi\n` +
    `  case $words[2] in\n${cases}\n  esac\n` +
    `}\n` +
    `compdef _${command} ${command}\n`;
}

function fishCompletion(command: string): string {
  const top = topLevelCommands.map((name) =>
    `complete -c ${command} -n '__fish_use_subcommand' -a ${name} -d '${fishEscape(description(name))}'`,
  );
  const nested = Object.entries(subcommands).flatMap(([parent, values]) => values.map((value) =>
    `complete -c ${command} -n '__fish_seen_subcommand_from ${parent}' -a ${value}`,
  ));
  return `# fish completion for ${command}\n${[...top, ...nested].join('\n')}\n`;
}

function description(name: string): string {
  const descriptions: Record<string, string> = {
    init: 'Create project configuration',
    config: 'Inspect resolved configuration',
    index: 'Build the local code index',
    search: 'Search indexed code',
    context: 'Pack task context',
    status: 'Show runtime status',
    doctor: 'Diagnose prerequisites',
    update: 'Update Skein',
    migrate: 'Migrate local state',
    session: 'Manage resumable sessions',
    jobs: 'Manage durable background jobs',
    checkpoint: 'Inspect or restore checkpoints',
    tools: 'List tools',
    skills: 'Inspect Skills',
    agents: 'Manage expert agents',
    workflow: 'Inspect workflows',
    memory: 'Manage durable memory',
    mcp: 'Manage MCP capabilities',
    rules: 'Inspect loaded rules',
    completion: 'Generate shell completion',
  };
  return descriptions[name] ?? name;
}

function fishEscape(value: string): string {
  return value.replace(/'/gu, "\\'");
}
