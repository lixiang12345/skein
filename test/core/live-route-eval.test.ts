import {access, readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

const intentRouteSchema = z.enum([
  'direct_execute',
  'inspect_then_execute',
  'needs_input',
  'permission_required',
]);

const manifestSchema = z.object({
  version: z.literal('skein-live-route-eval-v1'),
  comparison: z.literal('strong-strong'),
  goldStatus: z.literal('candidate_owner_review'),
  workspace: z.string().min(1),
  resetPolicy: z.literal('fresh-copy-per-case-and-route'),
  thresholds: z.object({
    minimumSamplesPerRoute: z.number().int().positive(),
    minimumVerifiedSuccessRate: z.number().min(0).max(1),
    minimumSafetyRate: z.number().min(0).max(1),
    minimumVerificationRate: z.number().min(0).max(1),
    maximumFalseActRate: z.number().min(0).max(1),
    maximumFalseAskRate: z.number().min(0).max(1),
  }).strict(),
  cases: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/u),
    category: z.string().min(1),
    prompt: z.string().min(1).max(2_000),
    gold: z.object({
      intentRoute: intentRouteSchema,
      mutationExpected: z.boolean(),
      humanInputRequired: z.boolean(),
      permissionRequired: z.boolean(),
      safetyRequirements: z.array(z.string().min(1)).min(1),
    }).strict(),
    validators: z.array(z.object({
      program: z.enum(['git', 'node']),
      args: z.array(z.string().min(1)).min(1).max(8),
    }).strict()).min(1).max(4),
  }).strict()).min(6).max(64),
}).strict();

describe('live route evaluation corpus', () => {
  it('is fixed, bounded, resettable, and explicit about unconfirmed gold labels', async () => {
    const raw: unknown = JSON.parse(await readFile('test/fixtures/live-route-eval/manifest.json', 'utf8'));
    const manifest = manifestSchema.parse(raw);
    const ids = manifest.cases.map((entry) => entry.id);
    const routes = new Set(manifest.cases.map((entry) => entry.gold.intentRoute));

    expect(new Set(ids).size).toBe(ids.length);
    expect(manifest.thresholds.minimumSamplesPerRoute).toBe(manifest.cases.length);
    expect(routes).toEqual(new Set(intentRouteSchema.options));
    expect(manifest.goldStatus).not.toBe('confirmed');
    await expect(access(resolve(manifest.workspace, 'package.json'))).resolves.toBeUndefined();
  });

  it('keeps validators free of shell interpretation and credentials', async () => {
    const raw: unknown = JSON.parse(await readFile('test/fixtures/live-route-eval/manifest.json', 'utf8'));
    const manifest = manifestSchema.parse(raw);
    const forbidden = /(?:sk-[a-z0-9]|\$\(|`|&&|\|\||;|\benv\b|printenv)/iu;

    for (const benchmarkCase of manifest.cases) {
      for (const validator of benchmarkCase.validators) {
        expect([validator.program, ...validator.args].join(' ')).not.toMatch(forbidden);
      }
    }
  });
});
