import {lstat, readFile, readdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename, join} from 'node:path';
import {parse as parseYaml} from 'yaml';
import {resolveHomeNamespace, resolveProjectNamespaceSync} from '../utils/namespace.js';

export interface AgentProfile {
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  readOnly: boolean;
  maxTurns: number;
  source: 'built-in' | 'user' | 'workspace';
}

export const builtInProfiles: AgentProfile[] = [
  {
    name: 'product',
    description: 'Defines customer journeys, interaction states, acceptance criteria, and product tradeoffs.',
    prompt: 'Act as a principal product engineer. Ground the user journey in the current product, identify setup and failure-state friction, define observable acceptance criteria, and recommend the smallest coherent product slice. Do not edit files.',
    readOnly: true,
    maxTurns: 8,
    source: 'built-in',
  },
  {
    name: 'frontend',
    description: 'Reviews terminal or web interaction architecture, responsive behavior, accessibility, and visual state.',
    prompt: 'Act as a senior frontend and interaction engineer. Inspect the existing component system and state flow, then propose implementation details that preserve accessibility, responsive layout, input behavior, and visual consistency. Do not edit files.',
    readOnly: true,
    maxTurns: 10,
    source: 'built-in',
  },
  {
    name: 'backend',
    description: 'Reviews state machines, concurrency, persistence, APIs, failure recovery, and complex logic.',
    prompt: 'Act as a senior backend and systems engineer. Trace state, concurrency, persistence, cancellation, and failure recovery. Specify invariants, interfaces, and tests for complex logic. Do not edit files.',
    readOnly: true,
    maxTurns: 10,
    source: 'built-in',
  },
  {
    name: 'research',
    description: 'Compares documentation and supplied external evidence, separating current facts from assumptions.',
    prompt: 'Act as a technical research lead. Compare supplied primary-source evidence, distinguish verified capabilities from marketing claims, identify uncertainty and version drift, and return decisions with source links when available. Do not edit files.',
    readOnly: true,
    maxTurns: 8,
    source: 'built-in',
  },
  {
    name: 'architect',
    description: 'Maps architecture, ownership boundaries, dependencies, and implementation tradeoffs.',
    prompt: 'Act as a senior software architect. Inspect evidence before conclusions. Produce a concrete architecture map, constraints, viable options, risks, and a recommended implementation path. Do not edit files.',
    readOnly: true,
    maxTurns: 8,
    source: 'built-in',
  },
  {
    name: 'debugger',
    description: 'Reproduces failures, traces causal chains, and proposes the smallest verified fix.',
    prompt: 'Act as a production debugger. Reproduce or ground the symptom, isolate the first incorrect state, distinguish causes from consequences, and return evidence with a minimal fix and verification plan. Do not edit files.',
    readOnly: true,
    maxTurns: 10,
    source: 'built-in',
  },
  {
    name: 'implementer',
    description: 'Makes one bounded change inside an isolated writer worktree for explicit review and integration.',
    prompt: 'Act as a careful implementation engineer inside a disposable Git worktree. Inspect the relevant files, make only the requested change, preserve established conventions, and finish with a concise summary of edits and remaining risks. You cannot run shell commands, use Git, access the network, or delegate.',
    readOnly: false,
    maxTurns: 16,
    source: 'built-in',
  },
  {
    name: 'reviewer',
    description: 'Reviews changes for correctness, regressions, maintainability, and missing tests.',
    prompt: 'Act as a strict code reviewer. Lead with actionable findings ordered by severity. Ground every claim in files, lines, behavior, or test evidence. Explicitly report residual test gaps. Do not edit files.',
    readOnly: true,
    maxTurns: 8,
    source: 'built-in',
  },
  {
    name: 'security',
    description: 'Audits trust boundaries, injection, secrets, permissions, path safety, and supply-chain risk.',
    prompt: 'Act as an application security engineer. Trace attacker-controlled inputs across trust boundaries, inspect permission and persistence behavior, and prioritize exploitable risks with concrete mitigations. Do not edit files.',
    readOnly: true,
    maxTurns: 10,
    source: 'built-in',
  },
  {
    name: 'tester',
    description: 'Designs focused verification, regression tests, boundary cases, and failure injection.',
    prompt: 'Act as a test engineer. Identify behavioral contracts and highest-risk boundaries, then produce a focused test matrix and executable verification steps. Prefer tests that would fail before the change. Do not edit files.',
    readOnly: true,
    maxTurns: 8,
    source: 'built-in',
  },
];

export class AgentProfileCatalog {
  private profiles = new Map<string, AgentProfile>(builtInProfiles.map((profile) => [profile.name, profile]));

  constructor(private readonly workspace: string) {}

  async discover(): Promise<AgentProfile[]> {
    const locations = [
      {path: join(resolveHomeNamespace(), 'agents'), source: 'user' as const},
      {path: join(homedir(), '.claude', 'agents'), source: 'user' as const},
      {path: join(resolveProjectNamespaceSync(this.workspace).active, 'agents'), source: 'workspace' as const},
      {path: join(this.workspace, '.claude', 'agents'), source: 'workspace' as const},
    ];
    for (const location of locations) {
      for (const file of await markdownFiles(location.path)) {
        const profile = await readProfile(join(location.path, file), location.source);
        if (profile) this.profiles.set(profile.name, profile);
      }
    }
    return this.list();
  }

  list(): AgentProfile[] {
    return [...this.profiles.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  get(name: string): AgentProfile | undefined {
    const profile = this.profiles.get(name);
    return profile ? {...profile, ...(profile.tools ? {tools: [...profile.tools]} : {})} : undefined;
  }
}

async function markdownFiles(directory: string): Promise<string[]> {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return [];
    return (await readdir(directory, {withFileTypes: true}))
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.md'))
      .map((entry) => entry.name)
      .slice(0, 200);
  } catch {
    return [];
  }
}

async function readProfile(path: string, source: AgentProfile['source']): Promise<AgentProfile | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 100_000) return undefined;
    const raw = await readFile(path, 'utf8');
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    const frontmatter = match ? parseYaml(match[1] ?? '') as Record<string, unknown> : {};
    const prompt = (match ? raw.slice(match[0].length) : raw).trim();
    const fallbackName = basename(path, '.md').toLocaleLowerCase();
    const name = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : fallbackName;
    const description = typeof frontmatter.description === 'string'
      ? frontmatter.description.trim()
      : prompt.split('\n')[0]?.replace(/^#+\s*/, '').trim() ?? '';
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name) || !description || !prompt) return undefined;
    const tools = Array.isArray(frontmatter.tools)
      ? frontmatter.tools.filter((tool): tool is string => typeof tool === 'string').slice(0, 64)
      : undefined;
    return {
      name,
      description: description.slice(0, 1_000),
      prompt: prompt.slice(0, 80_000),
      ...(tools?.length ? {tools} : {}),
      readOnly: frontmatter.readOnly !== false,
      maxTurns: integer(frontmatter.maxTurns, 8, 1, 24),
      source,
    };
  } catch {
    return undefined;
  }
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}
