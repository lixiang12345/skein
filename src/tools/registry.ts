import type {ToolDefinition} from '../types.js';
import type {AgentTool} from './types.js';

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();
  private readonly aliases = new Map<string, string>();

  constructor(tools: AgentTool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: AgentTool): this {
    const {name} = tool.definition;
    assertToolName(name);
    if (this.tools.has(name) || this.aliases.has(name)) {
      throw new Error(`Tool already registered: ${name}`);
    }
    this.tools.set(name, tool);
    return this;
  }

  /** Resolve a retired tool name without advertising it to the model. */
  registerAlias(alias: string, target: string): this {
    assertToolName(alias);
    assertToolName(target);
    if (this.tools.has(alias) || this.aliases.has(alias)) {
      throw new Error(`Tool already registered: ${alias}`);
    }
    if (!this.tools.has(target)) throw new Error(`Alias target is not registered: ${target}`);
    this.aliases.set(alias, target);
    return this;
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name) ?? this.tools.get(this.aliases.get(name) ?? '');
  }

  has(name: string): boolean {
    return this.tools.has(name) || this.aliases.has(name);
  }

  list(): AgentTool[] {
    return [...this.tools.values()];
  }

  definitions(): ToolDefinition[] {
    return this.list().map((tool) => tool.definition);
  }
}

function assertToolName(name: string): void {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) {
    throw new Error(`Invalid tool name: ${name}`);
  }
}
