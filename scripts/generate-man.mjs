#!/usr/bin/env node
// Generate man/skein.1 from the built CLI's own help output, so the man page
// can never drift from the real commands. Runs automatically via postbuild.
import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Escape text for verbatim roff blocks: backslashes and control lines. */
export function escapeRoff(text) {
  return text
    .split('\n')
    .map((line) => {
      const escaped = line.replaceAll('\\', '\\e');
      return /^[.']/u.test(escaped) ? `\\&${escaped}` : escaped;
    })
    .join('\n');
}

/** Extract subcommand names from grouped root help output. */
export function parseCommandNames(rootHelp) {
  const names = [];
  let heading = '';
  for (const line of rootHelp.split('\n')) {
    const headingMatch = /^([A-Z][^:]*):$/u.exec(line.trim());
    if (headingMatch && !line.startsWith(' ')) {
      heading = headingMatch[1];
      continue;
    }
    if (['', 'Arguments', 'Options', 'Examples', 'Learn more'].includes(heading)) continue;
    const commandMatch = /^ {2}([a-z][a-z0-9-]*)(?:\s|\[|<)/u.exec(line);
    if (commandMatch && !names.includes(commandMatch[1])) names.push(commandMatch[1]);
  }
  return names;
}

/** Render the complete roff man page. */
export function renderManPage({version, date, homepage, bugs, rootHelp, commandHelps}) {
  const lines = [
    `.TH SKEIN 1 "${date}" "skein ${version}" "Skein Manual"`,
    '.SH NAME',
    'skein \\- context-first, model-agnostic coding agent with an auditable terminal workspace',
    '.SH SYNOPSIS',
    '.B skein',
    '[options] [command] [prompt...]',
    '.SH DESCRIPTION',
    '.nf',
    escapeRoff(rootHelp.trim()),
    '.fi',
    '.SH COMMANDS',
  ];
  for (const {name, help} of commandHelps) {
    lines.push(`.SS skein ${name}`, '.nf', escapeRoff(help.trim()), '.fi');
  }
  lines.push(
    '.SH SEE ALSO',
    `Website: ${homepage}`,
    '.br',
    `Issues: ${bugs}`,
  );
  return `${lines.join('\n')}\n`;
}

/** Resolve the release-controlled man page date from package metadata. */
export function resolveManPageDate(packageJson) {
  const date = packageJson?.skein?.manPageDate;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date ?? '')) {
    throw new Error('package.json skein.manPageDate must be an ISO date (YYYY-MM-DD)');
  }
  return date;
}

export function writeManPage(path, page) {
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, page);
}

export function generateManPage({packageJson, run}) {
  const rootHelp = run(['--help']);
  const commandHelps = parseCommandNames(rootHelp).map((name) => ({name, help: run([name, '--help'])}));
  return {
    page: renderManPage({
      version: packageJson.version,
      date: resolveManPageDate(packageJson),
      homepage: packageJson.homepage,
      bugs: packageJson.bugs.url,
      rootHelp,
      commandHelps,
    }),
    commandCount: commandHelps.length,
  };
}

function main() {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const cli = join(root, 'dist', 'cli.js');
  const run = (args) => execFileSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: {...process.env, NO_COLOR: '1'},
  });
  const {page, commandCount} = generateManPage({packageJson, run});
  writeManPage(join(root, 'man', 'skein.1'), page);
  process.stdout.write(`man/skein.1 generated for ${commandCount} subcommands.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
