# Skein

**An open, context-first coding agent for the terminal.**

Skein understands the change surface before it edits, exposes every tool call,
and keeps sessions and pre-write checkpoints on your machine. It supports
OpenAI, Anthropic, Gemini, and OpenAI-compatible endpoints, with
[ContextEngine-plugin](https://github.com/lixiang12345/ContextEngine-plugin) as
an optional high-quality retrieval layer and a built-in local index as the
zero-service fallback.

```text
◆ SKEIN  ·  ~/work/api                                      ● BUILD
  anthropic/claude-sonnet-4-5  ·  context auto  ·  memory on  ·  agents 3

› Find the webhook retry bug and add a regression test.
◇ context  contextengine · 12 spans · ~8.4k
· prompt/debug  intent:debug · working-memory · code:contextengine
✓ read_file  src/billing/webhook.ts  31ms
✓ apply_patch  src/billing/webhook.ts  18ms

◆ Skein
  The retry timestamp was advanced before the failed attempt was persisted.
  I moved the update after persistence and added the timeout regression test.

────────────────────────────────────────────────────────────────────
› ask anything…
  Type a request · @file · /command

● ready  ·  ctx 18%  ·  14.2k tokens  ·  2 changed     graphite · /help
```

## Why Skein

- **Open automation:** text, quiet, JSON, and JSONL event modes are core
  features, suitable for local scripts and CI.
- **Model ownership:** use four provider families without changing the agent or
  session format.
- **Retrieval you control:** select ContextEngine for hybrid
  FTS/symbol/vector/graph retrieval, or run the local BM25/path/symbol index.
- **Visible trust:** per-category permissions, deny rules, hooks, workspace path
  enforcement, changed-file telemetry, and persisted tool results.
- **Reversible work:** Skein snapshots affected files before mutation without
  touching your Git history.
- **Resumable by default:** conversations, tasks, usage, and changed files live
  in project-local session files.
- **Layered agent runtime:** progressive Skills, MCP tools, typed workflows,
  isolated read-only experts, working memory, compacted session state, and
  reviewed durable memory share one permission and audit model.
- **Reviewed writer lane:** an opt-in API-backed writer can prepare a bounded
  patch in a disposable Git worktree; only the main agent can explicitly
  integrate it after review, conflict checks, and a recoverable checkpoint.

The product rationale and competitor research are in
[docs/PRODUCT.md](docs/PRODUCT.md); the implementation model is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Requirements

- Node.js 22.16 or newer
- A model API key, or an OpenAI-compatible local endpoint
- Optional: Git and ripgrep
- Optional: ContextEngine-plugin plus PostgreSQL/pgvector

## Install

From this repository:

```bash
npm install
npm run build
npm link
```

To build, verify, and install a local package artifact from this checkout:

```bash
npm run verify:package -- --output-dir artifacts/package
npm install -g ./artifacts/package/skein-code-cli-0.3.0.tgz
```

To install the published package from npm:

```bash
npm install -g @skein-code/cli
```

Once installed, upgrade in place with `skein update` (it detects your package
manager and runs the matching global install). Add `--check` to only report a
newer version, or `--yes` to skip the confirmation prompt.

`skein` is the primary command. Existing installations can continue using
`mosaic` or `mosaic-code`; the `.mosaic/` project state and `MOSAIC_*`
environment variables remain compatible with this release.

## Quick start

On the first interactive `skein` run, an incomplete model configuration opens
a keyboard-driven setup before any session is created. It offers an official
API, a third-party relay, or an explanation of signed-in CLI support. OpenAI,
Anthropic, and Gemini subscription logins are not API credentials; signed-in
Codex, Claude Code, and Gemini CLIs are available only as delegated agents.

For non-interactive setup, set credentials for one provider:

```bash
export OPENAI_API_KEY=...
# or ANTHROPIC_API_KEY / GEMINI_API_KEY / SKEIN_API_KEY
```

For an OpenAI-compatible local or self-hosted endpoint, provide the endpoint
explicitly so Skein never guesses where workspace code should be sent:

```bash
export SKEIN_API_KEY=... # omit when the local endpoint needs no authentication
skein init --provider compatible --base-url http://localhost:11434/v1 --yes
```

Relay protocol selection is explicit and is never inferred from the URL or
model name:

- OpenAI-compatible relays use `POST /chat/completions`, Bearer authentication,
  and OpenAI message/tool-call shapes (`provider: compatible`).
- Anthropic-compatible relays use `POST /messages`, `x-api-key`,
  `anthropic-version`, and Anthropic content blocks (`provider: anthropic` with
  a custom `baseUrl`).

Remote relays must use HTTPS. Loopback endpoints may use HTTP. To prevent an
official key from being sent to a third party, a custom OpenAI, Anthropic, or
Gemini base URL does not inherit the provider's official environment key; enter
the relay credential explicitly. The first-run flow writes its user config with
owner-only permissions and never renders the secret unmasked.

Create project configuration, index, and start the TUI:

```bash
cd /path/to/project
skein init --provider openai --model gpt-5 --yes
skein index
skein
```

Use `@path` to guarantee a file is attached to the current request:

```text
Explain the race in @src/queue/worker.ts and fix it with the smallest change.
```

### Interactive workspace

The transcript stays on the terminal's native background. A thin rule marks the
composer; consequential permission requests become an inline warning band with
the exact tool target and working directory. Enter sends a request, or steers the current run when it is busy;
`Alt+Enter` queues a follow-up, while `Ctrl+J` or `Shift+Enter` inserts a
newline. `Ctrl+R` searches prompt history, `Ctrl+O` expands or collapses the
latest tool result, and Escape interrupts the current run. The composer supports
multiline cursor movement, word movement/deletion, `Ctrl+U`/`Ctrl+K`, and
bounded undo/redo. Type `/` for a keyboard-navigable command palette, or run
`/hotkeys` inside Skein.

Useful interactive commands include `/workflow`, `/context`, `/mode`, `/memory`,
`/remember`, `/skills`, `/agents`, `/mcp`, `/tools`, `/permissions`, and
`/theme`. `/transcript` reveals bounded full tool results, `/changes` lists
session writes, `/diff` opens the current Git diff through the normal permission
policy, and `/checkpoints` shows recoverable pre-mutation snapshots. `/mode ask`,
`/mode plan`, and `/mode build` switch the workflow posture without restarting.
Plan mode is read-only and produces an approval-ready implementation plan;
Build mode is the only mode that can mutate under the configured policy.
`/context`
toggles one live inspector for the active transcript, mutable working memory,
compacted session summary, and durable retrieval layer separately. Model-
suggested durable memories can be reviewed with `/memory candidates` and then
approved or rejected.

The default `/theme auto` follows
`SKEIN_APPEARANCE=light|dark` or a terminal `COLORFGBG` hint and otherwise uses
the dark-safe graphite palette. Cinder and Mono mirror the interactive prototype;
Midnight and Paper remain available compatibility choices. Place data-only JSON palettes in `~/.mosaic/themes/` (or
`SKEIN_THEME_DIR`) and run `/theme reload`; each palette uses semantic keys such
as `accent`, `text`, `muted`, `success`, and `error`. Set
`SKEIN_GLYPHS=ascii` when a terminal or multiplexer renders Unicode symbols
inconsistently. `NO_COLOR=1` or `ui.color: false` removes palette colors while
keeping status symbols and semantic labels intact. `/density compact` and
`/density comfortable` control vertical rhythm.

Run `skein doctor --visual` to inspect terminal width, color mode, glyph
fallback, keyboard protocol support, and a CJK/emoji/box-drawing calibration
sample. Skein cannot force a terminal font; Iosevka Term is a compact default,
JetBrains Mono NL maximizes compatibility, and Sarasa Mono SC is recommended
for Chinese-heavy work.

## Automation

```bash
# One-shot progress plus final answer
skein --print "Fix the failing typecheck"

# Final answer only
skein --print --quiet "Summarize the staged changes"

# A deterministic object for CI
skein --print --output-format json "Review this branch"

# One JSON event per line
skein --print --output-format stream-json "Run tests and fix failures"

# Pipeline input and sequential follow-up
cat build.log | skein --print --quiet "Find the root cause"
skein --print --queue "Run focused tests" --queue "Summarize risks" "Fix the bug"

# Read-only investigation
skein --ask --print "Trace request authentication"

# Read-only implementation planning
skein --plan --print "Design the storage migration"
```

Non-interactive permission requests are denied unless the operation is already
allowed by policy. Use `--auto-edit` to allow file edits while retaining prompts
for shell/Git/network, or `--yes` for intentionally unattended runs. Hard deny
rules still win over both flags.

## Commands

```text
skein [prompt]                       interactive workspace
skein --print [prompt]               headless agent run
skein init                           project setup
skein doctor                         prerequisite and fallback checks
skein doctor --visual                terminal rendering and input calibration
skein update                         upgrade to the latest release
skein config show                    resolved, redacted configuration
skein index                          build/update the selected index
skein search <query>                 ranked grounded spans
skein context <task>                 packed model context
skein status                         model and index status
skein session list|show|delete       local session management
skein session export <id>            Markdown audit export
skein checkpoint list <session>      inspect snapshots
skein checkpoint restore <s> <c>     restore a snapshot
skein tools                          tool schemas and categories
skein rules                          loaded user/workspace rule files
```

Run `skein <command> --help` for complete flags.

### Project configuration trust

A cloned repository must not be able to execute commands merely by committing
`.mosaic/config.*`. Skein therefore ignores project-defined hooks, custom
ContextEngine executables, verification commands, checkpoint overrides, and
permission policy by default. It also ignores remote model provider/endpoint
overrides and their project-stored API keys; loopback compatible endpoints and
local credentials remain available for local models. Review the file first,
then opt in explicitly:

```bash
skein --trust-project-config --print "Run the project checks and fix failures"
skein --trust-project-config index
```

User-level configuration and an explicitly supplied `--config` file remain the
recommended locations for trusted automation policy.

`skein init` records an owner-only fingerprint of the model settings it just
created under `~/.mosaic` (or `SKEIN_HOME`). This lets Anthropic, Gemini, and
remote compatible setup work normally without trusting project hooks or
permissions. If those model settings are later edited, that narrow routing
trust is invalidated automatically.

## Configuration

Skein merges configuration in this order:

1. defaults and environment variables;
2. `~/.mosaic/config.yaml`;
3. `<workspace>/.mosaic/config.yaml`;
4. `<workspace>/.mosaic/config.json`;
5. command-line overrides.

Example:

```yaml
model:
  provider: anthropic
  model: claude-sonnet-4-5
  temperature: 0.2
  maxTokens: 8192

context:
  engine: auto
  maxTokens: 12000
  topK: 12
  contextEngineCommand: contextengine

permissions:
  read: allow
  write: ask
  shell: ask
  git: ask
  network: ask
  allowCommands:
    - git status
    - git diff
    - npm test
  denyCommands:
    - rm -rf /
    - git reset --hard
    - sudo

agent:
  maxTurns: 24
  maxSessionTokens: 250000
  autoVerify: true
  verifyCommands:
    - npm run typecheck
    - npm test
  checkpointBeforeWrite: true

hooks:
  beforeTool: []
  afterTool: []
  afterTurn: []
```

See [examples/config.yaml](examples/config.yaml) for a ready-to-adapt file.
Secrets should normally stay in environment variables instead of committed
configuration.

The isolated writer lane is disabled by default. Enable it only in user-owned
or explicitly trusted configuration:

```yaml
agents:
  writerEnabled: true
  writerProfile: implementer
  writerReviewerProfile: reviewer
  maxWriterPatchBytes: 60000
```

`writer_run` requires write, Git, and shell approval because it creates a
temporary worktree. It cannot change the active workspace. A reviewed patch is
applied only through `writer_integrate`, which requires its Team Run ID and
SHA-256, rejects HEAD drift or dirty targets, and records a checkpoint rollback
command. See [docs/MULTI_MODEL_TEAMS.md](docs/MULTI_MODEL_TEAMS.md) for the full
trust and lifecycle contract.

`provider: compatible` must be paired with `model.baseUrl` (or the
`--base-url` flag). Additional roots declared in project config are constrained
to the project directory; use `--add-workspace` for an intentionally external
root.

## ContextEngine integration

Skein's `auto` mode negotiates a ContextEngine-compatible CLI by version,
required command flags, exit behavior, and response schemas. `skein index` can
bootstrap a compatible but unindexed workspace; `search` and `context` use the
external engine only after an index is ready. Missing, incompatible, unhealthy,
stale, malformed, or over-budget results fall back to the local index and emit
structured degradation metadata. `contextengine` makes those conditions hard
errors, while `local` never starts an external process.

```bash
git clone https://github.com/lixiang12345/ContextEngine-plugin.git
cd ContextEngine-plugin
npm install && npm run build && npm link
npm run db:up
export CONTEXTENGINE_DATABASE_URL=postgresql://contextengine:contextengine@127.0.0.1:54329/contextengine
# Optional semantic channel, using an embedding-specific credential:
# export CONTEXTENGINE_EMBEDDING_API_KEY=...
# export CONTEXTENGINE_EMBEDDING_BASE_URL=https://embedding.example/v1
# export CONTEXTENGINE_EMBEDDING_MODEL=your-embedding-model

cd /path/to/project
skein index
skein status
```

External commands run from a private temporary directory. Skein forwards only
`CONTEXTENGINE_*` variables and required proxy, certificate, locale, and
temporary-directory settings; it does not load a repository `.env` or forward
chat-model credentials. A shared gateway key should therefore be referenced by
an embedding-specific `CONTEXTENGINE_*` variable rather than reused implicitly.

ContextEngine status cannot prove that every indexed line still matches the
filesystem. Skein realpath-checks each result, verifies its hash and current line
content, and reruns the entire query locally if any hit is stale or invalid.
Empty external results in `auto` mode are cross-checked against the current
local index so newly added files are not silently missed. ContextEngine's
synthetic commit-lineage hits are reconstructed from the current repository
with a constrained read-only Git invocation before use. The external
`packedText` is never passed directly to a model; Skein repacks only verified
current-file or commit-summary spans under its own token cap.

ContextEngine remains an optional adapter, not a hidden hard dependency. The
local fallback keeps Skein useful offline, and fallback reason/remediation is
visible in TUI context telemetry, headless output, direct JSON commands, and
`skein doctor`.

## Safety model

- `read`, `write`, `shell`, `git`, and `network` have independent policies.
- File tools reject lexical and symlink escapes from configured workspace roots.
- Writes and patches are atomic; multi-file patches roll back partial commits.
- A checkpoint manifest and file blobs are saved before mutation.
- Command allow rules cannot bypass approval with shell control or substitution.
- Command allow rules approve only the shell/Git execution category; derived
  write and network policies still apply to package scripts and mutations.
- Ask mode only exposes inspection and planning tools to the model.
- Hooks receive JSON on stdin and run with bounded time/output.
- Project configuration cannot enable executable hooks or relax safety policy
  unless `--trust-project-config` is explicitly supplied.
- Untrusted project configuration cannot switch providers or redirect
  credentials/source code to a remote custom endpoint; these require trust.
- Git aliases, Git config overrides, repository hooks, and workspace overrides
  are disabled by the built-in Git tool; use an explicitly approved shell
  command when a repository workflow genuinely needs them.
- Git operations that may invoke transport, signing, merge, or checkout helpers
  require the `shell` category in addition to Git/write/network as applicable.
  Git and ContextEngine executables are resolved outside workspace-controlled
  `PATH` entries.
- Git checkpoints include dirty and explicitly named paths before a mutation.
  Branch switches can change clean tracked files that cannot be predicted
  without snapshotting the entire repository, so review the checkpoint list.

Shell approval is still powerful: an approved shell program can perform actions
that a file tool cannot. Custom environments require a fresh approval, common
mutation targets are checkpointed and audited, and network detection is
conservative but necessarily heuristic. Review the shown command, and use an
OS/container sandbox around Skein for untrusted repositories or fully
unattended agents.

## Project data

Existing installations and fresh projects on Skein 0.2.x keep using
`<workspace>/.mosaic/` until migration is explicitly requested. The migration
target—and the fresh-project default beginning with 0.3.0—is
`<workspace>/.skein/`, with the same layout:

```text
.skein/
  config.json
  index.json
  sessions/
  checkpoints/
```

Preview and apply project migration, or verify and roll it back:

```bash
skein migrate
skein migrate --yes
skein migrate --recover
skein migrate --recover --yes
skein migrate --rollback
skein migrate --rollback --yes
```

Use `--home` for user-level configuration, memory, themes, Skills, rules, and
agent profiles. Migration copies through a temporary directory and retains the
legacy source. Rollback is available only when the source, canonical copy, and
hash-bearing migration manifest still match; changed data is never deleted.
If a process exits between copy, rename, verification, and cleanup,
`--recover` previews the remaining `.migrating-*` or `.rollback-*` directory.
`--recover --yes` resumes a complete migration, restores a complete rollback
snapshot, or removes only a partial copy proven redundant with legacy state.
Conflicting or ambiguous candidates remain untouched. Normal Skein processes
hold shared namespace leases for the storage they use; migration, rollback, and
recovery require an exclusive lease. A live session, indexer, team run, or
default memory store therefore blocks namespace mutation, while an operating
system process exit (including a crash) releases its lease immediately. Custom
legacy and canonical paths must be separate and non-nested after symbolic links
are resolved.

The default durable memory database is user-owned at `~/.mosaic/memory.sqlite`
until user storage is migrated to `~/.skein/` (or overridden by `SKEIN_HOME`).
Set `memory.databasePath` when a team or deployment
needs a different local SQLite location. Working memory and compacted summaries
remain inside each session, while durable facts are retrieved only when their
lexical evidence and confidence clear the configured threshold.

Memory is intentionally layered: the active prompt holds the current turn,
`working_memory` holds bounded goals/constraints/decisions for the session,
compaction produces a fallible handoff summary, and SQLite FTS5 stores durable
semantic/episodic/procedural facts. A model can call `memory_propose`, but its
candidate is inactive, expires automatically, and carries provenance until a
person approves it with `/memory candidates` and `/memory approve <id>`. The
interactive `/remember` command and `skein memory add` are explicit user writes.
This prevents retrieved text from becoming an unreviewed instruction or
permission grant.

Add both `.mosaic/` and `.skein/` to `.gitignore` unless the team intentionally
shares a sanitized configuration file elsewhere.

Session JSON also keeps a bounded audit trail of permission decisions, tool
outcomes, changed files, and checkpoint ids. `skein session export` includes
that trail in the Markdown export.

## Development

```bash
npm run dev -- "explain this project"
npm run typecheck
npm test
npm run build
npm run check
npm run test:pty
npm run release:verify
```

Skein is licensed under MIT.
