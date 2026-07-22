# Skein Next Steps

This document is the handoff point for the next development conversation. It
describes the current shipped baseline and the smallest high-value sequence of
work that should follow it. Do not redo the baseline hardening before taking on
one of the milestones below.

## Current Baseline

- Product name: `Skein`; primary executable: `skein`.
- Compatibility executables: `mosaic` and `mosaic-code`.
- Current release: `0.2.0`.
- Runtime requirement: Node.js `>=22.16.0` (the runtime uses unflagged
  `node:sqlite` with FTS5, and current CLI/build dependencies require this
  Node 22 baseline).
- Retrieval: local BM25/path/symbol index with automatic ContextEngine-plugin
  detection and fallback.
- Agent: provider-agnostic multi-turn runner for OpenAI, Anthropic, Gemini, and
  OpenAI-compatible endpoints; built-in tools, permissions, checkpoints,
  workflows, Skills, MCP, expert profiles, sessions, and memory are present.
- UI: real Ink/React terminal UI, not a browser prototype. It supports prompt
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
npm pack
```

The last verified package was `skein-code-cli-0.2.0.tgz`. Its SHA-256 was:

```text
12386f9fffa9d859fb81aab91468686c308557b51daf07a44f4294008e7c62d5
```

The final verification included a fresh install and real PTY interaction for
all three executable aliases, `/about`, a permission prompt, denial, and clean
Ctrl+C exit. PTY coverage included 20, 24 ASCII, 40, 80, 120 columns and a
40x10 short-height case. The current suite contains 27 test files and 167 tests.

## Recommended Order

### P0: Continuous Integration And Release Reproducibility (Branch Rule Pending)

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
- Configure the `main` branch rule to require the `check` status after the
  workflow is present on GitHub.

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
  idempotent. The next increment should add an explicit verified rollback
  command and home-directory migration coverage.

### P1: ContextEngine-Plugin Production Adapter

Exercise the adapter against a real ContextEngine-plugin fixture, not only the
local fallback. Cover capability negotiation, index progress, search/context
packing, unavailable PostgreSQL/pgvector, stale indexes, multi-root workspaces,
and a useful degraded-mode explanation in the TUI and headless output.

Definition of done:

- `auto` selects the external engine only when its health contract is valid.
- A failed external query falls back without losing the user request.
- Results preserve source paths, symbols, line ranges, scores, and token caps.
- An integration fixture runs in CI without requiring a developer database.

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
- Team budgets default to `observe`: telemetry is retained, but configured
  thresholds do not warn or terminate work. `guard` adds non-blocking threshold
  warnings, while `strict` is an explicit hard-stop policy for controlled jobs.
- Task budget policy is separate from the provider context window and Skein's
  session compaction boundary. The latter remains a technical context limit,
  not a default product ceiling for large tasks.
- See `docs/MULTI_MODEL_TEAMS.md`. Writer worktrees, persistent blackboard
  artifacts, cost controls, Gemini CLI, and optional tmux/iTerm pane hosts remain
  next.

### P2: MCP, Skills, And Workflow Trust UX

Add a first-run catalog and inspection flow for bundled capabilities. Keep
installation explicit and reviewable: show source, requested tools, filesystem
scope, network scope, and trust state before activation. Add fixture servers and
Skills that exercise timeout, malformed schema, disconnect, and version drift.

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
- `src/context/context-engine.ts` — external/local retrieval selection.
- `src/context/local-index.ts` — offline fallback index.
- `src/mcp/manager.ts` — MCP lifecycle and tool registration.
- `src/skills/catalog.ts` — Skills discovery and activation.
- `src/memory/store.ts` and `src/tools/working-memory.ts` — durable and
  short-term memory layers.
- `src/tools/permissions.ts` — policy evaluation and scoped approvals.
- `test/ui-tui-integration.test.tsx`, `test/ui-safety.test.tsx`, and
  `test/pty/` — current interaction and terminal regression coverage.

## Suggested Next Conversation Opening

Start with: “Implement P0 CI and release reproducibility from
`docs/NEXT_STEPS.md`; preserve the current 0.2.0 behavior and add tests before
changing runtime behavior.” Then inspect the clean repository state and remote
workflow permissions before creating any release automation.
