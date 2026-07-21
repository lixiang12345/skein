import {mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {discoverWorkspaceRules, formatWorkspaceRules} from '../../src/agent/rules.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

describe('workspace rules', () => {
  it('discovers supported rule files and formats bounded XML sections', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-rules-'));
    roots.push(root);
    await writeFile(join(root, 'AGENTS.md'), '# Keep changes small\n');
    const rules = await discoverWorkspaceRules(root);
    const workspaceRule = rules.find((rule) => rule.path.endsWith('/AGENTS.md'));
    expect(workspaceRule?.scope).toBe('workspace');
    expect(formatWorkspaceRules(rules)).toContain('<workspace-rule');
    expect(formatWorkspaceRules(rules)).toContain('Keep changes small');
  });

  it('does not load workspace rules through an outside symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-rules-symlink-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'mosaic-rules-symlink-outside-'));
    roots.push(root, outside);
    await writeFile(join(outside, 'AGENTS.md'), 'outside instructions\n');
    await symlink(join(outside, 'AGENTS.md'), join(root, 'AGENTS.md'));

    const rules = await discoverWorkspaceRules(root);
    expect(rules.some((rule) => rule.path === join(root, 'AGENTS.md'))).toBe(false);
  });
});
