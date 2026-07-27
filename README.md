# Skein

<p align="center">
  <img src="docs/assets/skein-goose-flight.png" width="180" alt="Skein Goose: a flying goose carrying three woven context threads">
</p>

<p align="center">
  <a href="https://github.com/lixiang12345/skein/actions/workflows/ci.yml"><img src="https://github.com/lixiang12345/skein/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://www.npmjs.com/package/@skein-code/cli"><img src="https://img.shields.io/npm/v/%40skein-code%2Fcli" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
</p>

**An open, context-first coding agent for the terminal.**

Skein understands the change surface before it edits, exposes every tool call,
and keeps sessions and pre-write checkpoints on your machine. It supports
OpenAI, Anthropic, Gemini, and OpenAI-compatible endpoints, with a local,
inspectable index for code retrieval and no retrieval service dependency.

```text
⌁ SKEIN  ·  ~/work/api                                      ● BUILD
  anthropic/claude-sonnet-4-5  ·  context local  ·  memory on  ·  agents 3

› Find the webhook retry bug and add a regression test.
◇ context  local · 12 spans · ~8.4k
· prompt/debug  intent:debug · working-memory · code:local
✓ read_file  src/billing/webhook.ts  31ms
✓ apply_patch  src/billing/webhook.ts  18ms

⌁ Skein
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
- **Evidence-gated completion:** after a workspace edit, Skein only reports a
  verified outcome when a current successful test, typecheck, lint, build,
  configured check, or `git diff --check` tool result exists. Otherwise the
  TUI and machine output say `unverified` or `verification_failed`, regardless
  of what the model claims in prose.
- **Evidence-bound review:** Team Run reviewers return one strict structured
  verdict bound to the Task Contract and exact artifact SHA. Required criteria
  must cite content-addressed evidence; deterministic failures, malformed JSON,
  unknown handles, stale patches, and legacy text verdicts fail closed.
- **Model ownership:** use four provider families without changing the agent or
  session format.
- **Retrieval you control:** run the local BM25/path/symbol index, inspect its
  source spans, and rebuild it explicitly when needed.
- **Visible trust:** per-category permissions, deny rules, hooks, workspace path
  enforcement, changed-file telemetry, and persisted tool results.
- **Repository reuse guard:** the first substantive implementation addition gets
  a warning-only, content-free receipt of current helper candidates and read
  evidence. After a successful TS/JS write, Skein compares newly added or
  significantly expanded functions with the pre-write index generation using
  normalized fingerprints. Calibrated Type-1/2 matches block completion until
  reuse, removal, or exact audited suppression; Type-3 remains warning-only.
  Docs, config, fixtures, generated files, deletions, small functions, and
  ordinary local edits stay quiet.
- **Bounded tool context:** large tool results cannot crowd the task out of the
  model window. Skein keeps a token-budgeted head/tail receipt and, when the
  producer captured the complete result, retains a redacted session-scoped
  artifact for bounded readback.
- **Measurable token economy:** every model request records a privacy-safe
  receipt for stable, dynamic, history, retrieval, tool-result, and tool-schema
  estimates, alongside actual provider usage when available. OpenAI, Anthropic,
  and Gemini cache/reasoning counters are normalized into session totals and
  structured events when the provider reports them. Receipts retain only counts
  and runtime decisions, never prompt or source content.
- **Reversible work:** Skein snapshots affected files before mutation without
  touching your Git history.
- **Resumable by default:** conversations, tasks, usage, and changed files live
  in project-local session files.
- **Layered agent runtime:** progressive Skills, MCP tools, typed workflows,
  isolated read-only experts, working memory, compacted session state, and
  reviewed durable memory share one permission and audit model.
- **Reviewed writer lane:** an opt-in API-backed writer can prepare a bounded
  patch in a disposable Git worktree; only the main agent can explicitly
  integrate it after deterministic preflight, a structured evidence-bound
  review, current-contract validation, conflict checks, and a recoverable
  checkpoint.

The product rationale and competitor research are in
[docs/PRODUCT.md](docs/PRODUCT.md); the implementation model is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Requirements

- Node.js 22.16 or newer
- A model-provider/relay credential reference, or a keyless local connection
- Optional: Git and ripgrep

## Install

Install the published package from npm (recommended):

```bash
npm install -g @skein-code/cli
skein --version
```

Or use the guarded installer, which checks Node.js >= 22.16 first and can pin
an exact version (`--version x.y.z`); package integrity stays enforced by
npm's registry checksums:

```bash
curl -fsSL https://raw.githubusercontent.com/lixiang12345/skein/main/scripts/install.sh | sh
```

From this repository:

```bash
npm install
npm run build
npm link
```

To build, verify, and install a local package artifact from this checkout:

```bash
npm run verify:package -- --output-dir artifacts/package
npm install -g ./artifacts/package/skein-code-cli-<version>.tgz
```

Once installed, upgrade in place with `skein update` (it detects your package
manager and runs the matching global install). Add `--check` to only report a
newer version, or `--yes` to skip the confirmation prompt.

`skein` is the primary command. Existing installations can continue using
`mosaic` or `mosaic-code`; the `.mosaic/` project state and `MOSAIC_*`
environment variables remain compatible with this release.

## Quick start

Sixty seconds from install to a first grounded run:

```bash
npm install -g @skein-code/cli
cd your-project
skein                      # first run opens guided relay setup, then the workspace
```

Or fully headless (CI and scripts) — define a provider-neutral connection,
save only its credential reference, and print one verified result:

```bash
export TEAM_RELAY_API_KEY=...
skein connections add --yes --name team-relay --provider company-gateway \
  --protocol openai-responses --base-url https://relay.example/v1 \
  --api-key-env TEAM_RELAY_API_KEY --model provider/coding-model
skein -p "summarize the failing tests" --output-format json
```

The JSON record follows `docs/headless-output.schema.json` with a stable
exit-code contract (`0` verified … `9` needs review), so pipelines can gate on
the result without parsing prose.

On the first interactive `skein` run, an incomplete model configuration opens
a keyboard-driven connection setup before any session is created. A connection
has an independent provider label and wire protocol (`openai-responses`,
`openai-chat`, `anthropic-messages`, or `gemini`), plus an inference endpoint,
optional model catalog, credential source, request headers, and default model.
Skein never guesses a protocol from the provider or model name.

Before a new interactive session, Skein prepares the workspace before opening the composer. It
shows the real local index phases, reloads the persisted artifact, verifies its
generation and file/chunk counts, and only then enables chat. Later interactive
new sessions validate and reuse a current index or incrementally rebuild a stale one;
an empty workspace is a valid zero-file index, while failed validation offers
retry or exit instead of silently continuing.

For non-interactive setup, export the relay credential and save only its
environment-variable name:

```bash
export TEAM_RELAY_API_KEY=...
skein connections add --yes \
  --name team-relay \
  --provider company-gateway \
  --protocol openai-responses \
  --base-url https://relay.example/v1 \
  --api-key-env TEAM_RELAY_API_KEY \
  --model provider/coding-model
```

The same connection command works in PowerShell; only the shell syntax for
setting the environment variable changes:

```powershell
$env:TEAM_RELAY_API_KEY = "..."
skein connections add --yes `
  --name team-relay `
  --provider company-gateway `
  --protocol openai-responses `
  --base-url https://relay.example/v1 `
  --api-key-env TEAM_RELAY_API_KEY `
  --model provider/coding-model
```

For a keyless local relay, select `none` explicitly:

```bash
skein connections add --yes \
  --name local \
  --provider ollama \
  --protocol openai-responses \
  --base-url http://localhost:11434/v1 \
  --auth none \
  --model local-coder
```

Named connections can also drive the primary agent. One complete connection is
selected automatically; multiple complete connections require an interactive
choice or an explicit `--connection <name>` in headless runs:

```bash
export SKEIN_CONNECTIONS=local
export SKEIN_CONNECTION_LOCAL_PROVIDER=compatible
export SKEIN_CONNECTION_LOCAL_PROTOCOL=openai-responses
export SKEIN_CONNECTION_LOCAL_BASE_URL=http://127.0.0.1:11434/v1
export SKEIN_CONNECTION_LOCAL_AUTH=none
export SKEIN_CONNECTION_LOCAL_MODEL=coder
skein --connection local
```

Use `skein connections list`, `skein connections show <name>`,
`skein connections doctor`, `/connections`, or `skein doctor` to inspect
redacted source, protocol, endpoint, authentication, and catalog readiness.
`skein connections test <name>` resolves auth and tests the catalog but never
calls inference. The common
misspellings `SEKIN_API` and `SKEIN_BASEURL` are diagnostic-only and never
treated as supported credential aliases.

Relay protocol selection is explicit and is never inferred from the URL or
model name:

- `openai-responses` uses `POST /responses`, typed response items, stateless
  full-history replay, `store: false`, and Responses SSE events. This is the
  default for new connections.
- `openai-chat` uses `POST /chat/completions` and OpenAI message/tool-call
  shapes for relays that have not implemented Responses.
- `anthropic-messages` uses the relay's Anthropic SDK-style base and appends
  `/v1/messages` when needed. A model catalog is optional.
- `gemini` uses the Gemini generate/stream content wire format. It is explicit,
  just like every other transport.

`baseUrl` is the inference API base, not a model-discovery URL. Prefer the SDK
root documented by the provider; for legacy compatibility, OpenAI/Anthropic
bases that already end in the expected final endpoint are preserved. Otherwise
Skein appends the path required by the selected wire protocol:

| Protocol | Request derived from `baseUrl` |
| --- | --- |
| `openai-responses` | `POST <base>/responses` |
| `openai-chat` | `POST <base>/chat/completions` |
| `anthropic-messages` | `POST <base>/v1/messages` (or `<base>/messages` when the base already ends in `/v1`) |
| `gemini` | `POST <base>/models/<model>:generateContent` |

`modelsBaseUrl` and `modelsPath` control only model discovery. They may point
at another host, use independent auth/headers, or be omitted. `skein
connections models <name>` merges declared model IDs with the remote catalog;
`--no-model-discovery --declared-model <id>` is the deterministic choice for a
gateway without `/models`. A catalog failure never makes a valid inference
connection unusable, and `connections test` never sends an inference request.

Authentication sources are `env`, `command`, or `none`. `command` runs one
argv-based credential helper with no shell or stdin, a hard timeout, bounded
stdout, a minimal environment, explicit `passEnv`, and an in-memory refresh
cache. This makes macOS Keychain, Windows Credential Manager, Linux Secret
Service, Vault, cloud CLIs, and enterprise helpers optional integrations rather
than core dependencies. Bearer, `x-api-key`, and custom credential headers are
supported. The independent model catalog can inherit inference auth or use its
own env/command/none source and headers.

Literal credential headers are rejected; use auth or an environment-backed
header. URLs cannot contain userinfo, query parameters, or fragments. Project
configuration cannot define or redirect connections, provider endpoints,
credential sources, headers, or the default connection—even with
`--trust-project-config`. Those authorities remain user/managed configuration.

Gateways without `/models` can use a manual catalog:

```bash
skein connections add --yes \
  --name private-gateway --provider company-gateway \
  --protocol anthropic-messages --base-url https://gateway.example \
  --auth command --auth-command /usr/local/bin/fetch-gateway-token \
  --auth-header bearer --declared-model company/claude \
  --no-model-discovery --model company/claude
```

Skein stores the helper command and argv, never its stdout. Do not put a secret
literal in helper arguments; let the helper obtain it from its own secure store.

A relay may expose one protocol root or separate OpenAI- and Anthropic-style
roots. Skein does not assume either shape. Model each transport as its own named
connection and reuse the same credential environment variable when the relay
account uses one key. Keep `modelsBaseUrl` independent when an Anthropic
inference root still publishes its model catalog through `/v1/models`.

Observed gateway shapes are deliberately examples, not presets:

| Gateway | Responses base | Anthropic base | Models base/auth |
| --- | --- | --- | --- |
| OpenRouter | deployment-documented Responses root | deployment-documented Messages root | deployment-documented |
| Vercel AI Gateway | deployment-documented Responses root | deployment-documented Messages root | deployment-documented |
| New API | deployment base commonly ending in `/v1` | commonly the same root | deployment-defined |
| LiteLLM | proxy root or `/v1` SDK base | unified/passthrough root | deployment-defined |

Skein never turns this table into URL or authentication detection. Configure
each transport and catalog exactly as the selected relay documents it.

Provider-hosted search is a separate, explicit capability. Skein only sends a
Responses `web_search` tool when both the named connection declares
`hostedTools: ["web_search"]` and the selected route requests the same tool.
It never grants the delegated agent a local network or shell permission for
this. Search-call receipts and citation identities are persisted without query
strings, fragments, URL credentials, or hidden reasoning.

Relay pricing is also user-owned configuration. A connection or route may set
per-million input, output, cache-read, and cache-write USD rates; Skein never
substitutes an official price for a relay. Missing pricing is displayed as
`unpriced`, not `$0`. `strict` cost enforcement requires both an explicit USD
ceiling and explicit pricing; otherwise no model request is sent. `observe`
remains the default and never stops work.

The non-interactive setup command can persist the connection side of that
contract without storing a key or making a model request:

```bash
skein connections add --yes \
  --name research-relay \
  --provider company-gateway \
  --protocol openai-responses \
  --base-url https://relay.example/v1 \
  --auth env \
  --api-key-env TEAM_RELAY_API_KEY \
  --hosted-tool web_search \
  --input-price 2 \
  --output-price 8 \
  --cached-input-price 0.5 \
  --model provider/research-model
```

The route must still opt into `hostedTools: ["web_search"]`; declaring a
connection capability alone never enables a hosted tool.

Capability routing is local and shadow-only in this release. It fingerprints
the exact model, endpoint/auth reference, profile prompt, tool catalog, and
generation policy; keeps configured priors separate from receipt-backed
observed outcomes; and opens a component-labelled epoch when behavior changes.
Deterministic failures degrade and then quarantine a route from shadow
recommendations; quarantine recovery requires two passing canaries. Inspect,
replay, or manage it with:

```bash
skein agents capability inspect frontend
skein agents capability pin frontend backend
skein agents capability unpin frontend
skein agents capability canary frontend backend ./canary-receipt.json
skein agents capability replay ./capability-replay.json
skein agents capability export
skein agents capability reset --yes
```

The recommendation never changes live model selection. The project-local
Registry v2 migrates v1 on read and contains only hashes, bounded aggregates,
health transitions, Token Ledger receipt links, and fingerprint-bound pins; it
does not store task text, prompts, source, output, endpoint text, commands, or
credential values. Replay bundles are strict content-free JSON and evaluate
route regret, strong/medium tier plus provider coverage, position/verbosity/
self-preference judge probes, degradation/recovery, and Token Ledger coverage.
Even a fully passing local replay cannot enable automatic routing or claim
external validation. Repository config cannot inject capability priors unless
the project is explicitly trusted.

`capability canary` does not run a command, contact a provider, or accept model
self-report. It only ingests a bounded regular JSON file containing a valid
content-addressed deterministic receipt whose tool is exactly
`capability_canary`; failed receipts may add a structured `--failure` reason.

Configure a user relay connection, index, and start the TUI:

```bash
cd /path/to/project
skein connections add
skein index
skein
```

Existing direct `model.provider`, `agents.connections`, `agents setup`,
`agents connections`, and `agents models` remain readable compatibility paths.
New configuration is stored under top-level `connections` and uses the
first-class `skein connections ...` command family.

Use `@path` to guarantee a file is attached to the current request:

```text
Explain the race in @src/queue/worker.ts and fix it with the smallest change.
```

### Interactive workspace

The transcript stays on the terminal's native background. A thin rule marks the
composer; consequential permission requests become an inline warning band with
the exact tool target and working directory. Enter sends a request, or steers the current run when it is busy;
`Alt+Enter` queues a follow-up, while `/queue` lists, removes, or clears pending
follow-ups. `Ctrl+J` or `Shift+Enter` inserts a newline. `Ctrl+R` searches prompt
history, `Ctrl+O` expands or collapses the latest tool result, and Escape first
dismisses an active completion palette, then interrupts the current run. The composer supports
multiline cursor movement, word movement/deletion, `Ctrl+U`/`Ctrl+K`, and
bounded undo/redo. `Alt+E` or `/editor [initial draft]` opens the current prompt
in `VISUAL` or `EDITOR`; the editor is launched without a shell, receives only
an owner-only bounded temporary file, and must resolve outside the workspace.
Type `/` for a keyboard-navigable command palette, or run
`/hotkeys` inside Skein.

Useful interactive commands include `/workflow`, `/context`, `/mode`, `/queue`, `/memory`,
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
approved or rejected. `/memory privacy` shows content-free retention,
provenance-risk, lifecycle, and file-permission aggregates; it never shows
memory text, tags, scope keys, or the database path.

Tool output has three explicit boundaries. Shell capture is bounded while the
process runs; completed MCP responses are reduced to a 5 MiB adapter result
before entering the runner. This MCP boundary limits transcript amplification,
but it is not a process sandbox or a streaming transport limit. The runner then
uses the remaining session/context headroom to expose at most 1,024–8,192
estimated tokens to the model. An oversized result becomes a head/tail receipt
that preserves completion or failure state, exit code, changed files, original
size, and a SHA-256-bound `read_tool_artifact` continuation when the complete
captured result is available. Artifacts are redacted before persistence, belong
only to the originating session, expire after seven days, and are removed when
that session is deleted. A receipt marked `source-truncated` is honest about
bytes already omitted by the producing tool; those bytes cannot be recovered.

Normal chat runs discover MCP servers lazily through `mcp_search → mcp_inspect
→ mcp_activate`. Search and inspection use only redacted local manifests and
perform no transport I/O. Activation is rejected until the user confirms the
exact workspace-bound manifest fingerprint with `skein mcp trust <server>` or
`/mcp trust <server> --confirm`; the model cannot grant trust. A trusted
activation connects one server, runs remote discovery, and loads at most eight
request-relevant schemas into the live registry. `skein mcp status` is now a
no-connect diagnostic; only explicitly `required` servers may connect and block
during startup.

Manifests declare source, version, tools, permission categories, network,
command and path scopes, sensitive fields, background/process-tree effects,
and completion-evidence support. Legacy manifests without declared tools remain
inspectable but cannot be trusted or activated. MCP calls always retain the local `network`
boundary, and server annotations cannot lower declared permissions. When a
manifest names tools, undeclared schemas injected by the server are skipped.
Sensitive arguments are redacted from text, TUI, JSON, and approval events.
Remote mutations without a Skein-bound checkpoint plus changed-file, artifact,
and completion receipts remain explicitly `unresolved`. Use `skein mcp disable`
or `skein mcp revoke --yes` (and the matching `/mcp` commands) to unload schemas
and persist the decision.

Skills have a separate local trust boundary. User-owned and explicitly
configured external Skill directories are trusted by source. Workspace-owned
`SKILL.md` files are blocked until `skein skills inspect <name>` is reviewed and
`skein skills trust <name> --yes` records the exact workspace, source-path, and
content fingerprint. Any content or source change produces `changed` and blocks
activation until a new review; `skein skills revoke <name> --yes` persists an
explicit revocation. `/skills` exposes scope, trust, activation effect, and a
short fingerprint without injecting Skill content into the status view.
Built-in workflows are a read-only trusted catalog; `skein workflow list` and
`/workflow` disclose whether execution is read-only or uses the single-writer
lane.

Fresh sessions open as a compact, composer-first workspace: one Skein signature,
repository/model/mode context, one truthful readiness line, and the primary
input. Completed index preparation is cleared before chat on visual terminals;
screen readers retain its linear announcements. Run `/status` to inspect the
actual route, mode, permission posture, index counts, tools, Skills, MCP,
memory, usage, and context. Active team runs add Team Cockpit only while that
telemetry is relevant.

The default `/theme auto` follows
`SKEIN_APPEARANCE=light|dark` or a terminal `COLORFGBG` hint and otherwise uses
the dark-safe graphite palette. Cinder and Mono mirror the interactive prototype;
Midnight and Paper remain available compatibility choices. Place data-only JSON palettes in `~/.mosaic/themes/` (or
`SKEIN_THEME_DIR`) and run `/theme reload`; each palette uses semantic keys such
as `accent`, `text`, `muted`, `success`, and `error`. Set
`SKEIN_GLYPHS=ascii` when a terminal or multiplexer renders Unicode symbols
inconsistently. `NO_COLOR=1` or `ui.color: false` removes palette colors while
keeping status symbols and semantic labels intact. `/density compact` and
`/density comfortable` control vertical rhythm. `TERM=dumb` automatically uses
ASCII, monochrome, reduced-motion, non-incremental output. Set
`SKEIN_SCREEN_READER=1` (or Ink's `INK_SCREEN_READER=true`) for linear
screen-reader output with semantic timeline, permission-choice, and input roles;
this profile applies the same low-motion fallbacks while preserving keyboard
commands. `SKEIN_REDUCE_MOTION=1` disables activity animation independently.
Skein enables Kitty keyboard
enhancements without probing when Kitty, WezTerm, Ghostty, or foot declares
support; set `SKEIN_KITTY_KEYBOARD=on|off` to override detection.

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

JSON emits one `type: "result"` object; JSONL ends with a `type: "session"`
record, or `type: "final"` after a runtime error. These terminal records follow
[`docs/headless-output.schema.json`](docs/headless-output.schema.json), include
`schemaVersion: 1`, `status`, `reason`, and `exitCode`, and use this stable
exit-code contract:

| Code | Status | Meaning |
| ---: | --- | --- |
| 0 | `completed`, `verified` | The read-only run completed or current changes were verified. |
| 1 | `error` | Setup, provider, extension, or runtime failure. |
| 2 | `needs_input` | One persisted clarification is required; resume the same session. |
| 3 | `unverified` | Changes or required acceptance evidence remain unverified. |
| 4 | `verification_failed` | A current verification command failed. |
| 5 | `blocked` | The active Task Contract records a blocked required criterion. |
| 6 | `cancelled` | The run was interrupted; its session state was saved. |
| 7 | `max_turns` | The configured turn limit ended the run. |
| 8 | `token_budget` | The lifetime token budget ended the run. |

## Commands

```text
skein [prompt]                       interactive workspace
skein --print [prompt]               headless agent run
skein init                           project setup
skein connections add               add/update a user-owned model connection
skein connections list|show         inspect redacted connection metadata
skein connections models|use        inspect models or choose the user default
skein connections test|doctor       verify auth/catalog or diagnose locally
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
skein session fork <id>              fork a hash-bound logical session
skein session fork <id> --branch <name> --worktree <path> --yes
                                      fork into an isolated sibling worktree
skein jobs start <session> <command> --yes
                                      start an explicitly enabled durable job
skein jobs list|output|kill           inspect or stop session-owned jobs
skein completion bash|zsh|fish       generate shell completion
skein checkpoint list <session>      inspect snapshots
skein checkpoint restore <s> <c>     restore a snapshot
skein /review [scope]                 read-only fixed-scope review in the TUI
skein /recover [action]               recovery status, retry, resume, diff, audit, rollback
skein tools                          tool schemas and categories
skein rules                          loaded user/workspace rule files
```

Run `skein <command> --help` for complete flags.

### Project configuration trust

A cloned repository must not be able to execute commands merely by committing
`.mosaic/config.*`. Skein therefore ignores project-defined hooks, custom
verification commands, checkpoint overrides, and
permission policy by default. Provider endpoints, connections, credential
sources, request headers, and the default connection are never project-owned,
even after executable project trust. Optional LSP/background executables still
require trust. Review the file first,
then opt in explicitly:

```bash
skein --trust-project-config --print "Run the project checks and fix failures"
skein --trust-project-config index
```

User-level configuration and an explicitly supplied `--config` file remain the
recommended locations for trusted automation policy.

`skein init` writes only data-safe project state and creates the selected model
connection in owner-only user configuration. It rejects `--api-key`; use an
`env` or `command` credential reference. Legacy project model-trust
fingerprints remain readable for state migration but no longer grant endpoint
or credential authority.

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
  maxTokens: 12000
  topK: 12

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
  # Rotate deterministic context handoffs without changing the session id.
  maxEpochTokens: 250000
  # Hard lifetime cost/usage ceiling across every resumed epoch.
  maxSessionTokens: 1000000
  autoVerify: true
  verifyCommands:
    - npm run typecheck
    - npm test
  checkpointBeforeWrite: true

hooks:
  beforeTool: []
  afterTool: []
  afterTurn: []

# Optional local code intelligence. The server must already be installed and
# resolve outside every workspace root. Untrusted project config cannot enable it.
lsp:
  enabled: false
  timeoutMs: 5000
  servers:
    typescript:
      command: typescript-language-server
      args: [--stdio]
      extensions: [.ts, .tsx]
      languageId: typescript

# Optional durable commands. Model-started and model-stopped jobs always need
# live human approval and never count as complete mutation evidence.
backgroundJobs:
  enabled: false
  maxConcurrent: 2
  maxJobsPerSession: 16
  maxLogBytes: 2000000
  maxRuntimeMs: 1800000
```

`--epoch-token-budget` overrides the handoff boundary for one invocation;
`--token-budget` remains the hard lifetime ceiling. Reaching an epoch boundary
keeps the complete transcript and cumulative usage, validates Task Contract,
failure, changed-file, and verification state, then continues in the same
session with a bounded active window. The Context inspector shows both meters.

For complex executable requests, Skein records an Intent Sufficiency receipt
before model-driven mutation. Explicit requests proceed directly; repository
facts are inspected rather than asked back to the user; a genuine product
choice such as public-API compatibility pauses with one question and two or
three concrete options. Headless JSON/JSONL emits `needs_input`, persists the
question, performs no mutation, and exits with status 2. The next reply resumes
the same logical run. Permission approval remains a separate runtime gate.

See [examples/config.yaml](examples/config.yaml) for a ready-to-adapt file.
Secrets should normally stay in environment variables instead of committed
configuration.

When LSP is enabled, Skein registers one read-only `lsp_query` tool for
definition, references, and diagnostics. The adapter speaks bounded JSON-RPC
over stdio, passes a minimal environment without provider/relay credentials,
and returns only locations that re-resolve inside configured workspace roots.
Missing servers or unmatched extensions fail locally and do not affect the
index or TUI.

Durable background jobs are session-owned and disabled by default. The
`background_start` and `background_kill` model tools always require a live
operator; config allow rules, session grants, and headless `--yes` cannot
replace that approval. Starts are content-addressed without persisting command
text in job metadata, return `changeTracking: unresolved`, retain bounded
owner-only stdout/stderr with incremental cursors, and keep a namespace lease
while the detached worker is alive. Direct `skein jobs start ... --yes` is a
command-specific operator action; list/output/kill can recover the persisted
lifecycle after the initiating Skein process exits. Worker launch descriptors
are one-time HMAC-bound, subprocesses receive no provider/relay secrets, and
timeout or cancellation targets the spawned process group on POSIX.

The isolated writer lane is disabled by default. Enable it only in user-owned
or explicitly trusted configuration:

```yaml
agents:
  writerEnabled: true
  writerProfile: implementer
  writerReviewerProfile: reviewer
  maxWriterPatchBytes: 60000
  routes:
    implementer:
      runtime: claude
      provider: anthropic
      model: claude-opus-4-8
      timeoutMs: 180000
      costBudgetUsd: 1
```

`writer_run` requires write, Git, and shell approval because it creates a
temporary worktree. It cannot change the active workspace. A reviewed patch is
applied only through `writer_integrate`, which requires its Team Run ID and
SHA-256, rejects HEAD drift or dirty targets, and records a checkpoint rollback
command. An optional Claude CLI writer runs with `acceptEdits` only inside the
same disposable worktree, receives `Read,Glob,Grep,Edit,Write` but no Bash,
Git, network, plugins, hooks, project instructions, or nested agents, and
requires a pre-request USD cap plus a hard timeout. Claude tool names and counts
stream into the Team Cockpit without exposing file content or model reasoning.
Each run combines the stable writable Profile with a dynamic engineering brief
derived from the current objective, scope, constraints, non-goals, verification
requirements, and acceptance criteria; inferred specialty never expands
authority. The Reviewer remains an API route so it receives the complete patch. Team Run
v4 stores the semantic Review Contract, exact patch and Council artifact
hashes, content-addressed evidence receipts, normalized
pass/fail/unknown verdicts, Author/Reviewer independence evidence, criterion
conflicts, and artifact-bound human arbitration. Blind review removes Author
self-report and route identity, while deterministic oracle failures remain
authoritative. Version 1–3 manifests remain inspectable, but old text
`VERDICT: ACCEPT` can never authorize integration. Headless conflicts produce
`needs_review` and exit code 9; a live operator resolves only named criteria
with `skein agents arbitrate`. Model review never grants the human approval
required by `writer_integrate`, Git push, npm publish, deployments, migrations,
destructive commands, or external mutations. See
[docs/MULTI_MODEL_TEAMS.md](docs/MULTI_MODEL_TEAMS.md) for the full trust and
lifecycle contract.

`provider: compatible` must be paired with `model.baseUrl` (or the
`--base-url` flag). Additional roots declared in project config are constrained
to the project directory; use `--add-workspace` for an intentionally external
root.

## Local retrieval

Skein indexes supported source files into the project-local `.skein/index.json`
namespace. The index combines BM25 term scoring with path, symbol, phrase, and
CJK token signals, then repacks verified spans under the configured token cap.
`skein index` is explicit and repeatable; `search`, `context`, and the agent
automatically load the local index and never start an external process.

Interactive startup additionally runs an explicit preparation gate: it checks
manifest freshness, performs an incremental build only when needed, reloads the
on-disk index, and verifies its generation and counts before the TUI accepts a
request. This is real progress rather than a decorative loading animation.

Index entries are constrained to configured workspace roots. Before a result is
packed into a prompt, Skein rechecks the current file and rejects entries that
are stale, moved, symlinked, binary, or outside the workspace. Retrieval is
evidence only: the model must still confirm factual claims with read or other
workspace tools.

When a Skein tool reports changed files, the runner immediately invalidates and
atomically refreshes only those local-index paths before the next model turn;
headless and TUI runs share this boundary. External edits are reconciled from
file set, size, mtime, and ctime before retrieval, so even a same-size update
whose mtime was restored cannot turn a stale zero-hit result into evidence.
Repeated identical empty or unchanged `search_code` calls open the existing
recovery circuit instead of spending additional turns without new evidence.

Retrieval budgets are adaptive and treat `context.maxTokens` as a ceiling:
focused requests start at 2k estimated tokens, ordinary implementation/debug
work at 4k, cross-module work at 8k, and only explicit exhaustive repository
work can use 12k. The context receipt reports the chosen tier, reason, candidate
and selected hit counts, overlap drops, and evidence above the focused base.

To measure a local index change, run the reproducible benchmark with an explicit
query-to-relevant-file manifest:

```bash
npm run benchmark:context -- \
  --workspace test/fixtures/context-benchmark \
  --cases test/fixtures/context-benchmark.json \
  --fresh-index
```

It reports Recall@5/10/20, MRR, useful-token ratio, stale-hit rate, and cold,
incremental, and warm-query latency. `context-benchmark-v2` covers TypeScript,
Python, SQL, CJK, Markdown, mixed-language queries, and a TypeScript import
neighbor that has no direct lexical match. Its checked-in thresholds fail the
command instead of allowing a retrieval change to lower the quality bar.

The persisted local index now stores content-addressed TypeScript compiler AST
facts for definitions, calls, and relative imports. Matching definitions can
expand a query and import/call neighbors may receive a bounded graph score;
Python module imports and SQL definitions/references use explicit syntax-aware
offline fallbacks. Git recency is collected through a bounded, isolated
read-only history scan and contributes only a small tie-break score; missing
Git, timeouts, output limits, and non-repository workspaces degrade to
lexical/graph retrieval. A failed configured verification may add a bounded
diagnostic tie-break for paths parsed from non-truncated process output. Those
hints are current-run only, clear on success or the next run, and cannot create
a zero-relevance hit. Search and context JSON expose the index generation, file
hash, matched/expanded terms, and bm25/path/symbol/phrase/graph/recency/
diagnostic breakdown without persisting the query, diagnostic path, or another
copy of source. Index schema v2 artifacts rebuild as v3 rather than being
trusted after the parser contract changes.

The included fixture is a deterministic regression gate, not evidence for
performance on every production repository. `--fresh-index` deletes and
rebuilds that workspace's local index, so use it only where rebuilding the
index is intended.

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
- Project configuration cannot enable LSP servers or durable background jobs
  without the same explicit trust; both remain absent from the tool catalog by
  default.
- Untrusted project configuration cannot switch providers or redirect
  credentials/source code to a remote custom endpoint; these require trust.
- Git aliases, Git config overrides, repository hooks, and workspace overrides
  are disabled by the built-in Git tool; use an explicitly approved shell
  command when a repository workflow genuinely needs them.
- Git operations that may invoke transport, signing, merge, or checkout helpers
  require the `shell` category in addition to Git/write/network as applicable.
  Git executables are resolved outside workspace-controlled
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
  capability-registry.json
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

Memory governance is explicit:

```bash
skein memory privacy --json
skein memory export backup.json --scope workspace
skein memory clear --scope workspace --yes --json
```

`privacy` is content-free, while `export` is intentionally contentful and
writes an owner-only `0600` JSON file when a destination is provided. Export
destinations cannot be symbolic links. `clear` permanently deletes records and
candidates only in the selected `user`, `workspace`, or `all` scope and requires
`--yes` in non-interactive use. The store enables SQLite `secure_delete`,
truncates WAL state, and vacuums after deletion when no competing process keeps
the database busy. These measures reduce remanence but are not encryption:
Skein does not encrypt the SQLite database at rest, so device and backup
protection remain the operator's responsibility.

Add both `.mosaic/` and `.skein/` to `.gitignore` unless the team intentionally
shares a sanitized configuration file elsewhere.

Session JSON also keeps a bounded audit trail of permission decisions, tool
outcomes, changed files, checkpoint ids, and artifact receipts, never artifact
contents. `skein session export` includes the audit trail in the Markdown
export. Oversized result contents live separately under the active project
namespace's `tool-artifacts/` directory and are governed by session deletion,
expiry, per-item size, total-storage, and integrity checks.

## Development

```bash
npm run dev -- "explain this project"
npm run typecheck
npm test
npm run build
npm run check
npm run test:pty
npm run benchmark:terminal-ui
npm run release:verify
```

The PTY suite exercises 20/24/40/80/120 columns, a 40×10 viewport,
`TERM=dumb`, ASCII/`NO_COLOR`, and screen-reader interaction. It replays raw
output in a headless terminal and checks the final visible frame for overflow,
stale panels, control-sequence leaks, and missing ready/permission/error state.
`benchmark:terminal-ui` is a local single-process regression gate with p95
budgets of 25 ms for input processing and 150 ms for streaming renders; it is
not a universal hardware performance claim.

Skein is licensed under MIT.
