import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {describe, expect, it} from 'vitest';

import {
  PRODUCT_COMMAND,
  PRODUCT_ISSUES_URL,
  PRODUCT_REPO_URL,
  PRODUCT_WEBSITE_URL,
} from '../../src/brand.js';

describe('root help output', () => {
  it('groups every subcommand under a named heading', async () => {
    const result = await runCli(['--no-color', '--help']);
    expect(result.exitCode).toBe(0);
    for (const heading of [
      'Getting started:', 'Context & retrieval:', 'Sessions & recovery:', 'Agents & extensions:',
    ]) {
      expect(result.stdout).toContain(heading);
    }
    // A bare default heading means a subcommand was registered without a group.
    expect(result.stdout).not.toMatch(/^Commands:$/mu);
  }, 30_000);

  it('ends with usage examples and documentation pointers', async () => {
    const result = await runCli(['--no-color', '--help']);
    expect(result.exitCode).toBe(0);

    const examplesAt = result.stdout.indexOf('Examples:');
    const learnMoreAt = result.stdout.indexOf('Learn more:');
    expect(examplesAt).toBeGreaterThan(-1);
    expect(learnMoreAt).toBeGreaterThan(examplesAt);

    const examples = result.stdout.slice(examplesAt, learnMoreAt);
    expect(examples).toContain(`$ ${PRODUCT_COMMAND}`);
    expect(examples).toContain('-p');
    expect(examples).toContain('--continue');

    const learnMore = result.stdout.slice(learnMoreAt);
    expect(learnMore).toContain(PRODUCT_WEBSITE_URL);
    expect(learnMore).toContain(`${PRODUCT_REPO_URL}/blob/main/docs/ARCHITECTURE.md`);
    expect(learnMore).toContain(PRODUCT_ISSUES_URL);
  }, 30_000);
});

describe('feedback command', () => {
  it('prints the issues URL and a content-free environment summary', async () => {
    const result = await runCli(['--no-color', 'feedback']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(PRODUCT_ISSUES_URL);
    expect(result.stdout).toContain(`Node ${process.versions.node}`);
    expect(result.stdout).not.toMatch(/key|token|secret/iu);
  }, 30_000);
});

describe('package metadata', () => {
  it('publishes repository, homepage, and bugs URLs matching the brand', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      homepage?: string;
      repository?: {type?: string; url?: string};
      bugs?: {url?: string};
    };
    expect(packageJson.homepage).toBe(PRODUCT_WEBSITE_URL);
    expect(packageJson.repository).toEqual({type: 'git', url: `git+${PRODUCT_REPO_URL}.git`});
    expect(packageJson.bugs).toEqual({url: PRODUCT_ISSUES_URL});
  });
});

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
