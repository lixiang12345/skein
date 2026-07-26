import {readdir, readFile, stat} from 'node:fs/promises';
import {join} from 'node:path';

/**
 * Workspace-defined slash commands: each Markdown file under
 * `.agents/commands/` becomes `/<filename>`. The file body is a prompt
 * template, never an executable: the expanded text is submitted as the run
 * input, lands verbatim in the session transcript, and every tool the model
 * then requests still passes the normal permission gates.
 */
export interface CustomCommand {
  name: string;
  description: string;
  /** Workspace-relative source path shown when the command runs. */
  path: string;
  content: string;
}

export const CUSTOM_COMMANDS_DIR = join('.agents', 'commands');
const MAX_COMMANDS = 50;
const MAX_BYTES = 10_000;
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

/**
 * Read workspace command templates. Reserved built-in names can never be
 * shadowed, names outside the strict slug pattern are ignored, and both the
 * file count and per-file size are bounded so a hostile checkout cannot
 * balloon the suggestion list or the prompt.
 */
export async function discoverCustomCommands(
  workspaceRoot: string,
  reserved: ReadonlySet<string>,
): Promise<CustomCommand[]> {
  const directory = join(workspaceRoot, CUSTOM_COMMANDS_DIR);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }
  const commands: CustomCommand[] = [];
  for (const entry of entries.filter((name) => name.endsWith('.md')).sort()) {
    if (commands.length >= MAX_COMMANDS) break;
    const name = entry.slice(0, -'.md'.length).toLocaleLowerCase();
    if (!NAME_PATTERN.test(name) || reserved.has(name)) continue;
    const filePath = join(directory, entry);
    try {
      const info = await stat(filePath);
      if (!info.isFile() || info.size > MAX_BYTES) continue;
      const content = (await readFile(filePath, 'utf8')).trim();
      if (!content) continue;
      commands.push({
        name,
        description: describeTemplate(content),
        path: join(CUSTOM_COMMANDS_DIR, entry),
        content,
      });
    } catch {
      continue;
    }
  }
  return commands;
}

/**
 * Substitute `$ARGUMENTS` with the invocation arguments; templates without
 * the placeholder get the arguments appended so `/cmd extra context` never
 * silently drops user input.
 */
export function expandCustomCommand(command: CustomCommand, argumentText: string): string {
  const trimmed = argumentText.trim();
  if (command.content.includes('$ARGUMENTS')) {
    return command.content.replaceAll('$ARGUMENTS', trimmed);
  }
  return trimmed ? `${command.content}\n\n${trimmed}` : command.content;
}

function describeTemplate(content: string): string {
  const line = content.split('\n').map((entry) => entry.trim()).find(Boolean) ?? '';
  return line.replace(/^#+\s*/u, '').slice(0, 100);
}
