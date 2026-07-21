import {access} from 'node:fs/promises';
import {constants} from 'node:fs';
import chalk from 'chalk';
import type {MosaicConfig} from '../types.js';
import {redactEndpoint} from '../config.js';
import {ContextEngine} from '../context/context-engine.js';
import {resolveExecutableRuntime, runProcess} from '../utils/process.js';
import {PRODUCT_COMMAND, PRODUCT_NAME} from '../brand.js';
import {resolveCliGlyphs, type CliGlyphs} from './glyphs.js';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  required: boolean;
}

export interface DoctorOptions {
  json?: boolean;
  visual?: boolean;
}

export async function runDoctor(config: MosaicConfig, options: DoctorOptions = {}): Promise<boolean> {
  const json = options.json === true;
  const glyphs = resolveCliGlyphs();
  const root = config.workspaceRoots[0] ?? process.cwd();
  const checks: Check[] = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'Node.js',
    ok: major >= 22,
    detail: process.version,
    required: true,
  });
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

  const context = new ContextEngine(config);
  const external = await context.canUseExternal();
  checks.push({
    name: 'ContextEngine',
    ok: external,
    detail: external
      ? `${config.context.contextEngineCommand} available`
      : 'not installed; local BM25 fallback will be used',
    required: false,
  });
  try {
    const status = await context.status();
    const local = status.local as {available?: boolean; files?: number} | undefined;
    checks.push({
      name: 'Code index',
      ok: Boolean(external || local?.available),
      detail: external
        ? 'external engine selected'
        : local?.available
          ? `local index ${glyphs.separator} ${local.files ?? 0} files`
          : `not built; run ${PRODUCT_COMMAND} index`,
      required: false,
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
