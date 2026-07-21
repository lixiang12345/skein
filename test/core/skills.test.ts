import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {SkillCatalog, formatSkillsForPrompt} from '../../src/skills/catalog.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

describe('SkillCatalog', () => {
  it('discovers metadata first and activates only relevant skill content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-skills-'));
    roots.push(root);
    const path = join(root, '.agents', 'skills', 'release');
    await mkdir(path, {recursive: true});
    await writeFile(join(path, 'SKILL.md'), `---
name: release-check
description: Verify npm packages and release artifacts before publishing.
---
# Release
Run npm pack --dry-run and inspect the file list.
`);
    const catalog = new SkillCatalog(root, {
      enabled: true, directories: [], autoActivate: true, maxActive: 2, maxCharsPerSkill: 20_000,
    });
    const discovered = await catalog.discover();
    expect(discovered).toEqual(expect.arrayContaining([
      expect.objectContaining({name: 'release-check', scope: 'workspace'}),
    ]));
    expect(discovered.find((skill) => skill.name === 'release-check')).not.toHaveProperty('content');
    const active = await catalog.activate('Please verify the npm release package');
    expect(active[0]?.content).toContain('npm pack --dry-run');
    expect(formatSkillsForPrompt(active)).toContain('never override system safety');
  });
});
