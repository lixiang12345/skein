import {access} from 'node:fs/promises';
import {constants} from 'node:fs';
import chalk from 'chalk';
import type {MosaicConfig} from '../types.js';
import {redactEndpoint} from '../config.js';
import {ContextEngine} from '../context/context-engine.js';
import {resolveExecutableRuntime, runProcess} from '../utils/process.js';
import {PRODUCT_COMMAND, PRODUCT_NAME} from '../brand.js';
import {resolveCliGlyphs, type CliGlyphs} from './glyphs.js';
import {
  inspectHomeNamespace,
  inspectHomeRecovery,
  inspectProjectNamespace,
  inspectProjectRecovery,
} from '../utils/namespace.js';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  required: boolean;
}

export const MINIMUM_NODE_VERSION = '22.16.0';

export interface DoctorOptions {
  json?: boolean;
  visual?: boolean;
}

export async function runDoctor(config: MosaicConfig, options: DoctorOptions = {}): Promise<boolean> {
  const json = options.json === true;
  const glyphs = resolveCliGlyphs();
  const root = config.workspaceRoots[0] ?? process.cwd();
  const checks: Check[] = [];
  let namespace: Awaited<ReturnType<typeof inspectProjectNamespace>> | undefined;
  let homeNamespace: Awaited<ReturnType<typeof inspectHomeNamespace>> | undefined;
  let namespaceRecovery: Awaited<ReturnType<typeof inspectProjectRecovery>> | undefined;
  let homeRecovery: Awaited<ReturnType<typeof inspectHomeRecovery>> | undefined;
  try {
    namespace = await inspectProjectNamespace(root);
    checks.push({
      name: 'Storage namespace',
      ok: namespace.status !== 'conflict',
      detail: namespace.status === 'ready'
        ? `legacy .mosaic detected; migrate to ${namespace.destination}`
        : namespace.status === 'conflict'
          ? `conflict in ${namespace.conflicts.length} path(s); migration paused`
          : !namespace.sourceExists && !namespace.destinationExists
            ? `no durable state yet; first write uses ${namespace.source}`
            : `active ${namespace.destinationExists ? namespace.destination : namespace.source}; migration ${namespace.status}`,
      required: false,
    });
  } catch (error) {
    checks.push({
      name: 'Storage namespace',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      required: false,
    });
  }
  try {
    namespaceRecovery = await inspectProjectRecovery(root);
    if (namespaceRecovery.status !== 'clean') {
      checks.push({
        name: 'Storage recovery',
        ok: namespaceRecovery.status !== 'blocked',
        detail: `${namespaceRecovery.candidates.length} interrupted operation(s); run ${PRODUCT_COMMAND} migrate --recover`,
        required: false,
      });
    }
  } catch (error) {
    checks.push({
      name: 'Storage recovery',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      required: false,
    });
  }
  try {
    homeNamespace = await inspectHomeNamespace();
    checks.push({
      name: 'User storage namespace',
      ok: homeNamespace.status !== 'conflict',
      detail: homeNamespace.status === 'ready'
        ? `legacy ${homeNamespace.source}; migrate with ${PRODUCT_COMMAND} migrate --home --yes`
        : homeNamespace.status === 'conflict'
          ? `conflict in ${homeNamespace.conflicts.length} path(s); migration paused`
          : !homeNamespace.sourceExists && !homeNamespace.destinationExists
            ? `no user state yet; first write uses ${homeNamespace.source}`
            : `active ${homeNamespace.destinationExists ? homeNamespace.destination : homeNamespace.source}; migration ${homeNamespace.status}`,
      required: false,
    });
  } catch (error) {
    checks.push({
      name: 'User storage namespace',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      required: false,
    });
  }
  try {
    homeRecovery = await inspectHomeRecovery();
    if (homeRecovery.status !== 'clean') {
      checks.push({
        name: 'User storage recovery',
        ok: homeRecovery.status !== 'blocked',
        detail: `${homeRecovery.candidates.length} interrupted operation(s); run ${PRODUCT_COMMAND} migrate --home --recover`,
        required: false,
      });
    }
  } catch (error) {
    checks.push({
      name: 'User storage recovery',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      required: false,
    });
  }
  const nodeOk = supportsNodeVersion(process.versions.node);
  checks.push({
    name: 'Node.js',
    ok: nodeOk,
    detail: nodeOk
      ? process.version
      : `${process.version}; requires >=${MINIMUM_NODE_VERSION}`,
    required: true,
  });
  checks.push({name: 'SQLite FTS5', ...await checkSqliteFts5(), required: true});
  if (config.model.provider === 'compatible') {
    checks.push({
      name: 'Model endpoint',
      ok: Boolean(config.model.baseUrl),
      detail: config.model.baseUrl
        ? redactEndpoint(config.model.baseUrl)
        : 'set model.baseUrl or pass --base-url',
      required: true,
    });
  }
  try {
    await access(root, constants.R_OK | constants.W_OK);
    checks.push({name: 'Workspace', ok: true, detail: root, required: true});
  } catch (error) {
    checks.push({
      name: 'Workspace',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      required: true,
    });
  }

  if (options.visual) checks.push(...visualChecks(glyphs));
  checks.push({
    name: 'Model credentials',
    ok: config.model.provider === 'compatible' || Boolean(config.model.apiKey),
    detail: config.model.apiKey
      ? `${config.model.provider} key configured`
      : config.model.provider === 'compatible'
        ? 'not set; allowed when the endpoint does not require authentication'
        : `set ${keyEnvironmentName(config.model.provider)}`,
    required: true,
  });

  const git = await commandCheck('git', ['--version'], root, config.workspaceRoots);
  checks.push({name: 'Git', ...git, required: false});
  const rg = await commandCheck('rg', ['--version'], root, config.workspaceRoots);
  checks.push({name: 'ripgrep', ...rg, required: false});

  const externalRuntimes = [...new Set(Object.values(config.agents?.routes ?? {})
    .map((route) => route.runtime)
    .filter((runtime): runtime is 'codex' | 'claude' | 'grok' => Boolean(runtime && runtime !== 'api')))];
  for (const runtime of externalRuntimes) {
    const resolved = await resolveExecutableRuntime(runtime, root, config.workspaceRoots);
    checks.push({
      name: `Agent runtime: ${runtime}`,
      ok: Boolean(resolved),
      detail: resolved?.executable ?? 'not found on a trusted PATH entry',
      required: false,
    });
  }

  const context = new ContextEngine(config);
  const capability = await context.inspectExternal({refresh: true});
  const external = capability.available && capability.indexed;
  checks.push({
    name: 'ContextEngine',
    ok: config.context.engine === 'local' || capability.available,
    detail: capability.detail,
    required: config.context.engine === 'contextengine',
  });
  if (capability.available && capability.indexed) {
    const status = capability.status as {
      hasEmbeddings?: boolean;
      embeddingModel?: string | null;
    } | undefined;
    checks.push({
      name: 'Context channels',
      ok: status?.hasEmbeddings === true,
      detail: status?.hasEmbeddings === false
        ? 'lexical available; semantic unavailable; configure CONTEXTENGINE_EMBEDDING_*'
        : status?.embeddingModel
          ? `lexical + semantic (${status.embeddingModel})`
          : 'lexical available; semantic status not reported',
      required: false,
    });
  }
  try {
    const status = await context.status({refresh: false});
    const local = status.local as {available?: boolean; files?: number} | undefined;
    checks.push({
      name: 'Code index',
      ok: Boolean(external || local?.available),
      detail: external
        ? `external index selected; freshness ${capability.freshness}`
        : capability.available && !capability.indexed
          ? `external workspace is not indexed; run ${PRODUCT_COMMAND} index`
        : local?.available
          ? `local index ${glyphs.separator} ${local.files ?? 0} files`
          : capability.reason && capability.reason !== 'not-installed'
            ? `${capability.detail}; local index not built`
            : `not built; run ${PRODUCT_COMMAND} index`,
      required: config.context.engine === 'contextengine',
    });
  } catch (error) {
    checks.push({
      name: 'Code index',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      required: false,
    });
  }

  if (json) {
    process.stdout.write(`${JSON.stringify({
      ok: checks.every((check) => !check.required || check.ok),
      checks,
      ...(namespace ? {namespace} : {}),
      ...(homeNamespace ? {homeNamespace} : {}),
      ...(namespaceRecovery ? {namespaceRecovery} : {}),
      ...(homeRecovery ? {homeRecovery} : {}),
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`${chalk.hex('#A78BFA').bold(`${glyphs.brand} ${PRODUCT_NAME.toUpperCase()} DOCTOR`)}\n\n`);
    for (const check of checks) {
      const icon = check.ok ? chalk.green(glyphs.success) : check.required ? chalk.red(glyphs.error) : chalk.yellow('!');
      process.stdout.write(`${icon} ${check.name.padEnd(20)} ${chalk.dim(check.detail)}\n`);
    }
    if (options.visual) printVisualCalibration(glyphs);
  }
  return checks.every((check) => !check.required || check.ok);
}

export function supportsNodeVersion(version: string): boolean {
  const match = version.trim().replace(/^v/u, '').match(/^(\d+)\.(\d+)\.(\d+)/u);
  if (!match) return false;
  const current = match.slice(1).map(Number);
  const minimum = MINIMUM_NODE_VERSION.split('.').map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    if ((current[index] ?? 0) > (minimum[index] ?? 0)) return true;
    if ((current[index] ?? 0) < (minimum[index] ?? 0)) return false;
  }
  return true;
}

export async function checkSqliteFts5(): Promise<{ok: boolean; detail: string}> {
  try {
    const {DatabaseSync} = await import('node:sqlite');
    const database = new DatabaseSync(':memory:');
    try {
      database.exec('CREATE VIRTUAL TABLE skein_doctor_fts USING fts5(content)');
      return {ok: true, detail: 'available'};
    } finally {
      database.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {ok: false, detail: `unavailable; ${message}`};
  }
}

function visualChecks(glyphs: CliGlyphs): Check[] {
  const columns = process.stdout.columns ?? 0;
  const rows = process.stdout.rows ?? 0;
  const glyphMode = process.env.SKEIN_GLYPHS ?? process.env.MOSAIC_GLYPHS ?? 'unicode';
  const color = process.env.NO_COLOR
    ? 'disabled by NO_COLOR'
    : process.env.COLORTERM || process.env.TERM || 'terminal default';
  const keyboard = process.env.TERM_PROGRAM
    ? `${process.env.TERM_PROGRAM}; Kitty protocol auto-negotiates when supported`
    : 'Kitty protocol auto-negotiates when supported';
  return [
    {
      name: 'Terminal viewport',
      ok: Boolean(process.stdout.isTTY) && columns >= 20,
      detail: process.stdout.isTTY
        ? `${columns || '?'} columns ${glyphs.separator} ${rows || '?'} rows${columns && columns < 24 ? ` ${glyphs.separator} narrow mode active` : ''}`
        : 'not an interactive TTY',
      required: false,
    },
    {
      name: 'Color rendering',
      ok: true,
      detail: color,
      required: false,
    },
    {
      name: 'Glyph mode',
      ok: glyphMode === 'ascii' || process.stdout.isTTY === true,
      detail: glyphMode === 'ascii'
        ? 'ASCII fallback forced'
        : 'Unicode; set SKEIN_GLYPHS=ascii if symbols do not align',
      required: false,
    },
    {
      name: 'Keyboard input',
      ok: Boolean(process.stdin.isTTY),
      detail: keyboard,
      required: false,
    },
    {
      name: 'Font guidance',
      ok: true,
      detail: 'Iosevka Term for density; JetBrains Mono NL for broad compatibility; Sarasa Mono SC for CJK',
      required: false,
    },
  ];
}

function printVisualCalibration(glyphs: CliGlyphs): void {
  process.stdout.write('\nVisual calibration\n');
  if (glyphs.mode === 'ascii') {
    process.stdout.write('  0123456789  ABCDEFGHIJ  ASCII width  | box - draw\n');
    process.stdout.write(`  ${glyphs.success} success  ${glyphs.error} error  ! warning  i info  * accent  ${glyphs.ellipsis} truncation\n`);
  } else {
    process.stdout.write('  0123456789  ABCDEFGHIJ  中文宽度  🧪 emoji  │ box ─ draw\n');
    process.stdout.write(`  ${glyphs.success} success  ${glyphs.error} error  ! warning  i info  ● accent  ${glyphs.ellipsis} truncation\n`);
  }
  process.stdout.write(`  ${process.env.NO_COLOR ? 'Monochrome semantics are enabled.' : 'Check that each semantic color remains readable on your terminal background.'}\n`);
}

async function commandCheck(command: string, args: string[], cwd: string, excludedRoots: string[]) {
  try {
    const runtime = await resolveExecutableRuntime(command, cwd, excludedRoots);
    if (!runtime) return {ok: false, detail: 'not found'};
    const result = await runProcess(runtime.executable, args, {
      cwd,
      timeoutMs: 5_000,
      env: {PATH: runtime.path},
      unsetEnv: ['Path'],
    });
    return {
      ok: result.exitCode === 0,
      detail: (result.stdout || result.stderr).trim().split('\n')[0] ?? command,
    };
  } catch {
    return {ok: false, detail: 'not found'};
  }
}

function keyEnvironmentName(provider: MosaicConfig['model']['provider']): string {
  if (provider === 'anthropic') return 'ANTHROPIC_API_KEY';
  if (provider === 'gemini') return 'GEMINI_API_KEY';
  if (provider === 'compatible') return 'SKEIN_API_KEY';
  return 'OPENAI_API_KEY';
}
