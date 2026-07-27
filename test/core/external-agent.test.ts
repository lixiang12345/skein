import {describe, expect, it} from 'vitest';
import {
  createExternalAgentProgressObserver,
  externalAgentCommand,
  externalAgentFailure,
  externalRuntimeEnvironment,
  parseExternalAgentOutput,
  parseExternalAgentTelemetry,
} from '../../src/agent/external-runtime.js';

describe('external agent runtimes', () => {
  it('builds explicit read-only commands without a shell', () => {
    const codex = externalAgentCommand({runtime: 'codex', model: 'gpt-test', workspace: '/tmp/project', prompt: 'Review the diff'});
    expect(codex.binary).toBe('codex');
    expect(codex.args).toContain('read-only');
    expect(codex.args).toContain('--ephemeral');
    expect(codex.args.at(-1)).toBe('Review the diff');

    const claude = externalAgentCommand({
      runtime: 'claude', model: 'claude-test', workspace: '/tmp/project', prompt: 'Review UX', costBudgetUsd: 0.5,
    });
    expect(claude.args).toContain('plan');
    expect(claude.args).toContain('--safe-mode');
    expect(claude.args).toContain('--no-session-persistence');
    expect(claude.args).toContain('Read,Glob,Grep');
    expect(claude.args).toContain('--max-budget-usd');
    expect(claude.args).toContain('0.5');

    const grok = externalAgentCommand({runtime: 'grok', model: 'grok-test', workspace: '/tmp/project', prompt: 'Research APIs'});
    expect(grok.args).toContain('plan');
    expect(grok.args).toContain('--no-memory');
    expect(grok.args).toContain('--no-subagents');
  });

  it('builds one cost-capped Claude writer command without Bash, Git, or bypass permissions', () => {
    const claude = externalAgentCommand({
      runtime: 'claude',
      access: 'workspace-write',
      model: 'claude-opus-4-8',
      workspace: '/tmp/skein-writer',
      prompt: 'Implement the bounded change',
      costBudgetUsd: 0.75,
    });

    expect(claude.args).toContain('acceptEdits');
    expect(claude.args).toContain('stream-json');
    expect(claude.args).toContain('--verbose');
    expect(claude.args).toContain('Read,Glob,Grep,Edit,Write');
    expect(claude.args).toContain('--safe-mode');
    expect(claude.args).toContain('--no-session-persistence');
    expect(claude.args).toContain('--max-budget-usd');
    expect(claude.args).toContain('0.75');
    expect(claude.args).not.toContain('Bash');
    expect(claude.args).not.toContain('--dangerously-skip-permissions');
  });

  it('fails closed when external writer mode lacks a cost cap or selects another CLI', () => {
    expect(() => externalAgentCommand({
      runtime: 'claude', access: 'workspace-write', model: 'opus', workspace: '/tmp/writer', prompt: 'Write',
    })).toThrow('explicit USD cost budget');
    expect(() => externalAgentCommand({
      runtime: 'codex', access: 'workspace-write', model: 'gpt', workspace: '/tmp/writer', prompt: 'Write', costBudgetUsd: 1,
    })).toThrow('supports the Claude CLI only');
  });

  it('normalizes final reports from JSON and JSONL runtimes', () => {
    expect(parseExternalAgentOutput('claude', JSON.stringify({type: 'result', result: 'Claude report'}))).toBe('Claude report');
    expect(parseExternalAgentOutput('grok', JSON.stringify({content: 'Grok report'}))).toBe('Grok report');
    expect(parseExternalAgentOutput('codex', [
      JSON.stringify({type: 'thread.started', thread_id: 'one'}),
      JSON.stringify({type: 'item.completed', item: {type: 'agent_message', text: 'Codex report'}}),
    ].join('\n'))).toBe('Codex report');
  });

  it('extracts observable usage and tool counts without exposing reasoning text', () => {
    const telemetry = parseExternalAgentTelemetry([
      JSON.stringify({type: 'item.completed', item: {id: 'tool-1', type: 'command_execution', command: 'rg files'}}),
      JSON.stringify({type: 'turn.completed', usage: {input_tokens: 1200, output_tokens: 300}}),
    ].join('\n'));
    expect(telemetry).toEqual({usage: {inputTokens: 1200, outputTokens: 300}, toolCalls: 1});
  });

  it('streams only deduplicated Claude tool names and counts from split JSONL chunks', () => {
    const events: Array<{stage: 'tool'; tool: string; toolCalls: number}> = [];
    const observer = createExternalAgentProgressObserver('claude', (event) => events.push(event));
    expect(observer).toBeDefined();
    observer!.onChunk('{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool-1",');
    observer!.onChunk('"name":"Read","input":{"file_path":"secret.ts"}}]}}\n');
    observer!.onChunk('{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool-1","name":"Read"},{"type":"tool_use","id":"tool-2","name":"Edit"}]}}');
    observer!.flush();

    expect(events).toEqual([
      {stage: 'tool', tool: 'Read', toolCalls: 1},
      {stage: 'tool', tool: 'Edit', toolCalls: 2},
    ]);
    expect(JSON.stringify(events)).not.toContain('secret.ts');
  });

  it('passes only runtime-owned configuration and a minimal process environment', () => {
    const selected = externalRuntimeEnvironment('codex', '/trusted/bin', {
      HOME: '/tmp/home',
      LANG: 'en_US.UTF-8',
      CODEX_HOME: '/tmp/codex',
      OPENAI_API_KEY: 'openai-secret',
      ANTHROPIC_API_KEY: 'anthropic-secret',
      GEMINI_API_KEY: 'gemini-secret',
      SKEIN_API_KEY: 'skein-secret',
      SKEIN_CONNECTION_RELAY_API_KEY_ENV: 'RELAY_KEY',
      RELAY_KEY: 'relay-secret',
      NODE_OPTIONS: '--inspect',
    });

    expect(selected).toEqual({
      PATH: '/trusted/bin',
      HOME: '/tmp/home',
      LANG: 'en_US.UTF-8',
      CODEX_HOME: '/tmp/codex',
    });
    expect(JSON.stringify(selected)).not.toMatch(/openai-secret|anthropic-secret|gemini-secret|skein-secret|relay-secret/u);
  });

  it('passes only portable Anthropic variables to the Claude runtime', () => {
    const selected = externalRuntimeEnvironment('claude', '/trusted/bin', {
      HOME: '/tmp/home',
      CLAUDE_CONFIG_DIR: '/tmp/claude',
      ANTHROPIC_BASE_URL: 'https://relay.example',
      ANTHROPIC_API_KEY: 'anthropic-key',
      ANTHROPIC_AUTH_TOKEN: 'anthropic-token',
      OPENAI_API_KEY: 'openai-secret',
      GEMINI_API_KEY: 'gemini-secret',
      NODE_OPTIONS: '--inspect',
    });

    expect(selected).toEqual({
      PATH: '/trusted/bin',
      HOME: '/tmp/home',
      CLAUDE_CONFIG_DIR: '/tmp/claude',
      ANTHROPIC_BASE_URL: 'https://relay.example',
      ANTHROPIC_API_KEY: 'anthropic-key',
      ANTHROPIC_AUTH_TOKEN: 'anthropic-token',
    });
    expect(JSON.stringify(selected)).not.toMatch(/openai-secret|gemini-secret|--inspect/u);
  });

  it('maps an explicitly named relay credential without passing unrelated provider secrets', () => {
    const selected = externalRuntimeEnvironment('claude', '/trusted/bin', {
      HOME: '/tmp/home',
      SKEIN_CLAUDE_RELAY_KEY: 'relay-secret',
      ANTHROPIC_API_KEY: 'unrelated-anthropic-key',
      OPENAI_API_KEY: 'unrelated-openai-key',
    }, {
      baseUrl: 'https://relay.example',
      apiKeyEnv: 'SKEIN_CLAUDE_RELAY_KEY',
      apiKeyHeader: 'bearer',
    });

    expect(selected).toEqual({
      PATH: '/trusted/bin',
      HOME: '/tmp/home',
      ANTHROPIC_BASE_URL: 'https://relay.example',
      ANTHROPIC_AUTH_TOKEN: 'relay-secret',
    });
    expect(() => externalRuntimeEnvironment('claude', '/trusted/bin', {}, {
      apiKeyEnv: 'SKEIN_CLAUDE_RELAY_KEY',
    })).toThrow('External Claude credential environment SKEIN_CLAUDE_RELAY_KEY is not set');
  });

  it('never accepts an exit-zero process that crossed its timeout boundary', () => {
    const failure = externalAgentFailure('codex', {
      command: 'codex exec',
      exitCode: 0,
      stdout: '{"type":"result","result":"partial"}',
      stderr: '',
      timedOut: true,
      durationMs: 600_045,
      stdoutBytes: 44,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    expect(failure?.message).toContain('timed out after 600045ms');
    expect(failure?.message).toContain('partial output was not accepted as complete');
  });

  it('reports bounded non-zero failures and accepts clean completion', () => {
    const base = {
      command: 'claude --print',
      stdout: '',
      timedOut: false,
      durationMs: 20,
      stdoutBytes: 0,
      stderrBytes: 4,
      stdoutTruncated: false,
      stderrTruncated: false,
    };
    expect(externalAgentFailure('claude', {...base, exitCode: 1, stderr: 'boom'})?.message).toBe('claude agent failed: boom');
    expect(externalAgentFailure('claude', {...base, exitCode: 0, stderr: ''})).toBeUndefined();
  });
});
