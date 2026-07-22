import {access, chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {ContextEngine, mapExternalPath} from '../../src/context/context-engine.js';
import {LocalContextIndex} from '../../src/context/local-index.js';
import {defaultConfig} from '../../src/config.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

describe('LocalContextIndex', () => {
  it('maps ContextEngine multi-root aliases to their configured roots', () => {
    const main = '/tmp/mosaic-main';
    const extra = '/tmp/mosaic-extra';
    const third = '/tmp/mosaic-third';
    const configured = [main, extra, third];
    expect(mapExternalPath('main/src/index.ts', configured)).toBe(join(main, 'src/index.ts'));
    expect(mapExternalPath('workspace2/lib/util.ts', configured)).toBe(join(extra, 'lib/util.ts'));
    expect(mapExternalPath('workspace3/pkg/api.ts', configured)).toBe(join(third, 'pkg/api.ts'));
    expect(mapExternalPath('mosaic-extra/lib/util.ts', configured)).toBe(join(extra, 'lib/util.ts'));
    expect(mapExternalPath('relative.ts', configured)).toBe(join(main, 'relative.ts'));
    expect(mapExternalPath('main/../../secret.ts', configured)).toBeUndefined();
    expect(mapExternalPath('/tmp/not-a-mosaic-root/secret.ts', configured)).toBeUndefined();
    expect(mapExternalPath('workspace4/stale.ts', configured)).toBeUndefined();
  });

  it('uses the current ContextEngine CLI contract for index, search, and packing', async () => {
    const main = await mkdtemp(join(tmpdir(), 'mosaic-external-main-'));
    const extra = await mkdtemp(join(tmpdir(), 'mosaic-external-extra-'));
    const outside = await mkdtemp(join(tmpdir(), 'mosaic-external-outside-'));
    roots.push(main, extra, outside);
    await mkdir(join(extra, 'lib'));
    await writeFile(join(extra, 'lib', 'util.ts'), 'export const useful = true;\n');
    await writeFile(join(outside, 'secret.ts'), 'do not expose this\n');
    const log = join(main, 'contextengine-args.txt');
    const executable = join(main, 'contextengine-mock');
    await writeFile(executable, [
      '#!/bin/sh',
      `printf '%s\\n' "$*" > "${log}"`,
      'case "$1" in',
      '  status) echo \'{"ok":true}\' ;;',
      '  index) echo \'{"ok":true,"filesScanned":2}\' ;;',
      `  search) echo '[{"chunk":{"path":"workspace2/lib/util.ts","startLine":4,"endLine":8,"content":"export const useful = true;","symbol":"useful"},"score":0.9,"source":"hybrid"},{"chunk":{"path":"${join(outside, 'secret.ts')}","content":"do not expose this"},"score":1}]' ;;`,
      '  context) echo \'{"packedText":"<code>useful</code>","estimatedTokens":5,"truncated":false,"hits":[{"chunk":{"path":"workspace2/lib/util.ts","startLine":4,"endLine":8,"content":"export const useful = true;"},"score":0.9,"source":"hybrid"}]}\' ;;',
      'esac',
    ].join('\n'));
    await chmod(executable, 0o700);
    const config = defaultConfig(main);
    config.workspaceRoots = [main, extra];
    config.context.engine = 'contextengine';
    config.context.contextEngineCommand = executable;
    const engine = new ContextEngine(config);

    await expect(engine.index()).resolves.toMatchObject({
      engine: 'contextengine', ok: true, filesScanned: 2,
    });
    expect(await readFile(log, 'utf8')).toContain(`index ${main} --extra workspace2:${extra} --quiet`);
    await expect(engine.search('useful', 7)).resolves.toEqual([
      expect.objectContaining({path: join(extra, 'lib/util.ts'), startLine: 4, symbol: 'useful'}),
    ]);
    expect(await readFile(log, 'utf8')).toContain(`search useful --top-k 7 --json --root ${main}`);
    await expect(engine.pack('find useful')).resolves.toMatchObject({
      engine: 'contextengine', estimatedTokens: 5,
      hits: [expect.objectContaining({path: join(extra, 'lib/util.ts')})],
    });
    expect(await readFile(log, 'utf8')).toContain(`context find useful --max-tokens 12000 --json --root ${main}`);
  });

  it('falls back to the local index when auto external indexing fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-context-fallback-'));
    roots.push(root);
    await writeFile(join(root, 'source.ts'), 'export const fallbackValue = true;\n');
    const executable = join(root, 'contextengine-fail');
    await writeFile(executable, [
      '#!/bin/sh',
      'if [ "$1" = "status" ]; then echo "{\\"ok\\":true}"; exit 0; fi',
      'echo "external index unavailable" >&2',
      'exit 1',
    ].join('\n'));
    await chmod(executable, 0o700);
    const config = defaultConfig(root);
    config.context.engine = 'auto';
    config.context.contextEngineCommand = executable;
    const result = await new ContextEngine(config).index();
    expect(result.engine).toBe('local');
    expect(result.fallback).toBe('contextengine-index-failed');
    expect(result.files).toBe(1);

    config.context.engine = 'contextengine';
    await expect(new ContextEngine(config).index()).rejects.toThrow('external index unavailable');
  });

  it('does not pass packed context from out-of-workspace external hits to the model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-context-pack-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'mosaic-context-pack-outside-'));
    roots.push(root, outside);
    await writeFile(join(root, 'safe.ts'), 'export const safeContextValue = true;\n');
    const executable = join(root, 'contextengine-unsafe');
    await writeFile(join(outside, 'secret.ts'), 'OUTSIDE_SECRET\n');
    await symlink(outside, join(root, 'linked-outside'));
    await writeFile(executable, [
      '#!/bin/sh',
      'case "$1" in',
      '  status) echo \'{"ok":true}\' ;;',
      '  context) echo \'{"packedText":"OUTSIDE_SECRET","estimatedTokens":4,"hits":[{"chunk":{"path":"main/linked-outside/secret.ts","content":"OUTSIDE_SECRET"}}]}\' ;;',
      'esac',
    ].join('\n'));
    await chmod(executable, 0o700);
    const config = defaultConfig(root);
    config.context.engine = 'auto';
    config.context.contextEngineCommand = executable;

    const packed = await new ContextEngine(config).pack('safeContextValue');
    expect(packed.engine).toBe('local');
    expect(packed.text).toContain('safeContextValue');
    expect(packed.text).not.toContain('OUTSIDE_SECRET');

    config.context.engine = 'contextengine';
    await expect(new ContextEngine(config).pack('safeContextValue'))
      .rejects.toThrow('outside configured workspace roots');
  });

  it('does not auto-discover a ContextEngine executable from the workspace PATH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-context-path-root-'));
    roots.push(root);
    const bin = join(root, 'bin');
    const marker = join(root, 'executed');
    const executable = join(bin, 'mosaic-contextengine-path-test');
    await mkdir(bin);
    await writeFile(executable, '#!/bin/sh\nprintf ran > "$MOSAIC_CONTEXT_MARKER"\n');
    await chmod(executable, 0o700);
    const previousPath = process.env.PATH;
    const previousMarker = process.env.MOSAIC_CONTEXT_MARKER;
    try {
      process.env.PATH = `${bin}${delimiter}${previousPath ?? ''}`;
      process.env.MOSAIC_CONTEXT_MARKER = marker;
      const config = defaultConfig(root);
      config.context.contextEngineCommand = 'mosaic-contextengine-path-test';
      expect(await new ContextEngine(config).canUseExternal()).toBe(false);
      await expect(access(marker)).rejects.toMatchObject({code: 'ENOENT'});
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousMarker === undefined) delete process.env.MOSAIC_CONTEXT_MARKER;
      else process.env.MOSAIC_CONTEXT_MARKER = previousMarker;
    }
  });

  it('indexes symbols and ranks identifier matches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-context-'));
    roots.push(root);
    await writeFile(join(root, 'payments.ts'), [
      'export function processPayment(input: PaymentInput) {',
      '  return chargeGateway(input);',
      '}',
      '',
      'export function unrelated() { return null; }',
    ].join('\n'));
    await writeFile(join(root, 'README.md'), 'The payment service retries a webhook.\n');
    const interrupted = join(root, '.skein.rollback-00000000-0000-4000-8000-000000000010');
    await mkdir(interrupted);
    await writeFile(join(interrupted, 'private-session.json'), '{"secret":"do-not-index"}\n');
    await mkdir(join(root, '.skein.lock'));
    await writeFile(join(root, '.skein.lock', 'owner.json'), '{"pid":123}\n');

    const index = new LocalContextIndex([root]);
    const stats = await index.build();
    expect(stats.files).toBe(2);
    expect((await stat(index.indexPath)).mode & 0o777).toBe(0o600);
    const hits = await index.search('processPayment', 3);
    expect(hits[0]?.path).toBe(join(root, 'payments.ts'));
    expect(hits[0]?.symbol).toBe('processPayment');
  });

  it('keeps status reads side-effect free and emits stable multi-root aliases', async () => {
    const main = await mkdtemp(join(tmpdir(), 'mosaic-context-main-'));
    const extra = await mkdtemp(join(tmpdir(), 'mosaic-context-extra-'));
    roots.push(main, extra);
    const index = new LocalContextIndex([main, extra]);
    expect(await index.load()).toBe(false);
    await expect(access(join(main, '.mosaic'))).rejects.toMatchObject({code: 'ENOENT'});

    await writeFile(join(extra, 'useful.ts'), 'export const multiRootValue = true;\n');
    await index.build();
    const packed = await index.pack('multiRootValue', 3, 200);
    expect(packed.text).toContain('path="workspace2/useful.ts"');
    expect(packed.text).not.toContain('../');
  });

  it('does not load a local index through a symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-index-symlink-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'mosaic-index-symlink-outside-'));
    roots.push(root, outside);
    await mkdir(join(root, '.mosaic'), {recursive: true});
    const outsideIndex = join(outside, 'index.json');
    await writeFile(outsideIndex, '{"version":1,"createdAt":"now","roots":[],"files":[]}\n');
    const index = new LocalContextIndex([root]);
    await symlink(outsideIndex, index.indexPath);
    expect(await index.load()).toBe(false);
  });

  it('packs under a token budget and reports truncation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-pack-'));
    roots.push(root);
    await writeFile(join(root, 'large.ts'), `${'export const importantValue = 1;\n'.repeat(80)}`);
    const index = new LocalContextIndex([root]);
    await index.build();
    const packed = await index.pack('importantValue', 5, 20);
    expect(packed.engine).toBe('local');
    expect(packed.truncated).toBe(true);
    expect(packed.estimatedTokens).toBeLessThanOrEqual(20);
  });

  it('drops out-of-workspace entries from a tampered local index', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-index-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'mosaic-index-outside-'));
    roots.push(root, outside);
    await writeFile(join(root, 'inside.ts'), 'export const insideValue = 1;\n');
    await writeFile(join(outside, 'secret.ts'), 'export const secretValue = 2;\n');
    const first = new LocalContextIndex([root]);
    await first.build();
    const raw = JSON.parse(await readFile(first.indexPath, 'utf8')) as {
      files: Array<{absolutePath: string; chunks: Array<{absolutePath: string}>}>;
    };
    const file = raw.files[0];
    if (!file) throw new Error('Expected an indexed file.');
    file.absolutePath = join(outside, 'secret.ts');
    for (const chunk of file.chunks) chunk.absolutePath = file.absolutePath;
    await writeFile(first.indexPath, `${JSON.stringify(raw)}\n`);
    const reloaded = new LocalContextIndex([root]);
    expect(await reloaded.load()).toBe(true);
    expect(reloaded.status().files).toBe(0);
  });
});
