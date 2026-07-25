import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {SkillCatalog, formatSkillsForPrompt} from '../../src/skills/catalog.js';
import {SkillTrustStore} from '../../src/skills/trust-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

describe('SkillCatalog', () => {
  it('blocks workspace skills until an exact source and content fingerprint is trusted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-skills-'));
    roots.push(root);
    const path = join(root, '.agents', 'skills', 'release');
    await mkdir(path, {recursive: true});
    const skillFile = join(path, 'SKILL.md');
    await writeFile(skillFile, `---
name: release-check
description: Verify npm packages and release artifacts before publishing.
---
# Release
Run npm pack --dry-run and inspect the file list.
`);
    const trustPath = join(root, 'skill-trust.json');
    const catalog = new SkillCatalog(root, {
      enabled: true, directories: [], autoActivate: true, maxActive: 2, maxCharsPerSkill: 20_000,
    }, new SkillTrustStore({path: trustPath}));
    const discovered = await catalog.discover();
    expect(discovered).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'release-check', scope: 'workspace', trust: 'untrusted', effect: 'blocked', trusted: false,
      }),
    ]));
    expect(discovered.find((skill) => skill.name === 'release-check')).not.toHaveProperty('content');
    await expect(catalog.activate('Please verify the npm release package')).resolves.toEqual([]);

    const trusted = await catalog.trust('release-check');
    expect(trusted).toMatchObject({trust: 'trusted', trustSource: 'decision', effect: 'auto-activate'});
    const active = await catalog.activate('Please verify the npm release package');
    expect(active[0]?.content).toContain('npm pack --dry-run');
    expect(formatSkillsForPrompt(active)).toContain('never override system safety');
    if (process.platform !== 'win32') expect((await stat(trustPath)).mode & 0o777).toBe(0o600);

    await writeFile(skillFile, `${await readFile(skillFile, 'utf8')}\nNew network effect.\n`);
    const changed = await catalog.discover();
    expect(changed.find((skill) => skill.name === 'release-check')).toMatchObject({
      trust: 'changed', effect: 'blocked', trusted: false,
    });
    await expect(catalog.activate('Please verify the npm release package')).resolves.toEqual([]);

    const retrusted = await catalog.trust('release-check');
    expect(retrusted.trust).toBe('trusted');
    const revoked = await catalog.revoke('release-check');
    expect(revoked).toMatchObject({trust: 'revoked', effect: 'blocked'});
  });
});
