import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {CapabilityRegistryStore} from '../../src/agent/capability-registry.js';
import {buildCapabilityCandidates, evaluateCapabilityShadow} from '../../src/agent/capability-router.js';
import {createDeterministicEvidenceReceipt} from '../../src/agent/evidence-receipt.js';
import {resolveAgentModelRoute} from '../../src/agent/model-route.js';
import {builtInProfiles, type AgentProfile} from '../../src/agent/profiles.js';
import type {DeterministicEvidenceReceipt, MosaicConfig, RunCompletion} from '../../src/types.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

describe('capability shadow router', () => {
  it('separates configured priors from observed evidence and never changes static routing', async () => {
    const root = await workspace();
    const config = testConfig(root);
    const profile = builtIn('frontend');
    const candidates = await buildCapabilityCandidates({
      config,
      profile,
      environment: {TEAM_ROUTE_KEY: 'configured'},
    });
    const store = new CapabilityRegistryStore(root);
    let registry = await store.touchEpochs(candidates, new Date('2026-01-01T00:00:00.000Z'));
    const initial = evaluateCapabilityShadow({
      config, profile, candidates, registry, now: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(initial).toMatchObject({
      mode: 'shadow',
      profile: 'frontend',
      current: 'frontend',
      suggested: 'backend',
      changed: true,
      pinned: 'none',
    });
    const backend = initial.candidates.find((candidate) => candidate.ref === 'backend');
    expect(backend).toMatchObject({
      configured: {mean: 0.9, samples: 10},
    });
    expect(backend?.observed).toBeUndefined();
    expect(resolveAgentModelRoute(config.agents, config.model, 'frontend').route?.connection).toBe('fast');

    const backendRoute = candidates.find((candidate) => candidate.ref === 'backend');
    if (!backendRoute) throw new Error('Expected backend capability candidate.');
    await store.recordVerifiedRun({
      route: backendRoute,
      ...verifiedCompletion('backend-observed'),
      metrics: {inputTokens: 100, outputTokens: 25, latencyMs: 700},
      now: new Date('2026-01-02T00:00:00.000Z'),
    });
    registry = await store.snapshot();
    const observed = evaluateCapabilityShadow({
      config, profile, candidates, registry, now: new Date('2026-01-02T00:00:00.000Z'),
    });
    expect(observed.candidates.find((candidate) => candidate.ref === 'backend')?.observed).toMatchObject({
      status: 'uncertain',
      samples: 1,
      mean: 1,
      averageTokens: 125,
      averageLatencyMs: 700,
    });
    expect(observed.candidates.find((candidate) => candidate.ref === 'backend')?.configured).toMatchObject({
      mean: 0.9,
      samples: 10,
    });
  });

  it('applies hard credential constraints before conservative utility', async () => {
    const root = await workspace();
    const config = testConfig(root);
    const profile = builtIn('frontend');
    const candidates = await buildCapabilityCandidates({
      config,
      profile,
      environment: {},
    });
    const registry = await new CapabilityRegistryStore(root).touchEpochs(candidates);
    const report = evaluateCapabilityShadow({config, profile, candidates, registry});
    const backend = report.candidates.find((candidate) => candidate.ref === 'backend');
    expect(backend?.eligible).toBe(false);
    expect(backend?.ineligibleReasons).toContain('credential environment TEAM_ROUTE_KEY is not set');
    expect(report.suggested).toBe('frontend');
    expect(report.changed).toBe(false);
  });

  it('fails closed for missing compatible bases and unauthenticated custom native endpoints', async () => {
    const root = await workspace();
    const config = testConfig(root);
    config.agents!.routes!.broken = {provider: 'compatible', model: 'broken-model'};
    config.agents!.routes!.custom = {
      provider: 'openai', model: 'custom-openai', baseUrl: 'https://custom-openai.example/v1',
    };
    const candidates = await buildCapabilityCandidates({
      config,
      profile: builtIn('frontend'),
      environment: {
        TEAM_ROUTE_KEY: 'configured',
        SKEIN_API_KEY: 'configured',
        OPENAI_API_KEY: 'configured',
      },
    });
    expect(candidates.find((candidate) => candidate.ref === 'broken')?.ineligibleReasons)
      .toContain('compatible API route has no base URL');
    expect(candidates.find((candidate) => candidate.ref === 'custom')?.ineligibleReasons)
      .toContain('custom provider endpoint requires explicit connection auth');
  });

  it('opens a new epoch on endpoint or prompt drift and invalidates the old pin', async () => {
    const root = await workspace();
    const config = testConfig(root);
    const profile = builtIn('frontend');
    const environment = {TEAM_ROUTE_KEY: 'configured'};
    const store = new CapabilityRegistryStore(root);
    const initialCandidates = await buildCapabilityCandidates({config, profile, environment});
    await store.touchEpochs(initialCandidates, new Date('2026-01-01T00:00:00.000Z'));
    const pinned = initialCandidates.find((candidate) => candidate.ref === 'backend');
    if (!pinned) throw new Error('Expected backend capability candidate.');
    await store.pin(pinned, new Date('2026-01-01T00:00:01.000Z'));

    const changedConfig = testConfig(root);
    changedConfig.agents!.connections!.slow!.baseUrl = 'https://relay-2.example/v1';
    const changedProfile = {...profile, prompt: `${profile.prompt}\nNew reviewed prompt epoch.`};
    const changedCandidates = await buildCapabilityCandidates({
      config: changedConfig,
      profile: changedProfile,
      environment,
    });
    const changedBackend = changedCandidates.find((candidate) => candidate.ref === 'backend');
    if (!changedBackend) throw new Error('Expected changed backend capability candidate.');
    expect(changedBackend.routeIdentitySha256).toBe(pinned.routeIdentitySha256);
    expect(changedBackend.routeFingerprintSha256).not.toBe(pinned.routeFingerprintSha256);

    const registry = await store.touchEpochs(changedCandidates, new Date('2026-01-02T00:00:00.000Z'));
    expect(registry.epochs.filter((entry) =>
      entry.routeIdentitySha256 === pinned.routeIdentitySha256 &&
      entry.taskFingerprintSha256 === pinned.taskFingerprintSha256).map((entry) => entry.epoch)).toEqual([1, 2]);
    const report = evaluateCapabilityShadow({
      config: changedConfig,
      profile: changedProfile,
      candidates: changedCandidates,
      registry,
    });
    expect(report).toMatchObject({pinned: 'stale', suggested: 'frontend', changed: false});
  });

  it('changes the route fingerprint when a declared MCP tool capability changes', async () => {
    const root = await workspace();
    const config = testConfig(root);
    config.mcp = {
      enabled: true,
      connectTimeoutMs: 5_000,
      toolTimeoutMs: 30_000,
      servers: {
        docs: {
          enabled: true,
          transport: 'http',
          url: 'https://mcp.example.test',
          version: '1',
          tools: [{
            name: 'lookup',
            description: 'Read public documentation.',
            permissions: ['read'],
            paths: ['docs/**'],
          }],
        },
      },
    };
    const before = await buildCapabilityCandidates({
      config,
      profile: builtIn('frontend'),
      environment: {TEAM_ROUTE_KEY: 'configured'},
    });
    config.mcp.servers.docs!.tools![0]!.paths = ['docs/**', 'private/**'];
    const after = await buildCapabilityCandidates({
      config,
      profile: builtIn('frontend'),
      environment: {TEAM_ROUTE_KEY: 'configured'},
    });
    expect(after.find((candidate) => candidate.ref === 'frontend')?.toolCatalogSha256)
      .not.toBe(before.find((candidate) => candidate.ref === 'frontend')?.toolCatalogSha256);
    expect(after.find((candidate) => candidate.ref === 'frontend')?.routeFingerprintSha256)
      .not.toBe(before.find((candidate) => candidate.ref === 'frontend')?.routeFingerprintSha256);
  });

  it('rejects external runtimes for writable profiles even when installed', async () => {
    const root = await workspace();
    const config = testConfig(root);
    config.agents!.routes!.implementer = {runtime: 'codex', provider: 'openai', model: 'writer-model'};
    const profile = builtIn('implementer');
    const candidates = await buildCapabilityCandidates({
      config,
      profile,
      environment: {OPENAI_API_KEY: 'configured'},
      externalRuntimeAvailable: () => true,
    });
    const writer = candidates.find((candidate) => candidate.ref === 'implementer');
    expect(writer?.eligible).toBe(false);
    expect(writer?.ineligibleReasons).toContain('writer profiles require the API runtime');
  });
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'skein-capability-router-'));
  roots.push(root);
  return root;
}

function builtIn(name: string): AgentProfile {
  const profile = builtInProfiles.find((candidate) => candidate.name === name);
  if (!profile) throw new Error(`Missing built-in profile ${name}.`);
  return profile;
}

function testConfig(root: string): MosaicConfig {
  return {
    model: {
      provider: 'compatible',
      protocol: 'openai-responses',
      model: 'parent-model',
      baseUrl: 'https://parent.example/v1',
      apiKey: 'runtime-only-parent-key',
    },
    workspaceRoots: [root],
    context: {maxTokens: 2_000, topK: 4},
    permissions: {
      read: 'allow', write: 'deny', shell: 'deny', git: 'deny', network: 'deny',
      allowCommands: [], denyCommands: [],
    },
    hooks: {},
    agent: {
      maxTurns: 3,
      maxSessionTokens: 20_000,
      autoVerify: false,
      verifyCommands: [],
      checkpointBeforeWrite: false,
    },
    agents: {
      enabled: true,
      maxConcurrent: 2,
      maxDelegations: 4,
      defaultProfile: 'reviewer',
      connections: {
        fast: {
          provider: 'compatible', protocol: 'openai-responses', baseUrl: 'http://127.0.0.1:11434/v1',
          defaultModel: 'fast-model', auth: {type: 'none'},
        },
        slow: {
          provider: 'compatible', protocol: 'openai-responses', baseUrl: 'https://relay.example/v1',
          defaultModel: 'quality-model', auth: {type: 'env', name: 'TEAM_ROUTE_KEY'},
        },
      },
      routes: {
        frontend: {connection: 'fast'},
        backend: {connection: 'slow'},
      },
      capability: {
        mode: 'shadow',
        halfLifeDays: 30,
        minimumSamples: 5,
        priors: {
          frontend: {
            frontend: {successRate: 0.5, strength: 10},
            backend: {successRate: 0.9, strength: 10},
          },
        },
      },
    },
    ui: {color: false, compact: false},
  };
}

function verifiedCompletion(seed: string): {
  completion: RunCompletion;
  receipts: DeterministicEvidenceReceipt[];
} {
  const receipt = createDeterministicEvidenceReceipt({
    toolCallId: seed,
    tool: 'shell',
    arguments: {command: 'npm test'},
    ok: true,
    content: 'passed',
  });
  return {completion: {
    status: 'verified',
    changedFiles: ['src/frontend.ts'],
    detail: 'Verified by a deterministic test.',
    checks: [{
      toolCallId: seed,
      receiptId: receipt.id,
      tool: 'shell',
      command: 'npm test',
      kind: 'test',
      ok: true,
    }],
  }, receipts: [receipt]};
}
