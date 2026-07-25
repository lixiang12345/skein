import {randomUUID} from 'node:crypto';
import {ContextEngine} from '../context/context-engine.js';
import {activeMessages, clearOldToolResults, ContextManager} from '../context/manager.js';
import {resolveMentions} from '../context/mentions.js';
import {emptyPackedContext, selectContextBudget} from '../context/budget.js';
import {createProvider, type ModelProvider} from '../providers/index.js';
import {CheckpointStore} from '../checkpoint/store.js';
import {HookRunner} from '../hooks/runner.js';
import {SessionStore, createSession} from '../session/store.js';
import {ToolArtifactStore} from '../session/tool-artifacts.js';
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
  RunCompletion,
  ContextSource,
  MosaicConfig,
  ModelResponse,
  PackedContext,
  PromptTokenBreakdown,
  RunOptions,
  Session,
  SessionAuditEvent,
  TokenLedgerEntry,
  ToolCall,
  ToolCategory,
  ToolResult,
  ToolFailureReceipt,
  ToolArtifactReference,
  TaskContract,
  TokenMeasurementSource,
} from '../types.js';
import {estimateTokens} from '../utils/tokens.js';
import {
  buildRetrievedContext,
  buildSessionStatePrompt,
  buildStableSystemPrompt,
  buildTurnDirective,
  isTrivialTurn,
} from './prompt.js';
import {
  buildRunCompletion,
  captureVerification,
  completionRecoveryDirective,
  verificationDiagnosticPaths,
  type CapturedVerification,
} from './completion-gate.js';
import {
  createDraftTaskContract,
  shouldUseTaskContract,
} from './task-contract.js';
import {
  classifyToolFailure,
  formatFailureReceipt,
  ToolRecoveryController,
} from './tool-recovery.js';
import {dynamicToolOutputBudget, protectToolOutput} from './tool-output.js';
import type {PromptContextProvider} from './prompt-context.js';
import {discoverWorkspaceRules, formatWorkspaceRules} from './rules.js';
import {
  formatPinnedContext,
  pinContextSource,
  resolvePinnedContent,
  toggleMuteContextSource,
  unpinContextSource,
} from '../context/context-sources.js';
import {evaluateReuseGate} from './reuse-gate.js';
import {auditChangedFunctions} from './duplication-audit.js';
import {
  activeDuplicationMatchIds,
  buildDuplicationCompletion,
  hasDuplicationActivity,
} from './duplication-state.js';

export interface AgentRunnerOptions {
  config: MosaicConfig;
  provider?: ModelProvider;
  contextEngine?: ContextProvider;
  toolRegistry?: ToolRegistry;
  sessionStore?: SessionStore;
  toolArtifactStore?: ToolArtifactStore;
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
  readonly toolArtifactStore: ToolArtifactStore;
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
  private activeReuseGate: {requestId: string; request: string; attempted: boolean} | undefined;

  constructor(options: AgentRunnerOptions) {
    this.config = options.config;
    this.workspace = new WorkspaceAccess(options.config.workspaceRoots);
    this.provider = options.provider ?? createProvider(options.config.model);
    this.contextEngine = options.contextEngine ?? new ContextEngine(options.config);
    this.tools = options.toolRegistry ?? createDefaultToolRegistry({
      contextEngine: this.contextEngine,
    });
    this.sessionStore = options.sessionStore ?? new SessionStore(this.workspace.primaryRoot);
    this.toolArtifactStore = options.toolArtifactStore ?? new ToolArtifactStore(this.workspace.primaryRoot);
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
    this.contextEngine.resetDiagnostics?.();
    const emit = async (event: AgentEvent): Promise<void> => {
      await options.onEvent?.(event);
    };
    const changeSequenceAtStart = this.changeSequence;
    const runStartedAt = new Date().toISOString();
    const loadedProgressiveTools = new Set<string>();
    const runChangedFiles = new Set<string>();
    const verificationEvidence: CapturedVerification[] = [];
    const toolRecovery = new ToolRecoveryController();
    let activeRunContract: TaskContract | undefined = this.session.taskContract;
    let mutationTracking: 'complete' | 'unknown' = 'complete';
    let completionRecoveryAttempted = false;
    const recordExecution = (call: ToolCall, result: ToolResult): void => {
      const changedFiles = result.metadata?.changedFiles;
      if (Array.isArray(changedFiles)) {
        for (const path of changedFiles) {
          if (typeof path === 'string') runChangedFiles.add(path);
        }
      }
      if (result.metadata?.changeTracking === 'unresolved') mutationTracking = 'unknown';
      const evidence = captureVerification(
        call,
        result,
        this.changeSequence,
        this.config.agent.verifyCommands,
      );
      if (evidence) {
        verificationEvidence.push(evidence);
        this.contextEngine.recordDiagnostics?.({
          commandKey: evidence.commandKey,
          paths: verificationDiagnosticPaths(result, this.workspace.roots),
        });
      }
    };
    const completionReport = (): RunCompletion => {
      const completion = buildRunCompletion(
        runChangedFiles,
        verificationEvidence,
        this.changeSequence,
        mutationTracking,
        activeRunContract,
        this.session.audit ?? [],
        hasDuplicationActivity(this.session.audit ?? [], runStartedAt)
          ? buildDuplicationCompletion(
            this.session.audit ?? [],
            this.session.duplicationSuppressions ?? [],
          )
          : undefined,
      );
      if (completion.acceptance && activeRunContract && activeRunContract.state !== 'draft') {
        activeRunContract.state = completion.acceptance.state;
        activeRunContract.updatedAt = new Date().toISOString();
      }
      return completion;
    };
    const finishRun = async (reason: string, completion = completionReport()): Promise<Session> => {
      this.session.lastRun = {
        ...completion,
        reason,
        finishedAt: new Date().toISOString(),
      };
      await this.persist();
      const finalContract = activeRunContract && structuredClone(activeRunContract);
      if (finalContract && finalContract.state !== 'satisfied') {
        await emit({type: 'contract', contract: finalContract});
      }
      await emit({type: 'done', reason, completion});
      return this.session;
    };
    try {
      throwIfAborted(options.signal);
      await this.reconcileToolArtifacts();
      if (this.session.messages.length === 0 && this.session.title === 'New session') {
        this.session.title = titleFromInput(request);
      }
      this.contextManager.startTurn(this.session, request);
      const userMessage = message('user', request);
      this.activeReuseGate = {requestId: userMessage.id, request, attempted: false};
      this.session.messages.push(userMessage);
      await this.persist();

      // Greetings, acknowledgements, and connectivity checks carry no task.
      // Suppress the retrieval + prompt telemetry so a plain "hi" stays quiet
      // instead of dumping a dense context panel and degradation warning.
      const trivialTurn = isTrivialTurn(request);
      const turnDirective = buildTurnDirective(request, {
        agents: Boolean(this.config.agents?.enabled),
      });
      const packed = trivialTurn
        ? emptyPackedContext(selectContextBudget(request, this.config, {
          intent: turnDirective.intent,
          trivial: true,
        }))
        : await this.packContext(request, {intent: turnDirective.intent});
      if (!trivialTurn) await emit({type: 'context', packed});
      const mentions = await this.packMentions(request);
      const retrievedContext = trivialTurn && !mentions.length ? '' : buildRetrievedContext(
          packed,
          mentions,
          this.workspace.primaryRoot,
          this.workspace.roots,
        );
      const pinnedContext = formatPinnedContext(
        await resolvePinnedContent(this.session, this.workspace),
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
      const contractEnabled = shouldUseTaskContract(
        request,
        turnDirective.intent,
        this.session.taskContract,
      );
      if (contractEnabled && (!this.session.taskContract || this.session.taskContract.state === 'satisfied')) {
        this.session.taskContract = createDraftTaskContract(request, this.session.audit?.at(-1)?.id);
        await this.persist();
        await emit({type: 'contract', contract: structuredClone(this.session.taskContract)});
      }
      activeRunContract = contractEnabled ? this.session.taskContract : undefined;
      const promptSections = [
        `intent:${turnDirective.intent}`,
        ...(workspaceRules ? ['rules'] : []),
        ...(this.session.workingMemory ? ['working-memory'] : []),
        ...(contractEnabled ? ['task-contract'] : []),
        ...(this.session.contextSummary ? ['session-summary'] : []),
        ...(!trivialTurn ? [`context:${packed.engine}`] : []),
        ...(packed.text ? [`code:${packed.engine}`] : []),
        ...(options.turnInstructions ? ['workflow'] : []),
        ...(augmentation.skills?.length ? [`skills:${augmentation.skills.length}`] : []),
        ...(augmentation.memoryCount ? [`memory:${augmentation.memoryCount}`] : []),
      ];
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
          return finishRun('token_budget');
        }
        this.applySteering();
        await emit({type: 'thinking', turn});
        const dynamicPrompt = [
            buildSessionStatePrompt(this.session),
            turnDirective.text,
            this.contextManager.buildShortTermPrompt(this.session),
            pinnedContext,
            options.turnInstructions ?? '',
            augmentation.text,
          ].filter(Boolean).join('\n\n');
        const messages = packConversation(
          stableSystemPrompt,
          dynamicPrompt,
          retrievedContext,
          activeMessages(this.session),
          contextBudget,
        );
        const availableTokens = this.config.agent.maxSessionTokens -
          (this.session.usage.inputTokens + this.session.usage.outputTokens);
        const visibleTools = visibleToolDefinitions(
          this.tools,
          options.askMode === true,
          contractEnabled,
          this.hasReadableToolArtifact(),
          activeDuplicationMatchIds(
            this.session.audit ?? [],
            this.session.duplicationSuppressions ?? [],
          ).size > 0,
          request,
          loadedProgressiveTools,
        );
        const estimatedInputTokens = estimateMessages(messages) + estimateToolDefinitions(visibleTools);
        if (availableTokens <= 0 || estimatedInputTokens >= availableTokens) {
          return finishRun('token_budget');
        }
        const maxOutputTokens = Math.max(1, Math.min(
          this.config.model.maxTokens ?? 8_192,
          availableTokens - estimatedInputTokens,
        ));
        const breakdown = promptTokenBreakdown(
          messages,
          stableSystemPrompt,
          dynamicPrompt,
          retrievedContext,
          visibleTools,
          maxOutputTokens,
        );
        if (!trivialTurn) {
          await emit({
            type: 'prompt',
            intent: turnDirective.intent,
            sections: promptSections,
            estimatedTokens: breakdown.estimatedInputTokens,
            breakdown,
          });
        }
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
        const turnUsage = recordTokenUsage(
          this.session,
          response.usage,
          estimatedInputTokens,
          estimateResponseTokens(response),
        );
        const {inputTokens, outputTokens} = turnUsage;
        const actualInputTokens = validTokenCount(response.usage?.inputTokens);
        const actualOutputTokens = validTokenCount(response.usage?.outputTokens);
        const receipt = recordTokenLedger(this.session, {
          requestId: userMessage.id,
          turn,
          recordedAt: new Date().toISOString(),
          estimated: {
            ...breakdown,
            outputTokens: estimateResponseTokens(response),
          },
          actual: {
            ...(actualInputTokens === undefined ? {} : {inputTokens: actualInputTokens}),
            ...(actualOutputTokens === undefined ? {} : {outputTokens: actualOutputTokens}),
          },
          inputSource: actualInputTokens === undefined ? 'estimated' : 'actual',
          outputSource: actualOutputTokens === undefined ? 'estimated' : 'actual',
          tools: {
            loaded: visibleTools.map((tool) => tool.name),
            deferredCount: Math.max(0, this.tools.definitions().filter((tool) => tool.progressive).length -
              visibleTools.filter((tool) => tool.progressive).length),
          },
          retrieval: tokenRetrievalReceipt(packed),
        });
        await emit({
          type: 'usage',
          inputTokens: this.session.usage.inputTokens,
          outputTokens: this.session.usage.outputTokens,
          source: this.session.usage.source ?? 'unknown',
          inputSource: this.session.usage.inputSource ?? 'unknown',
          outputSource: this.session.usage.outputSource ?? 'unknown',
          actual: {
            inputTokens: this.session.usage.actualInputTokens ?? 0,
            outputTokens: this.session.usage.actualOutputTokens ?? 0,
          },
          estimated: {
            inputTokens: this.session.usage.estimatedInputTokens ?? 0,
            outputTokens: this.session.usage.estimatedOutputTokens ?? 0,
          },
          receipt,
        });
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
          return finishRun('token_budget');
        }

        if (response.toolCalls.length) {
          const visibleToolNames = new Set(visibleTools.map((tool) => tool.name));
          for (const call of response.toolCalls) {
            throwIfAborted(options.signal);
            const result = await this.executeTool(
              call,
              options,
              emit,
              toolRecovery,
              visibleToolNames,
            );
            if (call.name === 'task_contract') activeRunContract = this.session.taskContract;
            recordExecution(call, result);
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
          for (const {call, result} of verification) recordExecution(call, result);
          this.session.messages.push(message('user',
            `<automatic-verification>\n${verification.map(({result}) => result.content).join('\n\n')}\n</automatic-verification>\n` +
            'Review these results, correct any failures if needed, then provide the final answer.',
          ));
          await this.persist();
          await this.runAfterTurnHook(turn, [], options.signal);
          continue;
        }

        const completion = completionReport();
        if ((this.config.agent.autoVerify || Boolean(completion.acceptance)) &&
          (completion.status === 'unverified' || completion.status === 'verification_failed') &&
          !completionRecoveryAttempted && turn < maxTurns) {
          completionRecoveryAttempted = true;
          if (activeRunContract) {
            await emit({type: 'contract', contract: structuredClone(activeRunContract)});
          }
          this.session.messages.push(message('user', completionRecoveryDirective(completion)));
          await this.persist();
          await this.runAfterTurnHook(turn, [], options.signal);
          continue;
        }

        await this.runAfterTurnHook(turn, [], options.signal);
        const reason = completion.status === 'unverified'
          ? 'unverified'
          : completion.status === 'verification_failed'
            ? 'verification_failed'
            : 'completed';
        return finishRun(reason, completion);
      }
      return finishRun('max_turns');
    } catch (error) {
      const normalized = toError(error);
      if (isAbortError(normalized) || options.signal?.aborted) {
        const completion = completionReport();
        this.session.lastRun = {
          ...completion,
          reason: 'aborted',
          finishedAt: new Date().toISOString(),
        };
        await this.persist().catch(() => undefined);
        await safeEmit(emit, {type: 'done', reason: 'aborted', completion});
        return this.session;
      }
      const completion = completionReport();
      this.session.lastRun = {
        ...completion,
        reason: 'error',
        finishedAt: new Date().toISOString(),
      };
      await this.persist().catch(() => undefined);
      await safeEmit(emit, {type: 'error', error: normalized});
      throw normalized;
    } finally {
      this.running = false;
      this.steering = [];
      this.activeReuseGate = undefined;
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
    recovery = new ToolRecoveryController(),
    visibleToolNames?: ReadonlySet<string>,
  ): Promise<ToolResult> {
    const preflight = recovery.preflight(call);
    if (preflight) {
      const result = await this.protectToolResult(
        failedResult(call, 'Tool call rejected by the recovery circuit.', preflight),
      );
      this.recordToolResult(result);
      await emit({type: 'tool_result', result});
      return result;
    }
    if (visibleToolNames && !visibleToolNames.has(call.name)) {
      const receipt = recovery.recordFailure(call, 'unknown_tool');
      const result = await this.protectToolResult(
        failedResult(call, `Tool is not exposed for this turn: ${call.name}`, receipt),
      );
      this.recordToolResult(result);
      await emit({type: 'tool_result', result});
      return result;
    }
    const tool = this.tools.get(call.name);
    if (!tool) {
      const receipt = recovery.recordFailure(call, 'unknown_tool');
      const result = await this.protectToolResult(failedResult(call, `Unknown tool: ${call.name}`, receipt));
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
      const failureClass = classifyThrownToolFailure(error, options.signal);
      const receipt = recovery.recordFailure(call, failureClass);
      const result = await this.protectToolResult(failedResult(call, formatToolError(error), receipt));
      this.recordToolResult(result, tool.definition.category);
      await emit({type: 'tool_result', result});
      return result;
    }
    if (categories.some((category) => category !== 'read') && this.session.taskContract?.state === 'draft') {
      const receipt = recovery.recordFailure(call, 'contract_required');
      const result = await this.protectToolResult(
        failedResult(call, 'Potentially mutating work is paused until the draft Task Contract is activated.', receipt),
      );
      this.recordToolResult(result, tool.definition.category);
      await emit({type: 'tool_result', result});
      return result;
    }
    for (const category of categories) {
      const allowed = await this.authorize(call, category, options, emit);
      if (!allowed) {
        const receipt = recovery.recordFailure(call, 'permission_denied');
        const result = await this.protectToolResult(
          failedResult(call, `Permission denied for ${category} operation.`, receipt),
        );
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
      toolArtifactStore: this.toolArtifactStore,
      emit,
      ...(options.signal ? {signal: options.signal} : {}),
      toolCallId: call.id,
    };
    try {
      let reuseReceipt: Awaited<ReturnType<typeof evaluateReuseGate>>['receipt'];
      let reuseWarning: string | undefined;
      let duplicationBaseline: Awaited<ReturnType<NonNullable<ContextProvider['functionFingerprints']>>> | undefined;
      const duplicationAuditEnabled = categories.includes('write') &&
        (call.name === 'write_file' || call.name === 'apply_patch') &&
        Boolean(this.contextEngine.functionFingerprints);
      if (categories.includes('write') && this.activeReuseGate && !this.activeReuseGate.attempted &&
        (call.name === 'write_file' || call.name === 'apply_patch')) {
        this.activeReuseGate.attempted = true;
        try {
          const gate = await evaluateReuseGate({
            requestId: this.activeReuseGate.requestId,
            request: this.activeReuseGate.request,
            changeSequence: this.changeSequence,
            call,
            context: this.contextEngine,
            workspace: this.workspace,
          });
          reuseReceipt = gate.receipt;
          reuseWarning = gate.warning;
          if (!gate.triggered) this.activeReuseGate.attempted = false;
        } catch {
          this.activeReuseGate.attempted = false;
          reuseWarning = 'Reuse check (warning-only) was inconclusive.';
        }
      }
      if (duplicationAuditEnabled) {
        try {
          duplicationBaseline = await this.contextEngine.functionFingerprints?.();
        } catch {
          duplicationBaseline = undefined;
        }
      }
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
      const toolExecutionContext: ToolExecutionContext = checkpointId
        ? {...executionContext, checkpointId}
        : executionContext;
      const beforeHooks = await this.hooks.run('beforeTool', {
        sessionId: this.session.id,
        call,
      }, options.signal);
      throwIfAborted(options.signal);
      const execution = await tool.execute(call.arguments, toolExecutionContext);
      const changedFiles = await this.acceptChangedFiles(execution.changedFiles ?? []);
      const activeDuplicateFunctions = new Set(
        buildDuplicationCompletion(
          this.session.audit ?? [],
          [],
        )?.matches.map((match) => `${match.changedPath}\u0000${match.changedSymbol}`) ?? [],
      );
      const activeDuplicatePaths = new Set(
        buildDuplicationCompletion(this.session.audit ?? [], [])?.matches
          .map((match) => match.changedPath) ?? [],
      );
      const duplicationAudit = duplicationAuditEnabled
        ? await auditChangedFunctions({
          ...(duplicationBaseline ? {baseline: duplicationBaseline} : {}),
          changedFiles,
          changeSequence: this.changeSequence,
          recheckFunctions: activeDuplicateFunctions,
          recheckPaths: activeDuplicatePaths,
        })
        : undefined;
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
      let completeContent = afterHookError
        ? `${execution.content}\n\nTool succeeded, but afterTool hook failed: ${afterHookError.message}`
        : execution.content;
      if (reuseWarning) completeContent = `${reuseWarning}\n\n${completeContent}`;
      if (duplicationAudit?.status === 'warning' || duplicationAudit?.status === 'unresolved') {
        const enforcement = duplicationAudit.enforcement === 'blocking'
          ? 'completion-blocking Type-1/2'
          : 'warning-only';
        completeContent = `Duplication audit (${enforcement}): ${duplicationAudit.rationale}\n\n${completeContent}`;
      }
      const metadata: Record<string, unknown> = {
        ...(execution.metadata ?? {}),
        ...(changedFiles.length ? {changedFiles} : {}),
        ...(checkpointId ? {checkpointId} : {}),
        ...(reuseReceipt ? {reuseReceipt} : {}),
        ...(duplicationAudit ? {duplicationAudit} : {}),
        ...(beforeHooks.length || afterHooks.length
          ? {hooks: {before: beforeHooks.length, after: afterHooks.length}}
          : {}),
        ...(afterHookError ? {toolSucceeded: true, hookError: afterHookError.message} : {}),
      };
      const ok = execution.ok !== false && !afterHookError;
      if (!ok && reuseReceipt && this.activeReuseGate) this.activeReuseGate.attempted = false;
      if (!ok) {
        const failureClass = options.signal?.aborted
          ? 'cancelled'
          : classifyToolFailure({toolCallId: call.id, name: call.name, ok, content: completeContent, metadata});
        const receipt = recovery.recordFailure(call, failureClass);
        completeContent = `${formatFailureReceipt(receipt)}\n${completeContent}`;
        metadata.failure = receipt;
      } else {
        recovery.recordSuccess(call);
      }
      const evidenceProgress = recovery.recordEvidence(call, {
        toolCallId: call.id,
        name: call.name,
        ok,
        content: completeContent,
        metadata,
      });
      if (evidenceProgress) metadata.evidenceProgress = evidenceProgress;
      if (changedFiles.length && this.contextEngine.invalidate) {
        this.contextEngine.invalidate(changedFiles);
        if (this.contextEngine.flushDirty) {
          try {
            metadata.contextRefresh = await this.contextEngine.flushDirty();
          } catch (error) {
            metadata.contextRefresh = {
              status: 'degraded',
              detail: toError(error).message,
              paths: changedFiles.length,
            };
          }
        }
      }
      const result = await this.protectToolResult({
        toolCallId: call.id,
        name: call.name,
        ok,
        content: completeContent,
        metadata,
      });
      this.contextManager.recordTool(this.session, call, result);
      if (JSON.stringify(this.session.tasks) !== tasksBefore || call.name === 'task') {
        await emit({type: 'tasks', tasks: this.session.tasks.map((task) => ({...task}))});
      }
      if (call.name === 'task_contract' && this.session.taskContract) {
        await emit({type: 'contract', contract: structuredClone(this.session.taskContract)});
      }
      this.recordToolResult(result, tool.definition.category);
      await emit({type: 'tool_result', result});
      return result;
    } catch (error) {
      const normalized = toError(error);
      const failureClass = classifyThrownToolFailure(normalized, options.signal);
      const receipt = recovery.recordFailure(call, failureClass);
      const result = await this.protectToolResult(failedResult(call, formatToolError(error), receipt));
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
        if (!this.session.changedFiles.includes(safe)) this.session.changedFiles.push(safe);
      } catch {
        throw new Error(`Tool reported an out-of-workspace changed file: ${path}`);
      }
    }
    if (accepted.length) this.changeSequence += 1;
    return accepted;
  }

  private async runVerification(
    options: RunOptions,
    emit: (event: AgentEvent) => Promise<void>,
  ): Promise<Array<{call: ToolCall; result: ToolResult}>> {
    const results: Array<{call: ToolCall; result: ToolResult}> = [];
    for (const command of this.config.agent.verifyCommands) {
      const call: ToolCall = {
        id: `verify-${randomUUID()}`,
        name: 'shell',
        arguments: {command, cwd: this.workspace.primaryRoot},
      };
      const result = await this.executeTool(call, options, emit);
      results.push({call, result});
    }
    return results;
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

  private async packContext(input: string, options: Parameters<ContextProvider['pack']>[1]): Promise<PackedContext> {
    return this.contextEngine.pack(input, options);
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

  /** List the user-controlled context sources on the live session. */
  listContextSources(): ContextSource[] {
    return this.session.contextSources ?? [];
  }

  /** Pin a workspace file so it is read fresh and re-injected on every turn. */
  async pinContextSource(path: string): Promise<ContextSource> {
    const source = await pinContextSource(this.session, this.workspace, path);
    await this.persist();
    return source;
  }

  /** Remove a source entirely. Returns the removed alias, or undefined if absent. */
  async unpinContextSource(path: string): Promise<string | undefined> {
    const removed = unpinContextSource(this.session, path);
    if (removed) await this.persist();
    return removed;
  }

  /** Toggle a source between pinned and muted. Returns the source, or undefined. */
  async toggleMuteContextSource(path: string): Promise<ContextSource | undefined> {
    const source = toggleMuteContextSource(this.session, path);
    if (source) await this.persist();
    return source;
  }

  private persist(): Promise<void> {
    return this.persistSession ? this.sessionStore.save(this.session) : Promise.resolve();
  }

  private toolOutputBudget(): number {
    const contextWindowTokens = Math.max(24_000, Math.min(100_000, this.config.context.maxTokens * 3));
    const activeContextTokens = this.contextManager.status(this.session, contextWindowTokens).activeTokens;
    const remainingSessionTokens = this.config.agent.maxSessionTokens -
      (this.session.usage.inputTokens + this.session.usage.outputTokens);
    return dynamicToolOutputBudget(contextWindowTokens, activeContextTokens, remainingSessionTokens);
  }

  private async protectToolResult(result: ToolResult): Promise<ToolResult> {
    const metadata = {...(result.metadata ?? {})};
    const output = await protectToolOutput({
      content: result.content,
      sessionId: this.session.id,
      toolCallId: result.toolCallId,
      tool: result.name,
      ok: result.ok,
      budgetTokens: this.toolOutputBudget(),
      metadata,
      artifacts: this.toolArtifactStore,
    });
    if (output.metadata.artifact) this.registerToolArtifact({
      ...output.metadata.artifact,
      redacted: output.metadata.redacted,
    });
    return {
      ...result,
      content: output.content,
      ...(output.metadata.truncated || output.metadata.redacted || output.metadata.sanitized ||
        output.metadata.artifact || output.metadata.artifactUnavailable
        ? {metadata: {...metadata, toolOutput: output.metadata}}
        : Object.keys(metadata).length ? {metadata} : {}),
    };
  }

  private hasReadableToolArtifact(): boolean {
    const now = Date.now();
    return (this.session.toolArtifacts ?? []).some((artifact) =>
      Date.parse(artifact.expiresAt) > now,
    );
  }

  private registerToolArtifact(artifact: ToolArtifactReference): void {
    const now = Date.now();
    const artifacts = (this.session.toolArtifacts ?? [])
      .filter((candidate) => Date.parse(candidate.expiresAt) > now && candidate.toolCallId !== artifact.toolCallId);
    artifacts.push(artifact);
    artifacts.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    if (artifacts.length > 200) artifacts.splice(0, artifacts.length - 200);
    this.session.toolArtifacts = artifacts;
  }

  private async reconcileToolArtifacts(): Promise<void> {
    let stored: ToolArtifactReference[];
    try {
      stored = await this.toolArtifactStore.prune(this.session.id);
    } catch {
      // Corrupt or unsafe retention state must not enter the prompt, but it
      // also must not prevent the user from continuing the coding session.
      this.session.toolArtifacts = [];
      return;
    }
    const valid = new Map(stored.map((artifact) => [artifact.toolCallId, artifact]));
    const reconciled = (this.session.toolArtifacts ?? []).filter((receipt) => {
      const artifact = valid.get(receipt.toolCallId);
      return artifact !== undefined && artifact.sha256 === receipt.sha256 &&
        artifact.bytes === receipt.bytes && artifact.createdAt === receipt.createdAt &&
        artifact.expiresAt === receipt.expiresAt && artifact.redacted === receipt.redacted;
    });
    this.session.toolArtifacts = reconciled;
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

function promptTokenBreakdown(
  messages: ChatMessage[],
  stablePrompt: string,
  dynamicPrompt: string,
  retrievedContext: string,
  tools: {name: string; description: string; inputSchema: Record<string, unknown>}[],
  outputAllowanceTokens: number,
): PromptTokenBreakdown {
  const stableTokens = estimateTokens(stablePrompt);
  const dynamicTokens = estimateTokens(dynamicPrompt);
  const retrievedTokens = estimateTokens(retrievedContext);
  const messageTokens = estimateMessages(messages);
  const toolSchemaTokens = estimateToolDefinitions(tools);
  const toolResultTokens = messages
    .filter((message) => message.role === 'tool')
    .reduce((total, message) => total + estimateTokens(message.content), 0);
  return {
    stableTokens,
    dynamicTokens,
    conversationTokens: Math.max(0, messageTokens - stableTokens - dynamicTokens - retrievedTokens - toolResultTokens),
    toolResultTokens,
    retrievedTokens,
    toolSchemaTokens,
    estimatedInputTokens: messageTokens + toolSchemaTokens,
    outputAllowanceTokens,
  };
}

function tokenRetrievalReceipt(packed: PackedContext): TokenLedgerEntry['retrieval'] {
  const discarded: TokenLedgerEntry['retrieval']['discarded'] = [];
  if ((packed.duplicateHits ?? 0) > 0) {
    discarded.push({reason: 'overlapping-span', count: packed.duplicateHits ?? 0});
  }
  if (packed.truncated) discarded.push({reason: 'budget-cap', count: 1});
  return {
    engine: packed.engine,
    ...(packed.budgetTier ? {budgetTier: packed.budgetTier} : {}),
    ...(packed.budgetTokens === undefined ? {} : {budgetTokens: packed.budgetTokens}),
    ...(packed.candidateHits === undefined ? {} : {candidateHits: packed.candidateHits}),
    ...(packed.selectedHits === undefined ? {} : {selectedHits: packed.selectedHits}),
    ...(packed.duplicateHits === undefined ? {} : {duplicateHits: packed.duplicateHits}),
    ...(packed.incrementalEvidenceTokens === undefined
      ? {} : {incrementalEvidenceTokens: packed.incrementalEvidenceTokens}),
    discarded,
  };
}

function recordTokenLedger(session: Session, entry: TokenLedgerEntry): TokenLedgerEntry {
  const ledger = session.tokenLedger ?? (session.tokenLedger = []);
  ledger.push(entry);
  if (ledger.length > 256) ledger.splice(0, ledger.length - 256);
  return entry;
}

function recordTokenUsage(
  session: Session,
  providerUsage: ModelResponse['usage'],
  estimatedInputTokens: number,
  estimatedOutputTokens: number,
): {inputTokens: number; outputTokens: number} {
  const inputActual = validTokenCount(providerUsage?.inputTokens);
  const outputActual = validTokenCount(providerUsage?.outputTokens);
  const priorInputSource = existingMeasurementSource(session, 'input');
  const priorOutputSource = existingMeasurementSource(session, 'output');
  const inputTokens = inputActual ?? estimatedInputTokens;
  const outputTokens = outputActual ?? estimatedOutputTokens;
  session.usage.inputTokens += inputTokens;
  session.usage.outputTokens += outputTokens;
  if (inputActual !== undefined) {
    session.usage.actualInputTokens = (session.usage.actualInputTokens ?? 0) + inputActual;
  } else {
    session.usage.estimatedInputTokens = (session.usage.estimatedInputTokens ?? 0) + inputTokens;
  }
  if (outputActual !== undefined) {
    session.usage.actualOutputTokens = (session.usage.actualOutputTokens ?? 0) + outputActual;
  } else {
    session.usage.estimatedOutputTokens = (session.usage.estimatedOutputTokens ?? 0) + outputTokens;
  }
  session.usage.inputSource = mergeMeasurementSource(
    priorInputSource,
    inputActual === undefined ? 'estimated' : 'actual',
    session.usage.inputTokens,
  );
  session.usage.outputSource = mergeMeasurementSource(
    priorOutputSource,
    outputActual === undefined ? 'estimated' : 'actual',
    session.usage.outputTokens,
  );
  session.usage.source = combineMeasurementSources(
    session.usage.inputSource,
    session.usage.outputSource,
    session.usage.inputTokens,
    session.usage.outputTokens,
  );
  return {inputTokens, outputTokens};
}

function validTokenCount(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function existingMeasurementSource(
  session: Session,
  channel: 'input' | 'output',
): TokenMeasurementSource | undefined {
  const source = channel === 'input' ? session.usage.inputSource : session.usage.outputSource;
  if (source) return source;
  const total = channel === 'input' ? session.usage.inputTokens : session.usage.outputTokens;
  return total > 0 ? 'unknown' : undefined;
}

function mergeMeasurementSource(
  previous: TokenMeasurementSource | undefined,
  current: 'actual' | 'estimated',
  total: number,
): TokenMeasurementSource {
  if (total === 0 && !previous) return current;
  if (!previous) return current;
  return previous === current ? current : 'mixed';
}

function combineMeasurementSources(
  input: TokenMeasurementSource,
  output: TokenMeasurementSource,
  inputTokens: number,
  outputTokens: number,
): TokenMeasurementSource {
  const active = [
    ...(inputTokens > 0 ? [input] : []),
    ...(outputTokens > 0 ? [output] : []),
  ];
  if (!active.length) return 'unknown';
  return active.every((source) => source === active[0]) ? (active[0] ?? 'unknown') : 'mixed';
}

function uniqueCategories(categories: ToolCategory[]): ToolCategory[] {
  return [...new Set(categories)];
}

function failedResult(
  call: ToolCall,
  content: string,
  failure?: ToolFailureReceipt,
): ToolResult {
  return {
    toolCallId: call.id,
    name: call.name,
    ok: false,
    content: failure ? `${formatFailureReceipt(failure)}\n${content}` : content,
    ...(failure ? {metadata: {failure}} : {}),
  };
}

function visibleToolDefinitions(
  tools: ToolRegistry,
  askMode: boolean,
  contractEnabled: boolean,
  artifactReadAvailable: boolean,
  duplicationAvailable: boolean,
  request: string,
  loadedProgressiveTools: Set<string>,
): ReturnType<ToolRegistry['definitions']> {
  const eligible = tools.definitions().filter((tool) =>
    (!askMode || tool.category === 'read') &&
    (contractEnabled || tool.name !== 'task_contract') &&
    (artifactReadAvailable || tool.name !== 'read_tool_artifact') &&
    (duplicationAvailable || tool.name !== 'duplication_audit'),
  );
  const progressive = eligible.filter((tool) => tool.progressive);
  if (progressive.length <= 8) return eligible;
  for (const tool of selectProgressiveTools(progressive, request, 8)) {
    loadedProgressiveTools.add(tool.name);
  }
  return eligible.filter((tool) => !tool.progressive || loadedProgressiveTools.has(tool.name));
}

function selectProgressiveTools(
  tools: ReturnType<ToolRegistry['definitions']>,
  request: string,
  limit: number,
): ReturnType<ToolRegistry['definitions']> {
  const terms = new Set(request.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []);
  return tools.map((tool) => {
    const searchable = `${tool.name.replaceAll('_', ' ')} ${tool.description}`.toLocaleLowerCase();
    let score = 0;
    for (const term of terms) if (searchable.includes(term)) score += term.length;
    return {tool, score};
  }).sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
    .slice(0, limit)
    .map(({tool}) => tool);
}

function formatToolError(error: unknown): string {
  const normalized = toError(error);
  if (normalized.name === 'ZodError') return `Invalid tool arguments: ${normalized.message}`;
  return normalized.message;
}

function classifyThrownToolFailure(error: unknown, signal?: AbortSignal) {
  const normalized = toError(error);
  if (isAbortError(normalized) || signal?.aborted) return 'cancelled' as const;
  if (normalized.name === 'HookError') return 'hook' as const;
  if (normalized.name === 'ZodError' || normalized.name === 'ToolInputError') return 'schema_input' as const;
  return 'execution' as const;
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
