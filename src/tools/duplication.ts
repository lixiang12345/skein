import {z} from 'zod';
import {
  activeDuplicationMatchIds,
  findActiveDuplicationMatches,
  pruneDuplicationSuppressions,
} from '../agent/duplication-state.js';
import type {AgentTool} from './types.js';
import {jsonSchema} from './types.js';

const inputSchema = z.discriminatedUnion('action', [
  z.object({action: z.literal('show')}).strict(),
  z.object({
    action: z.literal('suppress'),
    match_id: z.string().regex(/^[a-f0-9]{24}$/u),
    reason_code: z.enum(['separate-boundary', 'protocol-required', 'generated-contract', 'false-positive', 'other']),
    reason: z.string().trim().min(12).max(240),
  }).strict(),
]);

export const duplicationTool: AgentTool = {
  definition: {
    name: 'duplication_audit',
    description: 'Inspect active duplicate-function warnings or suppress one exact match with an auditable reason. Suppression does not bypass correctness, security, accessibility, concurrency, or verification requirements.',
    category: 'read',
    inputSchema: jsonSchema({
      action: {type: 'string', enum: ['show', 'suppress']},
      match_id: {type: 'string', description: 'Exact 24-character match id from the current audit.'},
      reason_code: {type: 'string', enum: ['separate-boundary', 'protocol-required', 'generated-contract', 'false-positive', 'other']},
      reason: {type: 'string', description: 'Specific 12-240 character explanation; code blocks and credentials are rejected.'},
    }, ['action']),
  },

  async execute(arguments_, context) {
    const input = inputSchema.parse(arguments_);
    const suppressions = pruneDuplicationSuppressions(
      context.session.audit ?? [],
      context.session.duplicationSuppressions ?? [],
    );
    context.session.duplicationSuppressions = suppressions;
    const active = activeDuplicationMatchIds(context.session.audit ?? [], suppressions);
    if (input.action === 'suppress') {
      if (!active.has(input.match_id)) {
        throw new Error(`Unknown, stale, or already suppressed duplication match: ${input.match_id}`);
      }
      suppressions.push({
        matchId: input.match_id,
        reasonCode: input.reason_code,
        reason: cleanReason(input.reason),
        createdAt: new Date().toISOString(),
        toolCallId: context.toolCallId ?? 'unavailable',
      });
      context.session.duplicationSuppressions = suppressions.slice(-64);
      return {
        content: `Suppressed duplication match ${input.match_id}. This does not waive verification or safety requirements.`,
        metadata: {duplicationSuppression: context.session.duplicationSuppressions.at(-1)},
      };
    }
    const matches = findActiveDuplicationMatches(context.session.audit ?? [], suppressions);
    return {
      content: matches.length
        ? matches.map((match) =>
          `- ${match.matchId}: ${match.changedPath}#${match.changedSymbol} -> ${match.candidatePath}#${match.candidateSymbol} (${match.kind}, ${match.similarity.toFixed(3)})`,
        ).join('\n')
        : 'No unsuppressed duplication matches.',
      metadata: {activeDuplicationMatches: matches.map((match) => match.matchId)},
    };
  },
};

function cleanReason(value: string): string {
  if (/```|~~~|\b(?:api[_-]?key|access[_-]?token|authorization|cookie|password|secret)\s*[:=]/iu.test(value) ||
    /\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,})\b/u.test(value)) {
    throw new Error('Suppression reasons cannot contain code blocks or credentials.');
  }
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').replace(/\s+/gu, ' ').trim();
}
