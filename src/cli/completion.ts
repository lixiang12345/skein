import type {Command, Option} from 'commander';

export type CompletionShell = 'bash' | 'zsh' | 'fish';

export interface CompletionOption {
  short?: string;
  long?: string;
  description: string;
  requiresValue: boolean;
}

export interface CompletionCommand {
  name: string;
  aliases: string[];
  description: string;
  options: CompletionOption[];
  commands: CompletionCommand[];
}

export interface CompletionSpec {
  options: CompletionOption[];
  commands: CompletionCommand[];
}

interface CommandGroup {
  paths: string[][];
  commands: CompletionCommand[];
}

interface OptionGroup {
  paths: string[][];
  options: CompletionOption[];
  commands: CompletionCommand[];
}

/**
 * Build completion data from Commander's visible command graph. Keeping this
 * read-only projection next to the renderer prevents a second command catalog
 * from drifting as CLI commands, aliases, or options change.
 */
export function createCompletionSpec(program: Command): CompletionSpec {
  return {
    options: visibleOptions(program),
    commands: visibleCommands(program),
  };
}

export function generateShellCompletion(
  shell: CompletionShell,
  program: Command,
  command = program.name() || 'skein',
): string {
  const spec = createCompletionSpec(program);
  if (shell === 'bash') return bashCompletion(command, spec);
  if (shell === 'zsh') return zshCompletion(command, spec);
  return fishCompletion(command, spec);
}

function visibleCommands(command: Command): CompletionCommand[] {
  return command.createHelp().visibleCommands(command).map((child) => ({
    name: child.name(),
    aliases: child.aliases(),
    description: child.description(),
    options: visibleOptions(child),
    commands: visibleCommands(child),
  }));
}

function visibleOptions(command: Command): CompletionOption[] {
  return command.createHelp().visibleOptions(command).map((option) => completionOption(option));
}

function completionOption(option: Option): CompletionOption {
  return {
    ...(option.short ? {short: option.short} : {}),
    ...(option.long ? {long: option.long} : {}),
    description: option.description,
    requiresValue: option.required,
  };
}

function bashCompletion(command: string, spec: CompletionSpec): string {
  const commandGroups = collectCommandGroups(spec.commands);
  const optionGroups = collectOptionGroups(spec.commands).toSorted((left, right) =>
    Math.max(...right.paths.map((path) => path.length)) - Math.max(...left.paths.map((path) => path.length)),
  );
  const nestedCommands = commandGroups.map((group) => group.paths.map((path) =>
    `    '${path.length + 1}:${bashCase(path.join(' '))}') COMPREPLY=( $(compgen -W ${bashWordList(commandCandidates(group.commands))} -- "$cur") ); return ;;`,
  ).join('\n')).filter(Boolean).join('\n');
  const nestedOptions = optionGroups
    .filter((group) => group.options.length)
    .flatMap((group) => group.paths.map((path) => {
      const commandPath = bashCase(path.join(' '));
      return `      '${commandPath}'|'${commandPath} '*) COMPREPLY=( $(compgen -W ${bashWordList(optionCandidates(group.options))} -- "$cur") ); return ;;`;
    })).join('\n');

  return `# bash completion for ${command}\n` +
    `_${shellIdentifier(command)}_completion() {\n` +
    `  local cur path\n` +
    `  cur="\${COMP_WORDS[COMP_CWORD]}"\n` +
    `  if [[ "$cur" == -* ]]; then\n` +
    `    path="\${COMP_WORDS[*]:1:$((COMP_CWORD - 1))}"\n` +
    `    case "$path" in\n${nestedOptions}\n    esac\n` +
    `    COMPREPLY=( $(compgen -W ${bashWordList(optionCandidates(spec.options))} -- "$cur") )\n` +
    `    return\n` +
    `  fi\n` +
    `  if [[ $COMP_CWORD -eq 1 ]]; then\n` +
    `    COMPREPLY=( $(compgen -W ${bashWordList(commandCandidates(spec.commands))} -- "$cur") )\n` +
    `    return\n` +
    `  fi\n` +
    `  path="\${COMP_WORDS[*]:1:$((COMP_CWORD - 1))}"\n` +
    `  case "$COMP_CWORD:$path" in\n${nestedCommands}\n  esac\n` +
    `}\n` +
    `complete -F _${shellIdentifier(command)}_completion ${bashSingleQuote(command)}\n`;
}

function zshCompletion(command: string, spec: CompletionSpec): string {
  const commandGroups = collectCommandGroups(spec.commands);
  const optionGroups = collectOptionGroups(spec.commands).toSorted((left, right) =>
    Math.max(...right.paths.map((path) => path.length)) - Math.max(...left.paths.map((path) => path.length)),
  );
  const nestedOptions = optionGroups
    .filter((group) => group.options.length)
    .flatMap((group) => group.paths.map((path) =>
      `    if (( CURRENT > ${path.length + 1} )) && ${zshPathCondition(path)}; then\n` +
      `      _values 'option' ${zshOptionValues(group.options)}\n` +
      `      return\n` +
      `    fi`,
    )).join('\n');
  const nestedCommands = commandGroups.flatMap((group) => group.paths.map((path) =>
    `  if (( CURRENT == ${path.length + 2} )) && ${zshPathCondition(path)}; then\n` +
    `    _values 'command' ${zshCommandValues(group.commands)}\n` +
    `    return\n` +
    `  fi`,
  )).join('\n');

  return `#compdef ${command}\n` +
    `_${shellIdentifier(command)}() {\n` +
    `  if [[ "\${words[CURRENT]}" == -* ]]; then\n` +
    `${nestedOptions ? `${nestedOptions}\n` : ''}` +
    `    _values 'option' ${zshOptionValues(spec.options)}\n` +
    `    return\n` +
    `  fi\n` +
    `  if (( CURRENT == 2 )); then\n` +
    `    _values 'command' ${zshCommandValues(spec.commands)}\n` +
    `    return\n` +
    `  fi\n` +
    `${nestedCommands}\n` +
    `}\n` +
    `compdef _${shellIdentifier(command)} ${zshSingleQuote(command)}\n`;
}

function fishCompletion(command: string, spec: CompletionSpec): string {
  const commandName = fishSingleQuote(command);
  const topLevel = commandCandidatesWithDescriptions(spec.commands).map((candidate) =>
    `complete -c ${commandName} -n '__fish_use_subcommand' -a ${fishSingleQuote(candidate.name)} -d ${fishSingleQuote(candidate.description)}`,
  );
  const nested = collectCommandGroups(spec.commands).flatMap((group) => {
    const condition = fishPathCondition(group.paths, commandCandidates(group.commands));
    return commandCandidatesWithDescriptions(group.commands).map((candidate) =>
      `complete -c ${commandName} -n ${fishSingleQuote(condition)} -a ${fishSingleQuote(candidate.name)} -d ${fishSingleQuote(candidate.description)}`,
    );
  });
  const rootOptions = spec.options.map((option) => fishOption(commandName, '__fish_use_subcommand', option));
  const nestedOptions = collectOptionGroups(spec.commands).flatMap((group) => {
    const condition = fishPathCondition(group.paths, commandCandidates(group.commands));
    return group.options.map((option) => fishOption(commandName, condition, option));
  });
  return `# fish completion for ${command}\n${[...topLevel, ...nested, ...rootOptions, ...nestedOptions].join('\n')}\n`;
}

function collectCommandGroups(commands: CompletionCommand[], parentPaths: string[][] = [[]]): CommandGroup[] {
  return commands.flatMap((command) => {
    const paths = appendCommandPaths(parentPaths, command);
    const own = command.commands.length ? [{paths, commands: command.commands}] : [];
    return [...own, ...collectCommandGroups(command.commands, paths)];
  });
}

function collectOptionGroups(commands: CompletionCommand[], parentPaths: string[][] = [[]]): OptionGroup[] {
  return commands.flatMap((command) => {
    const paths = appendCommandPaths(parentPaths, command);
    return [{paths, options: command.options, commands: command.commands}, ...collectOptionGroups(command.commands, paths)];
  });
}

function appendCommandPaths(parentPaths: string[][], command: CompletionCommand): string[][] {
  return parentPaths.flatMap((path) => [command.name, ...command.aliases].map((name) => [...path, name]));
}

function commandCandidates(commands: CompletionCommand[]): string[] {
  return commandCandidatesWithDescriptions(commands).map(({name}) => name);
}

function commandCandidatesWithDescriptions(commands: CompletionCommand[]): Array<{name: string; description: string}> {
  return commands.flatMap((command) => [
    {name: command.name, description: command.description || command.name},
    ...command.aliases.map((alias) => ({
      name: alias,
      description: `${command.description || command.name} (alias for ${command.name})`,
    })),
  ]);
}

function optionCandidates(options: CompletionOption[]): string[] {
  return options.flatMap((option) => [option.short, option.long].filter((value): value is string => Boolean(value)));
}

function bashWordList(values: string[]): string {
  return bashSingleQuote(values.join(' '));
}

function bashCase(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "'\\''");
}

function bashSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function zshCommandValues(commands: CompletionCommand[]): string {
  return commandCandidatesWithDescriptions(commands).map(({name, description}) =>
    zshSingleQuote(`${name}[${zshDescription(description)}]`),
  ).join(' ');
}

function zshOptionValues(options: CompletionOption[]): string {
  return options.flatMap((option) => optionCandidates([option]).map((flag) =>
    zshSingleQuote(`${flag}[${zshDescription(option.description || flag)}]`),
  )).join(' ');
}

function zshPathCondition(path: string[]): string {
  return path.map((name, index) => `[[ "\${words[${index + 2}]}" == ${zshSingleQuote(name)} ]]`).join(' && ');
}

function zshDescription(value: string): string {
  return value.replaceAll('[', '(').replaceAll(']', ')').replaceAll('\n', ' ');
}

function zshSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function fishPathCondition(paths: string[][], absentCommands: string[] = []): string {
  return paths.map((path) => {
    const seenPath = path.map((name) => `__fish_seen_subcommand_from ${fishSingleQuote(name)}`).join('; and ');
    const noChild = absentCommands.length
      ? `; and not __fish_seen_subcommand_from ${absentCommands.map((name) => fishSingleQuote(name)).join(' ')}`
      : '';
    return `begin; ${seenPath}${noChild}; end`;
  }).join('; or ');
}

function fishOption(command: string, condition: string, option: CompletionOption): string {
  const flags = [
    option.short ? `-s ${fishSingleQuote(option.short.slice(1))}` : '',
    option.long ? `-l ${fishSingleQuote(option.long.slice(2))}` : '',
    option.requiresValue ? '-r' : '',
  ].filter(Boolean).join(' ');
  return `complete -c ${command} -n ${fishSingleQuote(condition)} ${flags} -d ${fishSingleQuote(option.description)}`;
}

function fishSingleQuote(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function shellIdentifier(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_]/gu, '_');
}
