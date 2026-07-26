import {createInterface} from 'node:readline/promises';
import {stdin as input, stdout as output} from 'node:process';
import {lstat, readFile, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {basename, isAbsolute, relative, resolve} from 'node:path';
import {Command, Option} from 'commander';
import chalk from 'chalk';
import {
  configSummary,
  defaultModelForProvider,
  loadConfig,
  redactEndpoint,
  resolveRuntimeModel,
  saveProjectConfig,
  saveUserConfig,
  trustProjectModelConfig,
} from './config.js';
import {ContextEngine, formatContextHits} from './context/context-engine.js';
import {AgentRunner} from './agent/index.js';
import {
  AgentProfileCatalog,
  buildCapabilityCandidates,
  CapabilityRegistryStore,
  evaluateCapabilityReplay,
  evaluateCapabilityShadow,
  formatReviewVerdict,
  listConnectionModels,
  TeamRunStore,
  type AgentProfile,
  type CapabilityShadowReport,
  type CapabilityReplayReport,
  type CapabilityHealthFailure,
} from './agent/index.js';
import {resolveAgentModelRoute} from './agent/model-route.js';
import {deterministicEvidenceReceiptValid} from './agent/evidence-receipt.js';
import {createAgentConnectionSetup, mergeAgentSetup} from './agent/model-setup.js';
import {
  connectionCredentialReference,
  connectionRuntimeCatalog,
  discoverConnectionCatalog,
  legacyConnectionRuntimeInfo,
  planConnectionSelection,
  resolveConnectionModel,
  type ConnectionProfile,
} from './agent/connection-catalog.js';
import {discoverWorkspaceRules} from './agent/rules.js';
import {createProvider} from './providers/index.js';
import {SessionStore, ToolArtifactStore, type SessionSummary} from './session/index.js';
import {CheckpointStore} from './checkpoint/index.js';
import {createDefaultToolRegistry} from './tools/index.js';
import {atomicWrite} from './tools/write.js';
import {runDoctor} from './cli/doctor.js';
import {
  askConsolePermission,
  HeadlessReporter,
  printBanner,
  type OutputFormat,
} from './cli/output.js';
import {resolveCliGlyphs} from './cli/glyphs.js';
import {acquireCliNamespaceLeases, releaseCliNamespaceLeases} from './cli/namespace-leases.js';
import {
  needsFirstRunOnboarding,
  runFirstRunOnboarding,
  runInteractiveTui,
  runWorkspacePreparation,
} from './ui/index.js';
import {ExtensionRuntime} from './runtime/index.js';
import {SkillCatalog, type SkillDescriptor} from './skills/index.js';
import {
  MemoryStore,
  type MemoryCandidate,
  type MemoryPrivacyReview,
  type MemorySelectionOptions,
} from './memory/index.js';
import {McpManager} from './mcp/index.js';
import {WorkflowCatalog} from './workflows/index.js';
import type {MosaicConfig, ProviderName, Session} from './types.js';
import type {IndexProgress} from './context/local-index.js';
import {workspaceAliasPath} from './utils/path.js';
import {
  inspectHomeNamespace,
  inspectHomeRecovery,
  inspectHomeRollback,
  inspectProjectNamespace,
  inspectProjectRecovery,
  inspectProjectRollback,
  migrateHomeNamespace,
  migrateProjectNamespace,
  rollbackHomeNamespace,
  rollbackProjectNamespace,
  recoverHomeNamespace,
  recoverProjectNamespace,
  resolveProjectNamespaceSync,
} from './utils/namespace.js';
import {refreshUpdateCache, updateNoticeText, upgradeCommand, type UpdateNotice} from './utils/update-check.js';
import {resolveUpgradePlan, runUpgrade, upgradeCommandOverride} from './utils/self-update.js';
import {PRODUCT_NAME, PRODUCT_COMMAND} from './brand.js';
import {PLAN_MODE_INSTRUCTIONS} from './agent/prompt.js';
import packageJson from '../package.json' with {type: 'json'};

const cliGlyphs = resolveCliGlyphs();

// node:sqlite is still marked experimental in Node 22. Keep its one-time
// notice out of the interactive surface while preserving all other warnings.
const defaultWarningListeners = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) return;
  for (const listener of defaultWarningListeners) {
    if (typeof listener === 'function') listener.call(process, warning);
  }
});

const program = new Command();
// Subcommands such as `init` intentionally reuse option names from the chat
// command. Positional parsing keeps `skein init --provider ...` owned by the
// subcommand instead of letting the parent silently consume it.
program.enablePositionalOptions();

program
  .name(PRODUCT_COMMAND)
  .description('A context-first, model-agnostic coding agent with an auditable workspace.')
  .version(packageJson.version)
  .showSuggestionAfterError();

program
  .argument('[prompt...]', 'instruction for the agent')
  .option('-p, --print', 'run once and print the result')
  .option('-a, --ask', 'retrieval and inspection mode; mutation tools are denied')
  .option('--plan', 'read-only planning mode; propose changes without mutating the workspace')
  .option('-q, --quiet', 'print only the final response in text mode')
  .addOption(new Option('--output-format <format>', 'text, json, or stream-json')
    .choices(['text', 'json', 'stream-json']).default('text'))
  .option('--compact', 'reduce progress output in print mode')
  .option('--yes', 'approve all non-denied tool requests for this run')
  .option('--auto-edit', 'approve read/write requests and ask before shell/Git/network')
  .option('--trust-project-config', 'allow executable and security-sensitive settings from project config')
  .option('--queue <prompt>', 'run an additional prompt after the first one', collect, [])
  .option('-w, --workspace <path>', 'primary workspace root', process.cwd())
  .option('--add-workspace <path>', 'additional workspace root', collect, [])
  .option('--config <path>', 'explicit config file')
  .option('--connection <name>', 'named model connection')
  .option('--provider <provider>', 'model provider')
  .option('--model <model>', 'model identifier')
  .option('--base-url <url>', 'OpenAI-compatible or provider base URL')
  .option('--max-turns <n>', 'maximum agent turns')
  .option('--epoch-token-budget <n>', 'maximum tokens before an internal context handoff')
  .option('--token-budget <n>', 'maximum lifetime tokens across the resumed session')
  .option('--resume [session]', 'resume a session by id or prefix')
  .option('-c, --continue', 'resume the latest session')
  .option('--no-color', 'disable color output')
  .option('--no-checkpoint', 'disable pre-mutation checkpoints for this run')
  .action(async (prompts: string[], options: RootOptions) => {
    await runChat(prompts, options);
  });

program
  .command('init')
  .description('Create a project-local config (preserving an existing .mosaic namespace)')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--provider <provider>', 'openai, anthropic, gemini, or compatible', 'openai')
  .option('--model <model>', 'model identifier')
  .option('--base-url <url>', 'provider base URL')
  .option('--api-key <key>', 'store a provider key in project config (prefer env vars)')
  .option('--index', 'build the index after writing config')
  .option('--yes', 'use defaults without prompting')
  .action(async (options: InitOptions) => {
    await runInit(options);
  });

const configCommand = program.command('config').description('Inspect the resolved configuration');
configCommand
  .command('show')
  .description('Show effective configuration with secrets redacted')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--config <path>', 'explicit config file')
  .option('--json', 'print JSON')
  .action(async (options: ConfigOptions) => {
    const config = await runtimeConfig(workspaceOption(options.workspace), runtimeOptions(options));
    printObject(configSummary(config), options.json === true);
  });
configCommand
  .command('path')
  .description('Show the project config path')
  .option('-w, --workspace <path>', 'workspace root')
  .action((options: {workspace?: string}) => {
    const workspace = workspaceOption(options.workspace);
    process.stdout.write(`${resolveProjectNamespaceSync(workspace).active}/config.json\n`);
  });

program
  .command('index')
  .description('Index the configured workspace')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--add-workspace <path>', 'additional root', collect, [])
  .option('--config <path>', 'explicit config file')
  .option('--json', 'print JSON')
  .action(async (options: IndexOptions) => {
    const config = await runtimeConfig(workspaceOption(options.workspace), runtimeOptions(options));
    const engine = new ContextEngine(config);
    let last = '';
    const result = await engine.index((progress) => {
      if (options.json || progress.phase === 'write') return;
      const line = progressLine(progress);
      if (line === last) return;
      last = line;
      process.stderr.write(`\r\x1b[K${line}`);
    });
    if (!options.json) process.stderr.write('\n');
    printObject(result, options.json === true);
  });

program
  .command('search')
  .description('Search indexed code and print grounded file spans')
  .argument('<query>', 'search query')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--config <path>', 'explicit config file')
  .option('-k, --top-k <n>', 'number of results', '12')
  .option('--json', 'print JSON')
  .action(async (query: string, options: SearchOptions) => {
    const config = await runtimeConfig(workspaceOption(options.workspace), runtimeOptions(options));
    const engine = new ContextEngine(config);
    const hits = await engine.search(query, positiveInt(options.topK, 12));
    const degradation = engine.lastDegradation();
    if (options.json) {
      printObject({hits, ...(degradation ? {degradation} : {})}, true);
      return;
    }
    process.stdout.write(`${formatContextHits(hits, config.workspaceRoots)}\n`);
    if (degradation) {
      process.stderr.write(chalk.yellow(`! ${degradation.summary}\n`));
    }
    for (const hit of hits) {
      process.stdout.write(`\n${workspaceAliasPath(hit.path, config.workspaceRoots)}:${hit.startLine}-${hit.endLine}\n`);
      process.stdout.write(`${hit.content.slice(0, 1_200)}\n`);
    }
  });

program
  .command('context')
  .description('Pack task-oriented context under a token budget')
  .argument('<query>', 'task description')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--config <path>', 'explicit config file')
  .option('--max-tokens <n>', 'token cap')
  .option('--json', 'print JSON')
  .action(async (query: string, options: ContextOptions) => {
    const config = await runtimeConfig(workspaceOption(options.workspace), runtimeOptions(options));
    const engine = new ContextEngine(config);
    const packed = options.maxTokens
      ? await new ContextEngine({...config, context: {
        ...config.context,
        maxTokens: positiveInt(options.maxTokens, config.context.maxTokens),
      }}).pack(query)
      : await engine.pack(query);
    if (options.json) {
      printObject(packed, true);
      return;
    }
    process.stdout.write(`${packed.text}\n\n`);
    process.stderr.write(chalk.dim(
      `${cliGlyphs.meta} ${packed.engine} ${cliGlyphs.separator} ${packed.hits.length} spans ${cliGlyphs.separator} ~${packed.estimatedTokens} estimated tokens${packed.budgetTokens === undefined ? '' : ` ${cliGlyphs.separator} ${packed.budgetTier ?? 'adaptive'} ${packed.budgetTokens} budget`}${packed.truncated ? ` ${cliGlyphs.separator} capped` : ''}${packed.degradation ? ` ${cliGlyphs.separator} ${packed.degradation.summary}` : ''}\n`,
    ));
  });

program
  .command('status')
  .description('Show model, context, workspace, and index status')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--config <path>', 'explicit config file')
  .option('--json', 'print JSON')
  .action(async (options: ConfigOptions) => {
    const config = await runtimeConfig(workspaceOption(options.workspace), runtimeOptions(options));
    const engine = new ContextEngine(config);
    const status = await engine.status();
    const namespace = resolveProjectNamespaceSync(config.workspaceRoots[0] ?? process.cwd());
    // status is a diagnostic surface and the only path that refreshes the update
    // cache for pure-CLI users who never open the TUI. Bounded, interval-gated,
    // and non-fatal; a null result just means "up to date or offline".
    const update = await refreshUpdateCache(packageJson.version).catch(() => undefined);
    if (options.json === true) {
      const updateJson = update
        ? {current: update.current, latest: update.latest, command: update.command, ...(update.highlights ? {highlights: update.highlights} : {})}
        : {current: packageJson.version, latest: null, command: upgradeCommand()};
      printObject({config: configSummary(config), context: status, namespace, update: updateJson}, true);
    } else {
      printStatusSummary(config, status, namespace, update);
    }
  });

program
  .command('doctor')
  .description('Diagnose prerequisites and safe fallbacks')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--config <path>', 'explicit config file')
  .option('--json', 'print JSON')
  .option('--visual', 'inspect terminal rendering, glyphs, and keyboard support')
  .action(async (options: ConfigOptions & {visual?: boolean}) => {
    const config = await runtimeConfig(workspaceOption(options.workspace), runtimeOptions(options));
    const ok = await runDoctor(config, {json: options.json === true, visual: options.visual === true});
    if (!ok) process.exitCode = 1;
  });

program
  .command('update')
  .description('Update to the latest published release')
  .option('--check', 'only report whether a newer version is available')
  .option('--yes', 'skip the confirmation prompt and upgrade immediately')
  .option('--json', 'print the result as JSON')
  .action(async (options: {check?: boolean; yes?: boolean; json?: boolean}) => {
    const json = options.json === true;
    const current = packageJson.version;
    // A user asking to update wants the freshest answer, so bypass the 24h
    // interval gate. Never throws; a null result means up to date or offline.
    const notice = await refreshUpdateCache(current, {force: true}).catch(() => undefined);

    if (!notice) {
      if (json) printObject({current, latest: current, upToDate: true}, true);
      else process.stdout.write(`${chalk.green(cliGlyphs.success)} Already on the latest release (v${current}).\n`);
      return;
    }

    const override = upgradeCommandOverride();
    const plan = override
      ? {command: override, args: [] as string[], manager: 'custom' as const, display: override, shell: true}
      : {...resolveUpgradePlan({version: notice.latest}), shell: false};

    if (json && options.check === true) {
      printObject({current, latest: notice.latest, upToDate: false, command: plan.display, ...(notice.highlights ? {highlights: notice.highlights} : {})}, true);
      return;
    }

    process.stdout.write(`${chalk.cyan(cliGlyphs.brand)} Update available ${chalk.dim(`v${current}`)} ${cliGlyphs.separator} ${chalk.green(`v${notice.latest}`)}\n`);
    for (const highlight of notice.highlights ?? []) {
      process.stdout.write(`  ${cliGlyphs.separator} ${highlight}\n`);
    }

    if (options.check === true) {
      process.stdout.write(`  Run ${chalk.cyan(`${PRODUCT_COMMAND} update`)} to install ${chalk.dim(`(${plan.display})`)}.\n`);
      return;
    }

    // Only prompt when attached to an interactive terminal; piped or scripted
    // invocations must pass --yes so we never block on a prompt nobody can answer.
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (options.yes !== true) {
      if (!interactive) {
        process.stdout.write(`  Re-run with ${chalk.cyan(`${PRODUCT_COMMAND} update --yes`)} to install ${chalk.dim(`(${plan.display})`)}.\n`);
        return;
      }
      const rl = createInterface({input, output});
      try {
        const answer = (await rl.question(`  Install ${chalk.dim(plan.display)}? [Y/n] `)).trim().toLowerCase();
        if (answer === 'n' || answer === 'no') {
          process.stdout.write('  Update cancelled.\n');
          return;
        }
      } finally {
        rl.close();
      }
    }

    process.stdout.write(`${chalk.dim(`${cliGlyphs.running} ${plan.display}`)}\n`);
    const result = await runUpgrade(plan);
    if (result.ok) {
      process.stdout.write(`${chalk.green(cliGlyphs.success)} Updated to v${notice.latest}. Restart ${PRODUCT_COMMAND} to use it.\n`);
    } else {
      process.stdout.write(`${chalk.red(cliGlyphs.error)} Update failed (exit ${result.exitCode}). Run ${chalk.cyan(plan.display)} manually.\n`);
      process.exitCode = 1;
    }
  });

program
  .command('migrate')
  .description('Inspect or migrate legacy .mosaic state into .skein')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--json', 'print a migration manifest as JSON')
  .option('--yes', 'perform the migration after conflict checks')
  .option('--rollback', 'verify and roll back a completed migration')
  .option('--recover', 'inspect or recover interrupted migration/rollback state')
  .option('--home', 'operate on the user-level Skein/Mosaic namespace')
  .action(async (options: {workspace?: string; json?: boolean; yes?: boolean; rollback?: boolean; recover?: boolean; home?: boolean}) => {
    if (options.home && options.workspace) throw new Error('--workspace cannot be combined with --home.');
    if (options.recover && options.rollback) throw new Error('--recover and --rollback cannot be combined.');
    if (options.recover) {
      const recovery = options.yes
        ? options.home ? await recoverHomeNamespace() : await recoverProjectNamespace(workspaceOption(options.workspace))
        : options.home ? await inspectHomeRecovery() : await inspectProjectRecovery(workspaceOption(options.workspace));
      if (options.json) {
        printObject(recovery, true);
        return;
      }
      if (recovery.status === 'clean') {
        process.stdout.write('No interrupted namespace operations found.\n');
        return;
      }
      process.stdout.write(`${recovery.status === 'recovered' ? 'Recovered' : 'Recovery candidates'}: ${recovery.destination}\n`);
      for (const candidate of recovery.candidates) {
        process.stdout.write(`  ${basename(candidate.path)}  ${candidate.kind}  ${candidate.action}  ${candidate.detail}\n`);
      }
      if (!options.yes && recovery.status === 'ready') {
        process.stdout.write(`Run \`skein migrate${options.home ? ' --home' : ''} --recover --yes\` to apply safe recovery actions.\n`);
      }
      return;
    }
    if (options.rollback && !options.yes) {
      const inspection = options.home
        ? await inspectHomeRollback()
        : await inspectProjectRollback(workspaceOption(options.workspace));
      const {manifest} = inspection;
      if (options.json) {
        printObject({...manifest, rollbackReady: inspection.ready, rollbackDetail: inspection.detail}, true);
        return;
      }
      process.stdout.write(`${manifest.source} -> ${manifest.destination}\n`);
      process.stdout.write(`${inspection.detail}\n`);
      if (inspection.ready) {
        process.stdout.write(`Run \`skein migrate${options.home ? ' --home' : ''} --rollback --yes\` to apply the verified rollback.\n`);
      }
      return;
    }
    const manifest = options.home
      ? options.rollback
        ? await rollbackHomeNamespace()
        : options.yes
          ? await migrateHomeNamespace()
          : await inspectHomeNamespace()
      : options.rollback
        ? await rollbackProjectNamespace(workspaceOption(options.workspace))
        : options.yes
          ? await migrateProjectNamespace(workspaceOption(options.workspace))
          : await inspectProjectNamespace(workspaceOption(options.workspace));
    if (options.json) {
      printObject(manifest, true);
      return;
    }
    if (options.rollback) {
      process.stdout.write(manifest.status === 'rolled_back'
        ? `Rolled back ${manifest.destination}; legacy state remains at ${manifest.source}.\n`
        : manifest.status === 'not_available'
          ? `No completed migration found; storage remains at ${manifest.source}.\n`
          : `Storage is already using ${manifest.source}; no rollback was needed.\n`);
      return;
    }
    if (manifest.status === 'complete') {
      process.stdout.write(!manifest.sourceExists && !manifest.destinationExists
        ? 'No storage state exists yet; nothing to migrate.\n'
        : `Storage is already migrated to ${manifest.destination}.\n`);
      return;
    }
    process.stdout.write(
      `${manifest.status === 'conflict' ? 'Migration blocked' : options.yes ? 'Migrated' : 'Migration available'}: ` +
      `${manifest.source} -> ${manifest.destination}\n`,
    );
    process.stdout.write(`${manifest.entries.length} entries, ${manifest.conflicts.length} conflicts.\n`);
    if (!options.yes && manifest.status === 'ready') {
      process.stdout.write(`Run \`skein migrate${options.home ? ' --home' : ''} --yes\` to copy atomically; legacy state is retained for rollback.\n`);
    }
  });

const sessionCommand = program.command('session').description('Manage local, resumable sessions');
sessionCommand
  .command('list')
  .description('List sessions for this workspace')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--json', 'print JSON')
  .action(async (options: SessionCommandOptions) => {
    const store = new SessionStore(workspaceOption(options.workspace));
    const sessions = await store.list();
    if (options.json) printObject(sessions, true);
    else printSessionList(sessions);
  });
sessionCommand
  .command('show <id>')
  .description('Show a saved session transcript')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--json', 'print JSON')
  .action(async (id: string, options: SessionCommandOptions) => {
    const store = new SessionStore(workspaceOption(options.workspace));
    const session = await requireSessionSelector(store, id);
    if (options.json) printObject(session, true);
    else process.stdout.write(sessionMarkdown(session));
  });
sessionCommand
  .command('delete <id>')
  .description('Delete a saved session')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--yes', 'skip confirmation')
  .action(async (id: string, options: SessionCommandOptions & {yes?: boolean}) => {
    const workspace = workspaceOption(options.workspace);
    const store = new SessionStore(workspace);
    const session = await requireSessionSelector(store, id);
    if (!options.yes && !(await confirm(`Delete session ${session.id.slice(0, 8)}?`))) return;
    await new ToolArtifactStore(workspace).removeSession(session.id);
    await store.remove(session.id);
    process.stdout.write(`Deleted ${session.id}\n`);
  });
sessionCommand
  .command('export <id>')
  .description('Export a session as Markdown')
  .option('-w, --workspace <path>', 'workspace root')
  .option('-o, --output <path>', 'write to a file')
  .action(async (id: string, options: SessionCommandOptions & {output?: string}) => {
    const store = new SessionStore(workspaceOption(options.workspace));
    const session = await requireSessionSelector(store, id);
    const markdown = sessionMarkdown(session);
    if (options.output) await writeFile(resolve(options.output), markdown, 'utf8');
    else process.stdout.write(markdown);
  });

const checkpointCommand = program.command('checkpoint').description('Inspect and restore pre-mutation snapshots');
checkpointCommand
  .command('list <session>')
  .description('List checkpoints for a session')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--json', 'print JSON')
  .action(async (sessionId: string, options: SessionCommandOptions) => {
    const store = new CheckpointStore(workspaceOption(options.workspace));
    const checkpoints = await store.list(sessionId);
    if (options.json) printObject(checkpoints, true);
    else {
      for (const checkpoint of checkpoints) {
        process.stdout.write(`${checkpoint.id}  ${checkpoint.createdAt}  ${checkpoint.reason}  (${checkpoint.entries.length} files)\n`);
      }
    }
  });
checkpointCommand
  .command('restore <session> <checkpoint>')
  .description('Restore files from a checkpoint')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--yes', 'skip confirmation')
  .action(async (sessionId: string, checkpointId: string, options: SessionCommandOptions & {yes?: boolean}) => {
    const store = new CheckpointStore(workspaceOption(options.workspace));
    const manifest = await store.load(sessionId, checkpointId);
    if (!options.yes && !(await confirm(`Restore ${manifest.entries.length} files from ${checkpointId}?`))) return;
    const restored = await store.restore(sessionId, checkpointId);
    process.stdout.write(`Restored ${restored.length} files.\n`);
  });

program
  .command('tools')
  .description('List built-in agent tools and permission categories')
  .option('--json', 'print JSON')
  .action((options: {json?: boolean}) => {
    const definitions = createDefaultToolRegistry().definitions();
    if (options.json) printObject(definitions, true);
    else for (const definition of definitions) {
      process.stdout.write(`${definition.name.padEnd(16)} ${definition.category.padEnd(8)} ${definition.description}\n`);
    }
  });

const skillsCommand = program.command('skills').description('Discover task-specific Agent Skills');
skillsCommand
  .command('list')
  .description('List discovered SKILL.md playbooks')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--config <path>', 'explicit config file')
  .option('--json', 'print JSON')
  .action(async (options: ConfigOptions) => {
    const {skills, workspace} = await discoverSkills(options);
    if (options.json) printObject(skills, true);
    else if (!skills.length) process.stdout.write('No skills discovered.\n');
    else for (const skill of skills) {
      process.stdout.write(
        `${skill.name.padEnd(22)} ${skill.scope.padEnd(10)} ${skill.trust.padEnd(10)} ` +
        `${skill.effect.padEnd(13)} ${displaySkillSource(workspace, skill.path)}  ${skill.description}\n`,
      );
    }
  });
skillsCommand
  .command('inspect <name>')
  .description('Inspect a skill source, exact fingerprint, trust, and activation effect')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--config <path>', 'explicit config file')
  .option('--json', 'print JSON')
  .action(async (name: string, options: ConfigOptions) => {
    const {skills, workspace} = await discoverSkills(options);
    const skill = skills.find((candidate) => candidate.name === name);
    if (!skill) throw new Error(`Unknown skill: ${name}`);
    if (options.json) printObject(skill, true);
    else printSkillReview(skill, workspace);
  });
skillsCommand
  .command('trust <name>')
  .description('Trust one exact workspace skill fingerprint after review')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--config <path>', 'explicit config file')
  .option('--yes', 'confirm the trust decision')
  .action(async (name: string, options: ConfigOptions & {yes?: boolean}) => {
    const {catalog, skills, workspace} = await discoverSkills(options);
    const skill = skills.find((candidate) => candidate.name === name);
    if (!skill) throw new Error(`Unknown skill: ${name}`);
    printSkillReview(skill, workspace);
    if (skill.trustSource === 'source') {
      process.stdout.write('This user-owned or explicitly configured external source is already trusted.\n');
      return;
    }
    if (!options.yes) {
      const accepted = await confirm(`Trust skill ${name} at this exact source and fingerprint?`);
      if (!accepted) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          throw new Error('Skill trust requires explicit --yes confirmation in non-interactive mode.');
        }
        process.stdout.write('Skill trust cancelled.\n');
        return;
      }
    }
    const trusted = await catalog.trust(name);
    process.stdout.write(`Trusted ${trusted.name} (${trusted.fingerprint.slice(0, 12)}); effect=${trusted.effect}.\n`);
  });
skillsCommand
  .command('revoke <name>')
  .description('Revoke persisted trust for a workspace skill')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--config <path>', 'explicit config file')
  .option('--yes', 'confirm revocation')
  .action(async (name: string, options: ConfigOptions & {yes?: boolean}) => {
    const {catalog, skills, workspace} = await discoverSkills(options);
    const skill = skills.find((candidate) => candidate.name === name);
    if (!skill) throw new Error(`Unknown skill: ${name}`);
    printSkillReview(skill, workspace);
    if (!options.yes) {
      const accepted = await confirm(`Revoke trust for skill ${name}?`);
      if (!accepted) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          throw new Error('Skill revocation requires explicit --yes confirmation in non-interactive mode.');
        }
        process.stdout.write('Skill revocation cancelled.\n');
        return;
      }
    }
    const revoked = await catalog.revoke(name);
    process.stdout.write(`Revoked ${revoked.name}; effect=${revoked.effect}.\n`);
  });

const agentsCommand = program.command('agents').description('Inspect specialized agent profiles');
agentsCommand
  .command('list')
  .description('List built-in and discovered expert profiles')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--config <path>', 'explicit config file')
  .option('--json', 'print JSON')
  .action(async (options: ConfigOptions) => {
    const workspace = workspaceOption(options.workspace);
    const config = await runtimeConfig(workspace, runtimeOptions(options));
    const catalog = new AgentProfileCatalog(workspace);
    const profiles = await catalog.discover();
    const roster = profiles.map((profile) => {
      const resolved = resolveAgentModelRoute(config.agents, config.model, profile.name);
      const route = resolved.route;
      const connection = route?.connection ? config.agents?.connections?.[route.connection] : undefined;
      return {
        ...profile,
        routeSource: resolved.source,
        route: route ? {
          runtime: route.runtime ?? 'api',
          connection: route.connection,
          provider: route.provider ?? connection?.provider,
          model: route.model ?? config.model.model,
          endpoint: redactEndpoint(route.baseUrl ?? connection?.baseUrl ?? (route.provider === config.model.provider ? config.model.baseUrl : undefined)),
          credentials: route.apiKeyEnv ?? connection?.apiKeyEnv
            ? `env:${route.apiKeyEnv ?? connection?.apiKeyEnv}`
            : 'inherited when compatible',
          tokenBudget: route.tokenBudget,
          maxToolCalls: route.maxToolCalls,
          timeoutMs: route.timeoutMs,
          hostedTools: route.hostedTools ?? [],
          pricing: route.pricing ? 'route' : connection?.pricing ? 'connection' : 'unpriced',
          costBudgetUsd: route.costBudgetUsd ?? config.agents?.maxAgentCostUsd,
          budgetMode: route.budgetMode ?? config.agents?.budgetMode ?? 'observe',
        } : {
          runtime: 'api',
          provider: config.model.provider,
          model: config.model.model,
          endpoint: redactEndpoint(config.model.baseUrl),
          credentials: 'inherited',
        },
      };
    });
    if (options.json) printObject(roster, true);
    else for (const profile of roster) {
      const routeTelemetry = 'pricing' in profile.route
        ? ` hosted=${profile.route.hostedTools?.join(',') || 'none'} pricing=${profile.route.pricing} cost-cap=${profile.route.costBudgetUsd ?? 'none'} mode=${profile.route.budgetMode}`
        : '';
      process.stdout.write(`${profile.name.padEnd(14)} ${profile.readOnly ? 'read-only' : 'writer   '} ${profile.route.runtime}:${profile.route.provider}/${profile.route.model} (${profile.routeSource})${routeTelemetry}  ${profile.description}\n`);
    }
  });
agentsCommand
  .command('setup')
  .description('Configure one shared model connection and team defaults')
  .option('-w, --workspace <path>', 'workspace used to resolve current defaults')
  .option('--name <name>', 'connection name')
  .option('--provider <provider>', 'relay provider; only compatible is supported')
  .option('--protocol <protocol>', 'openai-responses, openai-chat, or anthropic-messages')
  .option('--base-url <url>', 'relay inference base URL')
  .option('--models-base-url <url>', 'separate OpenAI-compatible base URL for GET /models')
  .option('--auth <type>', 'connection authentication: env or none')
  .option('--auth-header <header>', 'inference credential header: bearer or x-api-key')
  .option('--models-auth-header <header>', 'model-directory auth: bearer, x-api-key, or none; defaults to inference')
  .option('--api-key-env <name>', 'environment variable containing the credential')
  .option('--hosted-tool <tool>', 'provider-hosted tool: web_search; repeatable, or none to clear', collect, [])
  .option('--input-price <usd>', 'relay input price in USD per million tokens; pair none values to clear')
  .option('--output-price <usd>', 'relay output price in USD per million tokens; pair none values to clear')
  .option('--cached-input-price <usd>', 'relay cached-input price in USD per million tokens, or none')
  .option('--cache-write-input-price <usd>', 'relay cache-write input price in USD per million tokens, or none')
  .option('--model <model>', 'default model identifier')
  .option('--yes', 'use supplied or existing defaults without prompting')
  .option('--json', 'print JSON')
  .action(async (options: AgentSetupOptions) => {
    await runAgentSetup(options);
  });
agentsCommand
  .command('connections')
  .description('List named model endpoints and credential references')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--config <path>', 'explicit config file')
  .option('--json', 'print JSON')
  .action(async (options: ConfigOptions) => {
    const workspace = workspaceOption(options.workspace);
    const config = await runtimeConfig(workspace, runtimeOptions(options));
    const catalog = discoverConnectionCatalog(config);
    const connections = catalog.profiles.map((connection) => {
      const configured = config.agents?.connections?.[connection.id];
      return {
        name: connection.id,
        provider: connection.provider,
        protocol: connection.protocol,
        source: connection.source,
        endpoint: redactEndpoint(connection.baseUrl),
        modelsEndpoint: redactEndpoint(connection.modelsBaseUrl ?? connection.baseUrl),
        credentials: connectionCredentialReference(connection),
        authHeader: connection.auth.type === 'env' ? connection.auth.header ?? 'bearer' : null,
        modelsAuthHeader: connection.auth.type === 'env'
          ? connection.modelsAuthHeader ?? connection.auth.header ?? 'bearer'
          : null,
        routes: Object.values(config.agents?.routes ?? {}).filter((route) => route.connection === connection.id).length,
        hostedTools: configured?.hostedTools ?? [],
        pricing: configured?.pricing ? 'configured' : 'unpriced',
        default: catalog.defaultConnection === connection.id,
        complete: connectionRuntimeCatalog({profiles: [connection]}).profiles[0]?.complete ?? false,
      };
    });
    if (options.json) printObject(connections, true);
    else if (!connections.length) process.stdout.write('No named model connections configured.\n');
    else for (const connection of connections) {
      process.stdout.write(`${connection.name.padEnd(16)} ${connection.protocol.padEnd(20)} ${connection.credentials.padEnd(28)} ${connection.source.padEnd(11)} ${connection.complete ? 'ready' : 'incomplete'}${connection.default ? ' + default' : ''}  inference=${connection.endpoint} auth=${connection.authHeader ?? 'none'} models=${connection.modelsEndpoint} models-auth=${connection.modelsAuthHeader ?? 'none'} hosted=${connection.hostedTools.join(',') || 'none'} pricing=${connection.pricing}\n`);
    }
  });
agentsCommand
  .command('models <connection>')
  .description('List model IDs exposed by a named compatible connection')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--config <path>', 'explicit config file')
  .option('--json', 'print JSON')
  .action(async (connectionName: string, options: ConfigOptions) => {
    const workspace = workspaceOption(options.workspace);
    const config = await runtimeConfig(workspace, runtimeOptions(options));
    const connection = discoverConnectionCatalog(config).profiles.find(({id}) => id === connectionName);
    if (!connection) throw new Error(`Unknown model connection: ${connectionName}`);
    const models = await listConnectionModels(connection);
    if (options.json) printObject(models, true);
    else if (!models.length) process.stdout.write('No models returned by the connection.\n');
    else for (const model of models) {
      process.stdout.write(`${model.id}${model.ownedBy ? `  ${model.ownedBy}` : ''}${model.contextLength ? `  context ${model.contextLength}` : ''}\n`);
    }
  });
const capabilityCommand = agentsCommand
  .command('capability')
  .description('Inspect privacy-safe shadow capability routing');
capabilityCommand
  .command('inspect [profile]')
  .description('Compare current and conservative shadow routes without changing execution')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--config <path>', 'explicit config file')
  .option('--json', 'print JSON')
  .action(async (profileName: string | undefined, options: ConfigOptions) => {
    const context = await capabilityContext(options, profileName);
    const reports = await capabilityReports(context);
    if (options.json) printObject(profileName ? reports[0] : reports, true);
    else reports.forEach((report, index) => {
      if (index) process.stdout.write('\n');
      printCapabilityReport(report);
    });
  });
capabilityCommand
  .command('pin <profile> <route>')
  .description('Pin one exact route fingerprint for shadow recommendations')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--config <path>', 'explicit config file')
  .option('--json', 'print JSON')
  .action(async (profileName: string, routeRef: string, options: ConfigOptions) => {
    const context = await capabilityContext(options, profileName);
    const profile = context.profiles[0];
    if (!profile) throw new Error(`Unknown agent profile: ${profileName}`);
    const candidates = await buildCapabilityCandidates({
      config: context.config,
      profile,
    });
    await context.store.touchEpochs(candidates);
    const candidate = candidates.find((route) => route.ref === routeRef || route.aliases.includes(routeRef));
    if (!candidate) {
      throw new Error(`Unknown capability route ${routeRef}; use ${candidates.flatMap((route) => route.aliases).join(', ') || 'a configured route'}.`);
    }
    if (!candidate.eligible) {
      throw new Error(`Capability route ${routeRef} is ineligible: ${candidate.ineligibleReasons.join('; ')}`);
    }
    const pin = await context.store.pin(candidate);
    const result = {
      profile: profileName,
      route: candidate.ref,
      routeFingerprintSha256: pin.routeFingerprintSha256,
      taskFingerprintSha256: pin.taskFingerprintSha256,
      pinnedAt: pin.pinnedAt,
      mode: context.config.agents?.capability?.mode ?? 'shadow',
    };
    if (options.json) printObject(result, true);
    else process.stdout.write(`Pinned ${profileName} shadow route to ${candidate.ref} @ ${pin.routeFingerprintSha256.slice(0, 12)}.\n`);
  });
capabilityCommand
  .command('unpin <profile>')
  .description('Remove a profile shadow-route pin')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--config <path>', 'explicit config file')
  .option('--json', 'print JSON')
  .action(async (profileName: string, options: ConfigOptions) => {
    const context = await capabilityContext(options, profileName);
    const profile = context.profiles[0];
    if (!profile) throw new Error(`Unknown agent profile: ${profileName}`);
    const candidates = await buildCapabilityCandidates({
      config: context.config,
      profile,
    });
    const taskFingerprintSha256 = candidates[0]?.taskFingerprintSha256;
    if (!taskFingerprintSha256) throw new Error(`No capability routes are configured for ${profileName}.`);
    const removed = await context.store.unpin(taskFingerprintSha256);
    const result = {profile: profileName, removed};
    if (options.json) printObject(result, true);
    else process.stdout.write(removed ? `Removed ${profileName} shadow-route pin.\n` : `${profileName} has no shadow-route pin.\n`);
  });
capabilityCommand
  .command('canary <profile> <route> <receipt>')
  .description('Record one deterministic capability_canary receipt for shadow health')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--config <path>', 'explicit config file')
  .addOption(new Option('--failure <reason>', 'structured failure reason').choices([
    'verification_failed',
    'regression',
    'rollback',
    'reviewer_reject',
    'false_completion',
    'tool_failure',
    'schema_mismatch',
    'provider_error',
    'latency_regression',
  ]))
  .option('--json', 'print JSON')
  .action(async (profileName: string, routeRef: string, receiptFile: string, options: ConfigOptions & {
    failure?: CapabilityHealthFailure;
    json?: boolean;
  }) => {
    const context = await capabilityContext(options, profileName);
    const profile = context.profiles[0];
    if (!profile) throw new Error(`Unknown agent profile: ${profileName}`);
    const candidates = await buildCapabilityCandidates({config: context.config, profile});
    await context.store.touchEpochs(candidates);
    const candidate = candidates.find((route) => route.ref === routeRef || route.aliases.includes(routeRef));
    if (!candidate) throw new Error(`Unknown capability route ${routeRef}.`);
    const receipt = await readBoundedRegularJson(receiptFile, 'Capability canary receipt', 128_000);
    if (!deterministicEvidenceReceiptValid(receipt, {tool: 'capability_canary'})) {
      throw new Error('Capability canary receipt is invalid, corrupt, or not bound to capability_canary.');
    }
    const result = await context.store.recordCanary({
      route: candidate,
      receipt,
      ...(options.failure ? {failure: options.failure} : {}),
    });
    if (result.reason === 'inadmissible') {
      throw new Error('Capability canary receipt is invalid, corrupt, or not bound to capability_canary.');
    }
    const outputValue = {profile: profileName, route: candidate.ref, ...result};
    if (options.json) printObject(outputValue, true);
    else process.stdout.write(
      `Canary ${candidate.ref}: ${result.reason}; health=${result.health?.status ?? 'unknown'} ` +
      `failures=${result.health?.consecutiveFailures ?? 0} ` +
      `recovery-canaries=${result.health?.recoveryCanaryPasses ?? 0}.\n`,
    );
  });
capabilityCommand
  .command('replay <file>')
  .description('Evaluate a content-free route, judge-bias, and degradation replay bundle')
  .option('--json', 'print JSON')
  .action(async (file: string, options: {json?: boolean}) => {
    const report = evaluateCapabilityReplay(await readBoundedRegularJson(
      file,
      'Capability replay input',
      2_000_000,
    ));
    if (options.json) printObject(report, true);
    else printCapabilityReplayReport(report);
  });
capabilityCommand
  .command('export')
  .description('Export the content-free local registry as JSON')
  .option('-w, --workspace <path>', 'workspace root')
  .action(async (options: {workspace?: string}) => {
    const store = new CapabilityRegistryStore(workspaceOption(options.workspace));
    printObject(await store.snapshot(), true);
  });
capabilityCommand
  .command('reset')
  .description('Reset local capability observations, epochs, and pins')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--yes', 'skip confirmation')
  .option('--json', 'print JSON')
  .action(async (options: {workspace?: string; yes?: boolean; json?: boolean}) => {
    const workspace = workspaceOption(options.workspace);
    if (!options.yes && !(await confirm(`Reset the local capability registry for ${workspace}?`))) return;
    const state = await new CapabilityRegistryStore(workspace).reset();
    if (options.json) printObject(state, true);
    else process.stdout.write('Reset local capability observations, epochs, and pins.\n');
  });
agentsCommand
  .command('runs')
  .description('List persisted multi-model team runs')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--json', 'print JSON')
  .action(async (options: {workspace?: string; json?: boolean}) => {
    const store = new TeamRunStore(workspaceOption(options.workspace));
    const runs = await store.list();
    if (options.json) printObject(runs, true);
    else if (!runs.length) process.stdout.write('No team runs found.\n');
    else for (const run of runs) {
      const pricedAgents = Math.max(0, run.agentCount - run.unpricedAgents);
      const cost = !run.agentCount
        ? 'cost pending'
        : pricedAgents
        ? `$${(run.pricedCostMicros / 1_000_000).toFixed(6)}${run.unpricedAgents ? ` + ${run.unpricedAgents} unpriced` : ''}`
        : `${run.unpricedAgents} unpriced`;
      process.stdout.write(`${run.id.slice(0, 8)}  ${run.status.padEnd(12)} ${run.createdAt}  ${run.agentCount} agents  ${run.totalTokens} tok  ${run.toolCalls} tools  ${cost}  ${run.hostedToolCalls} hosted  ${run.sourceCount} sources  ${run.objective.replace(/\s+/gu, ' ').slice(0, 180)}\n`);
    }
  });
agentsCommand
  .command('show <id>')
  .description('Show a persisted team run and its peer reports')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--json', 'print JSON')
  .action(async (id: string, options: {workspace?: string; json?: boolean}) => {
    const store = new TeamRunStore(workspaceOption(options.workspace));
    const run = await requireTeamRun(store, id);
    const agents = await Promise.all(run.agents.map(async (agent) => ({
      ...agent,
      reportText: await store.readArtifact(run.id, agent.report),
    })));
    const messages = await Promise.all(run.messages.map(async (message) => ({
      ...message,
      contentText: await store.readArtifact(run.id, message.content),
    })));
    const writer = (run.version === 2 || run.version === 3 || run.version === 4) && run.writer ? {
      ...run.writer,
      ...(run.writer.review ? {reviewText: await store.readArtifact(run.id, run.writer.review)} : {}),
    } : undefined;
    if (options.json) printObject({...run, agents, messages, writer}, true);
    else {
      process.stdout.write(`Team run ${run.id}\n${run.status}  ${run.createdAt}\n\n${run.objective}\n\n`);
      const hasStructuredReviews = (run.version === 3 || run.version === 4) && (
        run.reviews.length > 0 || Boolean(writer && 'verdict' in writer && writer.verdict)
      );
      for (const agent of agents) {
        const tokens = (agent.usage?.inputTokens ?? 0) + (agent.usage?.outputTokens ?? 0);
        const report = hasStructuredReviews && agent.phase === 'review'
          ? '[Structured reviewer output is normalized below; use --json for the raw report.]'
          : agent.reportText;
        const cost = agent.cost?.status === 'priced'
          ? `$${(agent.cost.amountMicros / 1_000_000).toFixed(6)}`
          : 'unpriced';
        process.stdout.write(`## ${agent.profile} ${agent.phase} ${agent.provider}/${agent.model} ${agent.ok ? 'ok' : 'failed'}  ${tokens} tok  ${agent.toolCalls ?? 0} tools  ${cost}  ${agent.hostedTools?.length ?? 0} hosted  ${agent.sources?.length ?? 0} sources  ${agent.durationMs ?? 0}ms\n${report}\n\n`);
      }
      if (run.version === 4 && run.provenance) {
        process.stdout.write(`Provenance ${run.provenance.bundle.sha256}  ${run.provenance.agentCount} agents  ${run.provenance.reviewerDecisionCount} decisions  ${run.provenance.sourceCount} sources\n\n`);
      }
      if (writer) {
        process.stdout.write(`Writer patch ${writer.patch.sha256}  ${writer.outcome}  ${writer.files.length} files  cleanup ${writer.worktreeCleaned ? 'verified' : 'failed'}\n`);
        if (writer.integration) process.stdout.write(`Integration ${writer.integration.status}: ${writer.integration.detail}\n`);
        if ('verdict' in writer && writer.verdict) process.stdout.write(`\nStructured writer verdict\n${formatReviewVerdict(writer.verdict)}\n`);
        if ('independence' in writer && writer.independence) {
          process.stdout.write(`Review independence ${writer.independence.sufficient ? 'sufficient' : 'insufficient'}; maximum correlation penalty ${writer.independence.maximumCorrelationPenalty.toFixed(2)}.\n`);
        }
        if ('criterionConflicts' in writer && writer.criterionConflicts.length) {
          process.stdout.write(`Criterion conflicts: ${writer.criterionConflicts.map((item) => item.criterionId).join(', ')}\n`);
        }
        if (writer.reviewText && (!('verdict' in writer) || !writer.verdict)) {
          process.stdout.write(`\nWriter review\n${writer.reviewText}\n`);
        }
        process.stdout.write('\n');
      }
      if (run.version === 3 || run.version === 4) run.reviews.forEach((review, index) => {
        process.stdout.write(`Structured council verdict ${index + 1}/${run.reviews.length}\n${formatReviewVerdict(review.verdict)}\n\n`);
      });
      if (run.version === 4 && run.arbitrations.length) {
        process.stdout.write('Human arbitration\n');
        for (const arbitration of run.arbitrations) {
          process.stdout.write(`- ${arbitration.criterionId}: ${arbitration.decision} — ${arbitration.reason}\n`);
        }
        process.stdout.write('\n');
      }
      if (messages.length) {
        process.stdout.write('Peer handoffs\n');
        for (const message of messages) process.stdout.write(`- ${message.from} -> ${message.to}: ${message.contentText.replace(/\s+/gu, ' ').slice(0, 400)}\n`);
      }
    }
  });
agentsCommand
  .command('arbitrate <id> <criterion>')
  .description('Record one live-human criterion decision for a needs_review Team Run')
  .requiredOption('--decision <decision>', 'accept, request-changes, or reject')
  .requiredOption('--reason <reason>', 'concise evidence-backed human rationale')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--json', 'print JSON')
  .action(async (id: string, criterion: string, options: {
    workspace?: string;
    decision: string;
    reason: string;
    json?: boolean;
  }) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error('Human arbitration requires a live interactive TTY; non-interactive runs must remain needs_review.');
    }
    const decision = options.decision === 'request-changes'
      ? 'request_changes' as const
      : options.decision === 'accept' || options.decision === 'reject'
        ? options.decision
        : undefined;
    if (!decision) throw new Error('Unknown arbitration decision; use accept, request-changes, or reject.');
    const store = new TeamRunStore(workspaceOption(options.workspace));
    const run = await requireTeamRun(store, id);
    const approved = await confirm(
      `Record human arbitration ${decision} for ${run.id.slice(0, 8)} criterion ${criterion}?`,
    );
    if (!approved) throw new Error('Human arbitration was cancelled; Team Run remains unchanged.');
    const result = await store.arbitrate(run.id, {
      criterionId: criterion,
      decision,
      reason: options.reason,
    });
    if (options.json) printObject(result, true);
    else process.stdout.write(
      `Recorded ${decision} for ${criterion}; Team Run is ${result.gate.status}` +
      `${result.gate.unresolvedCriteria.length ? ` (${result.gate.unresolvedCriteria.join(', ')} unresolved)` : ''}.\n`,
    );
  });
agentsCommand
  .command('delete <id>')
  .description('Delete a persisted team run and its local reports')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--yes', 'skip confirmation')
  .action(async (id: string, options: {workspace?: string; yes?: boolean}) => {
    const store = new TeamRunStore(workspaceOption(options.workspace));
    const run = await requireTeamRun(store, id);
    if (!options.yes && !(await confirm(`Delete team run ${run.id.slice(0, 8)}?`))) return;
    await store.remove(run.id);
    process.stdout.write(`Deleted team run ${run.id}.\n`);
  });

const workflowCommand = program.command('workflow').description('Inspect typed coding workflows');
workflowCommand
  .command('list')
  .description('List built-in workflows')
  .option('--json', 'print JSON')
  .action((options: {json?: boolean}) => {
    const workflows = new WorkflowCatalog().list();
    if (options.json) printObject(workflows, true);
    else for (const workflow of workflows) {
      process.stdout.write(
        `${workflow.name.padEnd(12)} ${workflow.source.padEnd(8)} trusted  catalog=${workflow.catalogAccess} ` +
        `execution=${workflow.execution}  ${workflow.steps.length} steps  ${workflow.description}\n`,
      );
    }
  });
workflowCommand
  .command('show <name>')
  .description('Show workflow steps')
  .option('--json', 'print JSON')
  .action((name: string, options: {json?: boolean}) => {
    const workflow = new WorkflowCatalog().get(name);
    if (!workflow) throw new Error(`Unknown workflow: ${name}`);
    if (options.json) printObject(workflow, true);
    else {
      process.stdout.write(`${workflow.name} - ${workflow.description}\n`);
      process.stdout.write(
        `  Source: ${workflow.source}  Trust: trusted  Catalog: ${workflow.catalogAccess}  Execution: ${workflow.execution}\n`,
      );
      for (const step of workflow.steps) {
        process.stdout.write(`  ${step.id.padEnd(12)} ${step.kind.padEnd(10)} ${step.title}${step.expert ? ` [${step.expert}]` : ''}\n`);
      }
    }
  });

const memoryCommand = program.command('memory').description('Manage durable local memory');
memoryCommand
  .command('search <query>')
  .description('Search user and workspace memory')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--config <path>', 'explicit config file')
  .option('-k, --limit <n>', 'maximum results', '8')
  .option('--json', 'print JSON')
  .action(async (query: string, options: ConfigOptions & {limit: string}) => {
    const config = await runtimeConfig(workspaceOption(options.workspace), runtimeOptions(options));
    const store = await openMemoryStore(config);
    try {
      const workspace = config.workspaceRoots[0] ?? process.cwd();
      const records = store.search(query, {
        scopes: [{scope: 'user', scopeKey: 'default'}, {scope: 'workspace', scopeKey: workspace}],
        limit: positiveInt(options.limit, 8),
      });
      if (options.json) printObject(records, true);
      else if (!records.length) process.stdout.write('No matching memory.\n');
      else for (const record of records) {
        process.stdout.write(`${record.id}  ${record.scope}  ${record.content.replace(/\s+/g, ' ').slice(0, 240)}\n`);
      }
    } finally {
      store.close();
    }
  });
memoryCommand
  .command('add <content...>')
  .description('Store a non-secret workspace memory')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--config <path>', 'explicit config file')
  .option('--scope <scope>', 'user or workspace', 'workspace')
  .action(async (content: string[], options: ConfigOptions & {scope: string}) => {
    const config = await runtimeConfig(workspaceOption(options.workspace), runtimeOptions(options));
    const store = await openMemoryStore(config);
    try {
      const scope = options.scope === 'user' ? 'user' as const : 'workspace' as const;
      const record = store.remember({
        scope,
        scopeKey: scope === 'user' ? 'default' : config.workspaceRoots[0] ?? process.cwd(),
        content: content.join(' '),
        source: 'interactive:cli',
      });
      process.stdout.write(`Stored ${record.id} (${record.scope}).\n`);
    } finally {
      store.close();
    }
  });
memoryCommand
  .command('forget <id>')
  .description('Archive a memory')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--config <path>', 'explicit config file')
  .option('--permanent', 'delete instead of archive')
  .action(async (id: string, options: ConfigOptions & {permanent?: boolean}) => {
    const config = await runtimeConfig(workspaceOption(options.workspace), runtimeOptions(options));
    const store = await openMemoryStore(config);
    try {
      const changed = options.permanent ? store.remove(id) : store.archive(id);
      if (!changed) throw new Error(`Memory not found: ${id}`);
      process.stdout.write(`${options.permanent ? 'Deleted' : 'Archived'} ${id}.\n`);
    } finally {
      store.close();
    }
  });
memoryCommand
  .command('stats')
  .description('Show memory storage statistics')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--config <path>', 'explicit config file')
  .option('--json', 'print JSON')
  .action(async (options: ConfigOptions) => {
    const config = await runtimeConfig(workspaceOption(options.workspace), runtimeOptions(options));
    const store = await openMemoryStore(config);
    try { printObject(store.stats(), options.json === true); } finally { store.close(); }
  });
memoryCommand
  .command('privacy')
  .description('Review content-free memory retention and local storage privacy')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--config <path>', 'explicit config file')
  .option('--json', 'print JSON')
  .action(async (options: ConfigOptions) => {
    const config = await runtimeConfig(workspaceOption(options.workspace), runtimeOptions(options));
    const store = await openMemoryStore(config);
    try {
      const review = await store.privacyReview();
      if (options.json) printObject(review, true);
      else printMemoryPrivacyReview(review);
    } finally {
      store.close();
    }
  });
memoryCommand
  .command('export [file]')
  .description('Export reviewed memory as JSON to stdout or an owner-only file')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--config <path>', 'explicit config file')
  .addOption(new Option('--scope <scope>', 'user, workspace, or all')
    .choices(['user', 'workspace', 'all']).default('workspace'))
  .action(async (file: string | undefined, options: ConfigOptions & {scope: string}) => {
    const config = await runtimeConfig(workspaceOption(options.workspace), runtimeOptions(options));
    const store = await openMemoryStore(config);
    try {
      const workspace = config.workspaceRoots[0] ?? process.cwd();
      const bundle = store.exportData(memorySelection(options.scope, workspace));
      const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
      if (!file) {
        process.stdout.write(serialized);
        return;
      }
      const path = resolve(file);
      await assertMemoryExportTarget(path);
      await atomicWrite(path, serialized, 0o600);
      process.stdout.write(
        `Exported ${bundle.records.length} records and ${bundle.candidates.length} candidates to ${path} (owner-only).\n`,
      );
    } finally {
      store.close();
    }
  });
memoryCommand
  .command('clear')
  .description('Permanently delete memory records and candidates in a selected scope')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--config <path>', 'explicit config file')
  .addOption(new Option('--scope <scope>', 'user, workspace, or all')
    .choices(['user', 'workspace', 'all']).default('workspace'))
  .option('--yes', 'confirm permanent deletion')
  .option('--json', 'print JSON')
  .action(async (options: ConfigOptions & {scope: string; yes?: boolean}) => {
    const config = await runtimeConfig(workspaceOption(options.workspace), runtimeOptions(options));
    const store = await openMemoryStore(config);
    try {
      const workspace = config.workspaceRoots[0] ?? process.cwd();
      if (!options.yes) {
        const accepted = await confirm(
          `Permanently delete ${options.scope} memory records and candidates? This cannot be undone.`,
        );
        if (!accepted) {
          if (!process.stdin.isTTY || !process.stdout.isTTY) {
            throw new Error('Memory clear requires explicit --yes confirmation in non-interactive mode.');
          }
          process.stdout.write('Memory clear cancelled.\n');
          return;
        }
      }
      const result = store.clear(memorySelection(options.scope, workspace));
      if (options.json) printObject({...result, scope: options.scope}, true);
      else {
        process.stdout.write(
          `Deleted ${result.records} records and ${result.candidates} candidates from ${options.scope} memory.\n`,
        );
        if (!result.compacted) {
          process.stdout.write('Warning: logical deletion succeeded, but SQLite compaction could not finish; close other Skein processes and run clear again.\n');
        }
      }
    } finally {
      store.close();
    }
  });
memoryCommand
  .command('candidates')
  .description('List memory proposals awaiting user approval')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--config <path>', 'explicit config file')
  .option('--status <status>', 'pending, approved, rejected, or all', 'pending')
  .option('-k, --limit <n>', 'maximum proposals', '20')
  .option('--json', 'print JSON')
  .action(async (options: ConfigOptions & {status: string; limit: string; json?: boolean}) => {
    const config = await runtimeConfig(workspaceOption(options.workspace), runtimeOptions(options));
    const store = await openMemoryStore(config);
    try {
      const status = options.status === 'all' || options.status === 'approved' || options.status === 'rejected'
        ? options.status
        : 'pending';
      const candidates = store.listCandidates(status, positiveInt(options.limit, 20));
      if (options.json) printObject(candidates, true);
      else if (!candidates.length) process.stdout.write('No memory candidates.\n');
      else for (const candidate of candidates) {
        process.stdout.write(
          `${candidate.id}  ${candidate.status.padEnd(8)} ${candidate.scope}/${candidate.kind}  ` +
          `${candidate.content.replace(/\s+/g, ' ').slice(0, 220)}${candidate.rationale ? `  ${cliGlyphs.separator} ${candidate.rationale.replace(/\s+/g, ' ').slice(0, 140)}` : ''}\n`,
        );
      }
    } finally {
      store.close();
    }
  });
memoryCommand
  .command('approve <id>')
  .description('Approve a memory proposal and make it durable')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--config <path>', 'explicit config file')
  .option('--json', 'print JSON')
  .action(async (id: string, options: ConfigOptions & {json?: boolean}) => {
    const config = await runtimeConfig(workspaceOption(options.workspace), runtimeOptions(options));
    const store = await openMemoryStore(config);
    try {
      const candidate = resolveMemoryCandidate(store, id);
      const record = store.approveCandidate(candidate.id);
      if (!record) throw new Error(`Memory candidate ${id} is expired or already rejected.`);
      if (options.json) printObject(record, true);
      else process.stdout.write(`Approved ${record.id} (${record.scope}).\n`);
    } finally {
      store.close();
    }
  });
memoryCommand
  .command('reject <id>')
  .description('Reject a memory proposal without storing it')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--config <path>', 'explicit config file')
  .action(async (id: string, options: ConfigOptions) => {
    const config = await runtimeConfig(workspaceOption(options.workspace), runtimeOptions(options));
    const store = await openMemoryStore(config);
    try {
      const candidate = resolveMemoryCandidate(store, id);
      if (!store.rejectCandidate(candidate.id)) throw new Error(`Memory candidate ${id} is already resolved.`);
      process.stdout.write(`Rejected ${candidate.id}.\n`);
    } finally {
      store.close();
    }
  });

const mcpCommand = program.command('mcp').description('Inspect configured MCP servers');
mcpCommand
  .command('status')
  .description('Report redacted MCP trust and connection status without connecting optional servers')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--config <path>', 'explicit config file')
  .option('--json', 'print JSON')
  .action(async (options: ConfigOptions) => {
    const config = await runtimeConfig(workspaceOption(options.workspace), runtimeOptions(options));
    if (!config.mcp) return printObject([], options.json === true);
    const manager = new McpManager(config.mcp, {
      cwd: config.workspaceRoots[0] ?? process.cwd(),
      workspaceRoots: config.workspaceRoots,
    });
    try {
      await manager.loadTrust();
      const status = manager.list();
      if (options.json) printObject(status, true);
      else if (!status.length) process.stdout.write('No MCP servers configured.\n');
      else for (const server of status) {
        process.stdout.write(`${server.name.padEnd(18)} ${server.state.padEnd(12)} ${server.trust.padEnd(10)} ${server.required ? 'required' : 'optional'}  ${server.toolCount} tools${server.error ? `  ${server.error}` : ''}\n`);
      }
    } finally {
      await manager.close();
    }
  });
mcpCommand
  .command('search [query...]')
  .description('Search configured capability manifests without network access')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--config <path>', 'explicit config file')
  .option('--json', 'print JSON')
  .action(async (query: string[], options: ConfigOptions) => {
    const config = await runtimeConfig(workspaceOption(options.workspace), runtimeOptions(options));
    if (!config.mcp) return printObject([], options.json === true);
    const manager = createMcpManager(config);
    await manager.loadTrust();
    const results = manager.search(query.join(' '));
    if (options.json) printObject(results, true);
    else if (!results.length) process.stdout.write('No configured MCP capability matched.\n');
    else for (const result of results) {
      process.stdout.write(`${result.name.padEnd(18)} ${result.trust.padEnd(10)} ${result.version}  ${result.description}\n`);
    }
  });
mcpCommand
  .command('inspect <server>')
  .description('Review a redacted declarative capability manifest without connecting')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--config <path>', 'explicit config file')
  .option('--json', 'print JSON')
  .action(async (server: string, options: ConfigOptions) => {
    const config = await runtimeConfig(workspaceOption(options.workspace), runtimeOptions(options));
    if (!config.mcp) throw new Error('MCP is not configured.');
    const manager = createMcpManager(config);
    await manager.loadTrust();
    const review = {
      manifest: manager.inspect(server),
      fingerprint: manager.fingerprint(server),
      trust: manager.status(server)?.trust ?? 'untrusted',
    };
    if (options.json) printObject(review, true);
    else printMcpManifest(review);
  });
mcpCommand
  .command('trust <server>')
  .description('Trust the current redacted manifest fingerprint after review')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--config <path>', 'explicit config file')
  .option('--json', 'print JSON')
  .option('--yes', 'confirm trust non-interactively')
  .action(async (server: string, options: ConfigOptions & {yes?: boolean}) => {
    const config = await runtimeConfig(workspaceOption(options.workspace), runtimeOptions(options));
    if (!config.mcp) throw new Error('MCP is not configured.');
    const manager = createMcpManager(config);
    await manager.loadTrust();
    const review = {
      manifest: manager.inspect(server),
      fingerprint: manager.fingerprint(server),
      trust: manager.status(server)?.trust ?? 'untrusted',
    };
    if (!options.json) printMcpManifest(review);
    if (!options.yes && !(await confirm(`Trust this exact capability manifest for ${server}?`))) return;
    const status = await manager.trust(server);
    if (options.json) printObject({manifest: review.manifest, fingerprint: review.fingerprint, status}, true);
    else process.stdout.write(`Trusted ${server}. Activation remains explicit.\n`);
  });
mcpCommand
  .command('activate <server> <query...>')
  .description('Connect one trusted server and load only query-relevant schemas')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--config <path>', 'explicit config file')
  .option('--json', 'print JSON')
  .action(async (server: string, query: string[], options: ConfigOptions) => {
    const config = await runtimeConfig(workspaceOption(options.workspace), runtimeOptions(options));
    if (!config.mcp) throw new Error('MCP is not configured.');
    const manager = createMcpManager(config);
    const registry = createDefaultToolRegistry();
    try {
      await manager.loadTrust();
      const result = await manager.activate(server, query.join(' '), registry);
      if (options.json) printObject(result, true);
      else process.stdout.write(result.ok
        ? `Activated ${server}; loaded ${result.registeredTools.length}/${result.availableTools} relevant schemas.\n`
        : `Could not activate ${server}: ${result.status.error ?? result.status.trust}.\n`);
      if (!result.ok) process.exitCode = 1;
    } finally {
      await manager.close();
    }
  });
mcpCommand
  .command('disable <server>')
  .description('Persistently disable an MCP capability and unload its schemas')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--config <path>', 'explicit config file')
  .option('--json', 'print JSON')
  .action(async (server: string, options: ConfigOptions) => {
    const config = await runtimeConfig(workspaceOption(options.workspace), runtimeOptions(options));
    if (!config.mcp) throw new Error('MCP is not configured.');
    const manager = createMcpManager(config);
    await manager.loadTrust();
    const status = await manager.disable(server);
    if (options.json) printObject(status, true);
    else process.stdout.write(`Disabled ${server}.\n`);
  });
mcpCommand
  .command('revoke <server>')
  .description('Revoke persisted MCP trust and require a fresh review')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--config <path>', 'explicit config file')
  .option('--json', 'print JSON')
  .option('--yes', 'confirm revocation non-interactively')
  .action(async (server: string, options: ConfigOptions & {yes?: boolean}) => {
    const config = await runtimeConfig(workspaceOption(options.workspace), runtimeOptions(options));
    if (!config.mcp) throw new Error('MCP is not configured.');
    if (!options.yes && !(await confirm(`Revoke persisted trust for ${server}?`))) return;
    const manager = createMcpManager(config);
    await manager.loadTrust();
    const status = await manager.revoke(server);
    if (options.json) printObject(status, true);
    else process.stdout.write(`Revoked ${server}; inspect and trust the manifest before reuse.\n`);
  });

program
  .command('rules')
  .description('List user and workspace rules loaded into the agent')
  .option('-w, --workspace <path>', 'workspace root')
  .option('--json', 'print JSON')
  .action(async (options: {workspace: string; json?: boolean}) => {
    const rules = await discoverWorkspaceRules(workspaceOption(options.workspace));
    if (options.json) {
      printObject(rules.map((rule) => ({
        path: rule.path,
        scope: rule.scope,
        characters: rule.content.length,
        truncated: rule.truncated,
      })), true);
      return;
    }
    if (!rules.length) {
      process.stdout.write('No user or workspace rules found.\n');
      return;
    }
    for (const rule of rules) {
      process.stdout.write(`${rule.scope.padEnd(10)} ${rule.path}${rule.truncated ? ' (truncated)' : ''}\n`);
    }
  });

let cliNamespaceLeases: Awaited<ReturnType<typeof acquireCliNamespaceLeases>> = [];
program.hook('preAction', async (_command, actionCommand) => {
  cliNamespaceLeases = await acquireCliNamespaceLeases(actionCommand);
});

void runCli();

async function runCli(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    const format = structuredOutputFormat(process.argv);
    if (format) {
      const reporter = new HeadlessReporter({format, color: false});
      process.exitCode = reporter.fail(error).exitCode;
    } else {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${chalk.red(cliGlyphs.error)} ${message}\n`);
      process.exitCode = 1;
    }
  } finally {
    releaseCliNamespaceLeases(cliNamespaceLeases);
  }
}

function structuredOutputFormat(argv: string[]): Extract<OutputFormat, 'json' | 'stream-json'> | undefined {
  const inline = argv.find((argument) => argument.startsWith('--output-format='))?.slice('--output-format='.length);
  const index = argv.indexOf('--output-format');
  const value = inline ?? (index >= 0 ? argv[index + 1] : undefined);
  return value === 'json' || value === 'stream-json' ? value : undefined;
}

interface RootOptions {
  print?: boolean;
  ask?: boolean;
  plan?: boolean;
  quiet?: boolean;
  outputFormat: OutputFormat;
  compact?: boolean;
  yes?: boolean;
  autoEdit?: boolean;
  queue: string[];
  workspace: string;
  addWorkspace: string[];
  config?: string;
  connection?: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  maxTurns?: string;
  epochTokenBudget?: string;
  tokenBudget?: string;
  resume?: string | boolean;
  continue?: boolean;
  color?: boolean;
  checkpoint?: boolean;
  trustProjectConfig?: boolean;
}

interface InitOptions {
  workspace?: string;
  provider: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  index?: boolean;
  yes?: boolean;
}

interface ConfigOptions {workspace?: string; config?: string; json?: boolean}
interface AgentSetupOptions {
  workspace?: string;
  name?: string;
  provider?: string;
  protocol?: string;
  baseUrl?: string;
  modelsBaseUrl?: string;
  auth?: string;
  authHeader?: string;
  modelsAuthHeader?: string;
  apiKeyEnv?: string;
  hostedTool?: string[];
  inputPrice?: string;
  outputPrice?: string;
  cachedInputPrice?: string;
  cacheWriteInputPrice?: string;
  model?: string;
  yes?: boolean;
  json?: boolean;
}
interface IndexOptions extends ConfigOptions {addWorkspace: string[]}
interface SearchOptions extends ConfigOptions {topK: string}
interface ContextOptions extends ConfigOptions {maxTokens?: string}
interface SessionCommandOptions {workspace?: string; json?: boolean}

interface CapabilityCliContext {
  config: MosaicConfig;
  store: CapabilityRegistryStore;
  profiles: AgentProfile[];
}

interface RuntimeConfigOptions {
  config?: string;
  addWorkspace?: string[];
  connection?: string;
  connectionSelection?: 'inspect' | 'required' | 'interactive';
  provider?: string;
  model?: string;
  baseUrl?: string;
  maxTokens?: string;
  epochTokenBudget?: string;
  tokenBudget?: string;
  color?: boolean;
  checkpoint?: boolean;
  trustProjectConfig?: boolean;
}

async function capabilityContext(
  options: ConfigOptions,
  profileName?: string,
): Promise<CapabilityCliContext> {
  const workspace = workspaceOption(options.workspace);
  const config = await runtimeConfig(workspace, {
    ...runtimeOptions(options),
    connectionSelection: 'inspect',
  });
  const catalog = new AgentProfileCatalog(workspace);
  const discovered = await catalog.discover();
  const profiles = profileName
    ? discovered.filter((profile) => profile.name === profileName)
    : discovered;
  if (profileName && !profiles.length) throw new Error(`Unknown agent profile: ${profileName}`);
  return {config, store: new CapabilityRegistryStore(workspace), profiles};
}

async function capabilityReports(context: CapabilityCliContext): Promise<CapabilityShadowReport[]> {
  const candidateSets = await Promise.all(context.profiles.map((profile) => buildCapabilityCandidates({
    config: context.config,
    profile,
  })));
  const registry = context.config.agents?.capability?.mode === 'off'
    ? await context.store.snapshot()
    : await context.store.touchEpochs(candidateSets.flat());
  return context.profiles.map((profile, index) => evaluateCapabilityShadow({
    config: context.config,
    profile,
    candidates: candidateSets[index] ?? [],
    registry,
  }));
}

function printCapabilityReport(report: CapabilityShadowReport): void {
  const change = report.changed ? 'recommend change' : 'retain current';
  process.stdout.write(`${report.profile}  mode=${report.mode}  ${change}\n`);
  process.stdout.write(`  route: ${report.current} -> ${report.suggested}  pin=${report.pinned}\n`);
  process.stdout.write(`  reason: ${report.reason}\n`);
  for (const route of report.candidates) {
    const markers = [route.current ? 'current' : '', report.suggested === route.ref ? 'suggested' : ''].filter(Boolean).join('+') || '-';
    const observed = route.observed
      ? `${route.observed.status} n=${route.observed.samples.toFixed(2)} lb=${route.observed.lower.toFixed(3)}`
      : 'unobserved n=0.00 lb=0.000';
    const configured = route.configured
      ? `prior=${route.configured.mean.toFixed(3)}/${route.configured.samples.toFixed(2)}`
      : 'prior=none';
    const utility = Number.isFinite(route.utility) ? route.utility.toFixed(3) : 'ineligible';
    process.stdout.write(`  ${route.ref}  ${markers}\n`);
    process.stdout.write(`    model: ${route.runtime}:${route.provider}/${route.model}\n`);
    process.stdout.write(`    transport: ${route.protocol}  epoch=${route.epoch}\n`);
    process.stdout.write(
      `    health: ${route.health}  signals=${route.healthSignals}` +
      `${route.healthFailure ? `  last-failure=${route.healthFailure}` : ''}` +
      `${route.health === 'quarantined' ? `  recovery-canaries=${route.recoveryCanaryPasses}` : ''}\n`,
    );
    process.stdout.write(`    score: ${configured}  ${observed}  utility=${utility}\n`);
    process.stdout.write(
      `    hashes: route=${route.routeFingerprintSha256.slice(0, 12)} ` +
      `endpoint=${route.endpointSha256.slice(0, 12)}\n`,
    );
    if (route.ineligibleReasons.length) {
      process.stdout.write(`    ineligible: ${route.ineligibleReasons.join('; ')}\n`);
    }
  }
}

function printCapabilityReplayReport(report: CapabilityReplayReport): void {
  process.stdout.write(`Capability replay  source=${report.source}  automatic-routing=disabled\n`);
  process.stdout.write(
    `  routes: n=${report.routeReplay.samples} success=${report.routeReplay.verifiedSuccessRate.toFixed(3)} ` +
    `regret=${report.routeReplay.regretRate.toFixed(3)} providers=${report.routeReplay.providerCoverage} ` +
    `tiers=${report.routeReplay.modelTiers.join(',') || 'none'}\n`,
  );
  process.stdout.write(
    `  ledger: linked=${report.tokenLedger.linked}/${report.routeReplay.samples} ` +
    `coverage=${report.tokenLedger.coverage.toFixed(3)}\n`,
  );
  process.stdout.write(
    `  judge: probes=${report.judgeBias.probes} stability=${report.judgeBias.stabilityRate.toFixed(3)} ` +
    `biases=${report.judgeBias.covered.join(',') || 'none'}\n`,
  );
  process.stdout.write(
    `  drift: probes=${report.degradation.probes} accuracy=${report.degradation.transitionAccuracy.toFixed(3)} ` +
    `quarantine=${report.degradation.quarantineObserved} recovery=${report.degradation.recoveryObserved}\n`,
  );
  process.stdout.write(
    `  gates: replay=${report.gates.routeReplay} ledger=${report.gates.tokenLedger} ` +
    `judge=${report.gates.judgeCalibration} degradation=${report.gates.degradation} ` +
    `external=${report.gates.externalValidation} automatic=false\n`,
  );
  for (const reason of report.reasons) process.stdout.write(`  - ${reason}\n`);
}

async function readBoundedRegularJson(file: string, label: string, maximumBytes: number): Promise<unknown> {
  const path = resolve(file);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file.`);
  if (info.size > maximumBytes) throw new Error(`${label} exceeds the ${maximumBytes.toLocaleString('en-US')} byte limit.`);
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function runChat(prompts: string[], options: RootOptions): Promise<void> {
  const shouldPrint = options.print === true || !process.stdin.isTTY || !process.stdout.isTTY;
  if (options.ask && options.plan) throw new Error('--ask and --plan cannot be used together.');
  if (!shouldPrint && options.queue.length) throw new Error('--queue is only available with --print.');
  const stdinPrompt = !process.stdin.isTTY ? await readStdin() : '';
  const firstPrompt = [...prompts, stdinPrompt].filter(Boolean).join('\n\n').trim();
  if (shouldPrint && !firstPrompt) throw new Error('Provide a prompt argument or pipe input on stdin.');
  const workspace = resolve(options.workspace);
  const connectionSelection = shouldPrint ? 'required' as const : 'interactive' as const;
  let config = await runtimeConfig(workspace, {...options, connectionSelection});
  let completedOnboarding = false;
  if (!shouldPrint && needsFirstRunOnboarding(config)) {
    // An explicit config is caller-owned and may intentionally be incomplete;
    // do not silently write a separate user config that the explicit path would
    // not load. Normal first-run sessions use the guided user-level setup.
    if (!options.config) {
      const onboarding = await runFirstRunOnboarding(config);
      if (onboarding.status === 'cancelled') return;
      completedOnboarding = true;
      config = await runtimeConfig(workspace, {...options, connectionSelection});
    }
  }
  // Validate before SessionStore, provider, extensions, or AgentRunner creation.
  // A cancelled or invalid preflight therefore leaves no empty session behind.
  validateModelSetup(config);
  const store = new SessionStore(workspace);
  const selectedSession = options.resume !== undefined
    ? await loadSessionSelector(store, typeof options.resume === 'string' ? options.resume : undefined)
    : options.continue
      ? await loadSessionSelector(store)
      : undefined;
  if (selectedSession) {
    selectedSession.provider = config.model.provider;
    selectedSession.model = config.model.model;
  }
  const provider = createProvider(config.model);
  const contextEngine = new ContextEngine(config);
  const preparation = !shouldPrint && !selectedSession
    ? await runWorkspacePreparation(contextEngine, config, {
      workspace,
      forceBuild: completedOnboarding,
    })
    : undefined;
  if (preparation?.status === 'cancelled') return;
  const toolRegistry = createDefaultToolRegistry({contextEngine});
  const extensions = await ExtensionRuntime.create(config, toolRegistry, {provider, contextEngine});
  const runner = new AgentRunner({
    config,
    provider,
    contextEngine,
    toolRegistry,
    sessionStore: store,
    promptContextProvider: extensions,
    ...(selectedSession ? {session: selectedSession} : {}),
  });
  if (!shouldPrint) {
    await store.save(runner.getSession());
    try {
      await runInteractiveTui({
        runner,
        config,
        extensions,
        ...(preparation?.status === 'ready' ? {workspaceReadiness: preparation.readiness} : {}),
        ...(firstPrompt ? {initialPrompt: firstPrompt} : {}),
        askMode: options.ask === true || options.plan === true,
        planMode: options.plan === true,
      });
    } finally {
      await extensions.close();
    }
    return;
  }
  const reporter = new HeadlessReporter({
    format: options.outputFormat,
    quiet: options.quiet ?? false,
    compact: options.compact ?? false,
    color: (options.color ?? config.ui.color) && !process.env.NO_COLOR,
    ...(config.activeConnection ? {connection: config.activeConnection} : {}),
  });
  const colorOutput = (options.color ?? config.ui.color) && !process.env.NO_COLOR;
  const requestPermission = options.yes
    ? async () => true
    : options.autoEdit
      ? async (_call: Parameters<typeof askConsolePermission>[0], category: Parameters<typeof askConsolePermission>[1], reason?: string) =>
        category === 'read' || category === 'write' ? true : askConsolePermission(_call, category, colorOutput, reason)
      : async (call: Parameters<typeof askConsolePermission>[0], category: Parameters<typeof askConsolePermission>[1], reason?: string) =>
        askConsolePermission(call, category, colorOutput, reason);
  const requestHumanApproval = process.stdin.isTTY && process.stderr.isTTY
    ? async (
      call: Parameters<typeof askConsolePermission>[0],
      category: Parameters<typeof askConsolePermission>[1],
      reason?: string,
    ) => askConsolePermission(call, category, colorOutput, reason)
    : undefined;
  let extensionsClosed = false;
  try {
    let session = await runner.run(firstPrompt, {
      askMode: options.ask === true || options.plan === true,
      ...(options.plan ? {turnInstructions: PLAN_MODE_INSTRUCTIONS} : {}),
      maxTurns: positiveInt(options.maxTurns, config.agent.maxTurns),
      onEvent: reporter.onEvent,
      requestPermission,
      ...(requestHumanApproval ? {requestHumanApproval} : {}),
    });
    for (const queued of options.queue) {
      if (session.pendingInput) break;
      session = await runner.run(queued, {
        askMode: options.ask === true || options.plan === true,
        ...(options.plan ? {turnInstructions: PLAN_MODE_INSTRUCTIONS} : {}),
        maxTurns: positiveInt(options.maxTurns, config.agent.maxTurns),
        onEvent: reporter.onEvent,
        requestPermission,
        ...(requestHumanApproval ? {requestHumanApproval} : {}),
      });
    }
    await extensions.close();
    extensionsClosed = true;
    const outcome = reporter.finish(session);
    process.exitCode = outcome.exitCode;
  } catch (error) {
    const outcome = reporter.fail(error, runner.getSession());
    process.exitCode = outcome.exitCode;
  } finally {
    if (!extensionsClosed) await extensions.close().catch(() => undefined);
  }
}

async function openMemoryStore(config: MosaicConfig): Promise<MemoryStore> {
  if (config.memory?.enabled === false) throw new Error('Memory is disabled in the resolved configuration.');
  const store = config.memory?.databasePath
    ? new MemoryStore(config.memory.databasePath)
    : new MemoryStore();
  await store.open();
  return store;
}

function resolveMemoryCandidate(store: MemoryStore, selector: string): MemoryCandidate {
  const normalized = selector.trim().toLocaleLowerCase();
  if (!normalized) throw new Error('Memory candidate id cannot be empty.');
  const matches = store.listCandidates('all', 200).filter((candidate) =>
    candidate.id.toLocaleLowerCase().startsWith(normalized),
  );
  if (matches.length === 1) return matches[0] as MemoryCandidate;
  if (matches.length > 1) throw new Error(`Memory candidate id is ambiguous: ${selector}`);
  throw new Error(`Memory candidate not found: ${selector}`);
}

function validateModelSetup(config: MosaicConfig): void {
  if (config.model.provider === 'compatible') {
    if (!config.model.baseUrl) {
      throw new Error('OpenAI-compatible providers require model.baseUrl or --base-url.');
    }
    return;
  }
  if (!config.model.apiKey) {
    throw new Error(
      `No API key configured for ${config.model.provider}. Set ${environmentName(config.model.provider)} or run ${PRODUCT_COMMAND} doctor.`,
    );
  }
}

async function runInit(options: InitOptions): Promise<void> {
  const workspace = workspaceOption(options.workspace);
  let provider = validateProvider(options.provider);
  let model = options.model ?? '';
  let baseUrl = options.baseUrl ?? '';
  if (!options.yes && process.stdin.isTTY && process.stdout.isTTY) {
    const readline = createInterface({input, output});
    try {
      provider = validateProvider(await question(readline, 'Provider', provider));
      model = await question(readline, 'Model (blank uses provider default)', model);
      baseUrl = await question(readline, 'Base URL (blank uses provider default)', baseUrl);
    } finally {
      readline.close();
    }
  }
  if (provider === 'compatible' && !baseUrl) {
    throw new Error('OpenAI-compatible providers require --base-url (for example http://localhost:11434/v1).');
  }
  const config: Record<string, unknown> = {
    model: {
      provider,
      model: model || defaultModelForProvider(provider),
      ...(baseUrl ? {baseUrl} : {}),
      ...(options.apiKey ? {apiKey: options.apiKey} : {}),
    },
    context: {},
  };
  const path = await saveProjectConfig(workspace, config);
  await trustProjectModelConfig(workspace, path);
  process.stdout.write(`${chalk.green(cliGlyphs.success)} Wrote ${path}\n`);
  if (options.apiKey) {
    process.stdout.write(`  Next: run ${chalk.cyan(PRODUCT_COMMAND)}\n`);
  } else if (provider === 'compatible') {
    process.stdout.write(
      `  Next: run ${chalk.cyan(PRODUCT_COMMAND)} (set SKEIN_API_KEY only if the endpoint requires it)\n`,
    );
  } else {
    process.stdout.write(`  Next: set ${environmentName(provider)} and run ${chalk.cyan(PRODUCT_COMMAND)}\n`);
  }
  if (options.index) {
    const loaded = await loadConfig(workspace);
    const engine = new ContextEngine(loaded);
    const result = await engine.index();
    printObject(result, false);
  }
}

async function runAgentSetup(options: AgentSetupOptions): Promise<void> {
  const workspace = workspaceOption(options.workspace);
  const current = await loadConfig(workspace);
  const currentName = current.agents?.defaultConnection ?? 'team-relay';
  const currentConnection = current.agents?.connections?.[currentName];
  let name = options.name ?? currentName;
  let provider = validateProvider(options.provider ?? currentConnection?.provider ?? 'compatible');
  let protocol = validateConnectionProtocol(options.protocol ?? currentConnection?.protocol ?? 'openai-responses');
  let baseUrl = options.baseUrl ?? currentConnection?.baseUrl ?? '';
  let modelsBaseUrl = options.modelsBaseUrl ?? currentConnection?.modelsBaseUrl ?? '';
  let auth = validateConnectionAuth(options.auth ?? currentConnection?.auth?.type ?? 'env');
  let authHeader = validateConnectionApiKeyHeader(
    options.authHeader ?? (currentConnection?.auth?.type === 'env' ? currentConnection.auth.header : undefined) ?? 'bearer',
  );
  let modelsAuthHeader = validateConnectionModelAuth(
    options.modelsAuthHeader ?? currentConnection?.modelsAuthHeader ?? authHeader,
  );
  const currentApiKeyEnv = currentConnection?.apiKeyEnv ??
    (currentConnection?.auth?.type === 'env' ? currentConnection.auth.name : undefined);
  let apiKeyEnv = options.apiKeyEnv ?? (auth === 'env' ? currentApiKeyEnv ?? providerEnvironment(provider) : '');
  let hostedTools = options.hostedTool?.length
    ? validateHostedTools(options.hostedTool)
    : currentConnection?.hostedTools ?? [];
  let inputPrice = options.inputPrice ?? priceInput(currentConnection?.pricing?.inputPerMillionUsd);
  let outputPrice = options.outputPrice ?? priceInput(currentConnection?.pricing?.outputPerMillionUsd);
  let cachedInputPrice = options.cachedInputPrice ?? priceInput(currentConnection?.pricing?.cachedInputPerMillionUsd);
  let cacheWriteInputPrice = options.cacheWriteInputPrice ?? priceInput(currentConnection?.pricing?.cacheWriteInputPerMillionUsd);
  let model = options.model ?? current.agents?.defaultModel ?? current.model.model;

  if (!options.yes && process.stdin.isTTY && process.stdout.isTTY) {
    const readline = createInterface({input, output});
    try {
      name = await question(readline, 'Connection name', name);
      provider = validateProvider(await question(readline, 'Relay provider', provider));
      protocol = validateConnectionProtocol(await question(readline, 'Inference protocol', protocol));
      baseUrl = await question(readline, 'Inference base URL', baseUrl);
      modelsBaseUrl = await question(readline, 'Models base URL (optional unless Anthropic)', modelsBaseUrl);
      auth = validateConnectionAuth(await question(readline, 'Authentication (env or none)', auth));
      if (auth === 'env') {
        authHeader = validateConnectionApiKeyHeader(await question(
          readline,
          'Inference credential header (bearer or x-api-key)',
          authHeader,
        ));
        modelsAuthHeader = validateConnectionModelAuth(await question(
          readline,
          'Models authentication (bearer, x-api-key, or none)',
          modelsAuthHeader,
        ));
      }
      apiKeyEnv = auth === 'env'
        ? await question(readline, 'Credential environment variable', apiKeyEnv || providerEnvironment(provider))
        : '';
      hostedTools = validateHostedTools([
        await question(readline, 'Provider-hosted tools (web_search or none)', hostedTools.join(',') || 'none'),
      ]);
      inputPrice = await question(readline, 'Input USD per million tokens (none keeps usage unpriced)', inputPrice || 'none');
      outputPrice = await question(readline, 'Output USD per million tokens (none keeps usage unpriced)', outputPrice || 'none');
      cachedInputPrice = await question(readline, 'Cached-input USD per million tokens (optional)', cachedInputPrice || 'none');
      cacheWriteInputPrice = await question(readline, 'Cache-write input USD per million tokens (optional)', cacheWriteInputPrice || 'none');
      model = await question(readline, 'Default model', model);
    } finally {
      readline.close();
    }
  }

  const parsedInputPrice = optionalPrice(inputPrice, 'Input price');
  const parsedOutputPrice = optionalPrice(outputPrice, 'Output price');
  const parsedCachedInputPrice = optionalPrice(cachedInputPrice, 'Cached-input price');
  const parsedCacheWriteInputPrice = optionalPrice(cacheWriteInputPrice, 'Cache-write input price');
  const hasPricing = parsedInputPrice !== undefined || parsedOutputPrice !== undefined ||
    parsedCachedInputPrice !== undefined || parsedCacheWriteInputPrice !== undefined;
  if (hasPricing && (parsedInputPrice === undefined || parsedOutputPrice === undefined)) {
    throw new Error('Relay pricing requires both input and output USD-per-million values.');
  }
  const pricing = hasPricing ? {
    inputPerMillionUsd: parsedInputPrice as number,
    outputPerMillionUsd: parsedOutputPrice as number,
    ...(parsedCachedInputPrice === undefined ? {} : {cachedInputPerMillionUsd: parsedCachedInputPrice}),
    ...(parsedCacheWriteInputPrice === undefined
      ? {} : {cacheWriteInputPerMillionUsd: parsedCacheWriteInputPrice}),
  } : undefined;

  const setup = createAgentConnectionSetup({
    name,
    provider,
    protocol,
    ...(baseUrl ? {baseUrl} : {}),
    ...(modelsBaseUrl ? {modelsBaseUrl} : {}),
    auth,
    ...(auth === 'env' ? {authHeader, modelsAuthHeader} : {}),
    ...(apiKeyEnv ? {apiKeyEnv} : {}),
    ...(hostedTools.length ? {hostedTools} : {}),
    ...(pricing ? {pricing} : {}),
    defaultModel: model,
  });
  const path = await saveUserConfig({agents: mergeAgentSetup(undefined, setup)});
  const credentialConfigured = apiKeyEnv ? Boolean(process.env[apiKeyEnv]) : false;
  const result = {
    path,
    connection: setup.defaultConnection,
    provider,
    protocol,
    endpoint: redactEndpoint(baseUrl),
    modelsEndpoint: redactEndpoint(modelsBaseUrl || baseUrl),
    auth,
    authHeader: auth === 'env' ? authHeader : null,
    modelsAuthHeader: auth === 'env' ? modelsAuthHeader : null,
    apiKeyEnv: apiKeyEnv || null,
    credentialConfigured,
    hostedTools,
    pricing: pricing ?? null,
    defaultModel: setup.defaultModel,
  };
  if (options.json) {
    printObject(result, true);
    return;
  }
  process.stdout.write(`${chalk.green(cliGlyphs.success)} Saved shared connection ${setup.defaultConnection} to ${path}\n`);
  process.stdout.write(`  Default: ${protocol}/${setup.defaultModel} via ${redactEndpoint(baseUrl)}\n`);
  process.stdout.write(`  Models: ${PRODUCT_COMMAND} agents models ${setup.defaultConnection} via ${redactEndpoint(modelsBaseUrl || baseUrl)}\n`);
  process.stdout.write(`  Credential: ${auth === 'none' ? 'none' : `env:${apiKeyEnv} via ${authHeader}; models via ${modelsAuthHeader} (${credentialConfigured ? 'configured' : 'not set'})`}\n`);
  process.stdout.write(`  Hosted tools: ${hostedTools.join(', ') || 'none'}\n`);
  process.stdout.write(`  Pricing: ${pricing ? 'configured by user' : 'unpriced'}\n`);
  process.stdout.write(`  Routes: ${PRODUCT_COMMAND} agents list\n`);
}

async function runtimeConfig(
  workspaceInput: string,
  options: RuntimeConfigOptions,
): Promise<MosaicConfig> {
  const workspace = resolve(workspaceInput);
  const loaded = await loadConfig(workspace, options.config, {
    trustProjectConfig: options.trustProjectConfig === true,
  });
  const roots = [
    workspace,
    ...loaded.workspaceRoots,
    ...(options.addWorkspace ?? []).map((root) => resolve(workspace, root)),
  ];
  const provider = options.provider ? validateProvider(options.provider) : loaded.model.provider;
  const legacyModel = resolveRuntimeModel(loaded.model, {
    provider,
    ...(options.model ? {model: options.model} : {}),
    ...(options.baseUrl ? {baseUrl: options.baseUrl} : {}),
  });
  const catalog = discoverConnectionCatalog(loaded);
  let model = legacyModel;
  let activeConnection = legacyConnectionRuntimeInfo(legacyModel);
  if (options.provider || options.baseUrl) {
    if (options.connection) throw new Error('--connection cannot be combined with --provider or --base-url.');
    activeConnection = {...activeConnection, id: 'cli', source: 'cli'};
  } else if (options.connectionSelection !== 'inspect' || options.connection) {
    let selection = planConnectionSelection(catalog, process.env, options.connection);
    if (selection.kind === 'ambiguous') {
      if (options.connectionSelection === 'interactive') {
        selection = {kind: 'selected', profile: await promptConnectionSelection(selection.profiles)};
      } else if (options.connectionSelection === 'required') {
        throw new Error(`Multiple complete model connections found: ${selection.profiles.map(({id}) => id).join(', ')}. Pass --connection <name>.`);
      }
    }
    if (selection.kind === 'selected') {
      const resolved = resolveConnectionModel(legacyModel, selection.profile, {
        ...(options.model ? {model: options.model} : {}),
      });
      model = resolved.model;
      activeConnection = resolved.activeConnection;
    }
  }
  return {
    ...loaded,
    workspaceRoots: [...new Set(roots)],
    model,
    connectionCatalog: connectionRuntimeCatalog(catalog),
    activeConnection,
    context: loaded.context,
    agent: {
      ...loaded.agent,
      ...(options.checkpoint === false ? {checkpointBeforeWrite: false} : {}),
      ...(options.epochTokenBudget
        ? {maxEpochTokens: positiveInt(options.epochTokenBudget, loaded.agent.maxEpochTokens ?? loaded.agent.maxSessionTokens)}
        : {}),
      ...(options.tokenBudget
        ? {maxSessionTokens: positiveInt(options.tokenBudget, loaded.agent.maxSessionTokens)}
        : {}),
    },
    ui: {...loaded.ui, ...(options.color === false ? {color: false} : {})},
  };
}

async function promptConnectionSelection(profiles: ConnectionProfile[]): Promise<ConnectionProfile> {
  process.stdout.write('Multiple model connections are ready:\n');
  profiles.forEach((profile, index) => {
    process.stdout.write(`  ${index + 1}. ${profile.id}  ${profile.provider}/${profile.defaultModel ?? defaultModelForProvider(profile.provider)}  ${redactEndpoint(profile.baseUrl)}\n`);
  });
  const readline = createInterface({input, output});
  try {
    const answer = (await question(readline, 'Select connection by number or name', '')).trim();
    const numeric = Number(answer);
    const selected = Number.isInteger(numeric) && numeric >= 1
      ? profiles[numeric - 1]
      : profiles.find(({id}) => id === answer);
    if (!selected) throw new Error(`Unknown connection selection ${answer || '<empty>'}. Pass --connection <name> to choose explicitly.`);
    return selected;
  } finally {
    readline.close();
  }
}

async function loadSessionSelector(store: SessionStore, selector?: string): Promise<Session | undefined> {
  const summaries = await store.list();
  if (!summaries.length) {
    if (selector) throw new Error(`No saved sessions in ${store.workspace}.`);
    return undefined;
  }
  const selected = selector
    ? summaries.filter((summary) => summary.id === selector || summary.id.startsWith(selector))
    : [summaries[0] as SessionSummary];
  if (selected.length > 1) {
    throw new Error(`Session prefix is ambiguous: ${selector}. Use a longer id.`);
  }
  if (!selected[0]) throw new Error(`Session not found: ${selector}`);
  return store.load(selected[0].id);
}

async function requireSessionSelector(store: SessionStore, selector?: string): Promise<Session> {
  const session = await loadSessionSelector(store, selector);
  if (!session) throw new Error(`No saved sessions in ${store.workspace}.`);
  return session;
}

async function requireTeamRun(store: TeamRunStore, selector: string): Promise<import('./agent/team-store.js').TeamRunManifest> {
  const runs = await store.list();
  const selected = runs.filter((run) => run.id === selector || run.id.startsWith(selector));
  if (selected.length > 1) throw new Error(`Team run prefix is ambiguous: ${selector}. Use a longer id.`);
  if (!selected[0]) throw new Error(`Team run not found: ${selector}`);
  return store.load(selected[0].id);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').trim();
}

function printObject(value: unknown, json: boolean): void {
  if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else if (typeof value === 'string') process.stdout.write(`${value}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Render a human-readable status summary; the full record stays available via --json. */
function printStatusSummary(
  config: MosaicConfig,
  context: Record<string, unknown>,
  namespace: {activeKind: 'canonical' | 'legacy'; phase: string; active: string},
  update?: UpdateNotice,
): void {
  const glyphs = cliGlyphs;
  const dim = (text: string): string => chalk.dim(text);
  const line = (level: 'ok' | 'warn' | 'error', name: string, detail: string): void => {
    const icon = level === 'ok'
      ? chalk.green(glyphs.success)
      : level === 'error'
        ? chalk.red(glyphs.error)
        : chalk.yellow('!');
    process.stdout.write(`${icon} ${name.padEnd(16)} ${dim(detail)}\n`);
  };
  const keyReady = Boolean(config.model.apiKey) || config.model.provider === 'compatible';
  const endpoint = redactEndpoint(config.model.baseUrl);
  const local = (context.local ?? {}) as {available?: boolean; files?: number; chunks?: number};
  const engineDetail = 'local index';
  const indexFiles = local.files ?? 0;
  const indexReady = Boolean(local.available) && indexFiles > 0;
  const indexDetail = indexReady
    ? `${indexFiles} files ${glyphs.separator} ${local.chunks ?? 0} chunks`
    : `not built ${glyphs.separator} run ${PRODUCT_COMMAND} index`;

  process.stdout.write(`${chalk.hex('#A78BFA').bold(`${glyphs.brand} ${PRODUCT_NAME.toUpperCase()} STATUS`)}\n\n`);
  line('ok', 'Model', `${config.model.provider}/${config.model.model}`);
  line('ok', 'Endpoint', endpoint);
  line(keyReady ? 'ok' : 'warn', 'API key', keyReady
    ? 'configured'
    : `missing ${glyphs.separator} set it, then run ${PRODUCT_COMMAND} doctor to verify`);
  line('ok', 'Context engine', engineDetail);
  line(indexReady ? 'ok' : 'warn', 'Code index', indexDetail);
  line('ok', 'Workspace', config.workspaceRoots.join(`  ${glyphs.separator}  `));
  const namespaceName = namespace.activeKind === 'canonical' ? '.skein' : '.mosaic';
  const storageDetail = namespace.activeKind === 'canonical'
    ? `${namespaceName} (canonical)`
    : namespace.phase === 'active'
      ? `${namespaceName} (legacy; new projects switch to .skein from 0.3.0)`
      : `${namespaceName} (legacy; run ${PRODUCT_COMMAND} migrate --yes before removal)`;
  const storageReady = namespace.activeKind === 'canonical' || namespace.phase === 'active';
  line(storageReady ? 'ok' : 'warn', 'Storage', storageDetail);
  line(update ? 'warn' : 'ok', 'Version', update ? updateNoticeText(update) : `v${packageJson.version} (up to date)`);
  // Render up to the cap of release highlights beneath the version line so an
  // upgrade prompt explains *why* it's worth taking, degrading silently when the
  // registry omits them.
  if (update?.highlights?.length) {
    for (const highlight of update.highlights) {
      process.stdout.write(`  ${dim(`${cliGlyphs.separator} ${highlight}`)}\n`);
    }
  }
  process.stdout.write(`\n${dim(`Run ${PRODUCT_COMMAND} status --json for the full machine-readable record.`)}\n`);
}

function printSessionList(sessions: SessionSummary[]): void {
  if (!sessions.length) {
    process.stdout.write('No saved sessions.\n');
    return;
  }
  for (const session of sessions) {
    process.stdout.write(`${session.id.slice(0, 12).padEnd(14)} ${session.updatedAt.slice(0, 19).replace('T', ' ')}  ${session.title.slice(0, 64)}  ${session.messageCount} messages\n`);
  }
}

function sessionMarkdown(session: Session): string {
  const lines = [
    `# ${session.title}`,
    '',
    `- Session: ${session.id}`,
    `- Workspace: ${session.workspace}`,
    `- Model: ${session.provider}/${session.model}`,
    `- Updated: ${session.updatedAt}`,
    '',
  ];
  for (const message of session.messages) {
    if (message.role === 'system') continue;
    const label = message.role === 'tool' ? `Tool: ${message.name ?? 'result'}` : message.role;
    lines.push(`## ${label}`, '', message.content, '');
  }
  if (session.audit?.length) {
    lines.push('## Audit', '');
    for (const event of session.audit) {
      const category = event.category ? `/${event.category}` : '';
      const reason = event.reason ? ` - ${event.reason.replace(/\s+/g, ' ').slice(0, 240)}` : '';
      lines.push(`- ${event.createdAt} ${event.type} ${event.tool}${category}: ${event.outcome}${reason}`);
    }
    lines.push('');
  }
  if (session.changedFiles.length) {
    lines.push('## Changed files', '', ...session.changedFiles.map((path) => `- ${path}`), '');
  }
  return `${lines.join('\n')}\n`;
}

function createMcpManager(config: MosaicConfig): McpManager {
  if (!config.mcp) throw new Error('MCP is not configured.');
  return new McpManager(config.mcp, {
    cwd: config.workspaceRoots[0] ?? process.cwd(),
    workspaceRoots: config.workspaceRoots,
  });
}

function printMcpManifest(review: {
  manifest: ReturnType<McpManager['inspect']>;
  fingerprint: string;
  trust: string;
}): void {
  const {manifest} = review;
  process.stdout.write(`MCP capability ${manifest.name} (${manifest.version})\n`);
  process.stdout.write(`  Source: ${manifest.source.kind}/${manifest.source.owner}\n`);
  process.stdout.write(`  Target: ${manifest.transport} ${manifest.target}\n`);
  process.stdout.write(`  Trust: ${review.trust}  ${manifest.required ? 'required' : 'optional'}\n`);
  process.stdout.write(`  Fingerprint: ${review.fingerprint}\n`);
  if (!manifest.tools.length) {
    process.stdout.write('  Tools: dynamically discovered; network-only, completion evidence unsupported\n');
    return;
  }
  for (const tool of manifest.tools) {
    process.stdout.write(`  ${tool.name}: ${tool.permissions.join('+')}  evidence=${tool.completionEvidence}\n`);
    process.stdout.write(`    network=${tool.network.join(', ') || 'unspecified'} commands=${tool.commands.join(', ') || 'none'} paths=${tool.paths.join(', ') || 'none'} sensitive=${tool.sensitiveFields.join(', ') || 'none'}\n`);
  }
}

async function discoverSkills(options: ConfigOptions): Promise<{
  catalog: SkillCatalog;
  skills: SkillDescriptor[];
  workspace: string;
}> {
  const requestedWorkspace = workspaceOption(options.workspace);
  const config = await runtimeConfig(requestedWorkspace, runtimeOptions(options));
  const workspace = config.workspaceRoots[0] ?? requestedWorkspace;
  const catalog = new SkillCatalog(workspace, config.skills ?? {
    enabled: false, directories: [], autoActivate: false, maxActive: 1, maxCharsPerSkill: 32_000,
  });
  return {catalog, skills: await catalog.discover(), workspace};
}

function displaySkillSource(workspace: string, source: string): string {
  const normalized = resolve(source);
  const workspaceRelative = relative(resolve(workspace), normalized);
  if (!workspaceRelative.startsWith('..') && !isAbsolute(workspaceRelative)) {
    return `<workspace>/${workspaceRelative || '.'}`;
  }
  return normalized;
}

function printSkillReview(skill: SkillDescriptor, workspace: string): void {
  process.stdout.write(`Skill ${skill.name}\n`);
  process.stdout.write(`  Source: ${displaySkillSource(workspace, skill.path)}\n`);
  process.stdout.write(`  Scope: ${skill.scope}\n`);
  process.stdout.write(`  Trust: ${skill.trust} (${skill.trustSource})\n`);
  process.stdout.write(`  Effect: ${skill.effect}\n`);
  process.stdout.write(`  Fingerprint: ${skill.fingerprint}\n`);
  process.stdout.write(`  Description: ${skill.description}\n`);
}

function memorySelection(scope: string, workspace: string): MemorySelectionOptions {
  if (scope === 'all') return {};
  if (scope === 'user') return {scopes: [{scope: 'user', scopeKey: 'default'}]};
  return {scopes: [{scope: 'workspace', scopeKey: workspace}]};
}

async function assertMemoryExportTarget(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Memory export target cannot be a symbolic link: ${path}`);
    if (!info.isFile()) throw new Error(`Memory export target must be a regular file: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

function printMemoryPrivacyReview(review: MemoryPrivacyReview): void {
  const ownerOnly = review.storage.ownerOnly === null
    ? 'not verifiable on this platform'
    : review.storage.ownerOnly ? 'yes' : 'no';
  process.stdout.write('Memory privacy review (content-free)\n');
  process.stdout.write(`  Storage: local SQLite / WAL  owner-only=${ownerOnly}  encrypted-at-rest=no\n`);
  process.stdout.write(
    `  Records: ${review.totals.active} active  ${review.totals.archived} archived  ` +
    `${review.totals.candidates.pending} pending candidates\n`,
  );
  process.stdout.write(
    `  Retention: ${review.lifecycle.neverExpires} no-expiry  ${review.lifecycle.expiring} expiring  ` +
    `${review.lifecycle.expired} expired  ${review.lifecycle.unverified} unverified\n`,
  );
  process.stdout.write(
    `  Scopes: user=${review.recordsByScope.user} workspace=${review.recordsByScope.workspace} ` +
    `session=${review.recordsByScope.session} agent=${review.recordsByScope.agent}\n`,
  );
  if (!review.findings.length) {
    process.stdout.write('  Findings: none\n');
    return;
  }
  process.stdout.write('  Findings:\n');
  for (const finding of review.findings) {
    process.stdout.write(`    ${finding.severity} ${finding.code} (${finding.count}) - ${finding.action}\n`);
  }
}

async function confirm(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const readline = createInterface({input, output});
  try {
    const answer = await readline.question(`${prompt} [y/N] `);
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}

async function question(readline: ReturnType<typeof createInterface>, label: string, fallback: string): Promise<string> {
  const answer = await readline.question(`${label}${fallback ? ` [${fallback}]` : ''}: `);
  return answer.trim() || fallback;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function workspaceOption(value?: string): string {
  const rootOptions = program.opts<RootOptions>();
  return resolve(value ?? rootOptions.workspace ?? process.cwd());
}

function runtimeOptions(options: RuntimeConfigOptions): RuntimeConfigOptions {
  const root = program.opts<RootOptions>();
  const config = options.config ?? root.config;
  const connection = options.connection ?? root.connection;
  const provider = options.provider ?? root.provider;
  const model = options.model ?? root.model;
  const baseUrl = options.baseUrl ?? root.baseUrl;
  const epochTokenBudget = options.epochTokenBudget ?? root.epochTokenBudget;
  const tokenBudget = options.tokenBudget ?? root.tokenBudget;
  return {
    addWorkspace: [...(root.addWorkspace ?? []), ...(options.addWorkspace ?? [])],
    ...(config ? {config} : {}),
    ...(connection ? {connection} : {}),
    ...(provider ? {provider} : {}),
    ...(model ? {model} : {}),
    ...(baseUrl ? {baseUrl} : {}),
    ...(options.maxTokens ? {maxTokens: options.maxTokens} : {}),
    ...(epochTokenBudget ? {epochTokenBudget} : {}),
    ...(tokenBudget ? {tokenBudget} : {}),
    ...(root.color !== undefined ? {color: root.color} : {}),
    ...(root.checkpoint !== undefined ? {checkpoint: root.checkpoint} : {}),
    ...(root.trustProjectConfig ? {trustProjectConfig: true} : {}),
  };
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function validateHostedTools(values: string[]): Array<'web_search'> {
  const normalized = values.flatMap((value) => value.split(','))
    .map((value) => value.trim().toLocaleLowerCase())
    .filter(Boolean);
  if (normalized.length === 1 && normalized[0] === 'none') return [];
  if (normalized.some((value) => value !== 'web_search')) {
    throw new Error('Unknown provider-hosted tool; use web_search or none.');
  }
  return [...new Set(normalized)] as Array<'web_search'>;
}

function optionalPrice(value: string | undefined, label: string): number | undefined {
  if (value === undefined || !value.trim() || value.trim().toLocaleLowerCase() === 'none') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1_000_000) {
    throw new Error(`${label} must be a finite value between 0 and 1000000 USD per million tokens.`);
  }
  return parsed;
}

function priceInput(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

function validateProvider(value: string): ProviderName {
  if (value === 'openai' || value === 'anthropic' || value === 'gemini' || value === 'compatible') return value;
  throw new Error(`Unknown provider ${value}; use openai, anthropic, gemini, or compatible.`);
}

function validateConnectionProtocol(value: string): Exclude<import('./types.js').ConnectionProtocol, 'gemini'> {
  if (value === 'openai-responses' || value === 'openai-chat' || value === 'anthropic-messages') return value;
  throw new Error(`Unknown relay protocol ${value}; use openai-responses, openai-chat, or anthropic-messages.`);
}

function validateConnectionAuth(value: string): import('./types.js').ConnectionAuth['type'] {
  if (value === 'env' || value === 'none') return value;
  throw new Error(`Unknown connection authentication ${value}; use env or none.`);
}

function validateConnectionApiKeyHeader(value: string): import('./types.js').ConnectionApiKeyHeader {
  const normalized = value.trim().toLocaleLowerCase();
  if (normalized === 'bearer' || normalized === 'x-api-key') return normalized;
  throw new Error(`Unknown credential header ${value}; use bearer or x-api-key.`);
}

function validateConnectionModelAuth(value: string): import('./types.js').ConnectionModelAuth {
  const normalized = value.trim().toLocaleLowerCase();
  if (normalized === 'bearer' || normalized === 'x-api-key' || normalized === 'none') return normalized;
  throw new Error(`Unknown model-directory authentication ${value}; use bearer, x-api-key, or none.`);
}

function environmentName(provider: ProviderName): string {
  return providerEnvironment(provider);
}

function providerEnvironment(provider: ProviderName): string {
  if (provider === 'anthropic') return 'ANTHROPIC_API_KEY';
  if (provider === 'gemini') return 'GEMINI_API_KEY';
  if (provider === 'compatible') return 'SKEIN_API_KEY';
  return 'OPENAI_API_KEY';
}

function progressLine(progress: IndexProgress): string {
  const path = progress.path ? ` ${cliGlyphs.separator} ${progress.path}` : '';
  return `  ${progress.phase.padEnd(6)} ${progress.completed}/${progress.total}${path}`;
}
