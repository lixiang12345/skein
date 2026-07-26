import {describe, expect, it} from 'vitest';
import {
  formatRouteCost,
  routeCostExceeds,
  routeCostReceipt,
} from '../../src/agent/route-cost.js';

describe('route cost receipts', () => {
  it('keeps missing user pricing visibly unpriced', () => {
    expect(routeCostReceipt({
      inputTokens: 12,
      outputTokens: 3,
      source: 'actual',
    })).toEqual({
      status: 'unpriced',
      currency: 'USD',
      usageSource: 'actual',
      usage: {inputTokens: 12, outputTokens: 3, source: 'actual'},
      reason: 'pricing-not-configured',
    });
  });

  it('does not double-charge cached or reasoning tokens for OpenAI-shaped usage', () => {
    const receipt = routeCostReceipt({
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cachedInputTokens: 250_000,
      reasoningTokens: 80_000,
      source: 'actual',
    }, {
      protocol: 'openai-responses',
      pricingSource: 'connection',
      pricing: {
        inputPerMillionUsd: 10,
        outputPerMillionUsd: 20,
        cachedInputPerMillionUsd: 2,
      },
    });
    expect(receipt).toMatchObject({
      status: 'priced',
      amountMicros: 10_000_000,
      pricingSource: 'connection',
      protocol: 'openai-responses',
    });
    expect(formatRouteCost(receipt)).toBe('$10.000000');
  });

  it('prices Anthropic cache read and write tokens as separate input categories', () => {
    const receipt = routeCostReceipt({
      inputTokens: 750_000,
      outputTokens: 100_000,
      cachedInputTokens: 250_000,
      cacheWriteInputTokens: 100_000,
      reasoningTokens: 80_000,
      source: 'actual',
    }, {
      protocol: 'anthropic-messages',
      pricingSource: 'route',
      pricing: {
        inputPerMillionUsd: 10,
        outputPerMillionUsd: 20,
        cachedInputPerMillionUsd: 2,
        cacheWriteInputPerMillionUsd: 12,
      },
    });
    expect(receipt).toMatchObject({
      status: 'priced',
      amountMicros: 11_200_000,
      pricingSource: 'route',
      protocol: 'anthropic-messages',
    });
    expect(routeCostExceeds(receipt, 11.2)).toBe(false);
    expect(routeCostExceeds(receipt, 11.199999)).toBe(true);
  });

  it('binds the protocol and pricing configuration into a stable hash', () => {
    const usage = {inputTokens: 1, outputTokens: 1};
    const pricing = {inputPerMillionUsd: 1, outputPerMillionUsd: 2};
    const first = routeCostReceipt(usage, {
      protocol: 'openai-responses', pricingSource: 'route', pricing,
    });
    const second = routeCostReceipt(usage, {
      protocol: 'openai-responses', pricingSource: 'route', pricing,
    });
    const messages = routeCostReceipt(usage, {
      protocol: 'anthropic-messages', pricingSource: 'route', pricing,
    });
    expect(first.status).toBe('priced');
    expect(second.status).toBe('priced');
    expect(messages.status).toBe('priced');
    if (first.status !== 'priced' || second.status !== 'priced' || messages.status !== 'priced') return;
    expect(first.pricingSha256).toBe(second.pricingSha256);
    expect(first.pricingSha256).not.toBe(messages.pricingSha256);
  });
});
