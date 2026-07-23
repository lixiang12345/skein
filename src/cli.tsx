import {createInterface} from 'node:readline/promises';
import {stdin as input, stdout as output} from 'node:process';
import {readFile, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {basename, resolve} from 'node:path';
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
import {AgentProfileCatalog, listConnectionModels, TeamRunStore} from './agent/index.js';
import {resolveAgentModelRoute} from './agent/model-route.js';
import {createAgentConnectionSetup, mergeAgentSetup} from './agent/model-setup.js';
import {discoverWorkspaceRules} from './agent/rules.js';
import {createProvider} from './providers/index.js';
import {SessionStore, type SessionSummary} from './session/index.js';
import {CheckpointStore} from './checkpoint/index.js';
import {createDefaultToolRegistry} from './tools/index.js';
import {runDoctor} from './cli/doctor.js';
import {
  askConsolePermission,
  HeadlessReporter,
  printBanner,
  type OutputFormat,
} from './cli/output.js';
import {resolveCliGlyphs} from './cli/glyphs.js';
import {acquireCliNamespaceLeases, releaseCliNamespaceLeases} from './cli/namespace-leases.js';
import {runInteractiveTui} from './ui/index.js';
import {ExtensionRuntime} from './runtime/index.js';
import {SkillCatalog} from './skills/index.js';
import {MemoryStore, type MemoryCandidate} from './memory/index.js';
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
  .option('--provider <provider>', 'model provider')
  .option('--model <model>', 'model identifier')
  .option('--base-url <url>', 'OpenAI-compatible or provider base URL')
  .option('--context-engine <engine>', 'auto, contextengine, or local')
  .option('--max-turns <n>', 'maximum agent turns')
  .option('--token-budget <n>', 'maximum cumulative session tokens')
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
  .option('--context-engine <engine>', 'auto, contextengine, or local', 'auto')
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
      `${cliGlyphs.meta} ${packed.engine} ${cliGlyphs.separator} ${packed.hits.length} spans ${cliGlyphs.separator} ~${packed.estimatedTokens} tokens${packed.truncated ? ` ${cliGlyphs.separator} capped` : ''}${packed.degradation ? ` ${cliGlyphs.separator} ${packed.degradation.summary}` : ''}\n`,
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
        ? {current: update.current, latest: update.latest, command: update.command}
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
    const store = new SessionStore(workspaceOption(options.workspace));
    const session = await requireSessionSelector(store, id);
    if (!options.yes && !(await confirm(`Delete session ${session.id.slice(0, 8)}?`))) return;
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
    const config = await runtimeConfig(workspaceOption(options.workspace), runtimeOptions(options));
    const catalog = new SkillCatalog(config.workspaceRoots[0] ?? process.cwd(), config.skills ?? {
      enabled: false, directories: [], autoActivate: false, maxActive: 1, maxCharsPerSkill: 32_000,
    });
    const skills = await catalog.discover();
    if (options.json) printObject(skills, true);
    else if (!skills.length) process.stdout.write('No skills discovered.\n');
    else for (const skill of skills) {
      process.stdout.write(`${skill.name.padEnd(22)} ${skill.scope.padEnd(10)} ${skill.description}\n`);
    }
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
      process.stdout.write(`${profile.name.padEnd(14)} ${profile.readOnly ? 'read-only' : 'writer   '} ${profile.route.runtime}:${profile.route.provider}/${profile.route.model} (${profile.routeSource})  ${profile.description}\n`);
    }
  });
agentsCommand
  .command('setup')
  .description('Configure one shared model connection and team defaults')
  .option('-w, --workspace <path>', 'workspace used to resolve current defaults')
  .option('--name <name>', 'connection name')
  .option('--provider <provider>', 'openai, anthropic, gemini, or compatible')
  .option('--base-url <url>', 'provider or relay base URL')
  .option('--api-key-env <name>', 'environment variable containing the credential')
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
    const connections = Object.entries(config.agents?.connections ?? {}).map(([name, connection]) => ({
      name,
      provider: connection.provider,
      endpoint: redactEndpoint(connection.baseUrl),
      credentials: connection.apiKeyEnv ? `env:${connection.apiKeyEnv}` : 'provider default environment',
      routes: Object.values(config.agents?.routes ?? {}).filter((route) => route.connection === name).length,
      default: config.agents?.defaultConnection === name,
    }));
    if (options.json) printObject(connections, true);
    else if (!connections.length) process.stdout.write('No named model connections configured.\n');
    else for (const connection of connections) {
      process.stdout.write(`${connection.name.padEnd(16)} ${connection.provider.padEnd(10)} ${connection.credentials.padEnd(28)} ${connection.routes} explicit${connection.default ? ' + team default' : ''}  ${connection.endpoint}\n`);
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
    const connection = config.agents?.connections?.[connectionName];
    if (!connection) throw new Error(`Unknown model connection: ${connectionName}`);
    const models = await listConnectionModels(connection);
    if (options.json) printObject(models, true);
    else if (!models.length) process.stdout.write('No models returned by the connection.\n');
    else for (const model of models) {
      process.stdout.write(`${model.id}${model.ownedBy ? `  ${model.ownedBy}` : ''}${model.contextLength ? `  context ${model.contextLength}` : ''}\n`);
    }
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
      process.stdout.write(`${run.id.slice(0, 8)}  ${run.status.padEnd(8)} ${run.createdAt}  ${run.agentCount} agents  ${run.totalTokens} tok  ${run.toolCalls} tools  ${run.objective.replace(/\s+/gu, ' ').slice(0, 180)}\n`);
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
    if (options.json) printObject({...run, agents, messages}, true);
    else {
      process.stdout.write(`Team run ${run.id}\n${run.status}  ${run.createdAt}\n\n${run.objective}\n\n`);
      for (const agent of agents) {
        const tokens = (agent.usage?.inputTokens ?? 0) + (agent.usage?.outputTokens ?? 0);
        process.stdout.write(`## ${agent.profile} ${agent.phase} ${agent.provider}/${agent.model} ${agent.ok ? 'ok' : 'failed'}  ${tokens} tok  ${agent.toolCalls ?? 0} tools  ${agent.durationMs ?? 0}ms\n${agent.reportText}\n\n`);
      }
      if (messages.length) {
        process.stdout.write('Peer handoffs\n');
        for (const message of messages) process.stdout.write(`- ${message.from} -> ${message.to}: ${message.contentText.replace(/\s+/gu, ' ').slice(0, 400)}\n`);
      }
    }
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
      process.stdout.write(`${workflow.name.padEnd(12)} ${workflow.steps.length} steps  ${workflow.description}\n`);
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
  .description('Connect and report MCP server/tool status')
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
      await manager.connectAll();
      const status = manager.list();
      if (options.json) printObject(status, true);
      else if (!status.length) process.stdout.write('No MCP servers configured.\n');
      else for (const server of status) {
        process.stdout.write(`${server.name.padEnd(18)} ${server.state.padEnd(12)} ${server.toolCount} tools${server.error ? `  ${server.error}` : ''}\n`);
      }
    } finally {
      await manager.close();
    }
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
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${chalk.red(cliGlyphs.error)} ${message}\n`);
    process.exitCode = 1;
  } finally {
    releaseCliNamespaceLeases(cliNamespaceLeases);
  }
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
  provider?: string;
  model?: string;
  baseUrl?: string;
  contextEngine?: string;
  maxTurns?: string;
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
  contextEngine: string;
  index?: boolean;
  yes?: boolean;
}

interface ConfigOptions {workspace?: string; config?: string; json?: boolean}
interface AgentSetupOptions {
  workspace?: string;
  name?: string;
  provider?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  model?: string;
  yes?: boolean;
  json?: boolean;
}
interface IndexOptions extends ConfigOptions {addWorkspace: string[]}
interface SearchOptions extends ConfigOptions {topK: string}
interface ContextOptions extends ConfigOptions {maxTokens?: string}
interface SessionCommandOptions {workspace?: string; json?: boolean}

interface RuntimeConfigOptions {
  config?: string;
  addWorkspace?: string[];
  provider?: string;
  model?: string;
  baseUrl?: string;
  contextEngine?: string;
  maxTokens?: string;
  tokenBudget?: string;
  color?: boolean;
  checkpoint?: boolean;
  trustProjectConfig?: boolean;
}

async function runChat(prompts: string[], options: RootOptions): Promise<void> {
  const shouldPrint = options.print === true || !process.stdin.isTTY || !process.stdout.isTTY;
  if (options.ask && options.plan) throw new Error('--ask and --plan cannot be used together.');
  if (!shouldPrint && options.queue.length) throw new Error('--queue is only available with --print.');
  const stdinPrompt = !process.stdin.isTTY ? await readStdin() : '';
  const firstPrompt = [...prompts, stdinPrompt].filter(Boolean).join('\n\n').trim();
  if (shouldPrint && !firstPrompt) throw new Error('Provide a prompt argument or pipe input on stdin.');
  const workspace = resolve(options.workspace);
  const config = await runtimeConfig(workspace, options);
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
  });
  const colorOutput = (options.color ?? config.ui.color) && !process.env.NO_COLOR;
  const requestPermission = options.yes
    ? async () => true
    : options.autoEdit
      ? async (_call: Parameters<typeof askConsolePermission>[0], category: Parameters<typeof askConsolePermission>[1]) =>
        category === 'read' || category === 'write' ? true : askConsolePermission(_call, category, colorOutput)
      : async (call: Parameters<typeof askConsolePermission>[0], category: Parameters<typeof askConsolePermission>[1]) =>
        askConsolePermission(call, category, colorOutput);
  try {
    validateModelSetup(config);
    let session = await runner.run(firstPrompt, {
      askMode: options.ask === true || options.plan === true,
      ...(options.plan ? {turnInstructions: PLAN_MODE_INSTRUCTIONS} : {}),
      maxTurns: positiveInt(options.maxTurns, config.agent.maxTurns),
      onEvent: reporter.onEvent,
      requestPermission,
    });
    for (const queued of options.queue) {
      session = await runner.run(queued, {
        askMode: options.ask === true || options.plan === true,
        ...(options.plan ? {turnInstructions: PLAN_MODE_INSTRUCTIONS} : {}),
        maxTurns: positiveInt(options.maxTurns, config.agent.maxTurns),
        onEvent: reporter.onEvent,
        requestPermission,
      });
    }
    reporter.finish(session);
  } catch (error) {
    reporter.fail(error);
    process.exitCode = 1;
  } finally {
    await extensions.close();
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
    context: {engine: validateContextEngine(options.contextEngine)},
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
  let baseUrl = options.baseUrl ?? currentConnection?.baseUrl ?? '';
  let apiKeyEnv = options.apiKeyEnv ?? currentConnection?.apiKeyEnv ?? providerEnvironment(provider);
  let model = options.model ?? current.agents?.defaultModel ?? current.model.model;

  if (!options.yes && process.stdin.isTTY && process.stdout.isTTY) {
    const readline = createInterface({input, output});
    try {
      name = await question(readline, 'Connection name', name);
      const previousProvider = provider;
      provider = validateProvider(await question(readline, 'Provider', provider));
      if (!options.apiKeyEnv && !currentConnection?.apiKeyEnv && apiKeyEnv === providerEnvironment(previousProvider)) {
        apiKeyEnv = providerEnvironment(provider);
      }
      baseUrl = await question(readline, 'Base URL', baseUrl);
      apiKeyEnv = await question(readline, 'Credential environment variable', apiKeyEnv || providerEnvironment(provider));
      model = await question(readline, 'Default model', model);
    } finally {
      readline.close();
    }
  }

  const setup = createAgentConnectionSetup({
    name,
    provider,
    ...(baseUrl ? {baseUrl} : {}),
    ...(apiKeyEnv ? {apiKeyEnv} : {}),
    defaultModel: model,
  });
  const path = await saveUserConfig({agents: mergeAgentSetup(undefined, setup)});
  const credentialConfigured = apiKeyEnv ? Boolean(process.env[apiKeyEnv]) : false;
  const result = {
    path,
    connection: setup.defaultConnection,
    provider,
    endpoint: redactEndpoint(baseUrl),
    apiKeyEnv: apiKeyEnv || null,
    credentialConfigured,
    defaultModel: setup.defaultModel,
  };
  if (options.json) {
    printObject(result, true);
    return;
  }
  process.stdout.write(`${chalk.green(cliGlyphs.success)} Saved shared connection ${setup.defaultConnection} to ${path}\n`);
  process.stdout.write(`  Default: ${provider}/${setup.defaultModel} via ${redactEndpoint(baseUrl)}\n`);
  process.stdout.write(`  Credential: ${apiKeyEnv ? `env:${apiKeyEnv} (${credentialConfigured ? 'configured' : 'not set'})` : 'provider default environment'}\n`);
  process.stdout.write(`  Models: ${provider === 'compatible' || provider === 'openai' ? `${PRODUCT_COMMAND} agents models ${setup.defaultConnection}` : 'managed by the provider or official CLI'}\n`);
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
  const contextEngine = options.contextEngine
    ? validateContextEngine(options.contextEngine)
    : loaded.context.engine;
  return {
    ...loaded,
    workspaceRoots: [...new Set(roots)],
    model: resolveRuntimeModel(loaded.model, {
      provider,
      ...(options.model ? {model: options.model} : {}),
      ...(options.baseUrl ? {baseUrl: options.baseUrl} : {}),
    }),
    context: {...loaded.context, engine: contextEngine},
    agent: {
      ...loaded.agent,
      ...(options.checkpoint === false ? {checkpointBeforeWrite: false} : {}),
      ...(options.tokenBudget
        ? {maxSessionTokens: positiveInt(options.tokenBudget, loaded.agent.maxSessionTokens)}
        : {}),
    },
    ui: {...loaded.ui, ...(options.color === false ? {color: false} : {})},
  };
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
  const selected = String(context.selected ?? 'local');
  const engineDetail = selected === 'contextengine'
    ? 'ContextEngine (external)'
    : selected === 'unindexed'
      ? `ContextEngine available; index not built ${glyphs.separator} run ${PRODUCT_COMMAND} index`
      : selected === 'unavailable'
        ? `ContextEngine required but unavailable ${glyphs.separator} run ${PRODUCT_COMMAND} doctor`
        : 'local index';
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
  line(selected === 'unavailable' ? 'error' : 'ok', 'Context engine', engineDetail);
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
  const provider = options.provider ?? root.provider;
  const model = options.model ?? root.model;
  const baseUrl = options.baseUrl ?? root.baseUrl;
  const contextEngine = options.contextEngine ?? root.contextEngine;
  const tokenBudget = options.tokenBudget ?? root.tokenBudget;
  return {
    addWorkspace: [...(root.addWorkspace ?? []), ...(options.addWorkspace ?? [])],
    ...(config ? {config} : {}),
    ...(provider ? {provider} : {}),
    ...(model ? {model} : {}),
    ...(baseUrl ? {baseUrl} : {}),
    ...(contextEngine ? {contextEngine} : {}),
    ...(options.maxTokens ? {maxTokens: options.maxTokens} : {}),
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

function validateProvider(value: string): ProviderName {
  if (value === 'openai' || value === 'anthropic' || value === 'gemini' || value === 'compatible') return value;
  throw new Error(`Unknown provider ${value}; use openai, anthropic, gemini, or compatible.`);
}

function validateContextEngine(value: string): MosaicConfig['context']['engine'] {
  if (value === 'auto' || value === 'local' || value === 'contextengine') return value;
  throw new Error(`Unknown context engine ${value}; use auto, contextengine, or local.`);
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
