import {randomUUID} from 'node:crypto';
import {ContextEngine} from '../context/context-engine.js';
import {activeMessages, clearOldToolResults, ContextManager} from '../context/manager.js';
import {resolveMentions} from '../context/mentions.js';
import {createProvider, type ModelProvider} from '../providers/index.js';
import {CheckpointStore} from '../checkpoint/store.js';
import {HookRunner} from '../hooks/runner.js';
import {SessionStore, createSession} from '../session/store.js';
import {
  createDefaultToolRegistry,
  evaluatePermission,
  permissionKey,
  ToolRegistry,
  WorkspaceAccess,
} from '../tools/index.js';
import type {
  AgentTool,
  ContextProvider,
  ToolExecutionContext,
} from '../tools/types.js';
import type {
  AgentEvent,
  ChatMessage,
  MosaicConfig,
  ModelResponse,
  PackedContext,
  RunOptions,
  Session,
  SessionAuditEvent,
  ToolCall,
  ToolCategory,
  ToolResult,
} from '../types.js';
import {
  buildRetrievedContext,
  buildSessionStatePrompt,
  buildStableSystemPrompt,
  buildTurnDirective,
} from './prompt.js';
import type {PromptContextProvider} from './prompt-context.js';
import {discoverWorkspaceRules, formatWorkspaceRules} from './rules.js';

export interface AgentRunnerOptions {
  config: MosaicConfig;
  provider?: ModelProvider;
  contextEngine?: ContextProvider;
  toolRegistry?: ToolRegistry;
  sessionStore?: SessionStore;
  checkpointStore?: CheckpointStore;
  session?: Session;
  promptContextProvider?: PromptContextProvider;
  rolePrompt?: string;
  persistSession?: boolean;
  contextManager?: ContextManager;
}

export class AgentRunner {
  readonly config: MosaicConfig;
  readonly provider: ModelProvider;
  readonly contextEngine: ContextProvider;
  readonly tools: ToolRegistry;
  readonly sessionStore: SessionStore;
  readonly checkpointStore: CheckpointStore;
  readonly workspace: WorkspaceAccess;
  readonly hooks: HookRunner;
  readonly session: Session;
  readonly contextManager: ContextManager;
  readonly promptContextProvider: PromptContextProvider | undefined;
  readonly rolePrompt: string;
  readonly persistSession: boolean;
  private running = false;
  private changeSequence = 0;
  private steering: string[] = [];
  private readonly sessionApprovals = new Set<string>();

  constructor(options: AgentRunnerOptions) {
    this.config = options.config;
    this.workspace = new WorkspaceAccess(options.config.workspaceRoots);
    this.provider = options.provider ?? createProvider(options.config.model);
    this.contextEngine = options.contextEngine ?? new ContextEngine(options.config);
    this.tools = options.toolRegistry ?? createDefaultToolRegistry({
      contextEngine: this.contextEngine,
    });
    this.sessionStore = options.sessionStore ?? new SessionStore(this.workspace.primaryRoot);
    this.checkpointStore = options.checkpointStore ?? new CheckpointStore(this.workspace);
    this.hooks = new HookRunner(options.config.hooks, this.workspace);
    this.contextManager = options.contextManager ?? new ContextManager(options.config);
    this.promptContextProvider = options.promptContextProvider;
    this.rolePrompt = options.rolePrompt ?? '';
    this.persistSession = options.persistSession !== false;
    this.session = options.session ?? createSession({
      workspace: this.workspace.primaryRoot,
      model: options.config.model.model,
      provider: options.config.model.provider,
    });
    if (this.session.workspace !== this.workspace.primaryRoot) {
      throw new Error('Session workspace does not match the primary configured root.');
    }
  }

  /** Returns the live session object used by the runner and UI. */
  getSession(): Session {
    return this.session;
  }

  /** Inject a bounded user correction into the next model turn. */
  steer(input: string): boolean {
    const value = input.trim();
    if (!this.running || !value) return false;
    this.steering.push(value.slice(0, 20_000));
    if (this.steering.length > 8) this.steering.splice(0, this.steering.length - 8);
    return true;
  }

  async run(input: string, options: RunOptions = {}): Promise<Session> {
    if (this.running) throw new Error('This AgentRunner is already processing a turn.');
    const request = input.trim();
    if (!request) throw new Error('User input cannot be empty.');
    if (request.length > 120_000) {
      throw new Error('User input is too large; pass a focused request or attach files with @path.');
    }
    this.running = true;
    const emit = async (event: AgentEvent): Promise<void> => {
      await options.onEvent?.(event);
    };
    try {
      throwIfAborted(options.signal);
      if (this.session.messages.length === 0 && this.session.title === 'New session') {
        this.session.title = titleFromInput(request);
      }
      this.contextManager.startTurn(this.session, request);
      this.session.messages.push(message('user', request));
      await this.persist();

      const packed = await this.packContext(request);
      await emit({type: 'context', packed});
      const mentions = await this.packMentions(request);
      const retrievedContext = buildRetrievedContext(
        packed,
        mentions,
        this.workspace.primaryRoot,
        this.workspace.roots,
      );
      const workspaceRules = formatWorkspaceRules(
        await discoverWorkspaceRules(this.workspace.primaryRoot),
      );
      const stableSystemPrompt = buildStableSystemPrompt(this.config, workspaceRules, this.rolePrompt);
      const augmentation = this.promptContextProvider
        ? await this.promptContextProvider.prepare(request, this.session, options.signal)
        : {text: ''};
      if (augmentation.skills?.length) {
        for (const skill of augmentation.skills) {
          await emit({type: 'skill', name: skill.name, description: skill.description});
        }
      }
      if (augmentation.memoryCount) {
        await emit({
          type: 'memory',
          count: augmentation.memoryCount,
          scope: augmentation.memoryScope ?? 'session',
        });
      }
      const turnDirective = buildTurnDirective(request);
      const promptSections = [
        `intent:${turnDirective.intent}`,
        ...(workspaceRules ? ['rules'] : []),
        ...(this.session.workingMemory ? ['working-memory'] : []),
        ...(this.session.contextSummary ? ['session-summary'] : []),
        ...(retrievedContext ? [`code:${packed.engine}`] : []),
        ...(options.turnInstructions ? ['workflow'] : []),
        ...(augmentation.skills?.length ? [`skills:${augmentation.skills.length}`] : []),
        ...(augmentation.memoryCount ? [`memory:${augmentation.memoryCount}`] : []),
      ];
      await emit({
        type: 'prompt',
        intent: turnDirective.intent,
        sections: promptSections,
        estimatedTokens: Math.ceil([
          turnDirective.text,
          buildSessionStatePrompt(this.session),
          this.contextManager.buildShortTermPrompt(this.session),
          options.turnInstructions ?? '',
          augmentation.text,
          retrievedContext,
          workspaceRules,
        ].join('\n').length / 4),
      });
      const changeSequenceAtStart = this.changeSequence;
      let verificationAttempted = false;
      const maxTurns = options.maxTurns ?? this.config.agent.maxTurns;

      const contextBudget = Math.max(24_000, Math.min(100_000, this.config.context.maxTokens * 3));
      if (this.contextManager.shouldCompact(this.session, contextBudget)) {
        const compacted = await this.compactContext(undefined, options.signal);
        await emit({type: 'context_compacted', ...compacted});
      }

      for (let turn = 1; turn <= maxTurns; turn += 1) {
        throwIfAborted(options.signal);
        if (this.session.usage.inputTokens + this.session.usage.outputTokens >=
          this.config.agent.maxSessionTokens) {
          await this.persist();
          await emit({type: 'done', reason: 'token_budget'});
          return this.session;
        }
        this.applySteering();
        await emit({type: 'thinking', turn});
        const messages = packConversation(
          stableSystemPrompt,
          [
            buildSessionStatePrompt(this.session),
            turnDirective.text,
            this.contextManager.buildShortTermPrompt(this.session),
            options.turnInstructions ?? '',
            augmentation.text,
          ]
            .filter(Boolean).join('\n\n'),
          retrievedContext,
          activeMessages(this.session),
          contextBudget,
        );
        const availableTokens = this.config.agent.maxSessionTokens -
          (this.session.usage.inputTokens + this.session.usage.outputTokens);
        const estimatedInputTokens = estimateMessages(messages) + estimateToolDefinitions(
          options.askMode
            ? this.tools.definitions().filter((tool) => tool.category === 'read')
            : this.tools.definitions(),
        );
        if (availableTokens <= 0 || estimatedInputTokens >= availableTokens) {
          await this.persist();
          await emit({type: 'done', reason: 'token_budget'});
          return this.session;
        }
        const maxOutputTokens = Math.max(1, Math.min(
          this.config.model.maxTokens ?? 8_192,
          availableTokens - estimatedInputTokens,
        ));
        const visibleTools = options.askMode
          ? this.tools.definitions().filter((tool) => tool.category === 'read')
          : this.tools.definitions();
        const assistantId = randomUUID();
        const response = await this.completeModel(
          messages,
          visibleTools,
          options.signal,
          maxOutputTokens,
          emit,
          assistantId,
        );
        const assistantMessage = message('assistant', response.content, {
          ...(response.toolCalls.length ? {toolCalls: response.toolCalls} : {}),
        });
        assistantMessage.id = assistantId;
        this.session.messages.push(assistantMessage);
        if (response.content) await emit({type: 'assistant', id: assistantId, content: response.content});
        const inputTokens = response.usage?.inputTokens ?? estimatedInputTokens;
        const outputTokens = response.usage?.outputTokens ?? estimateResponseTokens(response);
        this.session.usage.inputTokens += inputTokens;
        this.session.usage.outputTokens += outputTokens;
        if (inputTokens || outputTokens) {
          await emit({
            type: 'usage',
            inputTokens: this.session.usage.inputTokens,
            outputTokens: this.session.usage.outputTokens,
          });
        }
        await this.persist();

        if (this.session.usage.inputTokens + this.session.usage.outputTokens >=
          this.config.agent.maxSessionTokens) {
          for (const call of response.toolCalls) {
            const skipped = failedResult(call,
              'Tool call skipped because the session token budget was reached.');
            this.session.messages.push(message('tool', skipped.content, {
              toolCallId: skipped.toolCallId,
              name: skipped.name,
            }));
            this.recordToolResult(skipped);
            await emit({type: 'tool_result', result: skipped});
          }
          await this.persist();
          await emit({type: 'done', reason: 'token_budget'});
          return this.session;
        }

        if (response.toolCalls.length) {
          for (const call of response.toolCalls) {
            throwIfAborted(options.signal);
            const result = await this.executeTool(call, options, emit);
            this.session.messages.push(message('tool', result.content, {
              toolCallId: result.toolCallId,
              name: result.name,
            }));
            await this.persist();
          }
          await this.runAfterTurnHook(turn, response.toolCalls, options.signal);
          continue;
        }

        // A steering message can arrive while the provider is finishing a
        // response. Give the next model turn a chance to incorporate it before
        // declaring the run complete.
        if (this.steering.length) continue;

        const hasNewChanges = this.changeSequence > changeSequenceAtStart;
        if (!verificationAttempted && hasNewChanges && this.config.agent.autoVerify &&
          this.config.agent.verifyCommands.length) {
          verificationAttempted = true;
          const verification = await this.runVerification(options, emit);
          this.session.messages.push(message('user',
            `<automatic-verification>\n${verification}\n</automatic-verification>\n` +
            'Review these results, correct any failures if needed, then provide the final answer.',
          ));
          await this.persist();
          await this.runAfterTurnHook(turn, [], options.signal);
          continue;
        }

        await this.runAfterTurnHook(turn, [], options.signal);
        await this.persist();
        await emit({type: 'done', reason: 'completed'});
        return this.session;
      }
      await this.persist();
      await emit({type: 'done', reason: 'max_turns'});
      return this.session;
    } catch (error) {
      const normalized = toError(error);
      if (isAbortError(normalized) || options.signal?.aborted) {
        await this.persist().catch(() => undefined);
        await safeEmit(emit, {type: 'done', reason: 'aborted'});
        return this.session;
      }
      await safeEmit(emit, {type: 'error', error: normalized});
      throw normalized;
    } finally {
      this.running = false;
      this.steering = [];
    }
  }

  private applySteering(): void {
    if (!this.steering.length) return;
    const pending = this.steering.splice(0, this.steering.length);
    for (const input of pending) {
      this.session.messages.push(message(
        'user',
        `[User steering while this run was in progress]\n${input}`,
      ));
    }
  }

  /** Consume a provider stream without persisting partial text as a durable message. */
  private async completeModel(
    messages: ChatMessage[],
    tools: ReturnType<ToolRegistry['definitions']>,
    signal: AbortSignal | undefined,
    maxOutputTokens: number,
    emit: (event: AgentEvent) => Promise<void>,
    assistantId: string,
  ): Promise<ModelResponse> {
    if (!this.provider.stream) {
      return this.provider.complete(messages, tools, signal, maxOutputTokens);
    }
    let content = '';
    let final: ModelResponse | undefined;
    for await (const chunk of this.provider.stream(messages, tools, signal, maxOutputTokens)) {
      if (chunk.type === 'text_delta') {
        if (!chunk.content) continue;
        content += chunk.content;
        await emit({type: 'assistant_delta', id: assistantId, content: chunk.content});
        continue;
      }
      final = chunk.response;
    }
    if (final) return final;
    return {content, toolCalls: []};
  }

  private async executeTool(
    call: ToolCall,
    options: RunOptions,
    emit: (event: AgentEvent) => Promise<void>,
  ): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      const result = failedResult(call, `Unknown tool: ${call.name}`);
      this.recordToolResult(result);
      await emit({type: 'tool_result', result});
      return result;
    }
    let categories: ToolCategory[];
    try {
      categories = uniqueCategories(
        tool.permissionCategories?.(call.arguments) ?? [tool.definition.category],
      );
    } catch (error) {
      const result = failedResult(call, formatToolError(error));
      this.recordToolResult(result, tool.definition.category);
      await emit({type: 'tool_result', result});
      return result;
    }
    for (const category of categories) {
      const allowed = await this.authorize(call, category, options, emit);
      if (!allowed) {
        const result = failedResult(call, `Permission denied for ${category} operation.`);
        this.recordToolResult(result, category);
        await emit({type: 'tool_result', result});
        return result;
      }
    }
    // Persist approvals before a subprocess or mutation starts so an abrupt
    // process exit cannot leave an unaudited operation behind.
    await this.persist();
    throwIfAborted(options.signal);
    await emit({type: 'tool_start', call, category: tool.definition.category});
      const executionContext: ToolExecutionContext = {
      config: this.config,
      workspace: this.workspace,
      session: this.session,
      contextEngine: this.contextEngine,
      emit,
      ...(options.signal ? {signal: options.signal} : {}),
    };
    try {
      let checkpointId: string | undefined;
      if (this.config.agent.checkpointBeforeWrite && categories.includes('write') &&
        tool.affectedPaths) {
        const paths = await tool.affectedPaths(call.arguments, executionContext);
        const checkpoint = await this.checkpointStore.capture(this.session.id, paths, {
          reason: `before ${call.name}`,
          metadata: {toolCallId: call.id, tool: call.name},
        });
        checkpointId = checkpoint?.id;
      }
      const beforeHooks = await this.hooks.run('beforeTool', {
        sessionId: this.session.id,
        call,
      }, options.signal);
      throwIfAborted(options.signal);
      const execution = await tool.execute(call.arguments, executionContext);
      const changedFiles = await this.acceptChangedFiles(execution.changedFiles ?? []);
      const tasksBefore = JSON.stringify(this.session.tasks);
      let afterHookError: Error | undefined;
      let afterHooks: Awaited<ReturnType<HookRunner['run']>> = [];
      try {
        afterHooks = await this.hooks.run('afterTool', {
          sessionId: this.session.id,
          call,
          result: execution,
        }, options.signal);
      } catch (error) {
        afterHookError = toError(error);
      }
      const result: ToolResult = {
        toolCallId: call.id,
        name: call.name,
        ok: execution.ok !== false && !afterHookError,
        content: truncateToolOutput(afterHookError
          ? `${execution.content}\n\nTool succeeded, but afterTool hook failed: ${afterHookError.message}`
          : execution.content),
        metadata: {
          ...(execution.metadata ?? {}),
          ...(changedFiles.length ? {changedFiles} : {}),
          ...(checkpointId ? {checkpointId} : {}),
          ...(beforeHooks.length || afterHooks.length
            ? {hooks: {before: beforeHooks.length, after: afterHooks.length}}
            : {}),
          ...(afterHookError ? {toolSucceeded: true, hookError: afterHookError.message} : {}),
        },
      };
      this.contextManager.recordTool(this.session, call, result);
      if (JSON.stringify(this.session.tasks) !== tasksBefore || call.name === 'task') {
        await emit({type: 'tasks', tasks: this.session.tasks.map((task) => ({...task}))});
      }
      this.recordToolResult(result, tool.definition.category);
      await emit({type: 'tool_result', result});
      return result;
    } catch (error) {
      const result = failedResult(call, formatToolError(error));
      this.recordToolResult(result, tool.definition.category);
      await emit({type: 'tool_result', result});
      return result;
    }
  }

  private async authorize(
    call: ToolCall,
    category: ToolCategory,
    options: RunOptions,
    emit: (event: AgentEvent) => Promise<void>,
  ): Promise<boolean> {
    if (options.askMode === true && category !== 'read') {
      this.recordPermission(call, category, 'deny', 'Ask mode permits read-only tools.');
      return false;
    }
    const decision = evaluatePermission(this.config.permissions, call, category);
    if (decision.outcome === 'allow') {
      this.recordPermission(call, category, 'allow', decision.reason);
      return true;
    }
    if (decision.outcome === 'deny') {
      this.recordPermission(call, category, 'deny', decision.reason);
      return false;
    }
    const approvalKey = permissionKey(call, category);
    if (this.sessionApprovals.has(approvalKey)) {
      this.recordPermission(call, category, 'allow', 'Approved for this session.');
      return true;
    }
    await emit({type: 'permission', call, category});
    if (!options.requestPermission) {
      this.recordPermission(call, category, 'deny', 'No permission handler was available.');
      return false;
    }
    try {
      const grant = await options.requestPermission(call, category);
      const allowed = grant === true || grant === 'session';
      if (grant === 'session') this.sessionApprovals.add(approvalKey);
      this.recordPermission(
        call,
        category,
        allowed ? 'allow' : 'deny',
        grant === 'session'
          ? 'Approved for this session.'
          : allowed
            ? 'Approved once.'
            : 'Denied interactively.',
      );
      return allowed;
    } catch {
      this.recordPermission(call, category, 'deny', 'Permission request failed.');
      return false;
    }
  }

  private recordPermission(
    call: ToolCall,
    category: ToolCategory,
    outcome: 'allow' | 'deny',
    reason: string,
  ): void {
    this.appendAudit({
      type: 'permission',
      toolCallId: call.id,
      tool: call.name,
      category,
      outcome,
      reason,
    });
  }

  private recordToolResult(result: ToolResult, category?: ToolCategory): void {
    this.appendAudit({
      type: 'tool',
      toolCallId: result.toolCallId,
      tool: result.name,
      ...(category ? {category} : {}),
      outcome: result.ok ? 'success' : 'failure',
      ...(!result.ok ? {reason: result.content.slice(0, 500)} : {}),
      ...(result.metadata ? {metadata: result.metadata} : {}),
    });
  }

  private appendAudit(
    event: Omit<SessionAuditEvent, 'id' | 'createdAt'>,
  ): void {
    const audit = this.session.audit ?? (this.session.audit = []);
    audit.push({id: randomUUID(), createdAt: new Date().toISOString(), ...event});
    if (audit.length > 5_000) audit.splice(0, audit.length - 5_000);
  }

  private async acceptChangedFiles(paths: string[]): Promise<string[]> {
    const accepted: string[] = [];
    for (const path of paths) {
      try {
        const safe = await this.workspace.resolvePath(path, {allowMissing: true});
        accepted.push(safe);
        this.changeSequence += 1;
        if (!this.session.changedFiles.includes(safe)) this.session.changedFiles.push(safe);
      } catch {
        throw new Error(`Tool reported an out-of-workspace changed file: ${path}`);
      }
    }
    return accepted;
  }

  private async runVerification(
    options: RunOptions,
    emit: (event: AgentEvent) => Promise<void>,
  ): Promise<string> {
    const results: string[] = [];
    for (const command of this.config.agent.verifyCommands) {
      const call: ToolCall = {
        id: `verify-${randomUUID()}`,
        name: 'shell',
        arguments: {command, cwd: this.workspace.primaryRoot},
      };
      const result = await this.executeTool(call, options, emit);
      results.push(result.content);
    }
    return results.join('\n\n');
  }

  private async runAfterTurnHook(
    turn: number,
    toolCalls: ToolCall[],
    signal?: AbortSignal,
  ): Promise<void> {
    await this.hooks.run('afterTurn', {
      sessionId: this.session.id,
      turn,
      toolCalls: toolCalls.map((call) => ({id: call.id, name: call.name})),
    }, signal);
  }

  private async packContext(input: string): Promise<PackedContext> {
    try {
      return await this.contextEngine.pack(input);
    } catch (error) {
      if (this.config.context.engine === 'contextengine') throw error;
      return {
        text: '',
        hits: [],
        estimatedTokens: 0,
        engine: 'unavailable',
        truncated: false,
      };
    }
  }

  private async packMentions(input: string) {
    try {
      return await resolveMentions(input, this.workspace.roots);
    } catch {
      return [];
    }
  }

  async compactContext(instructions?: string, signal?: AbortSignal) {
    const result = await this.contextManager.compact(
      this.session,
      this.provider,
      signal,
      instructions,
    );
    await this.persist();
    return result;
  }

  getContextStatus() {
    return this.contextManager.status(this.session);
  }

  private persist(): Promise<void> {
    return this.persistSession ? this.sessionStore.save(this.session) : Promise.resolve();
  }
}

function message(
  role: ChatMessage['role'],
  content: string,
  extra: Pick<ChatMessage, 'toolCalls' | 'toolCallId' | 'name'> = {},
): ChatMessage {
  return {
    id: randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

function packConversation(
  systemPrompt: string,
  dynamicPrompt: string,
  retrievedContext: string,
  history: ChatMessage[],
  tokenBudget: number,
): ChatMessage[] {
  const system = message('system', systemPrompt);
  const dynamic = dynamicPrompt ? message('system', dynamicPrompt) : undefined;
  const context = retrievedContext ? message('system', retrievedContext) : undefined;
  const reserved = estimateTokens(system.content) + estimateTokens(dynamic?.content ?? '') +
    estimateTokens(context?.content ?? '');
  const budget = Math.max(4_000, tokenBudget - reserved);
  const groups = groupMessages(clearOldToolResults(history));
  const selected: ChatMessage[][] = [];
  let used = 0;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index] ?? [];
    const cost = group.reduce((sum, item) => sum + estimateTokens(item.content) +
      estimateTokens(JSON.stringify(item.toolCalls ?? [])), 0);
    if (selected.length && used + cost > budget) break;
    selected.unshift(group);
    used += cost;
  }
  const kept = selected.flat();
  const omitted = history.length - kept.length;
  return [
    system,
    ...(dynamic ? [dynamic] : []),
    ...(context ? [context] : []),
    ...(omitted > 0 ? [message('system',
      `${omitted} older persisted messages were omitted from this model call to stay within the context budget.`,
    )] : []),
    ...kept,
  ];
}

function groupMessages(messages: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const current = messages[index] as ChatMessage;
    if (current.role === 'assistant' && current.toolCalls?.length) {
      const ids = new Set(current.toolCalls.map((call) => call.id));
      const group = [current];
      while (index + 1 < messages.length) {
        const next = messages[index + 1] as ChatMessage;
        if (next.role !== 'tool' || !next.toolCallId || !ids.has(next.toolCallId)) break;
        group.push(next);
        index += 1;
      }
      groups.push(group);
    } else {
      groups.push([current]);
    }
  }
  return groups;
}

function estimateTokens(input: string): number {
  return Math.ceil(input.length / 4);
}

function estimateMessages(messages: ChatMessage[]): number {
  return messages.reduce((total, item) => total + estimateTokens(item.content) +
    estimateTokens(JSON.stringify(item.toolCalls ?? [])), 0);
}

function estimateToolDefinitions(tools: {name: string; description: string; inputSchema: Record<string, unknown>}[]): number {
  return estimateTokens(JSON.stringify(tools));
}

function estimateResponseTokens(response: {content: string; toolCalls: ToolCall[]}): number {
  return estimateTokens(response.content) + estimateTokens(JSON.stringify(response.toolCalls));
}

function uniqueCategories(categories: ToolCategory[]): ToolCategory[] {
  return [...new Set(categories)];
}

function failedResult(call: ToolCall, content: string): ToolResult {
  return {
    toolCallId: call.id,
    name: call.name,
    ok: false,
    content: truncateToolOutput(content),
  };
}

function truncateToolOutput(content: string): string {
  // Keep a single tool result below the smallest model context budget. Large
  // command logs otherwise defeat conversation packing and crowd out the task.
  const max = 80_000;
  return content.length <= max ? content : `${content.slice(0, max)}\n… tool output truncated`;
}

function formatToolError(error: unknown): string {
  const normalized = toError(error);
  if (normalized.name === 'ZodError') return `Invalid tool arguments: ${normalized.message}`;
  return normalized.message;
}

function titleFromInput(input: string): string {
  return input.trim().replace(/\s+/g, ' ').slice(0, 80) || 'New session';
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function isAbortError(error: Error): boolean {
  return error.name === 'AbortError' || error.message === 'The operation was aborted';
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function safeEmit(
  emit: (event: AgentEvent) => Promise<void>,
  event: AgentEvent,
): Promise<void> {
  try {
    await emit(event);
  } catch {
    // Avoid masking the original runner failure with a UI event-handler error.
  }
}
