import type {Session} from '../types.js';

export interface PromptSkillActivation {
  name: string;
  description: string;
}

export interface PromptAugmentation {
  text: string;
  skills?: PromptSkillActivation[];
  memoryCount?: number;
  memoryScope?: string;
}

export interface PromptContextProvider {
  prepare(input: string, session: Session, signal?: AbortSignal): Promise<PromptAugmentation>;
}
