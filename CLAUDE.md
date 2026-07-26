# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Skein (`@skein-code/cli`) is a context-first, model-agnostic terminal coding agent written in TypeScript/ESM (Node.js >= 22.16). Entry point: `src/cli.tsx`. Binaries `skein`, `mosaic`, and `mosaic-code` all point to `dist/cli.js`. `AGENTS.md` contains the canonical repository guidelines; `docs/ARCHITECTURE.md` and `docs/MULTI_MODEL_TEAMS.md` describe the runtime and trust model in depth.

## Commands

```bash
npm ci                      # install (Node 22.16+ required)
npm run dev -- "prompt"     # run the CLI from source via tsx
npm run typecheck           # strict tsc, no emit
npm test                    # vitest run (all tests)
npm run test:watch          # vitest watch mode
npx vitest run test/core/context.test.ts        # single test file
npx vitest run -t "name substring"              # single test by name
npm run build               # tsup bundle into dist/
npm run check               # typecheck + tests + website check + build + dist smoke test
npm run test:pty            # real-terminal regressions (builds first; requires `expect`)
npm run release:verify      # full check + package verification (pre-release)
```

Benchmarks with checked-in quality gates (fail on regression): `npm run benchmark:context`, `benchmark:duplication`, `benchmark:token-economy`, `benchmark:terminal-ui`.

Run `npm run check` before a PR; UI/input changes should also pass `npm run test:pty`.

## Architecture

Layered pipeline (see `docs/ARCHITECTURE.md`):

1. **CLI / TUI** (`src/cli/`, `src/ui/`, `src/cli.tsx`) — Ink/React interactive workspace plus headless modes (`--print`, `--output-format json|stream-json`). Headless terminal records follow `docs/headless-output.schema.json` with a stable exit-code contract (0 verified … 9 needs_review).
2. **Agent runner** (`src/agent/runner.ts` and siblings) — the turn loop: resolve `@path` mentions → retrieve context under an adaptive token budget → Intent Sufficiency gate (may persist one `needs_input` clarification) → model call → permission-checked tool execution with pre-mutation checkpoints → verification → persist. Key gates live beside it: `completion-gate.ts` (evidence-gated completion: only current successful test/typecheck/lint/build/`git diff --check` tool results yield `verified`; model prose never does), `reuse-gate.ts` + `duplication-audit.ts` (TS/JS clone detection; Type-1/2 matches block completion), `task-contract.ts`, `intent-sufficiency.ts`, `writer-lane.ts` (isolated writer + Team Run review), `capability-*.ts` (shadow-only capability routing registry).
3. **Context fabric** (`src/context/`) — local BM25/path/symbol/phrase/graph index persisted at `<workspace>/.skein/index.json` (legacy `.mosaic/`). No external retrieval service. Changed files from tool runs invalidate and refresh only affected index paths before the next model turn.
4. **Trust layer** — independent `read`/`write`/`shell`/`git`/`network` permission categories, workspace-root path enforcement (lexical + symlink), command allow/deny rules, hooks, checkpoints (`src/checkpoint/`), and audit events. Project-local `.mosaic/config.*` is **untrusted by default**: hooks, verification commands, permission policy, provider/endpoint overrides, LSP, and background jobs require explicit `--trust-project-config`.
5. **Providers** (`src/providers/`) — relay-only transports: OpenAI Responses (default), OpenAI Chat Completions, Anthropic Messages. Protocol is always explicit, never inferred from URLs. Credentials are referenced by environment-variable name only and never stored.

Other subsystems: `src/session/` (durable resumable sessions, epoch vs. lifetime token budgets, forking), `src/memory/` (layered working memory / compaction / SQLite FTS5 durable memory with human-approved candidates), `src/mcp/` (lazy fingerprint-trusted MCP activation), `src/skills/`, `src/workflows/`, `src/tools/`. Shared types in `src/types.ts`; cross-cutting helpers in `src/utils/`.

Tests: `test/core/` for subsystem tests, `test/*.test.ts(x)` for UI behavior, `test/pty/` for headless-terminal-emulator regressions, `test/fixtures/` for benchmark manifests. Add regressions beside the affected subsystem; no coverage threshold, but cover failure, cancellation, and security boundaries when applicable. `prototype/` is visual exploration only, not production UI. `website/` is verified by `npm run website:check`.

## Style

- Two-space indentation, single quotes, semicolons; no formatter or linter is configured — match adjacent code.
- `camelCase` functions, `PascalCase` classes/types/components, kebab-case filenames (`model-route.ts`).
- ESM with `NodeNext`: local imports must include the emitted `.js` extension.
- Strict typing; avoid `any` and unchecked casts.
- Conventional Commit subjects: `feat(ui): ...`, `fix(cli): ...`, `chore(release): ...`.
- PRs should explain the outcome, trust implications, and verification performed; include terminal captures for TUI changes and migration notes for storage/configuration changes.

## Invariants to preserve

- Completion status (`verified`/`unverified`/`verification_failed`) comes only from deterministic tool evidence recorded after the last mutation — never from model text.
- Receipts, registries, and telemetry are content-free: hashes, counts, and bounded aggregates only; no prompt text, source content, command arguments, or credential values.
- Live human approval gates (writer integration, background job start/kill, git push, publish, destructive commands) cannot be replaced by `--yes`, config allow rules, or model review.
- Untrusted project config must not gain execution or credential-redirection ability.

## Releases

Every successful push to the remote must be followed by a verified npm release of the same source state: bump the version, update `skein.releaseNotes` in `package.json`, run `npm run release:verify`, push the matching `v*` tag, publish `@skein-code/cli` with public access, and confirm the npm dist-tag resolves before handoff. Never report a release complete after only a Git push.

## Security

Never commit API keys, `.env`, `.mosaic/`, or `.skein/` state. Credentials stay in environment variables referenced by name.
