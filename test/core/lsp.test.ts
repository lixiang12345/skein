import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';
import {defaultConfig} from '../../src/config.js';
import {createSession} from '../../src/session/store.js';
import {createDefaultToolRegistry, createLspTool, WorkspaceAccess} from '../../src/tools/index.js';
import type {LspConfig} from '../../src/types.js';

const roots: string[] = [];
const fixture = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'fake-lsp-server.mjs');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

describe('optional LSP tool', () => {
  it('queries definitions and removes locations outside the workspace', async () => {
    const {root, tool, context} = await setup();
    const result = await tool.execute({operation: 'definition', path: 'sample.ts', line: 1, character: 0}, context);

    expect(result.content).toContain('LSP definition sample.ts:1:0');
    expect(result.content).toContain('sample.ts:2:2-2:8');
    expect(result.content).toContain('1 unsafe or excess location(s) omitted');
    expect(result.content).not.toContain('/etc/hosts');
    expect(result.metadata).toMatchObject({server: 'typescript', count: 1, discarded: 1});
    expect(root).toBeTruthy();
  });

  it('queries references and diagnostics without network or model access', async () => {
    const {tool, context} = await setup();
    const references = await tool.execute({operation: 'references', path: 'sample.ts', line: 2}, context);
    expect(references.content).toContain('sample.ts:3:0-3:6');
    expect(references.content).toContain('sample.ts:4:0-4:6');

    const diagnostics = await tool.execute({operation: 'diagnostics', path: 'sample.ts'}, context);
    expect(diagnostics.content).toContain('warning 5:1 fake server W1 example diagnostic');
    expect(diagnostics.metadata).toMatchObject({operation: 'diagnostics', count: 1});
  });

  it('is absent unless explicitly enabled with at least one server', () => {
    const disabled = config(false);
    expect(createDefaultToolRegistry({lsp: disabled}).has('lsp_query')).toBe(false);
    const enabled = config(true);
    expect(createDefaultToolRegistry({lsp: enabled}).has('lsp_query')).toBe(true);
  });

  it('degrades clearly when no server handles the file type', async () => {
    const {tool, context} = await setup();
    await writeFile(join(context.workspace.primaryRoot, 'sample.py'), 'print("ok")\n');
    await expect(tool.execute({operation: 'definition', path: 'sample.py', line: 1}, context))
      .rejects.toThrow('No enabled LSP server is configured for .py');
  });
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'skein-lsp-'));
  roots.push(root);
  await writeFile(join(root, 'sample.ts'), 'const value = 1;\nvalue;\nvalue;\nvalue;\nvalue;\n');
  const mosaic = defaultConfig(root);
  const lsp = config(true);
  mosaic.lsp = lsp;
  return {
    root,
    tool: createLspTool(lsp),
    context: {
      config: mosaic,
      workspace: new WorkspaceAccess([root]),
      session: createSession({workspace: root, provider: 'compatible', model: 'test'}),
    },
  };
}

function config(enabled: boolean): LspConfig {
  return {
    enabled,
    timeoutMs: 2_000,
    servers: {
      typescript: {
        command: process.execPath,
        args: [fixture],
        extensions: ['.ts'],
        languageId: 'typescript',
      },
    },
  };
}
