import type {ModelConfig} from '../types.js';
import {AnthropicProvider} from './anthropic.js';
import {GeminiProvider} from './gemini.js';
import {OpenAIProvider} from './openai.js';
import type {ModelProvider} from './provider.js';

export function createProvider(config: ModelConfig): ModelProvider {
  switch (config.provider) {
    case 'anthropic': return new AnthropicProvider(config);
    case 'gemini': return new GeminiProvider(config);
    case 'openai':
    case 'compatible': return new OpenAIProvider(config);
  }
}

export type {ModelProvider} from './provider.js';
export {ProviderError} from './provider.js';
