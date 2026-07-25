import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {TaskContractCriterion} from '../types.js';
import {
  refreshTaskContractState,
  successfulContractEvidence,
} from '../agent/task-contract.js';
import {classifyVerificationCommand} from '../agent/completion-gate.js';
import type {AgentTool} from './types.js';

const criterionSchema = z.object({
  id: z.string().min(1).max(128).optional(),
  description: z.string().min(1).max(2_000),
  required: z.boolean().optional(),
}).strict();

const inputSchema = z.discriminatedUnion('action', [
  z.object({action: z.literal('show')}).strict(),
  z.object({
    action: z.literal('replace'),
    objective: z.string().min(1).max(20_000),
    scope: z.array(z.string().min(1).max(2_000)).max(64),
    constraints: z.array(z.string().min(1).max(2_000)).max(64),
    non_goals: z.array(z.string().min(1).max(2_000)).max(64),
    acceptance_criteria: z.array(criterionSchema).min(1).max(64),
    verification_requirements: z.array(z.string().min(1).max(2_000)).min(1).max(64),
  }).strict(),
  z.object({action: z.literal('activate')}).strict(),
  z.object({
    action: z.literal('update_criterion'),
    id: z.string().min(1).max(128),
    status: z.enum(['pending', 'satisfied', 'blocked']),
    evidence_refs: z.array(z.string().min(1).max(256)).max(64).optional(),
    note: z.string().max(2_000).optional(),
  }).strict(),
]);

export const taskContractTool: AgentTool = {
  definition: {
    name: 'task_contract',
    description: 'Define and update the durable acceptance contract for a complex executable request. Satisfied criteria require successful tool audit evidence IDs or tool-call IDs.',
    category: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        action: {type: 'string', enum: ['show', 'replace', 'activate', 'update_criterion']},
        objective: {type: 'string'},
        scope: {type: 'array', items: {type: 'string'}},
        constraints: {type: 'array', items: {type: 'string'}},
        non_goals: {type: 'array', items: {type: 'string'}},
        acceptance_criteria: {type: 'array', items: {
          type: 'object',
          properties: {
            id: {type: 'string'},
            description: {type: 'string'},
            required: {type: 'boolean'},
          },
          required: ['description'],
          additionalProperties: false,
        }},
        verification_requirements: {
          type: 'array',
          minItems: 1,
          items: {type: 'string'},
          description: 'Required verification commands or the standard any-successful-check requirement.',
        },
        id: {type: 'string'},
        status: {type: 'string', enum: ['pending', 'satisfied', 'blocked']},
        evidence_refs: {type: 'array', items: {type: 'string'}},
        note: {type: 'string'},
      },
      required: ['action'],
      additionalProperties: false,
    },
  },

  async execute(arguments_, context) {
    const input = inputSchema.parse(arguments_);
    let contract = context.session.taskContract;
    if (!contract) throw new Error('No Task Contract is active for this session.');
    if (input.action === 'replace') {
      if (contract.state !== 'draft') {
        throw new Error('Only a draft Task Contract can be replaced.');
      }
      const now = new Date().toISOString();
      const criteria = input.acceptance_criteria.map((item): TaskContractCriterion => ({
        id: item.id ?? `criterion-${randomUUID().slice(0, 8)}`,
        description: item.description,
        required: item.required ?? true,
        status: 'pending',
        evidenceRefs: [],
      }));
      if (new Set(criteria.map((item) => item.id)).size !== criteria.length) {
        throw new Error('Task Contract criterion ids must be unique.');
      }
      if (!criteria.some((item) => item.required)) {
        throw new Error('Task Contract requires at least one required acceptance criterion.');
      }
      for (const existing of contract.acceptanceCriteria.filter((item) => item.required)) {
        const retained = criteria.find((item) => item.id === existing.id);
        if (!retained || !retained.required || retained.description !== existing.description) {
          throw new Error(`Required criterion cannot be removed or weakened: ${existing.id}`);
        }
      }
      for (const existing of contract.verificationRequirements) {
        if (!input.verification_requirements.includes(existing)) {
          throw new Error(`Verification requirement cannot be removed: ${existing}`);
        }
      }
      for (const requirement of input.verification_requirements) {
        validateVerificationRequirement(requirement);
      }
      Object.assign(contract, {
        version: 1,
        state: 'active',
        objective: input.objective,
        scope: input.scope,
        constraints: input.constraints,
        nonGoals: input.non_goals,
        acceptanceCriteria: criteria,
        verificationRequirements: input.verification_requirements,
        createdAt: contract.createdAt,
        updatedAt: now,
        ...(contract.auditBoundaryId ? {auditBoundaryId: contract.auditBoundaryId} : {}),
      });
    } else if (input.action === 'activate') {
      refreshTaskContractState(contract);
    } else if (input.action === 'update_criterion') {
      if (contract.state === 'draft') {
        throw new Error('Activate the draft Task Contract before updating acceptance criteria.');
      }
      const criterion = contract.acceptanceCriteria.find((item) => item.id === input.id);
      if (!criterion) throw new Error(`Unknown Task Contract criterion id: ${input.id}`);
      const refs = [...new Set(input.evidence_refs ?? [])];
      if (input.status === 'satisfied') {
        if (!refs.length) throw new Error('Satisfied criteria require at least one evidence_refs entry.');
        const valid = successfulContractEvidence(context.session);
        const invalid = refs.filter((ref) => !valid.has(ref));
        if (invalid.length) {
          throw new Error(`Unknown or unsuccessful evidence refs: ${invalid.join(', ')}`);
        }
      }
      criterion.status = input.status;
      criterion.evidenceRefs = input.status === 'satisfied' ? refs : [];
      if (input.note === undefined) delete criterion.note;
      else criterion.note = input.note;
      refreshTaskContractState(contract);
    }
    return {
      content: formatContract(contract),
      metadata: {taskContract: structuredClone(contract)},
    };
  },
};

function formatContract(contract: Parameters<typeof refreshTaskContractState>[0]): string {
  const satisfied = contract.acceptanceCriteria.filter((item) => item.status === 'satisfied').length;
  const criteria = contract.acceptanceCriteria.map((item) =>
    `- [${item.status}] ${item.id}: ${item.description}`,
  ).join('\n');
  return `Task Contract: ${contract.state} (${satisfied}/${contract.acceptanceCriteria.length} satisfied)\nObjective: ${contract.objective}\n${criteria}`;
}

function validateVerificationRequirement(requirement: string): void {
  if (/^Record at least one successful (.+) after the final mutation\.?$/iu.test(requirement)) return;
  if (/\b(?:api[_-]?key|authorization|password|secret|token)\s*=/iu.test(requirement)) {
    throw new Error('Verification requirements cannot contain credentials.');
  }
  if (!classifyVerificationCommand(requirement)) {
    throw new Error(`Verification requirement is not a recognized deterministic check: ${requirement}`);
  }
}
