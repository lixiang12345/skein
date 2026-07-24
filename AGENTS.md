# Repository Guidelines

## Project Structure & Module Organization

Skein is a TypeScript/ESM terminal coding agent with its entry point at `src/cli.tsx`. Runtime features are grouped under `src/`, including `agent/`, `context/`, `providers/`, `tools/`, `ui/`, `session/`, `memory/`, and `mcp/`. Keep shared types in `src/types.ts` and cross-cutting helpers in `src/utils/`.

Tests live in `test/core/`, at `test/*.test.ts(x)` for UI behavior, and in `test/pty/` for real-terminal regressions. Architecture belongs in `docs/`; `prototype/` contains visual explorations, not production UI. Examples live in `examples/`.

## Build, Test, and Development Commands

- `npm ci`: install locked dependencies; Node.js 22.16+ is required.
- `npm run dev -- "prompt"`: run the CLI from source with `tsx`.
- `npm run typecheck`: run strict TypeScript checks without emitting files.
- `npm test`: execute Vitest once; use `npm run test:watch` while iterating.
- `npm run build`: bundle the ESM CLI into `dist/` with tsup.
- `npm run check`: run typecheck, tests, build, and distribution smoke test.
- `npm run test:pty`: build and run terminal-size/input regressions; requires `expect`.

## Coding Style & Naming Conventions

Follow existing TypeScript style: two-space indentation, single quotes, semicolons, and compact object literals where readable. Use `camelCase` for functions, `PascalCase` for classes/types/components, and kebab-case filenames such as `model-route.ts`. With `NodeNext`, local imports include the emitted `.js` extension. Preserve strict typing and avoid `any` or unchecked casts. No formatter or linter is configured; match adjacent code.

## Testing Guidelines

Use Vitest with `describe`, `it`, and `expect`. Name tests `*.test.ts` or `*.test.tsx` and add regressions beside the affected subsystem. There is no numeric threshold; cover failure, cancellation, and security boundaries when applicable. Run `npm run check` before a PR; UI/input changes should also run `npm run test:pty`.

## Commit & Pull Request Guidelines

History follows Conventional Commit-style subjects: `feat(ui): ...`, `fix(cli): ...`, `docs: ...`, and `chore(release): ...`. Keep commits focused and summaries specific. PRs should explain the outcome, trust implications, and verification performed. Link issues; include terminal captures for TUI changes and migration notes for storage/configuration changes. CI must pass on Linux and macOS.

## Security & Configuration Tips

Never commit API keys, `.env`, `.mosaic/`, or `.skein/` state. Prefer environment-variable references for credentials. Treat repository configuration as untrusted executable input; use `--trust-project-config` only after reviewing hooks, endpoints, permissions, and verification commands.
