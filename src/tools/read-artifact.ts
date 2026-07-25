import {z} from 'zod';
import {ToolArtifactStore} from '../session/tool-artifacts.js';
import type {AgentTool} from './types.js';
import {jsonSchema} from './types.js';

const inputSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  start_line: z.number().int().positive().optional(),
  start_byte: z.number().int().nonnegative().optional(),
  max_lines: z.number().int().min(1).max(1_000).optional(),
  max_bytes: z.number().int().min(256).max(768).optional(),
}).strict().refine((input) => input.start_line === undefined || input.start_byte === undefined, {
  message: 'Use either start_line or start_byte, not both.',
});

/** Reads a small page of an oversized result retained by the current session. */
export const readToolArtifactTool: AgentTool = {
  definition: {
    name: 'read_tool_artifact',
    description: 'Read a bounded page of oversized tool output retained for this session. Use only the SHA-256 shown in a tool-output receipt.',
    category: 'read',
    inputSchema: jsonSchema({
      sha256: {type: 'string', description: 'The exact 64-character SHA-256 from a retained-output receipt.'},
      start_line: {type: 'integer', minimum: 1, default: 1},
      start_byte: {type: 'integer', minimum: 0, description: 'Exact UTF-8 continuation byte shown by a previous page.'},
      max_lines: {type: 'integer', minimum: 1, maximum: 1000, default: 200},
      max_bytes: {type: 'integer', minimum: 256, maximum: 768, default: 768},
    }, ['sha256']),
  },

  async execute(arguments_, context) {
    const input = inputSchema.parse(arguments_);
    const artifact = context.session.toolArtifacts?.find((candidate) =>
      candidate.sha256 === input.sha256 && Date.parse(candidate.expiresAt) > Date.now(),
    );
    if (!artifact) {
      throw new Error('No retained tool output matches this tool call in the current session.');
    }
    const store = context.toolArtifactStore ?? new ToolArtifactStore(context.workspace.primaryRoot);
    const page = await store.read(context.session.id, artifact.toolCallId, {
      ...(input.start_line !== undefined ? {startLine: input.start_line} : {}),
      ...(input.start_byte !== undefined ? {startByte: input.start_byte} : {}),
      ...(input.max_lines !== undefined ? {maxLines: input.max_lines} : {}),
      maxBytes: input.max_bytes ?? 768,
    });
    if (page.sha256 !== artifact.sha256 || page.bytes !== artifact.bytes) {
      throw new Error('Retained tool output no longer matches the session receipt.');
    }
    const heading = `Retained output page: lines ${page.startLine}-${page.endLine} of ${page.totalLines}; bytes ${page.startByte}-${page.endByte} of ${page.bytes}`;
    const continuation = page.nextStartByte !== undefined
      ? `continue with start_byte=${page.nextStartByte}`
      : page.nextStartLine !== undefined
        ? `continue with start_line=${page.nextStartLine}`
        : '';
    return {
      content: `${heading}\n${page.content}${page.hasMore ? `\n… more retained output; ${continuation}` : ''}`,
      metadata: {
        artifact: {
          toolCallId: page.toolCallId,
          sha256: page.sha256,
          bytes: page.bytes,
          expiresAt: page.expiresAt,
          redacted: page.redacted,
        },
        startLine: page.startLine,
        endLine: page.endLine,
        totalLines: page.totalLines,
        startByte: page.startByte,
        endByte: page.endByte,
        truncated: page.hasMore,
      },
    };
  },
};
