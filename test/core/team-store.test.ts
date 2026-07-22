import {mkdtemp, mkdir, rm, symlink, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {TeamRunStore} from '../../src/agent/team-store.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true}))));

describe('team run blackboard', () => {
  it('persists content-addressed reports and peer messages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-team-store-'));
    roots.push(root);
    const store = new TeamRunStore(root);
    const run = await store.create({objective: 'Ship a safe team loop', reviewer: 'reviewer', maxReviewRounds: 1});
    await Promise.all([
      store.recordAgent(run.id, {
        id: randomUUID(), profile: 'backend', provider: 'openai', model: 'gpt-test', phase: 'work', ok: true,
        report: 'State and cancellation are bounded.',
      }),
      store.recordMessage(run.id, {
        id: randomUUID(), from: 'backend', to: 'reviewer', content: 'Please verify cancellation.',
      }),
    ]);
    await store.complete(run.id, {accepted: true, reviewRounds: 0});
    const loaded = await store.load(run.id);
    expect(loaded.status).toBe('accepted');
    expect(loaded.agents).toHaveLength(1);
    expect(loaded.messages).toHaveLength(1);
    expect(await store.readArtifact(run.id, loaded.agents[0]!.report)).toContain('cancellation');
    expect((await store.list())[0]).toMatchObject({id: run.id, status: 'accepted', agentCount: 1, messageCount: 1});
  });

  it('detects tampered artifacts and preserves the original manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-team-store-tamper-'));
    roots.push(root);
    const store = new TeamRunStore(root);
    const run = await store.create({objective: 'Test integrity', reviewer: 'reviewer', maxReviewRounds: 0});
    await store.recordAgent(run.id, {
      id: randomUUID(), profile: 'tester', provider: 'compatible', model: 'test', phase: 'review', ok: true,
      report: 'Original report.',
    });
    const loaded = await store.load(run.id, false);
    const blob = join(store.directory, run.id, 'blobs', `${loaded.agents[0]!.report.sha256}.txt`);
    await writeFile(blob, 'tampered');
    await expect(store.load(run.id)).rejects.toThrow('integrity');
  });

  it('fails closed on a symlinked run directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-team-store-link-'));
    const outside = await mkdtemp(join(tmpdir(), 'skein-team-store-outside-'));
    roots.push(root, outside);
    const store = new TeamRunStore(root);
    await mkdir(store.directory, {recursive: true});
    await symlink(outside, join(store.directory, randomUUID()));
    await expect(store.list()).resolves.toEqual([]);
  });
});
