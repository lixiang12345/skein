import {readFile, stat} from 'node:fs/promises';
import {z} from 'zod';
import type {AgentTool} from './types.js';
import {jsonSchema} from './types.js';

const inputSchema = z.object({
  path: z.string().min(1),
  start_line: z.number().int().positive().optional(),
  end_line: z.number().int().positive().optional(),
  line_numbers: z.boolean().optional(),
  max_bytes: z.number().int().positive().max(1_000_000).optional(),
}).strict();

export const readFileTool: AgentTool = {
  definition: {
    name: 'read_file',
    description: 'Read a UTF-8 text file inside the workspace, optionally selecting a line range.',
    category: 'read',
    inputSchema: jsonSchema({
      path: {type: 'string', description: 'Workspace-relative or allowed absolute file path.'},
      start_line: {type: 'integer', minimum: 1},
      end_line: {type: 'integer', minimum: 1},
      line_numbers: {type: 'boolean', default: true},
      max_bytes: {type: 'integer', minimum: 1, maximum: 1_000_000, default: 200_000},
    }, ['path']),
  },

  async execute(arguments_, context) {
    const input = inputSchema.parse(arguments_);
    const path = await context.workspace.resolvePath(input.path, {expect: 'file'});
    const info = await stat(path);
    const maxBytes = input.max_bytes ?? 200_000;
    if (info.size > 10_000_000) {
      throw new Error(`File is too large to read safely (${info.size} bytes).`);
    }
    const buffer = await readFile(path);
    if (looksBinary(buffer)) throw new Error('Binary files cannot be read with read_file.');
    const raw = buffer.toString('utf8');
    const lines = raw.split('\n');
    const start = input.start_line ?? 1;
    const requestedEnd = input.end_line ?? lines.length;
    if (requestedEnd < start) throw new Error('end_line must be greater than or equal to start_line.');
    const end = Math.min(requestedEnd, lines.length);
    const selected = start > lines.length ? [] : lines.slice(start - 1, end);
    const numbered = input.line_numbers ?? true;
    let content = selected.map((line, offset) =>
      numbered ? `${String(start + offset).padStart(6)} | ${line}` : line,
    ).join('\n');
    let truncated = false;
    if (Buffer.byteLength(content) > maxBytes) {
      content = truncateUtf8(content, maxBytes);
      truncated = true;
    }
    const heading = `${context.workspace.display(path)}:${start}-${end}`;
    return {
      content: `${heading}\n${content}${truncated ? '\n… output truncated' : ''}`,
      metadata: {
        path,
        startLine: start,
        endLine: end,
        totalLines: lines.length,
        size: info.size,
        truncated,
      },
    };
  },
};

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_192));
  return sample.includes(0);
}

function truncateUtf8(input: string, maxBytes: number): string {
  const buffer = Buffer.from(input);
  let end = Math.min(buffer.length, maxBytes);
  while (end > 0 && (buffer[end] ?? 0) >= 0x80 && (buffer[end] ?? 0) < 0xc0) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}
