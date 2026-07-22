import {describe, expect, it} from 'vitest';
import {externalAgentCommand, parseExternalAgentOutput, parseExternalAgentTelemetry} from '../../src/agent/external-runtime.js';

describe('external agent runtimes', () => {
  it('builds explicit read-only commands without a shell', () => {
    const codex = externalAgentCommand({runtime: 'codex', model: 'gpt-test', workspace: '/tmp/project', prompt: 'Review the diff'});
    expect(codex.binary).toBe('codex');
    expect(codex.args).toContain('read-only');
    expect(codex.args).toContain('--ephemeral');
    expect(codex.args.at(-1)).toBe('Review the diff');

    const claude = externalAgentCommand({runtime: 'claude', model: 'claude-test', workspace: '/tmp/project', prompt: 'Review UX'});
    expect(claude.args).toContain('plan');
    expect(claude.args).toContain('--safe-mode');
    expect(claude.args).toContain('--no-session-persistence');

    const grok = externalAgentCommand({runtime: 'grok', model: 'grok-test', workspace: '/tmp/project', prompt: 'Research APIs'});
    expect(grok.args).toContain('plan');
    expect(grok.args).toContain('--no-memory');
    expect(grok.args).toContain('--no-subagents');
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
});
