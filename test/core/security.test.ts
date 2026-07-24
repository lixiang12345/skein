import {access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {WorkspaceAccess} from '../../src/tools/workspace.js';
import {
  evaluatePermission,
  matchesAllowedCommand,
  matchesDeniedCommand,
  permissionKey,
  permissionTarget,
} from '../../src/tools/permissions.js';
import {defaultPermissions} from '../../src/config.js';
import {gitTool} from '../../src/tools/git.js';
import {shellTool} from '../../src/tools/shell.js';
import {resolveMentions} from '../../src/context/mentions.js';
import type {ToolCall} from '../../src/types.js';
import {runProcess} from '../../src/utils/process.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

describe('workspace and permission boundaries', () => {
  it('rejects traversal and symlink escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-boundary-'));
    const outside = await mkdtemp(join(tmpdir(), 'mosaic-outside-'));
    roots.push(root, outside);
    await writeFile(join(outside, 'secret.txt'), 'private');
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
    const workspace = new WorkspaceAccess([root]);
    await expect(workspace.resolvePath('../secret.txt')).rejects.toThrow('outside');
    await expect(workspace.resolvePath('link.txt')).rejects.toThrow('symbolic link');
  });

  it('resolves local retrieval root aliases without losing workspace boundaries', async () => {
    const main = await mkdtemp(join(tmpdir(), 'mosaic-alias-main-'));
    const extra = await mkdtemp(join(tmpdir(), 'mosaic-alias-extra-'));
    roots.push(main, extra);
    await writeFile(join(main, 'main.ts'), 'main');
    await writeFile(join(extra, 'extra.ts'), 'extra');
    const workspace = new WorkspaceAccess([main, extra]);
    await expect(workspace.resolvePath('main/main.ts')).resolves.toBe(join(main, 'main.ts'));
    await expect(workspace.resolvePath('workspace2/extra.ts')).resolves.toBe(join(extra, 'extra.ts'));
    await expect(workspace.resolvePath('workspace3/missing.ts')).rejects.toThrow('outside');
  });

  it('lets deny rules win over allow rules and shell controls', () => {
    expect(matchesAllowedCommand('npm test -- --runInBand', 'npm test ')).toBe(true);
    expect(matchesAllowedCommand('npm test; rm -rf /', 'npm test ')).toBe(false);
    expect(matchesDeniedCommand('git reset --hard HEAD', 'git reset --hard')).toBe(true);
    expect(matchesDeniedCommand('echo ok;rm -rf /', 'rm -rf /')).toBe(true);
    expect(matchesDeniedCommand('echo ok&&sudo whoami', 'sudo')).toBe(true);
    for (const command of [
      '/bin/rm -rf /',
      'command rm -rf /',
      '$(rm -rf /)',
      '`rm -rf /`',
    ]) {
      expect(matchesDeniedCommand(command, 'rm -rf /')).toBe(true);
      expect(evaluatePermission(
        {...defaultPermissions, shell: 'allow'},
        {id: command, name: 'shell', arguments: {command}},
        'shell',
      ).outcome).toBe('deny');
    }
    const call: ToolCall = {id: '1', name: 'shell', arguments: {command: 'rm -rf /'}};
    expect(evaluatePermission(defaultPermissions, call, 'shell').outcome).toBe('deny');
  });

  it('scopes session approvals to a concrete command or resource without leaking it', () => {
    const first = permissionKey({
      id: '1', name: 'shell', arguments: {command: 'npm run build -- --token secret-value'},
    }, 'shell');
    const same = permissionKey({
      id: '2', name: 'shell', arguments: {command: 'npm  run build -- --token secret-value'},
    }, 'shell');
    const differentCommand = permissionKey({
      id: '3', name: 'shell', arguments: {command: 'npm test'},
    }, 'shell');
    const firstPath = permissionKey({
      id: '4', name: 'write_file', arguments: {path: 'src/first.ts', content: 'secret'},
    }, 'write');
    const secondPath = permissionKey({
      id: '5', name: 'write_file', arguments: {path: 'src/second.ts', content: 'secret'},
    }, 'write');
    expect(first).toBe(same);
    expect(first).not.toBe(differentCommand);
    expect(firstPath).not.toBe(secondPath);
    expect(first).not.toContain('secret-value');
    expect(firstPath).not.toContain('src/first.ts');
  });

  it('does not reuse command approvals across working directories, environments, or stdin', () => {
    const commandCall = (overrides: Record<string, unknown> = {}): ToolCall => ({
      id: 'shell',
      name: 'shell',
      arguments: {command: 'npm test', cwd: 'packages/api', ...overrides},
    });
    const baseline = permissionKey(commandCall(), 'shell');
    expect(permissionKey(commandCall({cwd: 'packages/web'}), 'shell')).not.toBe(baseline);

    const firstEnvironment = permissionKey(commandCall({
      env: {API_TOKEN: 'first-secret', NODE_ENV: 'test'},
    }), 'shell');
    const reorderedEnvironment = permissionKey(commandCall({
      env: {NODE_ENV: 'test', API_TOKEN: 'first-secret'},
    }), 'shell');
    const differentEnvironment = permissionKey(commandCall({
      env: {API_TOKEN: 'second-secret', NODE_ENV: 'test'},
    }), 'shell');
    expect(firstEnvironment).toBe(reorderedEnvironment);
    expect(differentEnvironment).not.toBe(firstEnvironment);
    expect(firstEnvironment).not.toContain('first-secret');
    expect(permissionTarget(commandCall({
      env: {API_TOKEN: 'first-secret', NODE_ENV: 'test'},
    }))).not.toContain('first-secret');

    const firstStdin = permissionKey(commandCall({stdin: 'first-input'}), 'shell');
    const secondStdin = permissionKey(commandCall({stdin: 'second-input'}), 'shell');
    expect(firstStdin).not.toBe(secondStdin);
    expect(firstStdin).not.toContain('first-input');

    const gitCall = (cwd: string, args = ['status']): ToolCall => ({
      id: cwd,
      name: 'git',
      arguments: {args, cwd},
    });
    expect(permissionKey(gitCall('packages/api'), 'git'))
      .not.toBe(permissionKey(gitCall('packages/web'), 'git'));
    expect(permissionKey(gitCall('packages/api', ['checkout', '--', 'a b']), 'git'))
      .not.toBe(permissionKey(gitCall('packages/api', ['checkout', '--', 'a', 'b']), 'git'));
  });

  it('scopes network approvals to the full URL, method, and request body', () => {
    const requestCall = (overrides: Record<string, unknown> = {}): ToolCall => ({
      id: 'request',
      name: 'http_request',
      arguments: {
        url: 'https://user:password@example.test/items?token=first#summary',
        method: 'POST',
        body: {operation: 'create', apiKey: 'body-secret'},
        ...overrides,
      },
    });
    const baseline = permissionKey(requestCall(), 'network');
    expect(permissionKey(requestCall({
      url: 'https://user:password@example.test/items?token=second#summary',
    }), 'network')).not.toBe(baseline);
    expect(permissionKey(requestCall({
      url: 'https://user:password@example.test/items?token=first#details',
    }), 'network')).not.toBe(baseline);
    expect(permissionKey(requestCall({method: 'PUT'}), 'network')).not.toBe(baseline);
    expect(permissionKey(requestCall({
      body: {operation: 'delete', apiKey: 'body-secret'},
    }), 'network')).not.toBe(baseline);
    expect(baseline).not.toContain('password');
    expect(baseline).not.toContain('first');
    expect(baseline).not.toContain('body-secret');
    const target = permissionTarget(requestCall());
    expect(target).not.toContain('password');
    expect(target).not.toContain('token=first');
    expect(target).not.toContain('body-secret');
    expect(permissionTarget(requestCall({
      url: 'https://user:password@example.test/items?token=second#summary',
    }))).not.toBe(target);
    expect(permissionTarget(requestCall({method: 'PUT'}))).not.toBe(target);
    expect(permissionTarget(requestCall({
      body: {operation: 'delete', apiKey: 'body-secret'},
    }))).not.toBe(target);
    expect(permissionTarget(requestCall({
      url: 'https://user:password@[]/items?token=malformed-secret',
    }))).not.toContain('malformed-secret');

    const mcpCall = (title: string): ToolCall => ({
      id: title,
      name: 'mcp_github_create_issue',
      arguments: {server: 'github', owner: 'skein', repository: 'cli', title},
    });
    expect(permissionKey(mcpCall('First issue'), 'network'))
      .not.toBe(permissionKey(mcpCall('Second issue'), 'network'));
  });

  it('rejects Git options that can execute config or escape the workspace', () => {
    expect(() => gitTool.permissionCategories?.({args: ['-c', 'alias.pwn=!touch marker', 'pwn']}))
      .toThrow('not allowed');
    expect(() => gitTool.permissionCategories?.({args: ['--upload-pack=touch marker', 'fetch']}))
      .toThrow('not allowed');
    expect(() => gitTool.permissionCategories?.({args: ['archive', '-o', '/tmp/archive.zip', 'HEAD']}))
      .toThrow('subcommand is not allowed');
    expect(() => gitTool.permissionCategories?.({args: ['clone', '-u', '/tmp/upload-pack', 'https://example.test/repo']}))
      .toThrow('not allowed');
    expect(() => gitTool.permissionCategories?.({args: ['bisect', 'run', 'touch', 'marker']}))
      .toThrow('arbitrary commands');
    expect(() => gitTool.permissionCategories?.({args: ['submodule', 'foreach', 'touch marker']}))
      .toThrow('arbitrary commands');
    expect(() => gitTool.permissionCategories?.({args: ['rebase', '-x', 'touch marker', 'HEAD']}))
      .toThrow('not allowed');
    expect(() => gitTool.permissionCategories?.({args: ['apply', '--unsafe-paths', 'change.patch']}))
      .toThrow('not allowed');
    expect(() => gitTool.permissionCategories?.({args: ['grep', '--open-files-in-pager=sh', 'token']}))
      .toThrow('not allowed');
    expect(gitTool.permissionCategories?.({args: ['verify-commit', 'HEAD']})).toContain('shell');
  });

  it('isolates Git execution from inherited workspace and external-diff overrides', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-git-env-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'mosaic-git-env-outside-'));
    roots.push(root, outside);
    await runProcess('git', ['init', '--quiet'], {cwd: root});
    await runProcess('git', ['init', '--quiet'], {cwd: outside});
    await writeFile(join(root, 'inside.txt'), 'before\n');
    await writeFile(join(outside, 'outside.txt'), 'outside\n');
    await runProcess('git', ['add', 'inside.txt'], {cwd: root});
    await runProcess('git', [
      '-c', 'user.name=Mosaic Test',
      '-c', 'user.email=mosaic@example.test',
      'commit', '--quiet', '-m', 'initial',
    ], {cwd: root});
    await writeFile(join(root, 'inside.txt'), 'after\n');
    const marker = join(outside, 'external-diff-ran');
    const externalDiff = join(outside, 'external-diff.sh');
    await writeFile(externalDiff, '#!/bin/sh\nprintf ran > "$MOSAIC_GIT_MARKER"\n');
    await chmod(externalDiff, 0o700);
    const previous = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE,
      GIT_EXTERNAL_DIFF: process.env.GIT_EXTERNAL_DIFF,
      MOSAIC_GIT_MARKER: process.env.MOSAIC_GIT_MARKER,
      PATH: process.env.PATH,
    };
    try {
      const injectedBin = join(root, 'bin');
      const injectedGit = join(injectedBin, 'git');
      const injectedMarker = join(outside, 'injected-git-ran');
      await mkdir(injectedBin);
      await writeFile(injectedGit, '#!/bin/sh\nprintf ran > "$MOSAIC_GIT_MARKER"\n');
      await chmod(injectedGit, 0o700);
      process.env.PATH = `${injectedBin}${delimiter}${process.env.PATH ?? ''}`;
      process.env.MOSAIC_GIT_MARKER = injectedMarker;
      process.env.GIT_DIR = join(outside, '.git');
      process.env.GIT_WORK_TREE = outside;
      const context = {
        workspace: new WorkspaceAccess([root]),
        config: {} as never,
        session: {} as never,
      };
      const status = await gitTool.execute({args: ['status', '--short']}, context);
      expect(status.ok).toBe(true);
      expect(status.content).toContain('inside.txt');
      expect(status.content).not.toContain('outside.txt');
      await expect(access(injectedMarker)).rejects.toMatchObject({code: 'ENOENT'});

      delete process.env.GIT_DIR;
      delete process.env.GIT_WORK_TREE;
      process.env.GIT_EXTERNAL_DIFF = externalDiff;
      process.env.MOSAIC_GIT_MARKER = marker;
      const diff = await gitTool.execute({args: ['diff']}, context);
      expect(diff.ok).toBe(true);
      expect(diff.content).toContain('+after');
      await expect(access(marker)).rejects.toMatchObject({code: 'ENOENT'});

      const restore = await gitTool.execute({args: ['restore', 'inside.txt']}, context);
      expect(restore.ok).toBe(true);
      expect(restore.changedFiles).toEqual([join(root, 'inside.txt')]);
      expect(await readFile(join(root, 'inside.txt'), 'utf8')).toBe('before\n');
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('rejects Git destinations outside configured workspace roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-git-boundary-'));
    const outside = await mkdtemp(join(tmpdir(), 'mosaic-git-outside-'));
    roots.push(root, outside);
    const workspace = new WorkspaceAccess([root]);
    await expect(gitTool.affectedPaths?.({args: ['init', outside]}, {
      workspace,
      config: {} as never,
      session: {} as never,
    })).rejects.toThrow('outside');
  });

  it('does not read a file mention through an outside symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-mention-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'mosaic-mention-outside-'));
    roots.push(root, outside);
    await writeFile(join(outside, 'secret.txt'), 'do not disclose');
    await symlink(join(outside, 'secret.txt'), join(root, 'secret.txt'));
    await expect(resolveMentions('Explain @secret.txt', [root])).resolves.toEqual([]);
  });

  it('resolves explicit multi-root aliases in file mentions', async () => {
    const main = await mkdtemp(join(tmpdir(), 'mosaic-mention-main-'));
    const extra = await mkdtemp(join(tmpdir(), 'mosaic-mention-extra-'));
    roots.push(main, extra);
    await writeFile(join(extra, 'shared.ts'), 'export const sharedValue = true;\n');
    await expect(resolveMentions('Inspect @workspace2/shared.ts', [main, extra]))
      .resolves.toEqual([
        expect.objectContaining({
          path: join(extra, 'shared.ts'),
          content: expect.stringContaining('sharedValue'),
        }),
      ]);
  });

  it('requires approval for custom shell environments and catches wrapped network commands', () => {
    const shellAllow = {...defaultPermissions, shell: 'allow' as const};
    expect(evaluatePermission(shellAllow, {
      id: 'env', name: 'shell', arguments: {command: 'npm test', env: {NODE_ENV: 'test'}},
    }, 'shell').outcome).toBe('ask');
    expect(() => shellTool.permissionCategories?.({
      command: 'npm test', env: {NODE_OPTIONS: '--require=/tmp/hook.js'},
    })).toThrow('not allowed');
    expect(() => shellTool.permissionCategories?.({
      command: 'git status', env: {GIT_DIR: '/tmp/outside'},
    })).toThrow('not allowed');

    for (const command of [
      'FOO=1 curl https://example.com',
      'sudo curl https://example.com',
      'env FOO=1 python -c "import urllib.request"',
      '/usr/bin/python3.12 -c "import urllib.request"',
      '/usr/bin/git pull',
      '/usr/bin/npm test',
      '/bin/sh ./project-script.sh',
    ]) {
      expect(shellTool.permissionCategories?.({command})).toContain('network');
    }
    expect(shellTool.permissionCategories?.({command: 'echo ok > result.txt'})).toContain('write');
    expect(shellTool.permissionCategories?.({command: "sed -i '' 's/old/new/' file.txt"})).toContain('write');
    expect(shellTool.permissionCategories?.({command: 'git branch feature'})).toEqual(
      expect.arrayContaining(['git', 'write']),
    );
  });

  it('does not let a command allow rule bypass derived safety categories', () => {
    const packageCall: ToolCall = {id: 'package', name: 'shell', arguments: {command: 'npm test'}};
    expect(shellTool.permissionCategories?.(packageCall.arguments)).toEqual(
      expect.arrayContaining(['shell', 'write', 'network']),
    );
    expect(evaluatePermission(defaultPermissions, packageCall, 'shell').outcome).toBe('allow');
    expect(evaluatePermission(defaultPermissions, packageCall, 'write').outcome).toBe('ask');
    expect(evaluatePermission(defaultPermissions, packageCall, 'network').outcome).toBe('ask');

    const shellGit: ToolCall = {id: 'git', name: 'shell', arguments: {command: 'git status'}};
    expect(shellTool.permissionCategories?.(shellGit.arguments)).toContain('git');
    expect(evaluatePermission(defaultPermissions, shellGit, 'shell').outcome).toBe('allow');
    expect(evaluatePermission(defaultPermissions, shellGit, 'git').outcome).toBe('ask');

    const outsideSearch: ToolCall = {id: 'search', name: 'shell', arguments: {command: 'rg token /etc'}};
    expect(evaluatePermission(defaultPermissions, outsideSearch, 'shell').outcome).toBe('ask');
  });

  it('tracks common shell redirection targets as changed files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-shell-tracking-'));
    roots.push(root);
    const context = {
      workspace: new WorkspaceAccess([root]),
      config: {} as never,
      session: {} as never,
    };
    const arguments_ = {command: 'printf tracked > tracked.txt'};
    await expect(shellTool.affectedPaths?.(arguments_, context))
      .resolves.toEqual([join(root, 'tracked.txt')]);
    const result = await shellTool.execute(arguments_, context);
    expect(result.ok).toBe(true);
    expect(result.changedFiles).toEqual([join(root, 'tracked.txt')]);

    await writeFile(join(root, 'removed.txt'), 'remove me\n');
    const absoluteRm = {command: '/bin/rm removed.txt'};
    await expect(shellTool.affectedPaths?.(absoluteRm, context))
      .resolves.toEqual([join(root, 'removed.txt')]);
    const removed = await shellTool.execute(absoluteRm, context);
    expect(removed.changedFiles).toEqual([join(root, 'removed.txt')]);
  });
});
