import {z} from 'zod';
import type {AgentTool} from '../tools/types.js';
import {jsonSchema} from '../tools/types.js';
import type {MemoryScope} from '../types.js';
import {MemoryStore} from './store.js';

const scopeSchema = z.enum(['user', 'workspace', 'session', 'agent']);
const kindSchema = z.enum(['semantic', 'episodic', 'procedural']);

export function createMemoryTools(store: MemoryStore): AgentTool[] {
  return [
    {
      definition: {
        name: 'memory_search',
        description: 'Search durable user, workspace, session, and agent memories relevant to the task.',
        category: 'read',
        inputSchema: jsonSchema({
          query: {type: 'string', description: 'Natural-language memory query.'},
          scope: {type: 'string', enum: ['user', 'workspace', 'session', 'agent']},
          limit: {type: 'integer', minimum: 1, maximum: 20},
        }, ['query']),
      },
      async execute(arguments_, context) {
        const input = z.object({
          query: z.string().max(4_000),
          scope: scopeSchema.optional(),
          limit: z.number().int().min(1).max(20).optional(),
        }).parse(arguments_);
        const scopes = input.scope
          ? [{scope: input.scope, scopeKey: scopeKey(input.scope, context)}]
          : availableScopes(context);
        const records = store.search(input.query, {scopes, limit: input.limit ?? 8});
        return {
          content: records.length
            ? records.map((record) =>
              `[${record.id.slice(0, 8)}] ${record.scope} importance=${record.importance.toFixed(2)}\n${record.content}`,
            ).join('\n\n')
            : 'No matching memory found.',
          metadata: {count: records.length, memoryIds: records.map((record) => record.id)},
        };
      },
    },
    {
      definition: {
        name: 'memory_propose',
        description: 'Propose a non-secret durable memory for user review. The candidate remains inactive until the user explicitly approves it.',
        category: 'write',
        inputSchema: jsonSchema({
          content: {type: 'string', description: 'Concise fact, preference, experience, or procedure to propose. Never include secrets.'},
          rationale: {type: 'string', description: 'Why this is useful beyond the current response and what evidence supports it.'},
          scope: {type: 'string', enum: ['user', 'workspace', 'session', 'agent'], description: 'Recall scope. Defaults to workspace.'},
          kind: {type: 'string', enum: ['semantic', 'episodic', 'procedural']},
          tags: {type: 'array', items: {type: 'string'}, maxItems: 24},
          importance: {type: 'number', minimum: 0, maximum: 1},
          confidence: {type: 'number', minimum: 0, maximum: 1},
          agent: {type: 'string'},
          revision: {type: 'string', description: 'Optional source revision or commit identifier.'},
          conflictKey: {type: 'string', description: 'Optional stable identity for a fact that may supersede an older value.'},
        }, ['content', 'rationale']),
      },
      async execute(arguments_, context) {
        const input = z.object({
          content: z.string().min(1).max(12_000),
          rationale: z.string().min(1).max(1_000),
          scope: scopeSchema.optional(),
          kind: kindSchema.optional(),
          tags: z.array(z.string()).max(24).optional(),
          importance: z.number().min(0).max(1).optional(),
          confidence: z.number().min(0).max(1).optional(),
          agent: z.string().max(64).optional(),
          revision: z.string().max(240).optional(),
          conflictKey: z.string().max(240).optional(),
        }).strict().parse(arguments_);
        const scope = input.scope ?? 'workspace';
        const candidate = store.propose({
          scope,
          scopeKey: scope === 'agent' ? input.agent ?? 'default' : scopeKey(scope, context),
          content: input.content,
          rationale: input.rationale,
          ...(input.tags ? {tags: input.tags} : {}),
          ...(input.kind ? {kind: input.kind} : {}),
          ...(input.importance !== undefined ? {importance: input.importance} : {}),
          ...(input.confidence !== undefined ? {confidence: input.confidence} : {}),
          ...(input.revision ? {revision: input.revision} : {}),
          ...(input.conflictKey ? {conflictKey: input.conflictKey} : {}),
          source: `model:session:${context.session.id}`,
        });
        return {
          content: `Proposed memory ${candidate.id.slice(0, 8)} in ${candidate.scope} scope. It is inactive until the user approves it with /memory approve ${candidate.id.slice(0, 8)}.`,
          metadata: {
            memoryCandidateId: candidate.id,
            scope: candidate.scope,
            status: candidate.status,
            requiresApproval: true,
          },
        };
      },
    },
    {
      definition: {
        name: 'memory_forget',
        description: 'Archive or permanently delete a memory by id.',
        category: 'write',
        inputSchema: jsonSchema({
          id: {type: 'string'},
          permanent: {type: 'boolean'},
        }, ['id']),
      },
      async execute(arguments_) {
        const input = z.object({
          id: z.string().uuid(),
          permanent: z.boolean().optional(),
        }).parse(arguments_);
        const changed = input.permanent ? store.remove(input.id) : store.archive(input.id);
        return {
          ok: changed,
          content: changed
            ? `${input.permanent ? 'Deleted' : 'Archived'} memory ${input.id.slice(0, 8)}.`
            : `Memory not found: ${input.id}`,
          metadata: {memoryId: input.id, permanent: input.permanent === true},
        };
      },
    },
  ];
}

function availableScopes(context: Parameters<AgentTool['execute']>[1]) {
  return [
    {scope: 'user' as const, scopeKey: 'default'},
    {scope: 'workspace' as const, scopeKey: context.workspace.primaryRoot},
    {scope: 'session' as const, scopeKey: context.session.id},
  ];
}

function scopeKey(scope: MemoryScope, context: Parameters<AgentTool['execute']>[1]): string {
  if (scope === 'user') return 'default';
  if (scope === 'session') return context.session.id;
  if (scope === 'agent') return 'default';
  return context.workspace.primaryRoot;
}
