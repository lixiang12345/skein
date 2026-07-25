import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {evaluateReuseGate} from '../../src/agent/reuse-gate.js';
import type {ContextProvider} from '../../src/tools/types.js';
import {WorkspaceAccess} from '../../src/tools/workspace.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

function context(hits: Awaited<ReturnType<ContextProvider['search']>>): ContextProvider {
  return {
    async pack() { return {text: '', hits: [], estimatedTokens: 0, engine: 'test', truncated: false}; },
    async search() { return hits; },
    async flushDirty() { return {status: 'current', generation: 'g-test', paths: 0}; },
  };
}

describe('reuse gate', () => {
  it('records current helper evidence without retaining source or query text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-reuse-gate-'));
    roots.push(root);
    const helper = join(root, 'src', 'helper.ts');
    await mkdir(join(root, 'src'), {recursive: true});
    await writeFile(helper, 'export function parseThing(value: string) { return value.trim(); }\n');
    const result = await evaluateReuseGate({
      requestId: '2e1b1e8a-8dd4-477d-a66c-2b8b9ee3f8f1',
      request: 'add a parser helper',
      changeSequence: 0,
      call: {name: 'write_file', arguments: {
        path: 'src/parser.ts',
        content: 'export function parseThing(value: string) { return value.trim(); }\n',
      }},
      context: context([{
        path: helper, startLine: 1, endLine: 1, content: 'secret source bytes', score: 0.934,
        source: 'local', symbol: 'parseThing',
      }]),
      workspace: new WorkspaceAccess([root]),
    });

    expect(result.receipt).toMatchObject({
      decision: 'reuse', status: 'warning', indexGeneration: 'g-test',
      selectedPath: helper, selectedSymbol: 'parseThing', warningOnly: true,
    });
    expect(JSON.stringify(result)).not.toContain('secret source bytes');
    expect(JSON.stringify(result)).not.toContain('add a parser helper');
    expect(result.warning).toContain('warning-only');
  });

  it('labels unreadable candidates unresolved instead of claiming new is safe', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-reuse-unresolved-'));
    roots.push(root);
    const result = await evaluateReuseGate({
      requestId: '2e1b1e8a-8dd4-477d-a66c-2b8b9ee3f8f1',
      request: 'add parser',
      changeSequence: 0,
      call: {name: 'write_file', arguments: {
        path: 'src/parser.ts', content: 'export function parseThing(value: string) { return value.trim(); }',
      }},
      context: context([{
        path: join(root, 'missing.ts'), startLine: 1, endLine: 2, content: 'candidate', score: 0.8,
        source: 'local', symbol: 'other',
      }]),
      workspace: new WorkspaceAccess([root]),
    });
    expect(result.receipt).toMatchObject({decision: 'unresolved', status: 'unresolved'});
  });

  it('skips docs, config, and test fixture writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-reuse-exempt-'));
    roots.push(root);
    for (const path of ['docs/guide.md', 'config.json', 'test/fixtures/new.ts']) {
      const result = await evaluateReuseGate({
        requestId: '2e1b1e8a-8dd4-477d-a66c-2b8b9ee3f8f1', request: 'add helper', changeSequence: 0,
        call: {name: 'write_file', arguments: {path, content: 'export function helper() { return true; }'}},
        context: context([]), workspace: new WorkspaceAccess([root]),
      });
      expect(result.triggered).toBe(false);
      expect(result.receipt).toBeUndefined();
    }
  });

  it('skips an apply_patch local edit to an existing symbol', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-reuse-local-edit-'));
    roots.push(root);
    await writeFile(join(root, 'existing.ts'), 'export function existing() { return false; }\n');
    const result = await evaluateReuseGate({
      requestId: '2e1b1e8a-8dd4-477d-a66c-2b8b9ee3f8f1', request: 'fix existing', changeSequence: 0,
      call: {name: 'apply_patch', arguments: {patch: [
        '*** Begin Patch',
        '*** Update File: existing.ts',
        '@@',
        '-export function existing() { return false; }',
        '+export function existing() { return true; }',
        '*** End Patch',
      ].join('\n')}},
      context: context([]), workspace: new WorkspaceAccess([root]),
    });
    expect(result.triggered).toBe(false);
  });

  it('marks provider degradation unresolved even when search returns no hits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-reuse-degraded-'));
    roots.push(root);
    const degraded: ContextProvider = {
      ...context([]),
      lastDegradation() { return {code: 'test', summary: 'contains secret detail'}; },
    };
    const result = await evaluateReuseGate({
      requestId: '2e1b1e8a-8dd4-477d-a66c-2b8b9ee3f8f1', request: 'add parser', changeSequence: 0,
      call: {name: 'write_file', arguments: {
        path: 'parser.ts', content: 'export function parser() { return true; }',
      }},
      context: degraded, workspace: new WorkspaceAccess([root]),
    });
    expect(result.receipt).toMatchObject({decision: 'unresolved', status: 'unresolved'});
    expect(JSON.stringify(result)).not.toContain('secret detail');
  });
});
