import {lstat, readFile} from 'node:fs/promises';
import {createTwoFilesPatch} from 'diff';
import type {ToolCall} from '../types.js';
import {sanitizeTerminalText} from './text.js';

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
