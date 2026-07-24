import {spawn} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {PACKAGE_NAME} from './update-check.js';

/**
 * Self-update support for the globally installed CLI. The heavy lifting is
 * delegated to whichever package manager originally installed the binary — we
 * never download or overwrite files ourselves, so the update path is exactly
 * the one the user (or their distro) already trusts. Detection is best-effort
 * and always falls back to npm; users can force a specific command with
 * `SKEIN_UPDATE_COMMAND` (or the legacy `MOSAIC_UPDATE_COMMAND`).
 */

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface UpgradePlan {
  /** Executable to spawn, e.g. `npm`. */
  command: string;
  /** Argument vector; kept as an array so nothing is shell-interpolated. */
  args: string[];
  /** Detected package manager driving the upgrade. */
  manager: PackageManager;
  /** Human-readable command line, for prompts and dry runs. */
  display: string;
}

/** Package managers we know how to drive for a global upgrade. */
const GLOBAL_INSTALL_ARGS: Record<PackageManager, (spec: string) => string[]> = {
  npm: (spec) => ['install', '-g', spec],
  pnpm: (spec) => ['add', '-g', spec],
  yarn: (spec) => ['global', 'add', spec],
  bun: (spec) => ['add', '-g', spec],
};

/**
 * Infer the package manager from the resolved path of the running binary. A
 * global install lands under a manager-specific directory (pnpm's store, bun's
 * `~/.bun`, yarn's global folder), which is a far more reliable signal than
 * `npm_config_user_agent` — that variable is only set while a package manager
 * is actively running, not when the installed binary later invokes itself.
 */
export function detectPackageManager(
  binaryPath: string | undefined = process.argv[1],
  env: NodeJS.ProcessEnv = process.env,
): PackageManager {
  const fromAgent = parseUserAgent(env.npm_config_user_agent);
  if (fromAgent) return fromAgent;

  let resolved = binaryPath ?? '';
  try {
    if (resolved) resolved = realpathSync(resolved);
  } catch {
    // Non-fatal: fall back to the raw path for pattern matching.
  }
  const path = resolved.replace(/\\/g, '/').toLowerCase();
  if (/(^|\/)\.bun\/|(^|\/)bun\//.test(path)) return 'bun';
  if (/(^|\/)pnpm(\/|-global\/|$)/.test(path)) return 'pnpm';
  if (/(^|\/)yarn\//.test(path)) return 'yarn';
  return 'npm';
}

function parseUserAgent(agent: string | undefined): PackageManager | null {
  if (!agent) return null;
  const name = agent.trim().split('/')[0]?.toLowerCase();
  if (name === 'pnpm' || name === 'yarn' || name === 'bun' || name === 'npm') return name;
  return null;
}

/**
 * Build the upgrade command. An explicit `SKEIN_UPDATE_COMMAND` override wins
 * and is run verbatim through the user's shell (their env, their call); the
 * detected-manager path always spawns an argv array so a package name can never
 * be shell-interpreted.
 */
export function resolveUpgradePlan(
  options: {version?: string; env?: NodeJS.ProcessEnv; binaryPath?: string} = {},
): UpgradePlan {
  const env = options.env ?? process.env;
  const spec = `${PACKAGE_NAME}@${options.version ?? 'latest'}`;
  const manager = detectPackageManager(options.binaryPath, env);
  const args = GLOBAL_INSTALL_ARGS[manager](spec);
  return {command: manager, args, manager, display: `${manager} ${args.join(' ')}`};
}

/** The verbatim shell override, if the user configured one. */
export function upgradeCommandOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.SKEIN_UPDATE_COMMAND ?? env.MOSAIC_UPDATE_COMMAND;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

export interface RunUpgradeResult {
  ok: boolean;
  exitCode: number;
  display: string;
}

/**
 * Spawn the upgrade, streaming the package manager's own output straight to the
 * terminal so the user sees real progress. Resolves (never rejects) with the
 * outcome; a missing executable is reported as a clean failure.
 */
export function runUpgrade(
  plan: {command: string; args: string[]; display: string; shell?: boolean},
): Promise<RunUpgradeResult> {
  return new Promise((resolve) => {
    const child = spawn(plan.command, plan.args, {
      stdio: 'inherit',
      shell: plan.shell ?? false,
    });
    child.on('error', () => resolve({ok: false, exitCode: 127, display: plan.display}));
    child.on('close', (code) => {
      const exitCode = code ?? 1;
      resolve({ok: exitCode === 0, exitCode, display: plan.display});
    });
  });
}
