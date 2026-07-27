import {afterEach, describe, expect, it} from 'vitest';
import {
  clearConnectionCredentialCache,
  connectionAuthReference,
  resolveConnectionCredential,
  resolveConnectionHeaders,
} from '../../src/agent/connection-auth.js';

describe('connection credential resolution', () => {
  afterEach(() => clearConnectionCredentialCache());

  it('resolves environment credentials, custom placement, and environment-backed headers', async () => {
    await expect(resolveConnectionHeaders({
      type: 'env', name: 'RELAY_TOKEN', placement: {name: 'X-Gateway-Token', prefix: 'Token '},
    }, {
      static: {'anthropic-version': '2023-06-01'},
      env: {'X-Tenant': 'TENANT_ID'},
    }, {environment: {RELAY_TOKEN: 'secret-value', TENANT_ID: 'tenant-a'}})).resolves.toEqual({
      value: 'secret-value',
      reference: 'env:RELAY_TOKEN',
      headers: {
        'anthropic-version': '2023-06-01',
        'X-Tenant': 'tenant-a',
        'X-Gateway-Token': 'Token secret-value',
      },
    });
  });

  it('runs a command helper without a shell or stdin and passes only declared environment names', async () => {
    const result = await resolveConnectionCredential({
      type: 'command',
      command: process.execPath,
      args: ['-e', "process.stdin.on('data',()=>process.exit(9)); console.log(process.env.HELPER_TOKEN + ':' + (process.env.UNRELATED ?? 'absent'))"],
      passEnv: ['HELPER_TOKEN'],
      header: 'x-api-key',
      refreshIntervalMs: 0,
    }, {environment: {...process.env, HELPER_TOKEN: 'from-helper-env', UNRELATED: 'must-not-pass'}});

    expect(result).toEqual({
      value: 'from-helper-env:absent',
      reference: `command:${process.platform === 'win32' ? 'node.exe' : 'node'}`,
      headers: {'x-api-key': 'from-helper-env:absent'},
    });
  });

  it('fails closed for missing, timed-out, non-zero, empty, and oversized helpers', async () => {
    await expect(resolveConnectionCredential({
      type: 'command', command: '__skein_missing_credential_helper__', refreshIntervalMs: 0,
    })).rejects.toThrow('could not start');
    await expect(resolveConnectionCredential({
      type: 'command', command: process.execPath, args: ['-e', 'setTimeout(()=>{}, 10_000)'],
      timeoutMs: 100, refreshIntervalMs: 0,
    })).rejects.toThrow('timed out after 100ms');
    await expect(resolveConnectionCredential({
      type: 'command', command: process.execPath, args: ['-e', 'process.exit(7)'], refreshIntervalMs: 0,
    })).rejects.toThrow('exit 7');
    await expect(resolveConnectionCredential({
      type: 'command', command: process.execPath, args: ['-e', "console.log('   ')"], refreshIntervalMs: 0,
    })).rejects.toThrow('empty credential');
    await expect(resolveConnectionCredential({
      type: 'command', command: process.execPath,
      args: ['-e', "console.log('first\\nsecond')"], refreshIntervalMs: 0,
    })).rejects.toThrow('more than one line');
    await expect(resolveConnectionCredential({
      type: 'command', command: process.execPath,
      args: ['-e', "process.stdout.write('x'.repeat(17_000))"], refreshIntervalMs: 0,
    })).rejects.toThrow('exceeds 16384 bytes');
  });

  it('keeps helper credentials only in bounded process memory until refresh', async () => {
    const auth = {
      type: 'command' as const,
      command: process.execPath,
      args: ['-e', 'console.log(Math.random())'],
      refreshIntervalMs: 1_000,
    };
    const first = await resolveConnectionCredential(auth, {now: 1_000});
    const cached = await resolveConnectionCredential(auth, {now: 1_500});
    const refreshed = await resolveConnectionCredential(auth, {now: 2_001});

    expect(cached.value).toBe(first.value);
    expect(refreshed.value).not.toBe(first.value);
    expect(connectionAuthReference(auth)).toMatch(/^command:/u);
  });

  it('rejects ambiguous duplicate headers case-insensitively', async () => {
    await expect(resolveConnectionHeaders({type: 'none'}, {
      static: {'X-Tenant': 'one'},
      env: {'x-tenant': 'TENANT'},
    }, {environment: {TENANT: 'two'}})).rejects.toThrow('configured more than once');
    await expect(resolveConnectionHeaders({type: 'none'}, {
      static: {'X-Tenant': 'one', 'x-tenant': 'two'},
    })).rejects.toThrow('configured more than once');
    await expect(resolveConnectionHeaders({type: 'env', name: 'TOKEN'}, undefined, {
      environment: {TOKEN: 'value\nInjected: header'},
    })).rejects.toThrow('contains a newline');
  });
});
