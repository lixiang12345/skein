# CLI Excellence Backlog

Research-grounded gap analysis against clig.dev (Command Line Interface
Guidelines) and the 2026 top terminal coding agents (Claude Code, Codex CLI,
Gemini CLI, opencode). This is the working backlog for the "top-tier CLI"
initiative; it is mirrored to the Notion tracker once the Notion connection is
authorized.

## Verified strengths (do not regress)

Skein already satisfies most clig.dev requirements; these were verified against
the current build, not assumed:

- `--version`, `--help`, `-h`, and per-subcommand help via commander.
- Mistyped flags and subcommands get "did you mean" suggestions
  (`showSuggestionAfterError`).
- Machine output: `--output-format json|stream-json` with a published headless
  schema (`docs/headless-output.schema.json`) and a stable exit-code contract.
- Respects `NO_COLOR`, `--no-color`, `TERM=dumb`, screen readers, and reduced
  motion.
- Reads piped stdin as prompt input; non-TTY implies print mode.
- Shell completion for bash/zsh/fish; `doctor`, `update`, `status` commands.
- Durable sessions with `--resume`/`--continue`, pre-mutation checkpoints,
  independent permission categories, and untrusted-by-default project config.

## Shipped in this initiative

- **Help ends with examples and pointers** (clig.dev: "Provide examples").
  Root `--help` now shows six common invocations plus Website/Docs/Issues
  links sourced from `src/brand.ts`. Regression: `test/core/help-output.test.ts`.
- **npm metadata**: `homepage`, `repository`, and `bugs` in `package.json` so
  the npm page, `npm repo`, and `npm bugs` resolve like a first-class CLI.

## Prioritized backlog

### P1 — next slices

1. **Mistyped-command guard.** `skein sessoin` is parsed as an agent prompt and
   spends a model call instead of hinting `session`. When a print-mode prompt
   is a single token within edit distance ≤2 of a known subcommand, print a
   stderr hint (and in interactive mode, surface the hint before the first
   turn). Never block — free text is a legitimate prompt.
2. **Distribution beyond npm.** Top agents ship a curl installer and Homebrew
   formula. Add `scripts/install.sh` (checksums, version pinning) and a
   `homebrew-skein` tap formula fed by the release flow; document both on the
   website and README.
3. **Grouped command help.** With ~20 subcommands, group the root help like
   `gh` (Chat & sessions / Context & index / Trust & ops) if commander's help
   groups support it cleanly; otherwise a curated ordering.
4. **README quickstart parity.** One screenful from install to first verified
   run, matching the website's terminal story; include the headless/CI recipe.

### P2 — later

- Man page generation from commander metadata at release time.

### Also shipped (2026-07-26)

- Mistyped-command guard (`skein sessoin` → stderr hint) with
  Damerau-Levenshtein matching: `src/cli/command-hint.ts`.
- Grouped root help (Getting started / Context & retrieval / Sessions &
  recovery / Agents & extensions) with a no-bare-`Commands:` regression.
- Guarded installer `scripts/install.sh` (+ tests) and README/website curl
  install path; Homebrew tap still pending a new repository.
- Idle composer starter-hint rotation with a stable "Type a request" anchor:
  `src/ui/starter-hints.ts` (PTY 8/8 verified).
- README CI/npm/license badges; `skein feedback` command printing the issues
  URL plus a content-free environment summary.

## Tracking

- Local: session task list (this repo's working loop).
- Notion: official Notion MCP installed at user scope
  (`https://mcp.notion.com/mcp`); pending one-time OAuth via `/mcp`. After
  authorization, create a "Skein CLI Excellence" project page mirroring this
  document and keep status in sync at each milestone.
