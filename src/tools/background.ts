import {z} from 'zod';
import type {BackgroundJobsConfig} from '../types.js';
import {BackgroundJobStore, type BackgroundJob} from '../session/background-jobs.js';
import {shellTool} from './shell.js';
import type {AgentTool} from './types.js';
import {jsonSchema} from './types.js';

const startSchema = z.object({
  command: z.string().min(1).max(100_000),
  cwd: z.string().min(1).optional(),
  timeout_ms: z.number().int().min(1_000).optional(),
}).strict();
const listSchema = z.object({}).strict();
const outputSchema = z.object({
  job_id: z.string().uuid(),
  cursor: z.string().regex(/^\d+:\d+$/u).optional(),
  max_bytes: z.number().int().min(256).max(32_000).optional(),
}).strict();
const killSchema = z.object({job_id: z.string().uuid()}).strict();

export function createBackgroundJobTools(config: BackgroundJobsConfig): AgentTool[] {
  const start: AgentTool = {
    definition: {
      name: 'background_start',
      description: 'Start a durable local command only after live human approval. Output is persisted with a quota; mutation tracking remains unresolved.',
      category: 'shell',
      permissionCategories: ['shell', 'git', 'write', 'network'],
      completionEvidence: 'none',
      humanApproval: true,
      inputSchema: jsonSchema({
        command: {type: 'string'},
        cwd: {type: 'string', default: '.'},
        timeout_ms: {type: 'integer', minimum: 1_000, maximum: config.maxRuntimeMs, default: config.maxRuntimeMs},
      }, ['command']),
    },
    permissionCategories(arguments_) {
      const input = startSchema.parse(arguments_);
      return shellTool.permissionCategories?.({command: input.command, cwd: input.cwd ?? '.'}) ?? ['shell'];
    },
    async execute(arguments_, context) {
      const input = startSchema.parse(arguments_);
      const cwd = await context.workspace.resolveDirectory(input.cwd ?? '.');
      const job = await new BackgroundJobStore(context.workspace.primaryRoot, config).start(context.session.id, {
        command: input.command,
        cwd,
        ...(input.timeout_ms !== undefined ? {timeoutMs: input.timeout_ms} : {}),
      });
      return {
        content: `${formatJob(job)}\nUse background_output with cursor 0:0 to read bounded logs; background_kill requires another live human approval.`,
        metadata: {
          backgroundJob: job.id,
          status: job.status,
          commandSha256: job.commandSha256,
          changeTracking: 'unresolved',
          completionEvidence: 'none',
        },
      };
    },
  };

  const list: AgentTool = {
    definition: {
      name: 'background_list',
      description: 'List durable background jobs owned by the current session without exposing command text.',
      category: 'read',
      inputSchema: jsonSchema({}),
    },
    async execute(arguments_, context) {
      listSchema.parse(arguments_);
      const jobs = await new BackgroundJobStore(context.workspace.primaryRoot, config).list(context.session.id);
      return {
        content: jobs.length ? jobs.map(formatJob).join('\n') : 'No background jobs for this session.',
        metadata: {count: jobs.length, active: jobs.filter((job) => isActive(job.status)).length},
      };
    },
  };

  const output: AgentTool = {
    definition: {
      name: 'background_output',
      description: 'Read bounded incremental stdout/stderr for one current-session background job.',
      category: 'read',
      inputSchema: jsonSchema({
        job_id: {type: 'string', format: 'uuid'},
        cursor: {type: 'string', description: 'Opaque stdout:stderr byte cursor returned by the previous read.', default: '0:0'},
        max_bytes: {type: 'integer', minimum: 256, maximum: 32_000, default: 8_000},
      }, ['job_id']),
    },
    async execute(arguments_, context) {
      const input = outputSchema.parse(arguments_);
      const result = await new BackgroundJobStore(context.workspace.primaryRoot, config).output(context.session.id, input.job_id, {
        ...(input.cursor ? {cursor: input.cursor} : {}),
        ...(input.max_bytes ? {maxBytes: input.max_bytes} : {}),
      });
      const sections = [
        formatJob(result.job),
        result.stdout ? `stdout:\n${result.stdout}` : '',
        result.stderr ? `stderr:\n${result.stderr}` : '',
        `next_cursor: ${result.cursor}${result.hasMore ? ' (more available)' : ''}`,
        result.job.truncated ? `Log quota reached; ${result.job.stdoutBytes + result.job.stderrBytes - result.job.retainedBytes} source byte(s) were drained but not retained.` : '',
      ].filter(Boolean);
      return {
        content: sections.join('\n'),
        metadata: {jobId: result.job.id, status: result.job.status, cursor: result.cursor, hasMore: result.hasMore},
      };
    },
  };

  const kill: AgentTool = {
    definition: {
      name: 'background_kill',
      description: 'Request process-tree cancellation for one current-session background job.',
      category: 'shell',
      permissionCategories: ['shell'],
      humanApproval: true,
      inputSchema: jsonSchema({job_id: {type: 'string', format: 'uuid'}}, ['job_id']),
    },
    async execute(arguments_, context) {
      const input = killSchema.parse(arguments_);
      const job = await new BackgroundJobStore(context.workspace.primaryRoot, config).kill(context.session.id, input.job_id);
      return {content: formatJob(job), metadata: {jobId: job.id, status: job.status}};
    },
  };

  return [start, list, output, kill];
}

function formatJob(job: BackgroundJob): string {
  return `Background job ${job.id}  ${job.status}  cwd=${job.cwd}  command_sha256=${job.commandSha256.slice(0, 16)}  output=${job.retainedBytes}/${job.maxLogBytes} bytes`;
}

function isActive(status: BackgroundJob['status']): boolean {
  return status === 'starting' || status === 'running' || status === 'cancel_requested';
}
