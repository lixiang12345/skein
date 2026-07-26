import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

import {suggestCommandForPrompt} from '../../src/cli/command-hint.js';

const COMMANDS = [
  'init', 'config', 'index', 'search', 'context', 'status', 'doctor', 'update',
  'migrate', 'session', 'jobs', 'checkpoint', 'completion', 'tools', 'skills',
  'agents', 'workflow', 'memory', 'mcp', 'rules',
];

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

describe('suggestCommandForPrompt', () => {
  it('suggests the closest subcommand for a near-miss single token', () => {
    expect(suggestCommandForPrompt('sessoin', COMMANDS)).toBe('session');
    expect(suggestCommandForPrompt('serach', COMMANDS)).toBe('search');
    expect(suggestCommandForPrompt('checkpont', COMMANDS)).toBe('checkpoint');
    expect(suggestCommandForPrompt('  statis ', COMMANDS)).toBe('status');
  });

  it('keeps short tokens on a strict distance budget', () => {
    expect(suggestCommandForPrompt('mpc', COMMANDS)).toBe('mcp');
    expect(suggestCommandForPrompt('map', COMMANDS)).toBeUndefined();
  });

  it('never flags free-text prompts', () => {
    expect(suggestCommandForPrompt('fix the failing webhook test', COMMANDS)).toBeUndefined();
    expect(suggestCommandForPrompt('hello', COMMANDS)).toBeUndefined();
    expect(suggestCommandForPrompt('why?', COMMANDS)).toBeUndefined();
    expect(suggestCommandForPrompt('@src/cli.tsx', COMMANDS)).toBeUndefined();
    expect(suggestCommandForPrompt('', COMMANDS)).toBeUndefined();
  });
});

describe('CLI mistyped-command hint', () => {
  it('prints a stderr hint without blocking the prompt run', async () => {
    const home = await mkdtemp(join(tmpdir(), 'skein-command-hint-home-'));
    roots.push(home);
    const result = await runCli(['--no-color', '-p', 'sessoin'], {
      ...process.env, SKEIN_HOME: home, NO_COLOR: '1',
    });
    expect(result.stderr).toContain("hint: 'sessoin' is being sent to the agent as a prompt");
    expect(result.stderr).toContain('skein session');
  }, 30_000);

  it('stays quiet for ordinary prompts', async () => {
    const home = await mkdtemp(join(tmpdir(), 'skein-command-hint-home-'));
    roots.push(home);
    const result = await runCli(['--no-color', '-p', 'summarize recent changes'], {
      ...process.env, SKEIN_HOME: home, NO_COLOR: '1',
    });
    expect(result.stderr).not.toContain('hint:');
  }, 30_000);
});

function runCli(args: string[], environment: NodeJS.ProcessEnv): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.tsx', ...args], {
      cwd: process.cwd(),
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({exitCode, stdout, stderr}));
  });
}
