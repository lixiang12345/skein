import {createHash} from 'node:crypto';
import type {
  ConnectionProtocol,
  ModelTokenUsage,
  ProviderName,
  RouteCostReceipt,
  RouteTokenPricing,
  TokenMeasurementSource,
} from '../types.js';
import {canonicalJson} from '../utils/canonical-json.js';

export interface PricedRoute {
  pricing: RouteTokenPricing;
  pricingSource: 'route' | 'connection';
  protocol: ConnectionProtocol;
}

export function routeCostReceipt(
  usage: ModelTokenUsage,
  pricedRoute?: PricedRoute,
): RouteCostReceipt {
  const normalized = normalizeModelUsage(usage);
  const usageSource = normalized.source ?? 'unknown';
  if (!pricedRoute) {
    return {
      status: 'unpriced',
      currency: 'USD',
      usageSource,
      usage: normalized,
      reason: 'pricing-not-configured',
    };
  }
  const pricing = normalizePricing(pricedRoute.pricing);
  const cachedInputTokens = normalized.cachedInputTokens ?? 0;
  const cacheWriteInputTokens = normalized.cacheWriteInputTokens ?? 0;
  const cachedRate = pricing.cachedInputPerMillionUsd ?? pricing.inputPerMillionUsd;
  const cacheWriteRate = pricing.cacheWriteInputPerMillionUsd ?? pricing.inputPerMillionUsd;
  const inputMicros = pricedRoute.protocol === 'anthropic-messages'
    ? normalized.inputTokens * pricing.inputPerMillionUsd +
      cachedInputTokens * cachedRate +
      cacheWriteInputTokens * cacheWriteRate
    : Math.max(0, normalized.inputTokens - cachedInputTokens - cacheWriteInputTokens) *
      pricing.inputPerMillionUsd +
      cachedInputTokens * cachedRate +
      cacheWriteInputTokens * cacheWriteRate;
  const outputMicros = normalized.outputTokens * pricing.outputPerMillionUsd;
  return {
    status: 'priced',
    currency: 'USD',
    usageSource,
    usage: normalized,
    pricingSource: pricedRoute.pricingSource,
    protocol: pricedRoute.protocol,
    pricing,
    pricingSha256: createHash('sha256').update(canonicalJson({
      version: 1,
      protocol: pricedRoute.protocol,
      pricing,
    })).digest('hex'),
    amountMicros: Math.round(inputMicros + outputMicros),
  };
}

export function defaultCostProtocol(
  provider: ProviderName,
  protocol?: ConnectionProtocol,
): ConnectionProtocol {
  if (protocol) return protocol;
  if (provider === 'anthropic') return 'anthropic-messages';
  if (provider === 'gemini') return 'gemini';
  return 'openai-chat';
}

export function routeCostExceeds(receipt: RouteCostReceipt, budgetUsd: number): boolean {
  return receipt.status === 'priced' && receipt.amountMicros > Math.round(budgetUsd * 1_000_000);
}

export function formatRouteCost(receipt: RouteCostReceipt | undefined): string {
  if (!receipt || receipt.status === 'unpriced') return 'unpriced';
  return `$${(receipt.amountMicros / 1_000_000).toFixed(6)}`;
}

function normalizeModelUsage(usage: ModelTokenUsage): ModelTokenUsage {
  return {
    inputTokens: tokenCount(usage.inputTokens),
    outputTokens: tokenCount(usage.outputTokens),
    ...(usage.cachedInputTokens === undefined ? {} : {cachedInputTokens: tokenCount(usage.cachedInputTokens)}),
    ...(usage.cacheWriteInputTokens === undefined
      ? {} : {cacheWriteInputTokens: tokenCount(usage.cacheWriteInputTokens)}),
    ...(usage.reasoningTokens === undefined ? {} : {reasoningTokens: tokenCount(usage.reasoningTokens)}),
    ...(usage.source ? {source: tokenSource(usage.source)} : {}),
  };
}

function normalizePricing(pricing: RouteTokenPricing): RouteTokenPricing {
  return {
    inputPerMillionUsd: price(pricing.inputPerMillionUsd),
    outputPerMillionUsd: price(pricing.outputPerMillionUsd),
    ...(pricing.cachedInputPerMillionUsd === undefined
      ? {} : {cachedInputPerMillionUsd: price(pricing.cachedInputPerMillionUsd)}),
    ...(pricing.cacheWriteInputPerMillionUsd === undefined
      ? {} : {cacheWriteInputPerMillionUsd: price(pricing.cacheWriteInputPerMillionUsd)}),
  };
}

function tokenCount(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error('Token usage must be finite and non-negative.');
  return Math.floor(value);
}

function price(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error('Token pricing must be finite and non-negative.');
  return value;
}

function tokenSource(value: TokenMeasurementSource): TokenMeasurementSource {
  return value;
}
