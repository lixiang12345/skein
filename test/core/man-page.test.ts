import {readFile} from 'node:fs/promises';
import {describe, expect, it} from 'vitest';

// @ts-expect-error scripts/ ships plain ESM without type declarations.
import {escapeRoff, parseCommandNames, renderManPage} from '../../scripts/generate-man.mjs';

describe('man page generator', () => {
  it('escapes roff control characters', () => {
    expect(escapeRoff('.hidden directive')).toBe('\\&.hidden directive');
    expect(escapeRoff("'quoted line")).toBe("\\&'quoted line");
    expect(escapeRoff('a\\b')).toBe('a\\eb');
    expect(escapeRoff('plain text')).toBe('plain text');
  });

  it('parses command names only from grouped command sections', () => {
    const help = [
      'Usage: skein [options] [command] [prompt...]',
      '',
      'Arguments:',
      '  prompt                     instruction for the agent',
      '',
      'Options:',
      '  -p, --print                run once and print the result',
      '',
      'Getting started:',
      '  init [options]             Create a project-local config',
      '  doctor [options]           Diagnose prerequisites',
      '',
      'Examples:',
      '  $ skein search "token budget"   search the local code index',
      '',
      'Learn more:',
      '  Website  https://example.test/',
    ].join('\n');
    expect(parseCommandNames(help)).toEqual(['init', 'doctor']);
  });

  it('renders a complete roff document', () => {
    const page = renderManPage({
      version: '1.2.3',
      date: '2026-07-26',
      homepage: 'https://example.test/',
      bugs: 'https://example.test/issues',
      rootHelp: 'Usage: skein',
      commandHelps: [{name: 'doctor', help: 'Usage: skein doctor'}],
    });
    expect(page).toMatch(/^\.TH SKEIN 1 "2026-07-26" "skein 1\.2\.3"/u);
    expect(page).toContain('.SS skein doctor');
    expect(page).toContain('.SH SEE ALSO');
  });

  it('keeps a generated man/skein.1 checked in and fresh in shape', async () => {
    const page = await readFile('man/skein.1', 'utf8');
    expect(page.startsWith('.TH SKEIN 1 ')).toBe(true);
    expect(page).toContain('.SH COMMANDS');
    expect(page).toContain('.SS skein session');
    expect(page).toContain('.SS skein feedback');
  });
});
