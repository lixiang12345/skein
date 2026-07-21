import {z} from 'zod';
import type {WorkingMemory} from '../types.js';
import type {AgentTool} from './types.js';
import {jsonSchema} from './types.js';

const inputSchema = z.discriminatedUnion('action', [
  z.object({action: z.literal('show')}).strict(),
  z.object({action: z.literal('set_goal'), value: z.string().min(1).max(1_000)}).strict(),
  z.object({action: z.literal('set_focus'), value: z.string().min(1).max(1_000)}).strict(),
  z.object({action: z.literal('add_constraint'), value: z.string().min(1).max(1_000)}).strict(),
  z.object({action: z.literal('add_decision'), value: z.string().min(1).max(1_000)}).strict(),
  z.object({action: z.literal('add_question'), value: z.string().min(1).max(1_000)}).strict(),
  z.object({action: z.literal('resolve_question'), value: z.string().min(1).max(1_000)}).strict(),
  z.object({action: z.literal('add_file'), path: z.string().min(1).max(4_000)}).strict(),
  z.object({action: z.literal('clear'), field: z.enum(['constraints', 'decisions', 'openQuestions', 'relevantFiles'])}).strict(),
]);

/**
 * Maintains bounded, thread-local state that should survive compaction without
 * becoming a durable user memory. It deliberately has no filesystem/network
 * capability and therefore does not require a permission prompt.
 */
export const workingMemoryTool: AgentTool = {
  definition: {
    name: 'working_memory',
    description: 'Read or update short-term thread state: goal, focus, constraints, decisions, open questions, and relevant files. This state is temporary and is not durable memory.',
    category: 'read',
    inputSchema: jsonSchema({
      action: {type: 'string', enum: [
        'show', 'set_goal', 'set_focus', 'add_constraint', 'add_decision',
        'add_question', 'resolve_question', 'add_file', 'clear',
      ]},
      value: {type: 'string', description: 'Text for a goal, focus, constraint, decision, or question.'},
      path: {type: 'string', description: 'Workspace-relative relevant file path.'},
      field: {type: 'string', enum: ['constraints', 'decisions', 'openQuestions', 'relevantFiles']},
    }, ['action']),
  },

  async execute(arguments_, context) {
    const input = inputSchema.parse(arguments_);
    const memory = context.session.workingMemory ?? emptyWorkingMemory();
    switch (input.action) {
      case 'show':
        break;
      case 'set_goal':
        memory.goal = clean(input.value);
        break;
      case 'set_focus':
        memory.focus = clean(input.value);
        break;
      case 'add_constraint':
        pushBounded(memory.constraints, input.value, 12);
        break;
      case 'add_decision':
        pushBounded(memory.decisions, input.value, 12);
        break;
      case 'add_question':
        pushBounded(memory.openQuestions, input.value, 12);
        break;
      case 'resolve_question':
        removeMatching(memory.openQuestions, input.value);
        break;
      case 'add_file': {
        const safe = await context.workspace.resolvePath(input.path, {expect: 'any'});
        pushBounded(memory.relevantFiles, safe, 24);
        break;
      }
      case 'clear':
        memory[input.field] = [];
        break;
    }
    memory.lastUpdatedAt = new Date().toISOString();
    context.session.workingMemory = memory;
    return {content: render(memory), metadata: {workingMemory: {...memory}}};
  },
};

function emptyWorkingMemory(): WorkingMemory {
  return {
    goal: '',
    focus: '',
    constraints: [],
    decisions: [],
    openQuestions: [],
    relevantFiles: [],
    lastUpdatedAt: new Date().toISOString(),
  };
}

function pushBounded(values: string[], value: string, limit: number): void {
  const normalized = clean(value);
  const existing = values.indexOf(normalized);
  if (existing >= 0) values.splice(existing, 1);
  values.push(normalized);
  if (values.length > limit) values.splice(0, values.length - limit);
}

function removeMatching(values: string[], value: string): void {
  const query = value.toLocaleLowerCase().trim();
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const candidate = values[index] as string;
    if (candidate.toLocaleLowerCase() === query || candidate.toLocaleLowerCase().includes(query)) {
      values.splice(index, 1);
    }
  }
}

function clean(value: string): string {
  return value
    .trim()
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,})\b/g, '[redacted-secret]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret))\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\s+/g, ' ')
    .slice(0, 1_000);
}

function render(memory: WorkingMemory): string {
  return [
    `Goal: ${memory.goal || '(none)'}`,
    `Focus: ${memory.focus || '(none)'}`,
    `Constraints: ${memory.constraints.length ? memory.constraints.join(' · ') : '(none)'}`,
    `Decisions: ${memory.decisions.length ? memory.decisions.join(' · ') : '(none)'}`,
    `Open questions: ${memory.openQuestions.length ? memory.openQuestions.join(' · ') : '(none)'}`,
    `Relevant files: ${memory.relevantFiles.length ? memory.relevantFiles.join(' · ') : '(none)'}`,
  ].join('\n');
}
