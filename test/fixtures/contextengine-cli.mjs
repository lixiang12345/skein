#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const args = process.argv.slice(2);
const command = args[0];
const mode = process.env.CONTEXTENGINE_FIXTURE_MODE ?? 'healthy';
const logPath = process.env.CONTEXTENGINE_FIXTURE_LOG;

if (logPath) await writeFile(logPath, `${args.join(' ')}\n`, {flag: 'a'});
if (process.env.CONTEXTENGINE_FIXTURE_ENV_LOG) {
  await writeFile(process.env.CONTEXTENGINE_FIXTURE_ENV_LOG, `${JSON.stringify({
    cwd: process.cwd(),
    openai: process.env.OPENAI_API_KEY ?? null,
    mode,
  })}\n`, {flag: 'a'});
}

if (command === '--version') {
  process.stdout.write(mode === 'incompatible' ? '0.3.9\n' : '0.4.0\n');
  process.exit(0);
}

if (command === '--help' || args[1] === '--help') {
  const help = command === 'index'
    ? 'Usage: contextengine index [root] --extra <spec> --quiet'
    : command === 'search'
      ? 'Usage: contextengine search <query> --top-k <n> --json --root <dir>'
      : command === 'context'
        ? 'Usage: contextengine context <task> --top-k <n> --max-tokens <n> --json --root <dir>'
        : 'Usage: contextengine index search context status';
  process.stdout.write(`${help}\n`);
  process.exit(mode === 'help-fail' && command === 'context' ? 1 : 0);
}

if (mode === 'db-down') {
  process.stderr.write('CONTEXTENGINE_DATABASE_URL is required (PostgreSQL with pgvector).\n');
  process.exit(1);
}

const root = optionValue('--root') ?? (command === 'index' ? args[1] : process.cwd());

if (command === 'status') {
  if (mode === 'malformed-status') {
    process.stdout.write(JSON.stringify({ok: true, root, fileCount: 'two'}));
    process.exit(0);
  }
  if (mode === 'unindexed-exit-zero') {
    process.stdout.write(JSON.stringify({ok: false, error: 'no index'}));
    process.exit(0);
  }
  if (mode === 'unindexed') {
    process.stdout.write(JSON.stringify({ok: false, error: 'no index', hint: 'run contextengine index'}));
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    root: mode === 'wrong-root' ? `${root}-other` : root,
    dbPath: 'postgresql',
    fileCount: 2,
    chunkCount: 3,
    hasEmbeddings: mode !== 'degraded',
    embeddingModel: mode === 'degraded' ? null : 'fixture-embedding',
    lastIndexedAt: new Date(0).toISOString(),
    indexVersion: 1,
    generationId: 'fixture-generation',
    sourceRevision: mode === 'stale' ? 'source-old' : 'source-current',
    indexedRevision: 'indexed-old',
    ...(mode === 'indexing' ? {pendingRevision: 'source-next'} : {}),
  }));
  process.exit(0);
}

if (command === 'index') {
  if (mode === 'index-fail') {
    process.stderr.write('PostgreSQL + pgvector is required.\n');
    process.exit(1);
  }
  if (!args.includes('--quiet')) {
    const found = mode === 'noisy-progress' ? 'Found 99 files across 2 root(s)' : 'Found 2 files across 2 root(s)';
    process.stdout.write(`Indexing fixture\r\x1b[K  ${found}\r\x1b[K  src/index.ts\r\x1b[K  Index complete\n`);
    if (mode === 'noisy-progress') process.stdout.write('\x1b]0;fixture-title\x07warning / retry\n');
    if (mode === 'long-progress') {
      await new Promise((resolveWrite) => process.stdout.write(`${'x'.repeat(5_100_000)}\n`, resolveWrite));
    }
  }
  if (mode === 'malformed-index') {
    process.stdout.write(JSON.stringify({ok: true, filesScanned: 'two'}));
    process.exit(0);
  }
  const result = {
    ok: true,
    filesScanned: 2,
    filesIndexed: 2,
    filesRemoved: 0,
    chunksWritten: 3,
    embeddingsWritten: mode === 'degraded' ? 0 : 2,
    storage: 'postgresql+pgvector',
    ...(mode === 'index-extra' ? {
      engine: 'external-override',
      apiKey: 'sk-fixture-index-secret',
      databaseUrl: 'postgresql://fixture:secret@localhost/contextengine',
    } : {}),
  };
  if (mode === 'long-progress') {
    await new Promise((resolveWrite) => process.stdout.write(JSON.stringify(result), resolveWrite));
  } else {
    process.stdout.write(JSON.stringify(result));
  }
  process.exit(0);
}

if (command === 'search' || command === 'context') {
  if (mode === 'secret-error') {
    process.stderr.write(
      'Authorization: Bearer fixture-bearer-secret apiKey="fixture-json-secret" ' +
      'sk-fixture-bare-secret postgresql://fixture:db-secret@localhost/context?token=hidden\n',
    );
    process.exit(1);
  }
  if (mode === 'query-fail') {
    process.stderr.write('query unavailable\n');
    process.exit(1);
  }
  if (mode === 'malformed-search' && command === 'search') {
    process.stdout.write(JSON.stringify([{unexpected: true}]));
    process.exit(0);
  }
  if (mode === 'malformed-context' && command === 'context') {
    process.stdout.write(JSON.stringify({packedText: 'invalid', hits: []}));
    process.exit(0);
  }
  if (mode === 'malformed-secret-context' && command === 'context') {
    process.stdout.write('apiKey="fixture-json-secret" sk-fixture-json-secret not-json');
    process.exit(0);
  }
  const hit = mode === 'empty' ? undefined : await makeHit(root);
  const hits = hit ? [hit] : [];
  if (command === 'search') {
    process.stdout.write(JSON.stringify(hits));
  } else {
    const maxTokens = Number(optionValue('--max-tokens') ?? 12000);
    process.stdout.write(JSON.stringify({
      task: positionalValue() ?? 'fixture task',
      hits,
      packedText: hit ? `<code>${hit.chunk.content}</code>` : '',
      estimatedTokens: mode === 'over-budget' ? maxTokens + 1 : Math.min(maxTokens, 8),
      truncated: false,
      ...(mode === 'degraded' ? {degradedChannels: ['semantic']} : {}),
    }));
  }
  process.exit(0);
}

process.stderr.write(`unsupported fixture command: ${command}\n`);
process.exit(1);

function optionValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function positionalValue() {
  const separator = args.indexOf('--');
  return separator >= 0 ? args[separator + 1] : args[1];
}

async function makeHit(workspace) {
  const externalPath = process.env.CONTEXTENGINE_FIXTURE_HIT_PATH ?? 'src/index.ts';
  const actualPath = resolveActualPath(workspace, externalPath);
  let content = process.env.CONTEXTENGINE_FIXTURE_CONTENT;
  if (content === undefined) {
    content = await readFile(actualPath, 'utf8');
    content = content.replace(/\r\n/gu, '\n').split('\n').slice(0, 20).join('\n').replace(/\n$/u, '');
  }
  const lines = content.split('\n');
  const prefix = process.env.CONTEXTENGINE_FIXTURE_PREFIX;
  const indexedContent = prefix ? `// Context: ${prefix}\n${content}` : content;
  return {
    chunk: {
      id: 'fixture-hit',
      path: externalPath,
      language: 'typescript',
      startLine: 1,
      endLine: Math.max(1, lines.length),
      content: indexedContent,
      hash: createHash('sha256').update(indexedContent).digest('hex'),
      symbol: 'fixtureSymbol',
    },
    score: 0.91,
    source: 'hybrid',
    preview: indexedContent.slice(0, 200),
    ...(mode === 'degraded' ? {degradedChannels: ['semantic']} : {}),
  };
}

function resolveActualPath(workspace, externalPath) {
  const parts = externalPath.replaceAll('\\', '/').split('/').filter(Boolean);
  const first = parts[0];
  if (first === 'main' && process.env.CONTEXTENGINE_FIXTURE_MULTI_ROOT === '1') {
    return resolve(workspace, ...parts.slice(1));
  }
  if (/^workspace\d+$/u.test(first ?? '')) {
    const configuredRoot = process.env.CONTEXTENGINE_FIXTURE_HIT_ROOT;
    if (configuredRoot) return resolve(configuredRoot, ...parts.slice(1));
    const extra = args.slice(0, args.indexOf('--quiet')).find((value) => value.startsWith(`${first}:`));
    if (extra) return resolve(extra.slice(first.length + 1), ...parts.slice(1));
  }
  return resolve(workspace, ...parts);
}
