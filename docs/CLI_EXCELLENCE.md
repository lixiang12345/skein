# CLI Excellence Backlog

Research-grounded gap analysis against clig.dev (Command Line Interface
Guidelines) and the 2026 top terminal coding agents (Claude Code, Codex CLI,
Gemini CLI, opencode). This is the working backlog for the "top-tier CLI"
initiative. Progress is mirrored to the authorized Notion project tracker.

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

## Current backlog

### P1 — next slice

1. **Homebrew distribution.** The guarded curl installer is shipped. A
   `homebrew-skein` tap still needs a dedicated repository and a release flow
   that reuses the exact verified npm artifact rather than rebuilding source.

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
- README/website quickstart parity and generated `man/skein.1` from Commander
  help metadata.

### Current repository (2026-07-27)

- Bash, zsh, and fish completion now derive visible commands, aliases,
  recursive subcommands, options, and descriptions directly from Commander's
  command graph; a regression prevents the completion catalog from drifting.

## Tracking

- Local: session task list (this repo's working loop).
- Notion: [skein-cli 一款智能编码CLI](https://app.notion.com/p/cf684ae61fd1428ea044d5d6636ed447)
  is the authorized project tracker; implementation tasks and verification
  evidence are updated there at each milestone.
