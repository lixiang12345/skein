import {lstat, readFile} from 'node:fs/promises';
import {createTwoFilesPatch} from 'diff';
import type {ToolCall, ToolCategory} from '../types.js';
import {displayWidth, sanitizeTerminalText} from './text.js';

/**
 * Bounded, display-only diff preview for write-category permission prompts.
 *
 * This is live approval UI, not a receipt: the person approving the write is
 * entitled to see exactly what will land on disk, the same way command text
 * is shown before a shell approval. Nothing here is persisted.
 */
export interface PermissionPreview {
  lines: string[];
  more: number;
}

const MAX_PREVIEW_LINES = 10;
const MAX_PREVIEW_BYTES = 512 * 1024;

export async function buildWritePreview(
  call: ToolCall,
  resolvePath: (path: string) => Promise<string>,
): Promise<PermissionPreview | undefined> {
  try {
    if (call.name === 'apply_patch') return patchPreview(call);
    if (call.name === 'write_file') return await writeFilePreview(call, resolvePath);
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Preview for any ask-category approval. Write tools show their diff; calls
 * carrying a shell command show the complete command wrapped to the card
 * width, so approval never applies to text hidden behind an ellipsis.
 */
export async function buildPermissionPreview(
  call: ToolCall,
  category: ToolCategory,
  resolvePath: (path: string) => Promise<string>,
  width: number,
): Promise<PermissionPreview | undefined> {
  if (category === 'write' && (call.name === 'write_file' || call.name === 'apply_patch')) {
    return buildWritePreview(call, resolvePath);
  }
  const command = call.arguments.command;
  if (typeof command !== 'string') return undefined;
  const summaryBudget = 240;
  const wrapped = wrapForCard(sanitizeTerminalText(command), width);
  // The one-line target summary already shows short commands in full; only
  // add the block when wrapping or truncation would otherwise hide the tail.
  if (wrapped.lines.length <= 1 && command.length <= summaryBudget && displayWidth(command) < width - 20) {
    return undefined;
  }
  return wrapped;
}

function wrapForCard(text: string, width: number): PermissionPreview {
  const columns = Math.max(16, width - 4);
  const lines: string[] = [];
  for (const logical of text.split('\n')) {
    if (logical === '') {
      lines.push('');
      continue;
    }
    let rest = logical;
    while (rest !== '') {
      let take = Math.min(rest.length, columns);
      while (take > 1 && displayWidth(rest.slice(0, take)) > columns) take -= 1;
      lines.push(rest.slice(0, take));
      rest = rest.slice(take);
    }
  }
  return bounded(lines);
}

/** Rows the preview occupies in the permission card at this width. */
export function permissionPreviewRows(
  preview: PermissionPreview | undefined,
  width: number,
  compact: boolean,
): number {
  if (!preview || compact || width < 48) return 0;
  return preview.lines.length + (preview.more > 0 ? 1 : 0);
}

async function writeFilePreview(
  call: ToolCall,
  resolvePath: (path: string) => Promise<string>,
): Promise<PermissionPreview | undefined> {
  const path = call.arguments.path;
  const content = call.arguments.content;
  if (typeof path !== 'string' || typeof content !== 'string') return undefined;
  if (Buffer.byteLength(content) > MAX_PREVIEW_BYTES) {
    return {lines: ['(diff preview skipped: proposed content exceeds 512 KiB)'], more: 0};
  }
  const resolved = await resolvePath(path);
  let before = '';
  try {
    const info = await lstat(resolved);
    if (!info.isFile() || info.size > MAX_PREVIEW_BYTES) {
      return {lines: ['(diff preview skipped: existing file is too large or not regular)'], more: 0};
    }
    const buffer = await readFile(resolved);
    if (buffer.subarray(0, 8_192).includes(0)) {
      return {lines: ['(diff preview skipped: existing file is binary)'], more: 0};
    }
    before = buffer.toString('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (before === content) return {lines: ['(no content change)'], more: 0};
  const patch = createTwoFilesPatch('current', 'proposed', before, content, undefined, undefined, {context: 2});
  const body = patch.split('\n').filter((line) =>
    (line.startsWith('@@') || line.startsWith('+') || line.startsWith('-')) &&
    !line.startsWith('+++') && !line.startsWith('---'));
  return bounded(body);
}

function patchPreview(call: ToolCall): PermissionPreview | undefined {
  const patch = call.arguments.patch;
  if (typeof patch !== 'string') return undefined;
  const lines = patch.replace(/\r\n/g, '\n').split('\n').filter((line) => {
    const trimmed = line.trim();
    return trimmed !== '' && trimmed !== '*** Begin Patch' && trimmed !== '*** End Patch';
  });
  return bounded(lines);
}

function bounded(lines: string[]): PermissionPreview {
  const clean = lines.map((line) => sanitizeTerminalText(line));
  return {
    lines: clean.slice(0, MAX_PREVIEW_LINES),
    more: Math.max(0, clean.length - MAX_PREVIEW_LINES),
  };
}
