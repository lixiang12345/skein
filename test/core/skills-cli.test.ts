import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

describe('CLI Skill trust', () => {
  it('binds trust to the exact workspace Skill fingerprint and supports revocation', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'skein-skills-cli-workspace-'));
    const home = await mkdtemp(join(tmpdir(), 'skein-skills-cli-home-'));
    roots.push(workspace, home);
    const skillDirectory = join(workspace, '.agents', 'skills', 'release');
    const skillFile = join(skillDirectory, 'SKILL.md');
    await mkdir(skillDirectory, {recursive: true});
    await writeFile(skillFile, skillSource('Run npm pack --dry-run before publishing.'));
    const environment = {...process.env, SKEIN_HOME: home, NO_COLOR: '1'};

    const listed = await runCli([
      '--no-color', 'skills', 'list', '--workspace', workspace, '--json',
    ], environment);
    expect(listed.exitCode).toBe(0);
    const initial = findSkill(listed.stdout);
    expect(initial).toMatchObject({
      name: 'release-check', scope: 'workspace', trust: 'untrusted', trustSource: 'none',
      trusted: false, effect: 'blocked',
    });
    expect(initial.fingerprint).toMatch(/^[a-f0-9]{64}$/u);

    const unconfirmed = await runCli([
      '--no-color', 'skills', 'trust', 'release-check', '--workspace', workspace,
    ], environment);
    expect(unconfirmed.exitCode).toBe(1);
    expect(unconfirmed.stderr).toContain('requires explicit --yes confirmation');

    const trusted = await runCli([
      '--no-color', 'skills', 'trust', 'release-check', '--workspace', workspace, '--yes',
    ], environment);
    expect(trusted.exitCode).toBe(0);
    expect(trusted.stdout).toContain(`Trusted release-check (${initial.fingerprint.slice(0, 12)})`);

    const inspected = await runCli([
      '--no-color', 'skills', 'inspect', 'release-check', '--workspace', workspace, '--json',
    ], environment);
    expect(JSON.parse(inspected.stdout)).toMatchObject({
      trust: 'trusted', trustSource: 'decision', trusted: true, effect: 'auto-activate',
      fingerprint: initial.fingerprint,
    });

    await writeFile(skillFile, `${await readFile(skillFile, 'utf8')}\nA newly added network effect.\n`);
    const changed = await runCli([
      '--no-color', 'skills', 'inspect', 'release-check', '--workspace', workspace, '--json',
    ], environment);
    const changedSkill = JSON.parse(changed.stdout) as SkillJson;
    expect(changedSkill).toMatchObject({trust: 'changed', trusted: false, effect: 'blocked'});
    expect(changedSkill.fingerprint).not.toBe(initial.fingerprint);

    expect((await runCli([
      '--no-color', 'skills', 'trust', 'release-check', '--workspace', workspace, '--yes',
    ], environment)).exitCode).toBe(0);
    const revoked = await runCli([
      '--no-color', 'skills', 'revoke', 'release-check', '--workspace', workspace, '--yes',
    ], environment);
    expect(revoked.exitCode).toBe(0);
    expect(revoked.stdout).toContain('Revoked release-check; effect=blocked');

    const final = await runCli([
      '--no-color', 'skills', 'inspect', 'release-check', '--workspace', workspace, '--json',
    ], environment);
    expect(JSON.parse(final.stdout)).toMatchObject({trust: 'revoked', trusted: false, effect: 'blocked'});
  }, 45_000);
});

interface SkillJson {
  name: string;
  fingerprint: string;
  trust: string;
  trustSource: string;
  trusted: boolean;
  effect: string;
}

function skillSource(body: string): string {
  return `---
name: release-check
description: Verify release package contents before publishing.
---
# Release
${body}
`;
}

function findSkill(stdout: string): SkillJson {
  const skills = JSON.parse(stdout) as SkillJson[];
  const skill = skills.find((candidate) => candidate.name === 'release-check');
  if (!skill) throw new Error('release-check was not discovered');
  return skill;
}

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
