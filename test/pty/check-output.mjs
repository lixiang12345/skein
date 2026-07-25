import {readFile} from 'node:fs/promises';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import xterm from '@xterm/headless';

const {Terminal} = xterm;

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
  ? ['Inspecting', 'verified', 'Type a request', 'Memory privacy', 'Context', 'Permission', 'Commands']
  : [
      'Inspecting',
      'verified',
      'SKEIN',
      'Memory privacy',
      'Skills',
      'blocked',
      'Workflows',
      'read-only',
      'Keyboard',
      'Permission',
      'History search',
      'Files',
      '@src/ui/tui.tsx',
    ];
if (scenario === 'full' && mode === 'unicode') required.push('项目');
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
if (mode !== 'unicode' && /[^\x00-\x7F]/u.test(cleaned)) {
  throw new Error(`${path} leaked non-ASCII terminal chrome in ${mode} mode`);
}
if (mode !== 'unicode' && hasColorSgr(raw)) {
  throw new Error(`${path} emitted ANSI colors in ${mode} mode`);
}
const finalFrame = await emulateFinalFrame(raw, width, scenario === 'short' ? 10 : 24);
const finalText = finalFrame.lines.join('\n');
const finalRequired = scenario === 'short'
  ? ['Type a request', 'Context', 'ready', 'Git diff was not']
  : ['SKEIN', 'Type a request', 'ready', 'Git diff was not'];
for (const value of finalRequired) {
  if (!finalText.includes(value)) throw new Error(`${path} final frame did not render ${value}`);
}
if (finalFrame.wrappedRows.length) {
  throw new Error(`${path} final frame overflowed into wrapped rows ${finalFrame.wrappedRows.join(', ')}`);
}
if (/uploaded\* SKEIN/u.test(finalText)) {
  throw new Error(`${path} joined workspace and chat announcements without a screen-reader boundary`);
}
if (mode !== 'screen-reader') {
  for (const value of ['Permission required', 'History search:', 'Keyboard reference', '@src/ui/tui.tsx']) {
    if (finalText.includes(value)) throw new Error(`${path} retained stale ${value} content in the final frame`);
  }
}
const finalWidest = Math.max(0, ...finalFrame.lines.map((line) => stringWidth(line)));
process.stdout.write(JSON.stringify({
  width,
  mode,
  widest,
  lines: contentLines.length,
  finalFrame: {rows: finalFrame.lines.filter((line) => line.trim()).length, widest: finalWidest},
}) + '\n');

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

async function emulateFinalFrame(value, columns, rows) {
  const terminal = new Terminal({
    cols: columns,
    rows,
    allowProposedApi: true,
    scrollback: 2_000,
  });
  try {
    await new Promise((resolve) => terminal.write(value, resolve));
    const buffer = terminal.buffer.active;
    const lines = [];
    const wrappedRows = [];
    for (let row = 0; row < rows; row += 1) {
      const line = buffer.getLine(buffer.viewportY + row);
      lines.push(line?.translateToString(true) ?? '');
      if (line?.isWrapped) wrappedRows.push(row + 1);
    }
    return {lines, wrappedRows};
  } finally {
    terminal.dispose();
  }
}
