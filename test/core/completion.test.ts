import {spawn} from 'node:child_process';
import {Command} from 'commander';
import {describe, expect, it} from 'vitest';
import {createCompletionSpec, generateShellCompletion} from '../../src/cli/completion.js';

describe('shell completion', () => {
  it.each(['bash', 'zsh', 'fish'] as const)('generates deterministic %s completion from the command graph', (shell) => {
    const program = fixtureProgram();
    const output = generateShellCompletion(shell, program);
    expect(output).toBe(generateShellCompletion(shell, program));
    expect(output).toContain('skein');
    expect(output).toContain('feedback');
    expect(output).toContain('session');
    expect(output).toContain('fork');
    expect(output).toContain('branch');
    expect(output).toContain('capability');
    expect(output).toContain('inspect');
    if (shell === 'fish') {
      expect(output).toContain("-l 'connection'");
      expect(output).toContain("-l 'help'");
    } else {
      expect(output).toContain('--connection');
      expect(output).toContain('--help');
    }
    expect(output).not.toMatch(/[\u0000\r]/u);
  });

  it('projects visible commands, recursive subcommands, aliases, and options', () => {
    const spec = createCompletionSpec(fixtureProgram());
    expect(spec.commands.map(({name}) => name)).toEqual(['feedback', 'session', 'agents', 'help']);
    expect(spec.options).toEqual(expect.arrayContaining([
      expect.objectContaining({short: '-p', long: '--print'}),
      expect.objectContaining({long: '--connection', requiresValue: true}),
      expect.objectContaining({short: '-h', long: '--help'}),
    ]));

    const session = spec.commands.find(({name}) => name === 'session');
    expect(session?.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({name: 'fork', aliases: ['branch']}),
    ]));
    const capability = spec.commands.find(({name}) => name === 'agents')
      ?.commands.find(({name}) => name === 'capability');
    expect(capability?.commands.map(({name}) => name)).toEqual(['inspect', 'help']);
  });

  it('emits shell-native global and nested option declarations', () => {
    const program = fixtureProgram();
    const bash = generateShellCompletion('bash', program);
    expect(bash).toContain("'session fork'|'session fork '*");
    expect(bash).toContain("'--json -h --help'");
    expect(generateShellCompletion('zsh', program)).toContain("'--json[Print JSON]'");
    expect(generateShellCompletion('fish', program)).toContain("-l 'connection' -r");
  });

  it.each(['bash', 'zsh', 'fish'] as const)('projects the real CLI graph into %s output', async (shell) => {
    const result = await runCli(['completion', shell]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    for (const currentCommand of ['feedback', 'skills', 'inspect', 'memory', 'add', 'mcp', 'status', 'capability']) {
      expect(result.stdout).toContain(currentCommand);
    }
  }, 30_000);
});

function fixtureProgram(): Command {
  const program = new Command()
    .name('skein')
    .version('1.0.0')
    .option('-p, --print', 'Run once')
    .option('--connection <name>', 'Named connection');
  program.command('feedback').description('Show issue reporting details');
  const session = program.command('session').description('Manage sessions');
  session.command('fork <id>').alias('branch').description('Fork a session').option('--json', 'Print JSON');
  const agents = program.command('agents').description('Manage agents');
  agents.command('capability').description('Inspect capability routes')
    .command('inspect [profile]').description('Inspect one route');
  return program;
}

function runCli(args: string[]): Promise<{exitCode: number | null; stdout: string; stderr: string}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.tsx', ...args], {
      cwd: process.cwd(),
      env: {...process.env, NO_COLOR: '1'},
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
