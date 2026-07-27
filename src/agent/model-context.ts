import type {MosaicConfig} from '../types.js';

/** Product fallback when a connection does not publish model context metadata. */
export const DEFAULT_MODEL_CONTEXT_TOKENS = 500_000;

/** Resolve the active model window without conflating it with retrieval or lifetime budgets. */
export function modelContextWindowTokens(config: MosaicConfig): number {
  const activeConnection = config.activeConnection?.id;
  const profile = activeConnection
    ? config.connections?.profiles?.[activeConnection] ?? config.agents?.connections?.[activeConnection]
    : undefined;
  const declared = profile?.models?.find((model) => model.id === config.model.model)?.contextLength;
  return positiveTokens(declared) ?? positiveTokens(config.context.windowTokens) ?? DEFAULT_MODEL_CONTEXT_TOKENS;
}

function positiveTokens(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}
