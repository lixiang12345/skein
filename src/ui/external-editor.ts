import {spawn} from 'node:child_process';
import {lstat, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveExecutableRuntime} from '../utils/process.js';

const MAX_DRAFT_BYTES = 120_000;

export interface EditorLaunch {
  command: string;
  args: string[];
}

export interface EditComposerDraftOptions {
  workspace: string;
  environment?: NodeJS.ProcessEnv;
  launch?: (command: string, args: string[], options: {cwd: string; env: NodeJS.ProcessEnv}) => Promise<number>;
}

export async function editComposerDraft(
  initial: string,
  options: EditComposerDraftOptions,
): Promise<string> {
  const environment = options.environment ?? process.env;
  const configured = environment.VISUAL?.trim() || environment.EDITOR?.trim();
  if (!configured) throw new Error('No external editor configured. Set VISUAL or EDITOR and retry /editor.');
  const editor = parseEditorCommand(configured);
  if (/^(?:sh|bash|dash|zsh|fish|ksh|csh|tcsh|xonsh|nu|pwsh|powershell(?:\.exe)?|cmd(?:\.exe)?)$/iu
    .test(editor.command.split(/[\\/]/u).at(-1) ?? '')) {
    throw new Error('VISUAL or EDITOR must name an editor, not a command shell.');
  }
  const executable = await resolveExecutableRuntime(editor.command, options.workspace, [options.workspace]);
  if (!executable) throw new Error('Configured editor is not installed or resolves inside the workspace.');
  const directory = await mkdtemp(join(tmpdir(), 'skein-composer-'));
  const path = join(directory, 'prompt.md');
  try {
    await writeFile(path, boundedDraft(initial), {encoding: 'utf8', mode: 0o600, flag: 'wx'});
    const env = editorEnvironment(executable.path, environment);
    const exitCode = await (options.launch ?? launchInteractive)(
      executable.executable,
      [...editor.args, path],
      {cwd: options.workspace, env},
    );
    if (exitCode !== 0) throw new Error(`External editor exited with status ${exitCode}.`);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_DRAFT_BYTES) {
      throw new Error('External editor draft must remain a regular UTF-8 file no larger than 120000 bytes.');
    }
    return boundedDraft(await readFile(path, 'utf8'));
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

export function parseEditorCommand(value: string): EditorLaunch {
  if (!value || value.length > 2_000 || /[\u0000\r\n]/u.test(value)) {
    throw new Error('VISUAL or EDITOR contains an invalid command.');
  }
  const parts: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | undefined;
  let escaped = false;
  for (const character of value.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== 'single') {
      escaped = true;
      continue;
    }
    if (character === "'" && quote !== 'double') {
      quote = quote === 'single' ? undefined : 'single';
      continue;
    }
    if (character === '"' && quote !== 'single') {
      quote = quote === 'double' ? undefined : 'double';
      continue;
    }
    if (/\s/u.test(character) && !quote) {
      if (current) parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (escaped || quote) throw new Error('VISUAL or EDITOR contains an unterminated escape or quote.');
  if (current) parts.push(current);
  const [command, ...args] = parts;
  if (!command) throw new Error('VISUAL or EDITOR does not name an executable.');
  if (parts.length > 32 || parts.some((part) => part.length > 1_000)) {
    throw new Error('VISUAL or EDITOR command is too large.');
  }
  return {command, args};
}

function boundedDraft(value: string): string {
  const normalized = value.replace(/\r\n?/gu, '\n').replace(/\u0000/gu, '');
  if (Buffer.byteLength(normalized) > MAX_DRAFT_BYTES) {
    throw new Error('Composer draft exceeds the 120000-byte limit.');
  }
  return normalized;
}

function editorEnvironment(path: string, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {PATH: path};
  for (const name of [
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
    'XDG_RUNTIME_DIR', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM',
    'DISPLAY', 'WAYLAND_DISPLAY', 'SSH_TTY', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT',
  ]) {
    if (environment[name] !== undefined) selected[name] = environment[name];
  }
  return selected;
}

function launchInteractive(
  command: string,
  args: string[],
  options: {cwd: string; env: NodeJS.ProcessEnv},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}
