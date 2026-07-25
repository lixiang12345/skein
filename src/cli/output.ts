import {createInterface} from 'node:readline/promises';
import chalk, {Chalk} from 'chalk';
import type {
  AgentEvent,
  ConnectionRuntimeInfo,
  PackedContext,
  RunCompletion,
  Session,
  SessionTokenUsage,
  ToolCall,
  ToolCategory,
  ToolResult,
} from '../types.js';
import {PRODUCT_NAME} from '../brand.js';
import {resolveCliGlyphs, type CliGlyphs} from './glyphs.js';
import {
  resolveHeadlessOutcome,
  type HeadlessOutcome,
} from './headless-contract.js';

export type OutputFormat = 'text' | 'json' | 'stream-json';

export interface ReporterOptions {
  format: OutputFormat;
  quiet?: boolean;
  compact?: boolean;
  color?: boolean;
  /** Runtime-only, already-redacted connection selection facts. */
  connection?: ConnectionRuntimeInfo;
}

export class HeadlessReporter {
  private finalResponse = '';
  private readonly tools: ToolResult[] = [];
  private context: Omit<PackedContext, 'text' | 'hits'> & {hits: number} | undefined;
  private streamedAssistant = false;
  private completion: RunCompletion | undefined;
  private doneReason: string | undefined;
  private readonly paint: typeof chalk;
  private readonly glyphs: CliGlyphs;

  constructor(private readonly options: ReporterOptions) {
    this.paint = options.color === false ? new Chalk({level: 0}) : chalk;
    this.glyphs = resolveCliGlyphs();
  }

  onEvent = (event: AgentEvent): void => {
    if (event.type === 'assistant') this.finalResponse = event.content;
    if (event.type === 'tool_result') this.tools.push(event.result);
    if (event.type === 'done') {
      this.doneReason = event.reason;
      this.completion = event.completion;
    }
    if (event.type === 'context') {
      const {text: _text, hits, ...context} = event.packed;
      this.context = {...context, hits: hits.length};
    }
    if (this.options.format === 'json') return;
    if (this.options.format === 'stream-json') {
      process.stdout.write(`${JSON.stringify(eventToJson(event))}\n`);
      return;
    }
    this.printText(event);
  };

  finish(session: Session): HeadlessOutcome {
    const completion = this.completion ?? session.lastRun;
    const reason = this.doneReason ?? session.lastRun?.reason;
    const outcome = resolveHeadlessOutcome({
      ...(reason ? {reason} : {}),
      ...(completion ? {completion} : {}),
    });
    if (this.options.format === 'stream-json') {
      process.stdout.write(`${JSON.stringify({
        type: 'session',
        ...outcome,
        ...(this.options.connection ? {connection: this.options.connection} : {}),
        session: sessionSummary(session),
      })}\n`);
      return outcome;
    }
    if (this.options.format === 'json') {
      process.stdout.write(`${JSON.stringify({
        type: 'result',
        ...outcome,
        ...(this.options.connection ? {connection: this.options.connection} : {}),
        response: this.finalResponse,
        session: sessionSummary(session),
        ...(completion ? {completion} : {}),
        ...(this.context ? {context: this.context} : {}),
        tools: this.tools,
      }, null, 2)}\n`);
      return outcome;
    }
    if (this.options.quiet && this.finalResponse.trim()) {
      process.stdout.write(`${this.finalResponse.trim()}\n`);
    }
    if (!this.options.quiet && !this.options.compact) {
      const usage = session.usage.inputTokens + session.usage.outputTokens;
      const usageLabel = tokenUsageLabel(session.usage);
      process.stderr.write(this.paint.dim(
        `\n${this.glyphs.meta} ${session.changedFiles.length} changed files ${this.glyphs.separator} ${usage.toLocaleString()} tokens (${usageLabel}) ${this.glyphs.separator} session ${session.id.slice(0, 8)}\n`,
      ));
      if (this.options.connection) {
        const connection = this.options.connection;
        process.stderr.write(this.paint.dim(
          `${this.glyphs.meta} connection @${connection.id} ${this.glyphs.separator} ${connection.protocol} ${this.glyphs.separator} ${connection.source} ${this.glyphs.separator} ${connection.authType}/${connection.authStatus} ${this.glyphs.separator} inference ${connection.endpoint} ${this.glyphs.separator} models ${connection.modelsEndpoint}\n`,
        ));
      }
    }
    return outcome;
  }

  fail(error: unknown, session?: Session): HeadlessOutcome {
    const message = error instanceof Error ? error.message : String(error);
    const outcome = resolveHeadlessOutcome({reason: 'error', error});
    if (this.options.format === 'stream-json') {
      process.stdout.write(`${JSON.stringify({
        type: 'final',
        ...outcome,
        error: message,
        ...(this.options.connection ? {connection: this.options.connection} : {}),
        ...(session ? {session: sessionSummary(session)} : {}),
      })}\n`);
      return outcome;
    }
    if (this.options.format === 'json') {
      process.stdout.write(`${JSON.stringify({
        type: 'result',
        ...outcome,
        error: message,
        ...(this.options.connection ? {connection: this.options.connection} : {}),
        ...(session ? {session: sessionSummary(session)} : {}),
      }, null, 2)}\n`);
      return outcome;
    }
    process.stderr.write(`${this.paint.red(this.glyphs.error)} ${message}\n`);
    return outcome;
  }

  private printText(event: AgentEvent): void {
    const {quiet, compact} = this.options;
    if (quiet && event.type !== 'needs_input') return;
    switch (event.type) {
      case 'thinking':
        if (!compact) process.stderr.write(this.paint.dim(`${this.glyphs.meta} reasoning ${this.glyphs.separator} turn ${event.turn}\n`));
        break;
      case 'context':
        {
          const budget = event.packed.budgetTokens === undefined
            ? ''
            : ` ${this.glyphs.separator} ${event.packed.budgetTier ?? 'adaptive'} ${event.packed.budgetTokens} budget`;
        process.stderr.write(this.paint.cyan(
          `${this.glyphs.meta} context ${this.glyphs.separator} ${event.packed.engine} ${this.glyphs.separator} ${event.packed.hits.length} spans ${this.glyphs.separator} ~${event.packed.estimatedTokens} tokens${budget}${event.packed.degradation ? ` ${this.glyphs.separator} ${event.packed.degradation.summary}` : ''}\n`,
        ));
        break;
        }
      case 'prompt':
        if (!compact) {
          const partition = event.breakdown
            ? ` ${this.glyphs.separator} stable ${event.breakdown.stableTokens} ${this.glyphs.separator} dynamic ${event.breakdown.dynamicTokens} ${this.glyphs.separator} history ${event.breakdown.conversationTokens} ${this.glyphs.separator} tool results ${event.breakdown.toolResultTokens} ${this.glyphs.separator} retrieved ${event.breakdown.retrievedTokens} ${this.glyphs.separator} tools ${event.breakdown.toolSchemaTokens} ${this.glyphs.separator} output cap ${event.breakdown.outputAllowanceTokens}`
            : '';
          process.stderr.write(this.paint.dim(
            `${this.glyphs.meta} prompt ${this.glyphs.separator} ${event.intent} ${this.glyphs.separator} ~${event.estimatedTokens} estimated tokens${partition}\n`,
          ));
        }
        break;
      case 'tool_start':
        process.stderr.write(
          `${this.paint.yellow(this.glyphs.running)} ${event.call.name}${formatToolDetail(event.call, this.paint, this.glyphs)}\n`,
        );
        break;
      case 'tool_result':
        process.stderr.write(
          `${event.result.ok ? this.paint.green(this.glyphs.success) : this.paint.red(this.glyphs.error)} ${event.result.name}${formatResultDetail(event.result, this.paint, this.glyphs)}\n`,
        );
        break;
      case 'assistant_delta':
        if (!quiet && event.content) {
          process.stdout.write(event.content);
          this.streamedAssistant = true;
        }
        break;
      case 'assistant':
        if (this.streamedAssistant) {
          process.stdout.write('\n');
          this.streamedAssistant = false;
        } else {
          process.stdout.write(`${event.content.trim()}\n`);
        }
        break;
      case 'tasks':
        if (!compact) {
          const completed = event.tasks.filter((task) => task.status === 'completed').length;
          process.stderr.write(this.paint.dim(`${this.glyphs.meta} plan ${this.glyphs.separator} ${completed}/${event.tasks.length} complete\n`));
        }
        break;
      case 'contract': {
        const required = event.contract.acceptanceCriteria.filter((item) => item.required);
        const satisfied = required
          .filter((item) => item.status === 'satisfied').length;
        process.stderr.write(this.paint.dim(
          `${this.glyphs.meta} contract ${this.glyphs.separator} ${event.contract.state} ${this.glyphs.separator} ${satisfied}/${required.length} accepted\n`,
        ));
        break;
      }
      case 'writer_lane': {
        const writerSymbol = event.status === 'ready' || event.status === 'integrated'
          ? this.paint.green(this.glyphs.success)
          : event.status === 'needs_review'
            ? this.paint.yellow(this.glyphs.warning)
            : this.paint.red(this.glyphs.error);
        process.stderr.write(
          `${writerSymbol} writer ${event.id.slice(0, 8)} ${this.glyphs.separator} ${event.status} ${this.glyphs.separator} ${event.detail}\n`,
        );
        break;
      }
      case 'needs_input':
        process.stderr.write(this.paint.yellow(`${this.glyphs.meta} ${event.pending.question}\n`));
        event.pending.options.forEach((option, index) => {
          process.stderr.write(this.paint.dim(
            `  ${index + 1}. ${option.label}${option.recommended ? ' (recommended)' : ''} ${this.glyphs.separator} ${option.impact}\n`,
          ));
        });
        break;
      case 'input_resolved':
        process.stderr.write(this.paint.dim(
          `${this.glyphs.meta} clarification resolved ${this.glyphs.separator} ${event.answer}\n`,
        ));
        break;
      case 'usage':
      case 'permission':
      case 'skill':
      case 'memory':
      case 'agent_queued':
      case 'agent_start':
      case 'agent_cancelled':
      case 'agent_done':
      case 'workflow':
      case 'context_compacted':
      case 'context_epoch':
      case 'intent':
        break;
      case 'done':
        this.printCompletion(event.completion);
        this.printStopReason(event.reason);
        break;
      case 'error':
        // The caller prints the terminal error after the runner unwinds. This
        // avoids duplicate text while stream-json still receives the event.
        break;
    }
  }

  private printCompletion(completion?: RunCompletion): void {
    if (!completion || completion.status === 'no_changes') return;
    const checks = completion.checks.map((check) => check.command).join(', ');
    const suffix = checks ? ` ${this.glyphs.separator} ${checks}` : '';
    const duplication = completion.duplication;
    const duplicateSuffix = duplication
      ? ` ${this.glyphs.separator} duplication ${duplication.status} (${duplication.warningCount} warning, ${duplication.unresolvedCount} incomplete, ${duplication.suppressedCount} suppressed)`
      : '';
    if (completion.status === 'verified') {
      process.stderr.write(this.paint.green(
        `${this.glyphs.success} verified ${this.glyphs.separator} ${completion.detail}${suffix}${duplicateSuffix}\n`,
      ));
      return;
    }
    if (completion.status === 'verification_failed') {
      process.stderr.write(this.paint.red(
        `${this.glyphs.error} verification failed ${this.glyphs.separator} ${completion.detail}${suffix}${duplicateSuffix}\n`,
      ));
      return;
    }
    process.stderr.write(this.paint.yellow(
      `${this.glyphs.warning} unverified ${this.glyphs.separator} ${completion.detail}${duplicateSuffix}\n`,
    ));
  }

  private printStopReason(reason: string): void {
    if (reason === 'aborted') {
      process.stderr.write(this.paint.yellow(`${this.glyphs.warning} cancelled ${this.glyphs.separator} resume with --resume after inspecting the saved session\n`));
    } else if (reason === 'max_turns') {
      process.stderr.write(this.paint.yellow(`${this.glyphs.warning} turn limit reached ${this.glyphs.separator} resume with --resume and a larger --max-turns value\n`));
    } else if (reason === 'token_budget') {
      process.stderr.write(this.paint.yellow(`${this.glyphs.warning} token budget reached ${this.glyphs.separator} inspect the saved session before resuming with a larger --token-budget\n`));
    } else if (reason === 'needs_review') {
      process.stderr.write(this.paint.yellow(`${this.glyphs.warning} needs review ${this.glyphs.separator} a live human decision is required before the pending action can continue\n`));
    }
  }
}

export async function askConsolePermission(
  call: ToolCall,
  category: ToolCategory,
  color = !process.env.NO_COLOR,
  reason = `${category} tools require approval.`,
): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return false;
  const paint = color ? chalk : new Chalk({level: 0});
  const glyphs = resolveCliGlyphs();
  process.stderr.write(`\n${paint.yellow('Permission required')} ${paint.dim(`(${category})`)}\n`);
  process.stderr.write(`${paint.bold(call.name)}${formatToolDetail(call, paint)}\n`);
  process.stderr.write(`${paint.dim(`Reason: ${reason}`)}\n`);
  process.stderr.write(`${paint.yellow(`Risk: ${permissionRisk(category)}`)}\n`);
  const readline = createInterface({input: process.stdin, output: process.stderr});
  try {
    const answer = await readline.question(`${paint.green('[y]')} allow once  ${paint.red('[n]')} deny ${glyphs.prompt} `);
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}

function permissionRisk(category: ToolCategory): string {
  if (category === 'read') return 'workspace content may enter model context';
  if (category === 'write') return 'workspace files may be created, replaced, or deleted';
  if (category === 'shell') return 'a local process may read or change workspace state';
  if (category === 'git') return 'repository state or remotes may change';
  return 'data may leave this machine or remote state may change';
}

export function printBanner(): void {
  const glyphs = resolveCliGlyphs();
  process.stdout.write(
    `${chalk.hex('#6EE7D0').bold(`${glyphs.brand} ${PRODUCT_NAME.toUpperCase()}`)} ${chalk.dim('context-first coding agent')}\n`,
  );
}

function eventToJson(event: AgentEvent): Record<string, unknown> {
  if (event.type === 'error') {
    return {type: event.type, error: event.error.message};
  }
  return event as unknown as Record<string, unknown>;
}

function sessionSummary(session: Session): Record<string, unknown> {
  return {
    id: session.id,
    title: session.title,
    workspace: session.workspace,
    provider: session.provider,
    model: session.model,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    tasks: session.tasks,
    ...(session.taskContract ? {taskContract: session.taskContract} : {}),
    changedFiles: session.changedFiles,
    ...(session.lastRun ? {lastRun: session.lastRun} : {}),
    ...(session.tokenLedger?.length ? {tokenLedger: session.tokenLedger} : {}),
    ...(session.contextCompactionReceipts?.length
      ? {contextCompactionReceipts: session.contextCompactionReceipts}
      : {}),
    ...(session.contextEpochs?.length ? {contextEpochs: session.contextEpochs} : {}),
    ...(session.intentAssessment ? {intentAssessment: session.intentAssessment} : {}),
    ...(session.pendingInput ? {pendingInput: session.pendingInput} : {}),
    usage: session.usage,
  };
}

export function tokenUsageLabel(usage: SessionTokenUsage): string {
  if (usage.source) return usage.source;
  return usage.inputTokens + usage.outputTokens > 0 ? 'unknown source' : 'no usage';
}

function formatToolDetail(call: ToolCall, paint: typeof chalk = chalk, glyphs = resolveCliGlyphs()): string {
  const environment = call.name === 'shell' && typeof call.arguments.env === 'object' &&
    call.arguments.env !== null && !Array.isArray(call.arguments.env)
    ? Object.keys(call.arguments.env).sort()
    : [];
  const environmentDetail = environment.length ? ` ${glyphs.separator} env ${environment.join(', ')}` : '';
  const candidate = ['path', 'query', 'command', 'pattern', 'title']
    .map((key) => call.arguments[key])
    .find((value) => typeof value === 'string');
  if (typeof candidate !== 'string' || !candidate.trim()) {
    return environmentDetail ? paint.dim(environmentDetail) : '';
  }
  const clean = candidate.trim().replace(/\s+/g, ' ');
  const command = clean.length > 90 ? `${clean.slice(0, 87)}${glyphs.ellipsis}` : clean;
  return paint.dim(` ${glyphs.separator} ${command}${environmentDetail}`);
}

function formatResultDetail(result: ToolResult, paint: typeof chalk = chalk, glyphs = resolveCliGlyphs()): string {
  if (!result.ok) {
    const clean = result.content.trim().replace(/\s+/g, ' ');
    return paint.red(` ${glyphs.separator} ${clean.slice(0, 120)}`);
  }
  const changed = result.metadata?.changedFiles;
  if (Array.isArray(changed)) return paint.dim(` ${glyphs.separator} ${changed.length} files`);
  return '';
}
