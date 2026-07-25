import {readFile} from 'node:fs/promises';
import {describe, expect, it} from 'vitest';
import {evaluateCapabilityReplay} from '../../src/agent/capability-evals.js';

describe('capability replay and calibration gates', () => {
  it('evaluates route regret, token linkage, judge bias, and degradation without enabling routing', async () => {
    const fixture = JSON.parse(await readFile('test/fixtures/capability-replay.json', 'utf8')) as unknown;
    const report = evaluateCapabilityReplay(fixture);

    expect(report).toMatchObject({
      source: 'fixture',
      routeReplay: {
        samples: 4,
        verifiedSuccessRate: 0.75,
        regretRate: 0.25,
        providerCoverage: 2,
        modelTiers: ['medium', 'strong'],
      },
      tokenLedger: {linked: 4, coverage: 1},
      judgeBias: {
        probes: 3,
        covered: ['position', 'verbosity', 'self_preference'],
        stabilityRate: 1,
      },
      degradation: {
        probes: 1,
        signals: 5,
        transitionAccuracy: 1,
        quarantineObserved: true,
        recoveryObserved: true,
      },
      gates: {
        routeReplay: true,
        tokenLedger: true,
        judgeCalibration: true,
        degradation: true,
        externalValidation: false,
        automaticRouting: false,
      },
      readyForAutomaticRouting: false,
    });
    expect(report.reasons).toContain('Fixture or recorded evidence is not live provider validation.');
    expect(report.reasons.at(-1)).toContain('only supported modes are off and shadow');
  });

  it('fails closed for missing ledger links and a position-sensitive judge', async () => {
    const fixture = JSON.parse(await readFile('test/fixtures/capability-replay.json', 'utf8')) as {
      routeReplays: Array<Record<string, unknown>>;
      judgeBiasProbes: Array<Record<string, unknown>>;
    };
    delete fixture.routeReplays[0]!.tokenLedgerSha256;
    fixture.judgeBiasProbes[0]!.reversedWinner = 'b';

    const report = evaluateCapabilityReplay(fixture);
    expect(report.gates).toMatchObject({tokenLedger: false, judgeCalibration: false, automaticRouting: false});
    expect(report.readyForAutomaticRouting).toBe(false);
  });

  it('does not treat a locally supplied live label as external attestation', async () => {
    const fixture = JSON.parse(await readFile('test/fixtures/capability-replay.json', 'utf8')) as {
      source: string;
    };
    fixture.source = 'live';
    const report = evaluateCapabilityReplay(fixture);
    expect(report.gates.externalValidation).toBe(false);
    expect(report.reasons).toContain('Locally supplied live-labelled evidence is not externally attested.');
  });

  it('rejects malformed or content-bearing replay records', () => {
    expect(() => evaluateCapabilityReplay({
      version: 1,
      source: 'fixture',
      routeReplays: [{prompt: 'secret source text'}],
      judgeBiasProbes: [],
      degradationProbes: [],
    })).toThrow();
  });
});
