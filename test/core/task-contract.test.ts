import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {createDraftTaskContract} from '../../src/agent/task-contract.js';
import {createDeterministicEvidenceReceipt} from '../../src/agent/completion-gate.js';
import {createSession} from '../../src/session/store.js';
import {taskContractTool} from '../../src/tools/task-contract.js';
import {WorkspaceAccess} from '../../src/tools/workspace.js';
import type {MosaicConfig} from '../../src/types.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

describe('task_contract tool', () => {
  it('does not let a model remove runtime-owned required criteria', async () => {
    const context = await toolContext();
    const contract = context.session.taskContract;
    expect(contract).toBeDefined();

    await expect(taskContractTool.execute({
      action: 'replace',
      objective: 'Make completion easy',
      scope: ['workspace'],
      constraints: [],
      non_goals: [],
      acceptance_criteria: [{description: 'Read one file'}],
      verification_requirements: contract?.verificationRequirements ?? [],
    }, context)).rejects.toThrow('cannot be removed or weakened');
  });

  it('rejects fake checks and replacement after activation', async () => {
    const context = await toolContext();
    const contract = context.session.taskContract;
    expect(contract).toBeDefined();
    const retained = contract?.acceptanceCriteria.map((item) => ({
      id: item.id,
      description: item.description,
      required: item.required,
    })) ?? [];
    await expect(taskContractTool.execute({
      action: 'replace',
      objective: contract?.objective ?? 'objective',
      scope: ['workspace'],
      constraints: [],
      non_goals: [],
      acceptance_criteria: retained,
      verification_requirements: [...(contract?.verificationRequirements ?? []), 'echo ok'],
    }, context)).rejects.toThrow('not a recognized deterministic check');

    await taskContractTool.execute({action: 'activate'}, context);
    await expect(taskContractTool.execute({
      action: 'replace',
      objective: 'Changed after work started',
      scope: ['workspace'],
      constraints: [],
      non_goals: [],
      acceptance_criteria: retained,
      verification_requirements: contract?.verificationRequirements ?? [],
    }, context)).rejects.toThrow('Only a draft');
  });

  it('updates a draft in place and retains its audit boundary', async () => {
    const context = await toolContext();
    const contract = context.session.taskContract;
    expect(contract).toBeDefined();
    if (!contract) throw new Error('Expected a task contract.');
    contract.auditBoundaryId = 'audit-before-contract';

    await taskContractTool.execute({
      action: 'replace',
      objective: contract.objective,
      scope: contract.scope,
      constraints: contract.constraints,
      non_goals: contract.nonGoals,
      acceptance_criteria: contract.acceptanceCriteria.map((item) => ({
        id: item.id, description: item.description, required: item.required,
      })),
      verification_requirements: contract.verificationRequirements,
    }, context);

    expect(context.session.taskContract).toBe(contract);
    expect(contract).toMatchObject({state: 'active', auditBoundaryId: 'audit-before-contract'});
  });

  it('does not allow draft criteria to bypass explicit activation', async () => {
    const context = await toolContext();
    const criterion = context.session.taskContract?.acceptanceCriteria[0];
    expect(criterion).toBeDefined();
    await expect(taskContractTool.execute({
      action: 'update_criterion',
      id: criterion?.id ?? 'missing',
      status: 'satisfied',
      evidence_refs: ['tool-evidence'],
    }, context)).rejects.toThrow('Activate the draft');
    expect(context.session.taskContract?.state).toBe('draft');
  });

  it('accepts a successful content-addressed evidence receipt for one criterion', async () => {
    const context = await toolContext();
    await taskContractTool.execute({action: 'activate'}, context);
    const criterion = context.session.taskContract?.acceptanceCriteria[0];
    if (!criterion) throw new Error('Expected a criterion.');
    const receipt = createDeterministicEvidenceReceipt({
      toolCallId: 'tool-evidence', tool: 'shell', arguments: {command: 'npm test'},
      ok: true, content: 'passed',
    });
    context.session.audit = [{
      id: 'audit-evidence',
      createdAt: new Date(Date.now() + 1_000).toISOString(),
      type: 'tool',
      toolCallId: 'tool-evidence',
      tool: 'shell',
      outcome: 'success',
      metadata: {evidenceReceipt: receipt},
    }];

    await taskContractTool.execute({
      action: 'update_criterion', id: criterion.id, status: 'satisfied', evidence_refs: [receipt.id],
    }, context);

    expect(criterion).toMatchObject({status: 'satisfied', evidenceRefs: [receipt.id]});
  });

  it('rejects a receipt whose content-addressed body was tampered', async () => {
    const context = await toolContext();
    await taskContractTool.execute({action: 'activate'}, context);
    const criterion = context.session.taskContract?.acceptanceCriteria[0];
    if (!criterion) throw new Error('Expected a criterion.');
    const receipt = createDeterministicEvidenceReceipt({
      toolCallId: 'tool-evidence', tool: 'shell', arguments: {command: 'npm test'},
      ok: true, content: 'passed',
    });
    const tampered = {...receipt, inputSha256: 'f'.repeat(64)};
    context.session.audit = [{
      id: 'audit-evidence', createdAt: new Date(Date.now() + 1_000).toISOString(),
      type: 'tool', toolCallId: 'tool-evidence', tool: 'shell', outcome: 'success',
      metadata: {evidenceReceipt: tampered},
    }];

    await expect(taskContractTool.execute({
      action: 'update_criterion', id: criterion.id, status: 'satisfied', evidence_refs: [receipt.id],
    }, context)).rejects.toThrow('Unknown or unsuccessful evidence refs');
  });
});

async function toolContext() {
  const root = await mkdtemp(join(tmpdir(), 'skein-task-contract-'));
  roots.push(root);
  const config: MosaicConfig = {
    model: {provider: 'compatible', model: 'test'},
    workspaceRoots: [root],
    context: {maxTokens: 2_000, topK: 4},
    permissions: {
      read: 'allow', write: 'allow', shell: 'deny', git: 'deny', network: 'deny',
      allowCommands: [], denyCommands: [],
    },
    hooks: {},
    agent: {
      maxTurns: 4, maxSessionTokens: 20_000, autoVerify: false,
      verifyCommands: [], checkpointBeforeWrite: true,
    },
    ui: {color: false, compact: true},
  };
  const session = createSession({workspace: root, model: 'test', provider: 'compatible'});
  session.taskContract = createDraftTaskContract(
    'Refactor several modules, preserve compatibility, add tests, and verify the final behavior.',
  );
  return {config, workspace: new WorkspaceAccess([root]), session};
}
