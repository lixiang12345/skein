import {randomUUID} from 'node:crypto';
import type {Session, TaskContract, TaskContractCriterion} from '../types.js';
import type {TurnIntent} from './prompt.js';
import {deterministicEvidenceReceiptValid} from './evidence-receipt.js';

const EXECUTABLE_INTENTS = new Set<TurnIntent>(['debug', 'refactor', 'test', 'implement']);

export function shouldUseTaskContract(
  request: string,
  intent: TurnIntent,
  existing?: TaskContract,
): boolean {
  if (existing && existing.state !== 'satisfied') return true;
  if (!EXECUTABLE_INTENTS.has(intent)) return false;
  const value = request.trim();
  if (value.length < 180) return false;
  const requirements = value.split(/(?:\n+|[；;。]\s*|\b(?:and|then|also|plus)\b|以及|并且|同时|还要|另外)/iu)
    .filter((item) => item.trim().length >= 12);
  const complexitySignals = [
    /\b(?:refactor|migrate|redesign|architecture|end[- ]to[- ]end|across|multiple)\b/iu,
    /重构|迁移|架构|完整|全链路|多个|跨模块|兼容|同时/iu,
    /(?:^|\n)\s*(?:[-*]|\d+[.)、])\s+/mu,
  ].filter((pattern) => pattern.test(value)).length;
  return requirements.length >= 3 || complexitySignals >= 2 || value.length >= 500;
}

export function createDraftTaskContract(request: string, auditBoundaryId?: string): TaskContract {
  const now = new Date().toISOString();
  const objective = compact(request, 2_000);
  return {
    version: 1,
    state: 'draft',
    objective,
    scope: ['Configured workspace roots and the files required by the objective.'],
    constraints: [
      'Preserve unrelated user changes.',
      'Use successful tool evidence for acceptance claims.',
    ],
    nonGoals: [],
    acceptanceCriteria: [
      criterion('requested-outcome', `Implement the requested outcome: ${compact(request, 500)}`),
      criterion('verification', 'Run the smallest relevant deterministic verification after the final mutation.'),
    ],
    verificationRequirements: [
      'Record at least one successful test, typecheck, lint, build, check, or diff check after the final mutation.',
    ],
    createdAt: now,
    updatedAt: now,
    ...(auditBoundaryId ? {auditBoundaryId} : {}),
  };
}

export function successfulContractEvidence(session: Session): Set<string> {
  const refs = new Set<string>();
  const contract = session.taskContract;
  if (!contract) return refs;
  for (const event of eventsSinceContract(session.audit ?? [], contract)) {
    if (event.type !== 'tool' || event.outcome !== 'success') continue;
    if (event.tool === 'task_contract' || event.tool === 'task' || event.tool === 'working_memory') continue;
    refs.add(event.id);
    refs.add(event.toolCallId);
    const receipt = event.metadata?.evidenceReceipt;
    if (deterministicEvidenceReceiptValid(receipt, {
      toolCallId: event.toolCallId,
      tool: event.tool,
      outcome: 'success',
    })) {
      refs.add(receipt.id);
    }
  }
  return refs;
}

export function eventsSinceContract<T extends {id: string; createdAt: string}>(
  audit: T[],
  contract: TaskContract,
): T[] {
  if (contract.auditBoundaryId) {
    const boundary = audit.findIndex((event) => event.id === contract.auditBoundaryId);
    if (boundary >= 0) return audit.slice(boundary + 1);
  }
  return audit.filter((event) => event.createdAt >= contract.createdAt);
}

export function refreshTaskContractState(contract: TaskContract): void {
  const required = contract.acceptanceCriteria.filter((item) => item.required);
  contract.state = required.some((item) => item.status === 'blocked')
    ? 'blocked'
    : required.length > 0 && required.every((item) => item.status === 'satisfied')
      ? 'satisfied'
      : 'active';
  contract.updatedAt = new Date().toISOString();
}

function criterion(id: string, description: string): TaskContractCriterion {
  return {
    id: `${id}-${randomUUID().slice(0, 8)}`,
    description,
    required: true,
    status: 'pending',
    evidenceRefs: [],
  };
}

function compact(value: string, limit: number): string {
  return value.trim().replace(/\s+/gu, ' ').slice(0, limit);
}
