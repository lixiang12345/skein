# Skein Next Steps

This document is the handoff point for the next development conversation. It
describes the current shipped baseline and the smallest high-value sequence of
work that should follow it. Do not redo the baseline hardening before taking on
one of the milestones below.

## Current Baseline

- Product name: `Skein`; primary executable: `skein`.
- Compatibility executables: `mosaic` and `mosaic-code`.
- Current repository version: `0.3.8`.
- Runtime requirement: Node.js `>=22.16.0` (the runtime uses unflagged
  `node:sqlite` with FTS5, and current CLI/build dependencies require this
  Node 22 baseline).
- Retrieval: local BM25/path/symbol index with visible interactive preparation,
  persisted-content validation, and bounded packing; no retrieval service is
  required.
- Agent: provider-agnostic multi-turn runner for OpenAI, Anthropic, Gemini, and
  OpenAI-compatible endpoints; built-in tools, permissions, checkpoints,
  workflows, Skills, MCP, expert profiles, sessions, and memory are present.
- UI: real Ink/React terminal UI, not a browser prototype. Fresh wide sessions
  include a factual workspace rail; all sizes support prompt
  history, `@file` completion, command completion, multiline editing, queued
  follow-ups, live context inspection, permission approval, themes, ASCII mode,
  `NO_COLOR`, and narrow-height degradation.
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

The latest verified package is `skein-code-cli-0.3.8.tgz`. The verifier writes
its SHA-256 to `artifacts/package/skein-code-cli-0.3.8.tgz.sha256`, and CI
retains the checksum beside the package metadata. The checksum is deliberately
not copied into this packaged document because doing so would change the
archive it describes.

The final verification included a fresh install and real PTY interaction for
all three executable aliases, `/about`, a permission prompt, denial, and clean
Ctrl+C exit. PTY coverage included 20, 24 ASCII, 40, 80, 120 columns and a
40x10 short-height case. The current 37-file test suite passes the full check.

## Recommended Order

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
- The `main` branch rule requires the strict `check` status. Version 0.3.8 adds
  the startup context-readiness gate, branded wide welcome rail, runtime
  completion evidence, and conservative dynamic-shell mutation tracking. Its
  tag, GitHub verification, and npm publication use the same source commit.

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

### P1: Local Context Engine Reliability And Benchmarking

Keep retrieval local and measurable as the repository grows. The next slice
should add content hashes to index entries, a small generation-keyed query cache,
overlap-aware packing, and language adapters for common declaration styles.

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
- Remaining work is content-hash freshness, cache invalidation, structured
  chunking, and the reproducible benchmark.

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
- Named `agents.connections` now let API routes share one provider, base URL,
  and credential environment-variable reference. This supports the common
  relay/gateway case where one key grants access to many model families while
  keeping subscription-backed official CLIs on their own login path.
- `skein agents connections` and `/connections` expose redacted connection
  status and route counts. Repository-owned connections are stripped until
  project config is trusted, just like direct model routes.
- `skein agents models <connection>` can query a compatible/OpenAI connection's
  standard `/models` endpoint, giving users model IDs without trial-and-error
  configuration. The command is read-only and does not persist the catalog.
- Team routing now supports `agents.defaultConnection` and optional
  `agents.defaultModel`. Most users configure one shared gateway once; profile
  routes only contain model or provider overrides when needed. CLI and TUI
  surfaces label inherited versus overridden routes, and unknown defaults fail
  validation before any agent starts.
- `skein agents setup` now provides a guided user-level setup for a shared
  connection and default model, with a non-interactive provisioning form. The
  wizard stores only credential environment-variable names and preserves other
  user configuration.
- Team budgets default to `observe`: telemetry is retained, but configured
  thresholds do not warn or terminate work. `guard` adds non-blocking threshold
  warnings, while `strict` is an explicit hard-stop policy for controlled jobs.
- Task budget policy is separate from the provider context window and Skein's
  session compaction boundary. The latter remains a technical context limit,
  not a default product ceiling for large tasks.
- The scheduler now emits `agent_queued` and `agent_cancelled` events so queued,
  running, cancelled, and completed specialists are all observable. A parent
  cancellation or upstream timeout clears queued work and records the reason on
  each cleared agent. The council reviewer emits a required `CONFLICTS` field
  that is parsed into a structured conflict report and surfaced in the returned
  team summary. The TUI Team Cockpit and Workbench render the queued and
  cancelled states with distinct glyphs, colors, and the cancellation reason.
- The first writer lane is implemented behind `agents.writerEnabled=false` by
  default. `writer_run` creates one repo-leased disposable worktree, confines an
  API writer to five path-safe read/write tools, requires an API Reviewer, and
  persists a bounded patch plus lifecycle evidence in Team Run v2.
- `writer_integrate` is the only main-workspace integration path. It gates on
  patch SHA, accepted review, base `HEAD`, clean target paths, patch parsing,
  `git apply --check`, and a mandatory checkpoint; failed applies restore the
  checkpoint and conflicts never overwrite user work.
- Writer regression coverage proves success and rollback, concurrent-lane
  rejection, cancellation cleanup, oversize rejection, SHA and dirty-target
  gates, simulated partial-apply recovery, workspace-profile rejection, and v1
  Team Run compatibility. Parallel writers, external CLI writer mode, cost
  controls, Gemini CLI, and optional tmux/iTerm pane hosts remain next.

### P2: MCP, Skills, And Workflow Trust UX

Add a first-run catalog and inspection flow for bundled capabilities. Keep
installation explicit and reviewable: show source, requested tools, filesystem
scope, network scope, and trust state before activation. Add fixture servers and
Skills that exercise timeout, malformed schema, disconnect, and version drift.
Introduce lazy MCP schema discovery and declarative capability manifests before
any marketplace. Do not load arbitrary plugin JavaScript in-process; package
reusable extensions as data-only Skills/workflows plus explicitly trusted MCP
servers, with an optional subprocess sandbox for stdio servers.

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

### P2: Terminal Accessibility And Visual Regression

Keep the current restrained graphite/cinder/mono theme system and add actual
final-frame regression tests for widths 20-160 and heights 8-60. Include CJK,
wide emoji, screen-reader mode, `TERM=dumb`, `NO_COLOR`, ASCII glyph mode,
permission panels, multiline composer, history search, and active palettes.
Use a terminal emulator fixture where raw ANSI logs cannot prove what remains
visible in the final frame.

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

Start with: “Audit the opt-in P1 writer lane against its Team Run v2 evidence,
then decide whether the next increment should add external CLI writers or
dependency-aware parallel worktrees. Keep active-workspace integration explicit
and preserve SHA, review, clean-target, checkpoint, and rollback gates.”
