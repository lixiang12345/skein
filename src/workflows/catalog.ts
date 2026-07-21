import {z} from 'zod';
import type {AgentTool} from '../tools/types.js';
import {jsonSchema} from '../tools/types.js';

export type WorkflowStepKind = 'retrieve' | 'plan' | 'delegate' | 'implement' | 'review' | 'verify' | 'finalize';

export interface WorkflowStep {
  id: string;
  title: string;
  kind: WorkflowStepKind;
  expert?: string;
  dependsOn: string[];
  readOnly: boolean;
}

export interface WorkflowDefinition {
  name: string;
  description: string;
  steps: WorkflowStep[];
}

export const builtInWorkflows: WorkflowDefinition[] = [
  {
    name: 'implement',
    description: 'Inspect, plan, implement with one writer, review, verify, and finalize.',
    steps: [
      step('retrieve', 'Retrieve relevant code and rules', 'retrieve'),
      step('plan', 'Map the change and risks', 'plan', ['retrieve'], 'architect'),
      step('implement', 'Make the smallest coherent change', 'implement', ['plan'], undefined, false),
      step('review', 'Review correctness and regressions', 'review', ['implement'], 'reviewer'),
      step('verify', 'Run focused tests and checks', 'verify', ['implement'], 'tester'),
      step('finalize', 'Resolve findings and report outcome', 'finalize', ['review', 'verify']),
    ],
  },
  {
    name: 'debug',
    description: 'Reproduce, isolate the causal chain, fix, regression-test, and verify.',
    steps: [
      step('retrieve', 'Collect symptoms, logs, and relevant code', 'retrieve'),
      step('diagnose', 'Find the first incorrect state', 'delegate', ['retrieve'], 'debugger'),
      step('plan', 'Choose the minimal corrective change', 'plan', ['diagnose']),
      step('implement', 'Apply the fix with one writer', 'implement', ['plan'], undefined, false),
      step('verify', 'Add regression coverage and reproduce success', 'verify', ['implement'], 'tester'),
      step('finalize', 'Report cause, fix, and evidence', 'finalize', ['verify']),
    ],
  },
  {
    name: 'review',
    description: 'Parallel correctness, security, and test review followed by a prioritized synthesis.',
    steps: [
      step('retrieve', 'Collect the diff and affected code', 'retrieve'),
      step('correctness', 'Review behavior and regressions', 'delegate', ['retrieve'], 'reviewer'),
      step('security', 'Audit trust boundaries and abuse cases', 'delegate', ['retrieve'], 'security'),
      step('tests', 'Assess verification and missing cases', 'delegate', ['retrieve'], 'tester'),
      step('finalize', 'Deduplicate and prioritize findings', 'finalize', ['correctness', 'security', 'tests']),
    ],
  },
  {
    name: 'refactor',
    description: 'Map contracts, stage a behavior-preserving refactor, review, and verify.',
    steps: [
      step('retrieve', 'Map callers, contracts, and tests', 'retrieve'),
      step('plan', 'Design staged ownership-safe changes', 'plan', ['retrieve'], 'architect'),
      step('implement', 'Refactor in small verifiable increments', 'implement', ['plan'], undefined, false),
      step('review', 'Check behavior preservation and complexity', 'review', ['implement'], 'reviewer'),
      step('verify', 'Run regression and boundary tests', 'verify', ['implement'], 'tester'),
      step('finalize', 'Resolve findings and summarize tradeoffs', 'finalize', ['review', 'verify']),
    ],
  },
];

export class WorkflowCatalog {
  private readonly workflows = new Map(builtInWorkflows.map((workflow) => [workflow.name, workflow]));

  list(): WorkflowDefinition[] {
    return [...this.workflows.values()].map(cloneWorkflow);
  }

  get(name: string): WorkflowDefinition | undefined {
    const workflow = this.workflows.get(name);
    return workflow ? cloneWorkflow(workflow) : undefined;
  }

  prompt(name: string, task: string): string {
    const workflow = this.get(name);
    if (!workflow) throw new Error(`Unknown workflow: ${name}`);
    const steps = workflow.steps.map((item) =>
      `- ${item.id}: ${item.title}${item.expert ? ` [expert=${item.expert}]` : ''}${item.dependsOn.length ? ` [after=${item.dependsOn.join(',')}]` : ''}${item.readOnly ? ' [read-only]' : ' [single-writer]'}`,
    ).join('\n');
    return `<workflow name="${workflow.name}">
Objective: ${task}

Execute this typed workflow and keep the visible task plan synchronized:
${steps}

Rules:
- Parallelize only independent read-only expert steps through delegate.
- Keep all workspace mutation in the main agent so there is a single writer.
- Do not skip verification or unresolved high-severity findings.
- Preserve permission prompts, checkpoints, and workspace boundaries.
</workflow>`;
  }
}

export function createWorkflowTool(catalog: WorkflowCatalog): AgentTool {
  return {
    definition: {
      name: 'workflow_plan',
      description: 'Load a built-in typed workflow for implementation, debugging, review, or refactoring.',
      category: 'read',
      inputSchema: jsonSchema({
        name: {type: 'string', enum: catalog.list().map((workflow) => workflow.name)},
        task: {type: 'string'},
      }, ['name', 'task']),
    },
    async execute(arguments_) {
      const input = z.object({name: z.string(), task: z.string().min(1).max(20_000)}).parse(arguments_);
      const workflow = catalog.get(input.name);
      if (!workflow) return {ok: false, content: `Unknown workflow: ${input.name}`};
      return {
        content: catalog.prompt(input.name, input.task),
        metadata: {workflow: workflow.name, steps: workflow.steps.length},
      };
    },
  };
}

function step(
  id: string,
  title: string,
  kind: WorkflowStepKind,
  dependsOn: string[] = [],
  expert?: string,
  readOnly = true,
): WorkflowStep {
  return {id, title, kind, dependsOn, ...(expert ? {expert} : {}), readOnly};
}

function cloneWorkflow(workflow: WorkflowDefinition): WorkflowDefinition {
  return {...workflow, steps: workflow.steps.map((item) => ({...item, dependsOn: [...item.dependsOn]}))};
}
