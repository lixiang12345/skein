import {createInterface} from 'node:readline/promises';
import chalk, {Chalk} from 'chalk';
import type {
  AgentEvent,
  Session,
  ToolCall,
  ToolCategory,
  ToolResult,
} from '../types.js';
import {PRODUCT_NAME} from '../brand.js';
import {resolveCliGlyphs, type CliGlyphs} from './glyphs.js';

export type OutputFormat = 'text' | 'json' | 'stream-json';

export interface ReporterOptions {
  format: OutputFormat;
  quiet?: boolean;
  compact?: boolean;
  color?: boolean;
}

export class HeadlessReporter {
  private finalResponse = '';
  private readonly tools: ToolResult[] = [];
  private eventError?: string;
  private streamedAssistant = false;
  private readonly paint: typeof chalk;
  private readonly glyphs: CliGlyphs;

  constructor(private readonly options: ReporterOptions) {
    this.paint = options.color === false ? new Chalk({level: 0}) : chalk;
    this.glyphs = resolveCliGlyphs();
  }

  onEvent = (event: AgentEvent): void => {
    if (event.type === 'assistant') this.finalResponse = event.content;
    if (event.type === 'tool_result') this.tools.push(event.result);
    if (event.type === 'error') this.eventError = event.error.message;
    if (this.options.format === 'json') return;
    if (this.options.format === 'stream-json') {
      process.stdout.write(`${JSON.stringify(eventToJson(event))}\n`);
      return;
    }
    this.printText(event);
  };

  finish(session: Session): void {
    if (this.options.format === 'stream-json') {
      process.stdout.write(`${JSON.stringify({
        type: 'session',
        session: sessionSummary(session),
      })}\n`);
      return;
    }
    if (this.options.format === 'json') {
      process.stdout.write(`${JSON.stringify({
        ok: true,
        response: this.finalResponse,
        session: sessionSummary(session),
        tools: this.tools,
      }, null, 2)}\n`);
      return;
    }
    if (this.options.quiet && this.finalResponse.trim()) {
      process.stdout.write(`${this.finalResponse.trim()}\n`);
    }
    if (!this.options.quiet && !this.options.compact) {
      const usage = session.usage.inputTokens + session.usage.outputTokens;
      process.stderr.write(this.paint.dim(
        `\n${this.glyphs.meta} ${session.changedFiles.length} changed files ${this.glyphs.separator} ${usage.toLocaleString()} tokens ${this.glyphs.separator} session ${session.id.slice(0, 8)}\n`,
      ));
    }
  }

  fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (this.options.format === 'stream-json' && this.eventError === message) return;
    if (this.options.format === 'json' || this.options.format === 'stream-json') {
      process.stdout.write(`${JSON.stringify({type: 'error', ok: false, error: message})}\n`);
      return;
    }
    process.stderr.write(`${this.paint.red(this.glyphs.error)} ${message}\n`);
  }

  private printText(event: AgentEvent): void {
    const {quiet, compact} = this.options;
    if (quiet) return;
    switch (event.type) {
      case 'thinking':
        if (!compact) process.stderr.write(this.paint.dim(`${this.glyphs.meta} reasoning ${this.glyphs.separator} turn ${event.turn}\n`));
        break;
      case 'context':
        process.stderr.write(this.paint.cyan(
          `${this.glyphs.meta} context ${this.glyphs.separator} ${event.packed.engine} ${this.glyphs.separator} ${event.packed.hits.length} spans ${this.glyphs.separator} ~${event.packed.estimatedTokens} tokens\n`,
        ));
        break;
      case 'prompt':
        if (!compact) {
          process.stderr.write(this.paint.dim(
            `${this.glyphs.meta} prompt ${this.glyphs.separator} ${event.intent} ${this.glyphs.separator} ${event.sections.join(' + ')} ${this.glyphs.separator} ~${event.estimatedTokens} tokens\n`,
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
      case 'usage':
      case 'permission':
      case 'skill':
      case 'memory':
      case 'agent_start':
      case 'agent_done':
      case 'workflow':
      case 'context_compacted':
      case 'done':
        break;
      case 'error':
        // The caller prints the terminal error after the runner unwinds. This
        // avoids duplicate text while stream-json still receives the event.
        break;
    }
  }
}

export async function askConsolePermission(
  call: ToolCall,
  category: ToolCategory,
  color = !process.env.NO_COLOR,
): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return false;
  const paint = color ? chalk : new Chalk({level: 0});
  const glyphs = resolveCliGlyphs();
  process.stderr.write(`\n${paint.yellow('Permission required')} ${paint.dim(`(${category})`)}\n`);
  process.stderr.write(`${paint.bold(call.name)}${formatToolDetail(call, paint)}\n`);
  const readline = createInterface({input: process.stdin, output: process.stderr});
  try {
    const answer = await readline.question(`${paint.green('[y]')} allow once  ${paint.red('[n]')} deny ${glyphs.prompt} `);
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}

export function printBanner(): void {
  const glyphs = resolveCliGlyphs();
  process.stdout.write(
    `${chalk.hex('#A78BFA').bold(`${glyphs.brand} ${PRODUCT_NAME.toUpperCase()}`)} ${chalk.dim('context-first coding agent')}\n`,
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
    changedFiles: session.changedFiles,
    usage: session.usage,
  };
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
