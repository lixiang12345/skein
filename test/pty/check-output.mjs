import {readFile} from 'node:fs/promises';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';

const [path, widthText, mode, scenario = 'full'] = process.argv.slice(2);
const width = Number(widthText);
const raw = await readFile(path, 'utf8');
for (const sequence of ['\u001b[?u', '\u001b[?0u', '^[[?u', '^[[?0u']) {
  if (raw.includes(sequence)) {
    throw new Error(`${path} leaked a terminal capability probe: ${JSON.stringify(sequence)}`);
  }
}
const physicalLines = raw
  .replace(/\u001b\[[0-9;]*[ABEFHf]/gu, '\n');
const cleaned = stripAnsi(physicalLines)
  .replace(/\r/g, '\n')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '');
const lines = cleaned.split('\n');
const contentLines = lines.filter((line) => line.trim());
const widest = Math.max(0, ...contentLines.map((line) => stringWidth(line)));
const required = scenario === 'short'
  ? ['Inspecting', 'verified', 'Type a request', 'Context', 'Permission', 'Commands']
  : [
      'Inspecting',
      'verified',
      'SKEIN',
      'Keyboard',
      'Permission',
      'History search',
      'Files',
      '@src/ui/tui.tsx',
    ];
if (scenario === 'full' && width >= 48) required.push('context runs automatically', '@file pins');
if (scenario === 'full' && width >= 80) required.push('Ctrl+R');
if (scenario === 'full' && width >= 96) {
  required.push('WORKSPACE', 'CONTEXT', 'local index ready', 'RUNTIME', 'EXTENSIONS', 'files', 'chunks', 'mode BUILD', 'tools', 'MCP off', 'memory on');
}
for (const value of required) {
  if (!cleaned.includes(value)) throw new Error(`${path} did not render ${value}`);
}
if (!/Git diff was not\s+run; permission\s+denied\./u.test(cleaned)) {
  throw new Error(`${path} did not render the complete denied Git diff receipt`);
}
if (widest > width) {
  throw new Error(`${path} rendered a ${widest}-column segment in a ${width}-column terminal`);
}
for (const value of ['Cannot update a component', 'Unknown command']) {
  if (cleaned.includes(value)) throw new Error(`${path} emitted ${value}`);
}
if (cleaned.includes('Denied git.')) {
  throw new Error(`${path} emitted a duplicate Git permission denial`);
}
if (mode === 'ascii' && /[^\x00-\x7F]/u.test(cleaned)) {
  throw new Error(`${path} leaked non-ASCII terminal chrome in ASCII mode`);
}
if (mode === 'ascii' && hasColorSgr(raw)) {
  throw new Error(`${path} emitted ANSI colors while NO_COLOR was set`);
}
process.stdout.write(JSON.stringify({width, mode, widest, lines: contentLines.length}) + '\n');

function hasColorSgr(value) {
  return [...value.matchAll(/\u001b\[([0-9;:]*)m/gu)].some((match) =>
    (match[1] ?? '').split(/[;:]/u).some((part) => {
      const code = Number(part);
      return (code >= 30 && code <= 38) ||
        (code >= 40 && code <= 48) ||
        (code >= 90 && code <= 107) ||
        code === 58;
    }),
  );
}
