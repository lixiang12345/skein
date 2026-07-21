import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {SessionTask} from '../types.js';
import type {AgentTool} from './types.js';
import {jsonSchema} from './types.js';

const taskSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().min(1).max(500),
  status: z.enum(['pending', 'in_progress', 'completed']),
}).strict();

const inputSchema = z.discriminatedUnion('action', [
  z.object({action: z.literal('list')}).strict(),
  z.object({action: z.literal('add'), title: z.string().min(1).max(500), status: z.enum(['pending', 'in_progress', 'completed']).optional()}).strict(),
  z.object({action: z.literal('update'), id: z.string().min(1), title: z.string().min(1).max(500).optional(), status: z.enum(['pending', 'in_progress', 'completed']).optional()}).strict(),
  z.object({action: z.literal('remove'), id: z.string().min(1)}).strict(),
  z.object({action: z.literal('replace'), tasks: z.array(taskSchema).max(100)}).strict(),
]);

export const taskTool: AgentTool = {
  definition: {
    name: 'task',
    description: 'List or update the concise execution plan stored with the current session.',
    // Session-local planning is safe and should not prompt like filesystem writes.
    category: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        action: {type: 'string', enum: ['list', 'add', 'update', 'remove', 'replace']},
        id: {type: 'string'},
        title: {type: 'string'},
        status: {type: 'string', enum: ['pending', 'in_progress', 'completed']},
        tasks: {type: 'array', items: {
          type: 'object',
          properties: {
            id: {type: 'string'},
            title: {type: 'string'},
            status: {type: 'string', enum: ['pending', 'in_progress', 'completed']},
          },
          required: ['title', 'status'],
          additionalProperties: false,
        }},
      },
      required: ['action'],
      additionalProperties: false,
    },
  },

  async execute(arguments_, context) {
    const input = inputSchema.parse(arguments_);
    const tasks = context.session.tasks;
    switch (input.action) {
      case 'list': break;
      case 'add':
        tasks.push({id: randomUUID(), title: input.title, status: input.status ?? 'pending'});
        break;
      case 'update': {
        const task = tasks.find((item) => item.id === input.id);
        if (!task) throw new Error(`Unknown task id: ${input.id}`);
        if (input.title !== undefined) task.title = input.title;
        if (input.status !== undefined) task.status = input.status;
        break;
      }
      case 'remove': {
        const index = tasks.findIndex((item) => item.id === input.id);
        if (index < 0) throw new Error(`Unknown task id: ${input.id}`);
        tasks.splice(index, 1);
        break;
      }
      case 'replace':
        tasks.splice(0, tasks.length, ...input.tasks.map((task): SessionTask => ({
          id: task.id ?? randomUUID(),
          title: task.title,
          status: task.status,
        })));
        break;
    }
    return {
      content: tasks.length
        ? tasks.map((task) => `- [${task.status}] ${task.id}: ${task.title}`).join('\n')
        : 'No tasks.',
      metadata: {tasks: tasks.map((task) => ({...task}))},
    };
  },
};
