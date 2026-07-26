# Skein Entry UI Research

Reviewed on 2026-07-26 against official documentation, public product
repositories, local terminal captures, and Skein's production `dist/cli.js`.
This is an information-hierarchy study, not a request to copy another product's
visual identity.

## Decision

Skein should open as a coding conversation, not as a workspace dashboard. The
first frame should answer five questions in this order:

1. What product is this?
2. Which repository am I in?
3. Which model/connection and interaction mode are active?
4. Is the workspace ready, degraded, or blocked?
5. What can I type now?

The composer is the primary action. Brand, location, route, mode, and one
truthful readiness line support that action. File/chunk counts, tools, Skills,
MCP, memory, detailed context pressure, and configuration belong in `/status`,
`/context`, or another inspector. A side rail is useful while agents or tasks
are active, but a permanent fresh-session dashboard competes with the composer.

## Competitive Evidence

| Product | Startup and primary focus | Persistent state | Progressive disclosure | Design implication |
| --- | --- | --- | --- | --- |
| Claude Code | A bounded welcome surface establishes brand, model, effort, billing context, and working directory, then gives the prompt the dominant position. | Small mode/effort/footer badges; an optional status line can show context, cost, and Git state. | `/` commands, transcript viewer, task checklist, permission UI, and status line reveal detail on demand. | Brand can be memorable at startup without turning the working surface into a dashboard. |
| Codex CLI | The composer and transcript form the main loop. Follow-ups steer the current turn or queue for the next turn. | Model/reasoning and permission controls stay close to the composer. | Queued messages appear above the composer; transcript, agent threads, theme/model pickers, and approval overlays open when needed. | Put current action and interruption/queue behavior near input; keep diagnostic detail out of the resting frame. |
| Gemini CLI | The official startup image uses a large temporary `GEMINI` wordmark, a few short tips, then timeline and input. | Working directory, sandbox/mode, and compact status remain near the bottom. | Tool results and pickers occupy local regions only when invoked. Themes change rendering without changing the hierarchy. | A launch mark is valuable only if it yields quickly to the conversation. |
| GitHub Copilot CLI | An animated splash/banner creates a GitHub-branded entry moment; `--banner` can replay it. The normal session centers the task timeline and prompt. | Current mode and run state remain visible. | Plan, autopilot, picker, sidebar, and compact timeline surfaces are task-dependent. | Brand memory and task telemetry should be separate layers. |
| Aider | Startup is deliberately plain: model, Git repository, repo-map, help, then a single prompt. | Minimal model/repository announcements. | In-chat commands add/drop files, switch mode/model, inspect tokens, run commands, and undo. | Low cognitive cost is a competitive advantage even without a rich TUI. |

Official evidence:

- Claude Code: [interactive mode](https://code.claude.com/docs/en/interactive-mode),
  [commands](https://code.claude.com/docs/en/commands), and
  [status line](https://code.claude.com/docs/en/statusline).
- Codex CLI: [CLI customization](https://learn.chatgpt.com/docs/cli-customization),
  [developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli),
  and [agent approvals](https://learn.chatgpt.com/docs/agent-approvals-security).
- Gemini CLI: [official repository](https://github.com/google-gemini/gemini-cli)
  and [themes](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/themes.md).
- GitHub Copilot CLI: [official repository](https://github.com/github/copilot-cli)
  and [product overview](https://github.com/features/copilot/cli).
- Aider: [usage](https://aider.chat/docs/usage.html) and
  [in-chat commands](https://aider.chat/docs/usage/commands.html).

## Why Mainstream Coding CLIs Converge

Coding agents are long-running, interruptible conversations. Their resting UI
therefore optimizes for the next decision rather than total observability.

- **Prompt-first lowers time to action.** A user can start work without first
  parsing implementation details about indexing, extensions, or storage.
- **Location and route prevent expensive mistakes.** Repository, model, mode,
  and permission posture materially change what a request will do, so they stay
  visible near input.
- **Progressive disclosure protects attention.** Cost, context, tools, tasks,
  agents, and command catalogs are important only at particular moments.
- **Temporal surfaces explain change.** Tool calls, approvals, errors, and
  agent work appear in the timeline when they happen instead of occupying a
  permanent empty panel.
- **A compact stable footer supports peripheral awareness.** Readiness, mode,
  context pressure, and changed-file state can be checked without competing
  with the transcript.
- **Responsive collapse must preserve decisions, not decoration.** At narrow
  widths, product, mode, readiness, and composer survive before hints, metrics,
  or artwork.

## Skein Production Baseline

The release PTY gate was run against `@skein-code/cli@0.3.40` from
`dist/cli.js`. It exercised full interactions after startup, not static React
fixtures.

| Viewport/profile | Widest emitted segment | Final-frame non-empty rows | Baseline observation |
| --- | ---: | ---: | --- |
| 20×24 Unicode | 20 | 20 | Fits, but workspace preparation consumes most of the terminal before a compact brand/composer frame. |
| 24×24 ASCII + `NO_COLOR` | 23 | 19 | Correct monochrome fallback; status and composer remain usable. |
| 40×24 Unicode | 39 | 13 | Brand, repository, mode, session metadata, composer, and two-line footer fit. |
| 80×24 Unicode | 79 | 9 | Four separate brand/status rows appear above the composer after a separate preparation screen. |
| 120×24 Unicode | 119 | 18 | A 13-row Workspace rail duplicates context, route, mode, tools, Skills, MCP, and memory on the first frame. |
| 40×24 `TERM=dumb` | 39 | 13 | ASCII, monochrome, reduced-motion rendering remains bounded. |
| 80×24 screen reader | 80 | 17 | Non-incremental accessible announcements retain readiness and input semantics. |
| 40×10 Unicode | 40 | 9 | Header is removed, but session banner, composer, readiness, context, and changed files remain. |

The 80-column resting frame currently reads, in essence:

```text
◆ SKEIN · repository · BUILD                         connection/model

  weave  S K E I N
  weave  grounded coding workspace
  ✓ local index verified · model · version
  context runs automatically · @file pins · /help commands · cwd …

──────────────────────────────────────────────────────────────────────────────
› inspect, change, or verify…
  Type a request · @file · /command

● ready · ctx 0% · 0 tokens · 0 changed                 theme · /help
```

At 120 columns, a second 13-row panel repeats several of those facts. The
implementation is technically responsive and accessible; the discomfort comes
from hierarchy and duplication rather than overflow or missing data.

## Problem Priority

1. **P0 — competing first-frame hierarchy.** Header, banner, preparation
   receipt, Workspace rail, composer, and footer all ask for attention.
2. **P0 — duplicated facts.** Brand, repository, route/model, mode, readiness,
   context entry points, and help appear more than once.
3. **P0 — observability before intent.** Tool/Skill/MCP/memory counts occupy a
   permanent rail before the user has started work.
4. **P1 — brand lacks a semantic owner.** The diamond/weave treatment is
   polished but generic and does not explain the Skein name.
5. **P1 — the preparation-to-chat transition feels like two entry pages.** The
   index preparation receipt is valuable evidence, but the fresh chat repeats
   its success in multiple places.

## First-Frame Contract

The implementation phase must satisfy all of the following:

- Render one brand signature, not a header plus a second wordmark.
- Keep repository, active connection/model, mode, and truthful readiness visible
  at 80 columns without repeating them.
- Place the composer within the first eight non-empty rows of a normal fresh
  80×24 chat frame after workspace preparation completes.
- Hide tool, Skill, MCP, memory, file, chunk, and permission details from the
  resting fresh-session frame; preserve them in `/status` and `/context`.
- Use the timeline for errors and degraded states so the reason and remediation
  remain visible.
- At 20–40 columns, preserve product, mode, readiness, input, and error meaning
  before repository, model, hints, metrics, or artwork.
- At 40×10, prioritize composer and actionable state; no multi-line logo.
- Keep `TERM=dumb`, ASCII, `NO_COLOR`, screen-reader, CJK, emoji, keyboard,
  permission, loading, empty, error, degraded, disabled, selected, and busy
  states deterministic.
- Do not change provider, tool, permission, task, context, or completion-evidence
  semantics as part of the layout refactor.

## Animal Brand Direction

The recommended animal is an original **Skein Goose**.

“Skein” can refer both to thread/yarn and to a formation of geese in flight.
That gives the product a native metaphor: context is woven into a useful
thread, while multiple agents coordinate toward one destination. It is more
defensible than selecting an unrelated mascot merely because another coding
tool has one.

The visual system should have three related but distinct assets:

1. A quiet one-cell Unicode terminal mark with an ASCII fallback.
2. A small code-native monochrome silhouette that remains recognizable at
   favicon and npm-avatar sizes.
3. A richer raster illustration for README, npm, release, and social surfaces.

The goose must be original and must not imitate Claude's spark, OpenAI's knot,
Gemini's star, Copilot's robot, or another product's mascot. The terminal mark
must not depend on color, and assistive output should announce “Skein” rather
than trying to verbalize decorative art.

## Verification Evidence

Commands run on the clean `v0.3.40` baseline:

```text
npm run test:pty
npm run benchmark:terminal-ui
```

All eight PTY scenarios passed with no final-frame wrapped rows, stale panels,
color leakage in monochrome modes, or missing accessibility/status evidence.
The local benchmark measured 2.007 ms input p95 against a 25 ms budget and
9.445 ms streaming-render p95 against a 150 ms budget. These measurements are
machine-local regression evidence, not cross-device performance claims.

