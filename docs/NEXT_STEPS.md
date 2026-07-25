# Skein Next Steps

This document is the handoff point for the next development conversation. It
describes the current shipped baseline and the smallest high-value sequence of
work that should follow it. Do not redo the baseline hardening before taking on
one of the milestones below.

## Current Baseline

- Product name: `Skein`; primary executable: `skein`.
- Compatibility executables: `mosaic` and `mosaic-code`.
- Current repository version: `0.3.33`.
- Runtime requirement: Node.js `>=22.16.0` (the runtime uses unflagged
  `node:sqlite` with FTS5, and current CLI/build dependencies require this
  Node 22 baseline).
- Retrieval: local BM25/path/symbol index with visible interactive preparation,
  persisted-content validation, and bounded packing; no retrieval service is
  required.
- Agent: provider-agnostic multi-turn runner for OpenAI, Anthropic, Gemini, and
  OpenAI-compatible endpoints; built-in tools, permissions, checkpoints,
  workflows, Skills, MCP, expert profiles, sessions, and memory are present.
- UI: real Ink/React terminal UI, not a browser prototype. Fresh sessions use
  a compact Skein identity; wide sessions add a grouped factual workspace rail;
  all sizes support prompt
  history, `@file` completion, command completion, multiline editing, queued
  follow-ups, live context inspection, permission approval, themes, ASCII mode,
  `NO_COLOR`, `TERM=dumb`, screen-reader output, reduced motion, and
  narrow-height degradation.
- Storage: sessions, checkpoints, local index, and project configuration still
  use `.mosaic/` paths for compatibility. `SKEIN_*` environment variables are
  preferred, while `MOSAIC_*` aliases remain supported.

## Verified Release Contract

Run these commands from the repository root before changing release behavior:

```bash
npm ci
npm run check
npm run test:pty
npm audit --omit=dev
npm run release:verify -- --output-dir artifacts/package
```

The latest verified package is `skein-code-cli-0.3.33.tgz`. The verifier writes
its SHA-256 to `artifacts/package/skein-code-cli-0.3.33.tgz.sha256`, and CI
retains the checksum beside the package metadata. The checksum is deliberately
not copied into this packaged document because doing so would change the
archive it describes.

The final verification includes a fresh install for all three executable
aliases. PTY coverage includes 20, 24 ASCII/`NO_COLOR`, 40, 80, and 120 columns;
a 40x10 short-height case; 40-column `TERM=dumb`; and 80-column screen-reader
interaction. Raw output is replayed through a headless terminal so the gate
checks the final visible screen rather than only accumulated logs. The current
full-suite count is recorded from the latest `npm run check` in the release
evidence.

## Recommended Order

### P0-C: Local Context Engine v2 foundations (complete in 0.3.21)

Version `0.3.19` moves the persisted local index to schema v3 and records
TypeScript compiler AST definitions, calls, and relative import facts beside
each content hash. Old schema v2 indexes rebuild instead of crossing the parser
contract. Python and SQL remain offline through bounded syntax-aware fallbacks;
this release does not claim equivalent AST coverage for those languages.

Matching definitions expand the lexical query, NodeNext `.js` imports resolve
to indexed TypeScript sources, and import/call neighbors receive a bounded graph
score. A minimum informative-term coverage removes low-value one-word matches,
with a fallback to the original ranked candidates when no sufficiently covered
result exists. Each hit carries generation, SHA-256 content hash, matched and
expanded terms, and a bm25/path/symbol/phrase/graph score breakdown. Query-cache
hits and misses are visible while cache entries remain generation-bound.

The checked-in `context-benchmark-v2` fixture covers eight TypeScript, Python,
SQL, CJK, Markdown, and mixed-language cases across ten files. The first
expanded run failed its preselected useful-token threshold at `0.348`; the
implementation reached `0.729` while Recall@5/10/20 and MRR remained `1.0`,
stale-hit rate stayed `0`, warm p95 was below 10 ms, and incremental indexing
reused every fixture file. Git-recency is now a bounded, isolated tie-break
with exact HEAD-bound cache invalidation and non-Git degradation. Version
`0.3.21` completes the milestone with current-run diagnostics ranking, Python
absolute/relative module adjacency, and explicit diversity-packing coverage.
Diagnostics require real nonzero, non-truncated process output; they expire on
success or a new run, are never persisted, and cannot create a zero-relevance
hit. Python and SQL intentionally retain bounded offline syntax adapters rather
than claiming compiler-equivalent AST coverage.

An isolated full Skein corpus calibration covered 206 files and 2,457 chunks:
cold indexing took 558.826 ms, an unchanged incremental pass reused all 206
files in 54.508 ms, and five representative queries took 77.205–88.359 ms with
the intended module ranked first. This is a reproducible scale calibration for
the repository, not a universal latency claim for every production workspace.

### P0-E: Token Economy measurement and bounded schema disclosure

Version `0.3.18` adds the repository-owned `token-economy-benchmark-v1`
deterministic replay. Its seven retrieval, large-output, CJK, and repeated
zero-hit fixtures compare the legacy ceilings with the adaptive budget and
firewall policies while requiring complete evidence and recovery coverage.
The replay reports a 36.7% estimated-input reduction; this is a deterministic
budget measurement, not a provider billing or task-success claim.

MCP tool definitions use progressive disclosure. Version `0.3.23` exposed a
compact `mcp_activate` catalog instead of connecting every server, then loaded
at most eight request-relevant schemas. Version `0.3.27` adds the preceding
local `mcp_search` and `mcp_inspect` stages plus user-owned fingerprint trust;
`skein mcp status` is now no-connect. Selected schemas remain stable for the
current run, Token Ledger receipts record the deferred count, MCP calls retain
the network boundary, and hidden tool calls remain rejected.

Version `0.3.22` normalizes provider-reported cache and reasoning usage across
streaming and non-streaming OpenAI, Anthropic, and Gemini responses. Token
Ledger receipts, cumulative session usage, and JSON/JSONL events retain cached
input, cache-write input, and reasoning counts when present, including explicit
zero values. The session schema remains compatible with older records. This is
measurement plumbing only: it does not enable provider cache controls, define a
stable cache key, defer MCP connection/discovery, run paid same-model task A/B,
or complete Context Compaction 2.0.

Version `0.3.23` completes the true lazy MCP lifecycle slice: normal chat
startup performs zero MCP transport connections and zero remote discovery until
the model explicitly calls `mcp_activate` for a configured server. The release
does not add per-server trust scopes, provider billing A/B, or Context
Compaction 2.0.

Version `0.3.24` completes the Context Compaction 2.0 engineering slice. Each
handoff rebuilds a deterministic facts envelope from the Task Contract,
working state, changed files, last-run verification, permission and failure
audit, retained artifact handles, and bounded older user corrections. Generated
narrative is fallible and optional; empty or contradictory output cannot erase
the authoritative facts, and the complete transcript remains persisted.
Automatic compaction calls the provider only when three predicted future prompt
reuses yield positive net estimated savings; explicit `/compact` remains a
manual override. Provider-reported or locally estimated compaction usage is
included in session totals and a separate content-free receipt. JSON/JSONL and
the Context Inspector expose the resulting decision without retaining prompt or
source text. Paid same-model task-success A/B remains required before closing
P0-E or making a provider-billing savings claim.

Version `0.3.25` separates one user-visible session into bounded internal
context epochs and a hard lifetime token ceiling. Epoch rotation preserves the
same session id and complete transcript while carrying content-free Contract,
unresolved-failure, changed-file, and verification evidence; an identical
successful tool call clears its recovered failure from future handoffs. The
Intent Sufficiency Gate sends clear requests directly to execution, routes
repository-inferable gaps to inspection, and persists one keyboard-answerable
question only for genuine user-owned product choices. TUI queues pause during
clarification and resume afterward; text, JSON, and JSONL expose the same
`needs_input` state. Real same-model success/token A/B remains an external
validation gate rather than an implied claim of this release.

### Phase 2: First-run, permission, recovery, review, and headless contracts (complete in 0.3.26)

Version `0.3.26` makes the first-run screen explicit that the primary agent
uses API credentials while provider subscription sessions and signed-in coding
CLIs remain separate delegated tools. Permission prompts now show the runtime
policy reason, redacted target, working directory, category risk, and all four
keyboard outcomes without leaking secrets.

The interactive Recovery Center joins last-run status, content-free failure
repair hints, changed files, checkpoints, diff, audit, rollback, bounded retry,
and safe resume. `/review` fixes working-tree, commit, or branch scope, forces
read-only runner capabilities even from Build mode, and injects a redacted
content-free evidence bundle as ephemeral turn instructions rather than user
transcript. Pending clarifications must still be answered directly and cannot
be consumed by a recovery command.

JSON and JSONL terminal records follow `docs/headless-output.schema.json` v1
and carry stable statuses plus exit codes for completed/verified, runtime error,
needs input, unverified, verification failed, blocked, cancelled, max turns,
and token budget. Text and TUI surfaces provide matching actionable stop and
recovery guidance. Responsive list clipping keeps the Recovery Center bounded
in narrow and short terminals.

### P0-D: Repository reuse and calibrated duplication enforcement

Version `0.3.14` added the prompt ladder and pre-write `ReuseReceipt`. Version
`0.3.15` added a post-write deterministic audit for ordinary TS/TSX/JS/JSX/MJS/
CJS functions. The audit captures a content-free baseline before mutation,
normalizes identifiers plus literals, uses exact hashes and 10-token
shingle/winnowing Jaccard matching, and runs before changed-path index refresh.
It audits only new or at least 1.5x-expanded functions; same-function edits,
renames, moves, deletions, small functions, tests, fixtures, generated/vendor/
dist/minified/declaration files, and failed writes stay quiet. Receipts expose
at most eight path/symbol/similarity matches through session, TUI, JSON, and
JSONL without storing source, normalized tokens, prompts, or raw index errors.
Type-3 remains warning-only and unavailable evidence is `unresolved`, never a
false pass. The repository-owned `duplication-benchmark-v1` fixture matrix
calibrated threshold `0.55` at 100% recall, 100% precision, and 0% legitimate
boundary false-positive rate. Unsuppressed Type-1/2 matches now block the
existing completion record; Type-4 semantic equivalence is not promised.

Version `0.3.16` integrated duplication summaries into the single completion
receipt and every output surface while keeping all matches warning-only. Version
`0.3.17` keeps Type-3 warning-only but promotes calibrated Type-1/2 matches to
the completion gate. Active matches receive stable 24-character ids. The read-only
`duplication_audit` tool is disclosed only when unsuppressed matches exist and
can suppress one exact match with a reason code plus a bounded explanation;
wildcard/global suppression, credentials, and code-block reasons are rejected.
Suppression is an audit event, never a verification bypass. A repaired,
deleted, or below-threshold function emits a clear receipt so old warnings do
not persist. Older `0.3.15` receipts without match ids remain readable.

### P0: Continuous Integration And Release Reproducibility

`.github/workflows/ci.yml` now covers Node 22 on macOS and Linux. It runs
typecheck, unit tests, build, smoke, the PTY suite when `expect` is available,
audit, and an isolated `npm pack` install. The release workflow records the
package checksum and verifies all three bin aliases.

Definition of done:

- Pull requests cannot merge with a failing `npm run check`.
- A clean checkout can reproduce the package without local `dist/` or
  `.mosaic/` state.
- CI logs retain the PTY dimensions and package metadata.

Implementation notes:

- `.github/workflows/ci.yml` runs the Node 22 contract on Linux and macOS and
  exposes a stable `check` status for branch protection.
- `.github/workflows/release.yml` rebuilds tagged or manually dispatched
  packages, verifies tag/version agreement, and retains the tarball plus its
  SHA-256 checksum.
- `npm run release:verify` reproduces the package from source, installs it into
  an isolated prefix, rejects packaged local state, and exercises `skein`,
  `mosaic`, and `mosaic-code`.
- The `main` branch rule requires the strict `check` status. Version 0.3.13
  retains v0.3.12's privacy-safe per-request token ledger and adaptive budgets,
  then adds targeted known-change index refresh, ctime freshness reconciliation,
  and bounded no-progress search recovery. Session telemetry stores counts,
  tool names, selection decisions, and hashes, never prompt, source, schema,
  argument, or tool-result content.
  Its tag, GitHub verification, and npm publication use the same source commit.

### P1: Skein Storage Namespace And Migration

The product is branded Skein but durable paths are still named `.mosaic`.
Design a backward-compatible migration rather than renaming blindly:

1. Define the canonical future paths (`.skein/` and `SKEIN_HOME`).
2. Detect existing `.mosaic` state and show the source and destination before
   copying.
3. Migrate config, sessions, checkpoints, indexes, themes, and memory metadata
   atomically with a manifest and rollback path.
4. Continue reading old `MOSAIC_*` variables and old paths for at least one
   compatibility release.

Definition of done:

- Migration is idempotent and tested against interrupted copies.
- No session, checkpoint, or memory record is lost.
- `skein doctor` reports the active namespace and migration status.

Implementation progress:

- `src/utils/namespace.ts` now resolves canonical `.skein` and legacy `.mosaic`
  project namespaces, with `SKEIN_HOME`/`MOSAIC_HOME` compatibility.
- `skein doctor --json` includes a hash-bearing read-only migration manifest;
  `skein migrate` previews it and `skein migrate --yes` performs an atomic
  temporary-directory copy while retaining `.mosaic` as the rollback source.
- Sessions, checkpoints, local indexes, memory, themes, Skills, rules, and
  agent profiles follow the active namespace. Both namespace names are ignored
  by retrieval and file tools.
- Conflict and symlink entries block migration; repeated migration is
  idempotent.
- `skein migrate --rollback` now performs a read-only verification preview;
  `--rollback --yes` atomically moves the canonical namespace aside, verifies
  it again, and removes it only when the legacy source, canonical files, and
  migration manifest still match. Changed, missing, extra, partial, symlink,
  and non-directory state blocks rollback.
- `skein migrate --home` applies the same preview, migration, and rollback
  contract to user-level state. `skein doctor` reports project and user
  namespace status independently.
- `skein migrate --recover` detects interrupted `.migrating-*` and
  `.rollback-*` directories. It resumes or restores a single complete verified
  snapshot, removes only partial data proven redundant with legacy state, and
  blocks changed or ambiguous candidates. Recovery is preview-only until
  `--yes`; `--home` covers user-level state and `doctor` surfaces pending
  recovery. Normal CLI lifecycles and managed session, checkpoint, team-run,
  index, project-config, and default memory writes hold shared cross-process
  leases; migration, rollback, and recovery require an exclusive lease. SQLite
  rollback-journal locks permit concurrent shared holders and are released by
  the operating system immediately after a crash. Cached legacy store paths are
  rejected after migration, and real child-process tests cover contention and
  `SIGKILL` cleanup. Overlapping custom source/destination paths are rejected
  before copying.
- The `.mosaic` compatibility window is now an explicit, versioned lifecycle:
  `legacyCompatibilityStatus()` reports the phase (`active` in 0.2.0,
  `deprecated` in 0.3.0, `pending-removal` in 0.4.0, `removed` in 0.5.0),
  whether legacy paths and `MOSAIC_*` variables are still in use, and the
  concrete paths involved. `skein doctor` surfaces this as `legacyCompatibility`
  so users see the removal timeline before aliases disappear.

### P0-C: Local Context Engine Reliability And Benchmarking

Keep retrieval local and measurable as the repository grows. Content hashes,
generation-keyed query caching, overlap-aware packing, adaptive budgets,
targeted known-change refresh, TypeScript AST facts, import adjacency, score
provenance, and the expanded multilingual benchmark are now implemented.

Definition of done:

- Editing a file without changing its size cannot leave a stale hit in a prompt.
- New, deleted, renamed, binary, symlinked, and out-of-root files are covered by
  regression tests.
- A benchmark reports Recall@5/10/20, MRR, stale-hit rate, useful-token ratio,
  and cold/incremental/warm latency for curated multilingual queries.
- `npm run check` and `npm run test:pty` pass without a service or downloaded
  model.

Implementation progress:

- The public `pack/search/index/status` boundary is now a pure local façade.
- Legacy external configuration is stripped at the config schema boundary and
  no external executable or database is probed by the CLI.
- Tool-reported creates, updates, and deletes refresh only affected paths and
  atomically persist before the next turn in TUI or headless mode.
- Size/mtime/ctime reconciliation closes the direct-new-query zero-hit window;
  repeated empty or unchanged searches stop through the recovery circuit.
- The v2 fixture is an enforced regression test, including a graph-only import
  neighbor and a no-stale-hit gate. Git recency, current-run diagnostics,
  Python module adjacency, diversity packing, and repository-scale calibration
  complete the P0-C acceptance scope in `0.3.21`.

### P1: Multi-Agent Scheduler And Team UX

Harden the existing expert delegation into an explicit observable scheduler:

- opt-in per-agent token, tool, and time policies;
- cancellation and timeout propagation;
- permission inheritance and independent audit trails;
- deterministic aggregation and conflict reporting;
- visible active-agent, queued-agent, and failed-agent states in the TUI;
- no concurrent mutation of the same session or workspace without a checkpoint
  boundary.

Definition of done:

- Two read-only experts can run concurrently and aggregate deterministically.
- Mutating work is serialized or isolated and always remains reversible.
- Interrupting the parent reliably stops child work and clears queued work.

Implementation progress:

- `team_run` now routes read-only profiles to independently configured models,
  shares bounded reports with a reviewer, and supports a capped revision loop.
- `/team <objective>` launches the flow from the TUI. Wide terminals render a
  picture-in-picture Team Cockpit; narrow terminals use the normal timeline.
- Project-owned model routes are stripped until config trust is explicit, and
  credentials are referenced by environment-variable name rather than stored.
- Routes may also select installed `codex`, `claude`, or `grok` runtimes. They
  run without a shell in read-only/plan mode and feed normalized reports into
  the same cockpit and reviewer loop.
- Team runs now persist a local manifest plus content-addressed reports and
  peer handoffs. `skein agents runs/show/delete` provides recovery and audit
  access; `agents.persistBoard=false` disables this for privacy-sensitive runs.
- Team Cockpit now renders safe observable telemetry—phase, active tool, token
  usage, tool count, timeout/budget state, and final report—without exposing
  hidden model chain-of-thought.
- `Ctrl+T` and `/workbench` now open an interactive Team Workbench with Agents,
  Tasks, and Messages views, keyboard navigation, selected-agent report
  expansion, run summary, and persistent soft-budget alerts. The focused view
  degrades to the full available width on narrow terminals.
- Running Agents can now receive an explicit stop or retry request from the
  Workbench. A retry creates a new attempt linked by `retryOf`, preserves the
  stopped attempt in telemetry, and feeds only the fresh result into the
  caller's aggregation. Completed attempts remain immutable until the next
  report-inspection increment.
- Named `agents.connections` and `SKEIN_CONNECTION_*` profiles now let the
  primary agent and API routes share one provider, protocol, base URL, default
  model, and typed authentication reference. One complete connection is
  selected automatically; multiple candidates require a TTY choice or
  `--connection` in headless mode. New connections are relay-only and accept
  only `env` or `none`; subscription-backed official CLIs remain isolated
  delegated runtimes rather than primary connections.
- `skein agents connections` and `/connections` expose redacted connection
  status and route counts. Repository-owned connections are stripped until
  project config is trusted, just like direct model routes.
- `skein agents models <connection>` queries the relay's independent
  OpenAI-style `/models` endpoint. A 32-entry process-local cache uses a
  15-minute TTL, ETag revalidation, endpoint/credential fingerprint isolation,
  and hard invalidation on `401`/`403`; it never stores credential values or
  treats stale data as an authentication success.
- Team routing now supports `agents.defaultConnection` and optional
  `agents.defaultModel`. Most users configure one shared gateway once; profile
  routes only contain model or provider overrides when needed. CLI and TUI
  surfaces label inherited versus overridden routes, and unknown defaults fail
  validation before any agent starts.
- `skein agents setup` now provides a guided user-level setup for a shared
  connection and default model, with explicit Responses, Chat Completions, and
  Anthropic Messages transports plus separate inference/model-catalog bases.
  The first-run TUI uses the same relay-only model and stores only credential
  environment-variable names while preserving other user configuration.
- The Responses transport uses `POST /responses`, `store: false`, typed SSE,
  normalized text/function/usage events, and exact output-item replay for
  stateless tool and reasoning continuation. It never retries a failed request
  through a different protocol. Anthropic relay transport accepts SDK-style
  root bases, appends `/v1/messages` when needed, and uses relay bearer auth.
- `skein doctor` reports unsupported `SEKIN_API`/`SKEIN_BASEURL` spellings and
  connection readiness without reading or printing their values. Custom native
  endpoints cannot inherit official provider keys, and external CLI runtimes
  receive a minimal environment allowlist instead of the parent secret set.
- This relay-only connection catalog, Responses transport, independent model
  directory, redacted status, and delegated-runtime isolation slice is complete
  and release-verified in `0.3.30`.
- Team budgets default to `observe`: telemetry is retained, but configured
  thresholds do not warn or terminate work. `guard` adds non-blocking threshold
  warnings, while `strict` is an explicit hard-stop policy for controlled jobs.
- Task budget policy is separate from the provider context window and Skein's
  session compaction boundary. The latter remains a technical context limit,
  not a default product ceiling for large tasks.
- The scheduler now emits `agent_queued` and `agent_cancelled` events so queued,
  running, cancelled, and completed specialists are all observable. A parent
  cancellation or upstream timeout clears queued work and records the reason on
  each cleared agent. The Council Reviewer now emits one strict JSON verdict
  with a bounded `conflicts` array that is surfaced in the returned team
  summary. The TUI Team Cockpit and Workbench render the queued and
  cancelled states with distinct glyphs, colors, and the cancellation reason.
- The first writer lane is implemented behind `agents.writerEnabled=false` by
  default. `writer_run` creates one repo-leased disposable worktree, confines an
  API writer to five path-safe read/write tools, requires an API Reviewer, and
  persists a bounded patch plus lifecycle evidence in Team Run v4.
- `writer_integrate` is the only main-workspace integration path. It gates on
  patch SHA, a structured evidence-backed verdict bound to the current semantic
  Task Contract, base `HEAD`, clean target paths, patch parsing,
  `git apply --check`, and a mandatory checkpoint; failed applies restore the
  checkpoint and conflicts never overwrite user work. Team Run v1/v2 remains
  readable, but legacy text acceptance is not integration authority.
- G1 Evidence Schema is complete in `0.3.31`: every tool-result path receives a
  canonical content-addressed receipt; Council report bundles are persisted per
  round; Reviewer JSON is strict and content-addressed; every required criterion
  needs admissible evidence; deterministic failure, malformed output, stale
  contract/artifact binding, and unknown evidence fail closed. The Workbench,
  text inspection, JSON, and JSONL surface decision and pass/fail/unknown counts.
- Writer regression coverage proves success and rollback, concurrent-lane
  rejection, cancellation cleanup, oversize rejection, SHA and dirty-target
  gates, simulated partial-apply recovery, workspace-profile rejection, v1/v2
  Team Run compatibility, artifact/manifest tampering, Reviewer failure and
  cancellation, Task Contract drift, and deterministic preflight short-circuit.
- G2 Capability Registry/router shadow mode is complete in `0.3.32`:
  privacy-safe route epochs, configured/observed separation, conservative
  Wilson utility, bounded decay,
  hard eligibility gates, fingerprint-bound pinning, and inspect/export/reset
  controls without changing live routing.
- G3 Judge Independence and Human Arbitration is complete in `0.3.33`: Team
  Run v4 blinds Reviewer input, records route/model/gateway correlation,
  reconciles model criteria against authoritative deterministic oracles,
  persists artifact-bound criterion decisions, and exposes headless
  `needs_review` with exit code 9. High-risk integration, release, deployment,
  migration, destructive, and external-mutation actions require live-human
  approval that model review and config cannot replace. Parallel writers and
  external CLI writer mode remain deferred.
- Relay connections remain transport-explicit: Responses is the default,
  Chat Completions and Anthropic Messages are compatibility transports, and
  inference/model-directory bases and auth are independent. Public model
  catalogs can use `modelsAuthHeader: none` without reading or sending the
  inference key.

### P1: MCP capability trust (complete in 0.3.27)

Version `0.3.27` completes local `search → inspect → trust → activate` for MCP.
Redacted manifests cover source, version, tools, permission categories,
network, commands, paths, sensitive fields, background/process-tree effects,
and completion-evidence support. Trust is bound to the exact manifest
fingerprint and workspace; the model cannot grant it. Persistent disable and
revoke unload activated schemas. Optional server failures remain isolated and
only explicitly required servers may block initialization.

Declared permissions are additive to the non-removable network boundary, and
server annotations cannot lower them. A named manifest rejects undeclared
server-injected tools. Text, JSON, and TUI events redact declared sensitive
arguments. External mutations stay completion-unresolved unless Skein's own
checkpoint id, workspace-valid changed files, artifact receipts, and completion
evidence round-trip successfully. Fixed tests cover malformed schemas,
injection, trust invalidation, disable/revoke, required degradation, schema
token savings, and top-tool selection. These are deterministic contract tests,
not a general real-model accuracy claim.

Future extension work may add an optional subprocess sandbox and data-only
bundles that compose Skills, workflows, profiles, and trusted MCP servers. It
must not load arbitrary plugin JavaScript in-process.

### Delivered: bounded long-session continuity and intent sufficiency

- Durable sessions now separate a 250k-token context epoch from a 1m-token
  lifetime ceiling. Epoch handoffs retain Contract, failure, changed-file, and
  verification receipts while preserving the complete transcript and session id.
- The Context inspector and structured session summary expose epoch/lifetime
  state, compaction receipts, and handoff evidence without prompt or source text.
- Complex ambiguous public-API or UI choices pause as `needs_input`; simple
  requests stay zero-question, repository facts route to inspection, and
  permission approval remains independent. A numbered or custom answer resumes
  the same logical run.

### P2: Memory Quality And User Control

Keep SQLite as the default durable engine. Improve the lifecycle around the
already separated short-term working memory and durable records:

- explicit consolidation from a completed session;
- confidence decay, expiry, supersession, and provenance display;
- workspace/user/session scopes with retrieval explanations;
- export, delete-all, and privacy review commands;
- bounded retrieval under the model token budget.

Never promote model-inferred facts directly into durable memory without the
existing candidate/approval path.

### P2: Terminal Accessibility And Visual Regression (complete in 0.3.29)

Version `0.3.29` adds an explicit screen-reader profile, automatic `TERM=dumb`
fallback, semantic Ink roles, reduced motion, and non-incremental low-capability
rendering. The PTY release gate now covers the contracted 20/24/40/80/120-column
matrix, 40x10 height constraint, CJK/emoji component fixtures, ASCII,
`NO_COLOR`, permission/error/ready states, history search, and file completion.
It replays logs through `@xterm/headless` and rejects final-frame wraps, stale
panels, control-probe leaks, joined announcements, or missing status. The
single-process benchmark enforces 25 ms input and 150 ms streaming-render p95
budgets while requiring the last chunk in the final frame. Future expansion may
sample additional widths through 160 and heights through 60 without changing
the shipped gate's factual scope.

### P3: Distribution

After CI and migration stabilize, publish the scoped npm package, document
upgrade/migration behavior, and add platform install options only if they can
reuse the same signed artifact. Keep `mosaic` aliases until a measured
deprecation window is complete.

## Useful Entry Points

- `src/ui/tui.tsx` — interactive state, queueing, height budgeting, and key
  handling.
- `src/ui/components.tsx` — terminal presentation, glyphs, sanitization, and
  responsive panels.
- `src/agent/runner.ts` — model/tool loop, context events, verification, and
  delegation boundaries.
- `src/context/context-engine.ts` — local retrieval façade.
- `src/context/local-index.ts` — persisted local index, scoring, and packing.
- `src/mcp/manager.ts` — MCP lifecycle and tool registration.
- `src/skills/catalog.ts` — Skills discovery and activation.
- `src/memory/store.ts` and `src/tools/working-memory.ts` — durable and
  short-term memory layers.
- `src/tools/permissions.ts` — policy evaluation and scoped approvals.
- `test/ui-tui-integration.test.tsx`, `test/ui-safety.test.tsx`, and
  `test/pty/` — current interaction and terminal regression coverage.

## Suggested Next Conversation Opening

Start with: “Implement P1-G G4 Drift Detection and Evals on top of Team Run v4
and the shadow-only Capability Registry. Add model/endpoint/prompt/tool epochs,
canary-driven degraded/quarantine/recovery state, route replay and judge-bias
fixtures, and Token Ledger linkage. Keep automatic routing shadow-only until
the replay, calibration, degradation, cost, and human-approval gates pass.”
