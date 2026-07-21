import {createHash, createHmac, randomBytes} from 'node:crypto';
import type {
  PermissionConfig,
  PermissionLevel,
  ToolCall,
  ToolCategory,
} from '../types.js';

export interface PermissionDecision {
  outcome: PermissionLevel;
  reason: string;
}

// Approval fingerprints only need to be stable for this process-local session.
// A keyed digest prevents low-entropy environment or request secrets from being
// recovered by comparing permission targets against an offline dictionary.
const permissionScopeSecret = randomBytes(32);

/**
 * Stable identity for a session approval. The resource is hashed so command
 * arguments, paths, URLs, and other call data never appear in the key.
 */
export function permissionKey(call: ToolCall, category: ToolCategory): string {
  const categoryScope = category === 'network'
    ? `\0network-request:${scopeFingerprint(normalizeRequestState(call.arguments))}`
    : '';
  const digest = createHash('sha256')
    .update(`${category}\0${call.name}\0${permissionTarget(call)}${categoryScope}`)
    .digest('hex')
    .slice(0, 24);
  return `${category}:${call.name}:${digest}`;
}

/** Return the non-secret resource identity an approval is scoped to. */
export function permissionTarget(call: ToolCall): string {
  const command = commandForCall(call);
  const values: string[] = [];
  if (command) {
    values.push(`command:${scopeFingerprint(command)}`);
    values.push(`cwd:${commandWorkingDirectory(call.arguments.cwd)}`);
    if (call.name === 'git') {
      appendFingerprintedArgument(values, call.arguments, 'args');
    }
  }
  appendFingerprintedArgument(values, call.arguments, 'env');
  appendFingerprintedArgument(values, call.arguments, 'stdin');
  for (const key of ['path', 'file', 'cwd', 'resource', 'server']) {
    if (command && key === 'cwd') continue;
    const value = call.arguments[key];
    if (typeof value === 'string' && value.trim()) {
      values.push(`${key}:${normalizeResource(value)}`);
    }
  }
  const url = call.arguments.url;
  if (typeof url === 'string' && url.trim()) {
    values.push(`url:${scopeFingerprint(normalizeFullUrl(url))}`);
  }
  const method = call.arguments.method;
  if (typeof method === 'string' && method.trim()) {
    values.push(`method:${method.trim().toLocaleUpperCase()}`);
  }
  if (hasRequestState(call.arguments)) {
    values.push(`request:${scopeFingerprint(normalizeRequestState(call.arguments))}`);
  }
  const paths = call.arguments.paths;
  if (Array.isArray(paths)) {
    const normalized = paths
      .filter((value): value is string => typeof value === 'string')
      .map(normalizeResource)
      .sort()
      .slice(0, 64);
    if (normalized.length) values.push(`paths:${normalized.join(',')}`);
  }
  if (values.length) return values.join('|');
  return `arguments:${scopeFingerprint(call.arguments)}`;
}

export function evaluatePermission(
  permissions: PermissionConfig,
  call: ToolCall,
  category: ToolCategory,
  options: {forceAsk?: boolean} = {},
): PermissionDecision {
  const command = commandForCall(call);
  if (command) {
    const denied = permissions.denyCommands.find((rule) =>
      matchesDeniedCommand(command, rule),
    );
    if (denied) {
      return {outcome: 'deny', reason: `Command matches deny rule: ${denied}`};
    }
  }

  const configured = permissions[category];
  if (configured === 'deny') {
    return {outcome: 'deny', reason: `${category} tools are disabled by configuration.`};
  }
  if (options.forceAsk && category !== 'read') {
    return {outcome: 'ask', reason: 'Interactive ask mode requires approval.'};
  }
  if (category === 'shell' && hasCustomEnvironment(call)) {
    return {outcome: 'ask', reason: 'Custom shell environment requires approval.'};
  }
  if (configured === 'allow') {
    return {outcome: 'allow', reason: `${category} tools are allowed by configuration.`};
  }
  if (category === allowListCategory(call) && command && permissions.allowCommands.some((rule) =>
    matchesAllowedCommand(command, rule))) {
    return {outcome: 'allow', reason: 'Command is in the configured allow list.'};
  }
  return {outcome: 'ask', reason: `${category} tools require approval.`};
}

function allowListCategory(call: ToolCall): ToolCategory | undefined {
  if (call.name === 'shell') return 'shell';
  if (call.name === 'git') return 'git';
  return undefined;
}

function hasCustomEnvironment(call: ToolCall): boolean {
  return call.name === 'shell' && typeof call.arguments.env === 'object' &&
    call.arguments.env !== null && Object.keys(call.arguments.env).length > 0;
}

export function commandForCall(call: ToolCall): string | undefined {
  if (call.name === 'shell' && typeof call.arguments.command === 'string') {
    return normalizeCommand(call.arguments.command);
  }
  if (call.name === 'git' && Array.isArray(call.arguments.args) &&
    call.arguments.args.every((value) => typeof value === 'string')) {
    return normalizeCommand(`git ${(call.arguments.args as string[]).join(' ')}`);
  }
  return undefined;
}

export function matchesAllowedCommand(command: string, rule: string): boolean {
  const normalizedCommand = normalizeCommand(command);
  const normalizedRule = normalizeCommand(rule);
  if (!normalizedRule) return false;
  if (containsShellControl(normalizedCommand)) return false;
  if (rule.endsWith(' ')) {
    return normalizedCommand.startsWith(`${normalizedRule} `);
  }
  return normalizedCommand === normalizedRule;
}

export function matchesDeniedCommand(command: string, rule: string): boolean {
  const normalizedCommand = normalizeCommand(command).toLocaleLowerCase();
  const normalizedRule = normalizeCommand(rule).toLocaleLowerCase();
  if (!normalizedRule) return false;
  const escapedRule = escapeRegExp(normalizedRule);
  // Deny rules are intentionally conservative: wrappers, absolute executable
  // paths, and command substitutions must not turn a denied program into an
  // apparently safe command. A non-word boundary avoids matching `rm` inside
  // an unrelated identifier while still catching shell syntax around it.
  return new RegExp(`(?:^|[^a-z0-9_-])${escapedRule}(?=$|[^a-z0-9_-])`, 'i')
    .test(normalizedCommand);
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/[\t ]+/g, ' ');
}

function normalizeResource(value: string): string {
  const normalized = value.trim().replace(/\\/g, '/').replace(/[\t\r\n ]+/g, ' ');
  if (/^https?:\/\//i.test(normalized)) {
    try {
      const url = new URL(normalized);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      return normalized.slice(0, 2_000);
    }
  }
  return normalized.slice(0, 2_000);
}

function commandWorkingDirectory(value: unknown): string {
  return scopeFingerprint(typeof value === 'string' && value.length > 0 ? value : '.');
}

function appendFingerprintedArgument(
  values: string[],
  arguments_: Record<string, unknown>,
  key: string,
): void {
  if (!Object.prototype.hasOwnProperty.call(arguments_, key)) return;
  if (key === 'env' && typeof arguments_[key] === 'object' && arguments_[key] !== null &&
    Object.keys(arguments_[key]).length === 0) {
    return;
  }
  values.push(`${key}:${scopeFingerprint(arguments_[key])}`);
}

function hasRequestState(arguments_: Record<string, unknown>): boolean {
  const requestKeys = /^(?:url|method|body|headers|query|search|fragment|data|payload|auth|credentials?)$/i;
  const sensitiveKeys = /(?:api[_-]?key|authorization|cookie|password|secret|token)/i;
  return Object.keys(arguments_).some((key) => requestKeys.test(key) || sensitiveKeys.test(key));
}

function normalizeRequestState(arguments_: Record<string, unknown>): Record<string, unknown> {
  const normalized = {...arguments_};
  if (typeof normalized.url === 'string') {
    normalized.url = normalizeFullUrl(normalized.url);
  }
  if (typeof normalized.method === 'string') {
    normalized.method = normalized.method.trim().toLocaleUpperCase();
  }
  return normalized;
}

function normalizeFullUrl(value: string): string {
  const normalized = value.trim();
  try {
    return new URL(normalized).toString();
  } catch {
    return normalized.slice(0, 8_000);
  }
}

function scopeFingerprint(value: unknown): string {
  return createHmac('sha256', permissionScopeSecret)
    .update(stableScopeValue(value))
    .digest('hex')
    .slice(0, 24);
}

function stableScopeValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return `string:${JSON.stringify(value)}`;
  if (typeof value === 'number') return `number:${String(value)}`;
  if (typeof value === 'boolean') return `boolean:${String(value)}`;
  if (typeof value === 'undefined') return 'undefined';
  if (Array.isArray(value)) return `array:[${value.map(stableScopeValue).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableScopeValue(item)}`);
    return `object:{${entries.join(',')}}`;
  }
  return `${typeof value}:${String(value)}`;
}

function containsShellControl(command: string): boolean {
  // Allow-list bypass is deliberately limited to a single, non-substituting
  // command. More complex shell programs can still run after explicit approval.
  return /(?:[;&|<>`\n\r]|\$\(|\$\{)/.test(command);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
