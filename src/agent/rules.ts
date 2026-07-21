import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {lstat, readFile} from 'node:fs/promises';
import {WorkspaceAccess} from '../tools/workspace.js';

export interface WorkspaceRule {
  path: string;
  content: string;
  scope: 'user' | 'workspace';
  truncated: boolean;
}

const workspaceRulePaths = [
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  '.mosaic/rules.md',
  '.github/copilot-instructions.md',
];

export async function discoverWorkspaceRules(
  workspace: string,
  maxChars = 120_000,
): Promise<WorkspaceRule[]> {
  const workspaceAccess = new WorkspaceAccess([workspace]);
  const candidates = [
    {path: join(homedir(), '.mosaic', 'rules.md'), scope: 'user' as const},
    ...workspaceRulePaths.map((path) => ({
      path: join(workspace, path),
      scope: 'workspace' as const,
    })),
  ];
  const rules: WorkspaceRule[] = [];
  let remaining = maxChars;
  for (const candidate of candidates) {
    if (remaining <= 0 || !existsSync(candidate.path)) continue;
    try {
      const info = await lstat(candidate.path);
      if (!info.isFile() || info.size > 1_000_000) continue;
      if (candidate.scope === 'workspace') {
        // Rule files are model instructions. Keep a repository-controlled
        // symlink (including a symlinked parent directory) from importing
        // content outside the configured workspace.
        const safePath = await workspaceAccess.resolvePath(candidate.path, {expect: 'file'});
        if (safePath !== candidate.path) continue;
      }
      const raw = await readFile(candidate.path, 'utf8');
      if (raw.includes('\0')) continue;
      const content = raw.slice(0, remaining);
      rules.push({
        ...candidate,
        content,
        truncated: content.length < raw.length,
      });
      remaining -= content.length;
    } catch {
      // Rules are optional and may disappear while an editor is saving them.
    }
  }
  return rules;
}

export function formatWorkspaceRules(rules: WorkspaceRule[]): string {
  if (!rules.length) return '';
  return rules.map((rule) =>
    `<workspace-rule path="${escapeAttribute(rule.path)}" scope="${rule.scope}"${rule.truncated ? ' truncated="true"' : ''}>\n` +
    `${rule.content}\n</workspace-rule>`,
  ).join('\n\n');
}

function escapeAttribute(value: string): string {
  return value.replace(/[&"<>]/g, (character) => ({
    '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;',
  })[character] ?? character);
}
