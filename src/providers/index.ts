import type {ModelConfig} from '../types.js';
import {AnthropicProvider} from './anthropic.js';
import {GeminiProvider} from './gemini.js';
import {OpenAIProvider} from './openai.js';
import {ResponsesProvider} from './responses.js';
import type {ModelProvider} from './provider.js';

export function createProvider(config: ModelConfig): ModelProvider {
  if (config.protocol === 'openai-responses') return new ResponsesProvider(config);
  if (config.protocol === 'openai-chat') return new OpenAIProvider(config);
  if (config.protocol === 'anthropic-messages') return new AnthropicProvider(config);
  if (config.protocol === 'gemini') return new GeminiProvider(config);
  switch (config.provider) {
    case 'anthropic': return new AnthropicProvider(config);
    case 'gemini': return new GeminiProvider(config);
    case 'openai': return new OpenAIProvider(config);
    case 'compatible':
      return new OpenAIProvider(config);
  }
}

export type {ModelProvider} from './provider.js';
export {ProviderError} from './provider.js';
