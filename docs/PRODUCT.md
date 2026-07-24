# Skein product brief

Research snapshot: 2026-07-20

## Positioning

Skein is an open, context-first coding agent for the terminal. It combines a
polished interactive workspace with a scriptable CLI, but keeps model choice,
source code, retrieval, permissions, sessions, and checkpoints under the user's
control.

The product is designed around one promise:

> Understand the change surface before editing, show every consequential action,
> and make the entire run reproducible or reversible.

## What we learned from the market

### Auggie

Auggie establishes the baseline for a modern terminal agent: automatic workspace
indexing, a full-screen interactive mode, print/quiet automation, resumable
sessions, prompt enhancement, tasks, permissions, custom commands, plugins, MCP,
and multiple workspaces.

Sources:

- [Auggie overview](https://docs.augmentcode.com/cli/overview)
- [Auggie CLI reference](https://docs.augmentcode.com/cli/reference)
- [Auggie interactive mode](https://docs.augmentcode.com/cli/interactive)
- [Auggie product page](https://www.augmentcode.com/product/cli)

The opportunity is not a larger flag list. It is a more trustworthy ownership
model: unrestricted local automation, provider portability, visible context,
offline retrieval, inspectable state, and first-class rollback.

### Gemini CLI

Gemini CLI shows that checkpoints and sandboxing are product features rather
than implementation details. Its checkpoint design stores project and
conversation state before edits; its CLI also supports text, JSON, and streaming
JSON output.

Sources:

- [Checkpointing](https://geminicli.com/docs/cli/checkpointing/)
- [Sandboxing](https://geminicli.com/docs/cli/sandbox/)
- [CLI reference](https://geminicli.com/docs/cli/cli-reference/)

## Product principles

1. **Context before tools.** Every task begins with retrieval and explicit file
   mentions are merged into the evidence packet.
2. **Open by default.** Headless automation is a core feature, not an enterprise
   entitlement.
3. **Local by default.** Retrieval is inspectable, offline-capable, and does not
   require a database, daemon, embedding download, or external executable.
4. **Bring your own model.** OpenAI, Anthropic, Gemini, and OpenAI-compatible
   endpoints share one agent contract.
5. **Trust is visible.** Tool intent, permission category, result, changed files,
   token use, and tasks are shown in the terminal and stored in the session.
6. **Risky work is reversible.** A checkpoint is created before mutation and can
   be inspected or restored independently of the project's Git history.
7. **Terminal native.** Interactive use is calm and legible; non-interactive use
   has deterministic text and JSON contracts.

## V1 capability map

| Surface | Capability |
|---|---|
| Context | Local BM25/path/symbol index, visible startup build/validation gate, freshness checks, token packing, multi-root, `@file` mentions |
| Models | OpenAI, Anthropic, Gemini, OpenAI-compatible endpoints |
| Agent | Multi-turn tool loop, task plan, evidence-gated completion, automatic verification, ask-only mode |
| Tools | Read, list, search, write, patch, shell, Git, context search, task updates |
| Trust | Workspace path boundary, allow/ask/deny policy, command rules, hooks, checkpoints |
| Sessions | Local persistence, resume/latest, list/show/delete/export |
| UX | Ink TUI, responsive branded welcome/workspace rail, action timeline, context telemetry, plan rail, inline permission band, interruption |
| Automation | Prompt/stdin input, queue, quiet mode, JSON and JSONL output with verified/unverified status, exit codes |
| Operations | Init, doctor, config, index/search/context/status, checkpoint management |

## Differentiation

Skein is not claiming that an open lexical fallback beats a proprietary
retrieval model on every huge monorepo. Its advantage is the complete ownership
and trust envelope around the agent:

- users can start offline and upgrade retrieval without changing the agent;
- the same run works with four provider families;
- automation, structured output, and stored sessions are available locally;
- checkpoints and permission decisions are part of the core runtime;
- every subsystem is replaceable and auditable TypeScript.

The runtime treats provider usage as a hard session budget. It estimates usage
when a compatible endpoint omits token counters, clamps the provider output
allowance to the remaining budget, and records skipped tool calls rather than
leaving an incomplete assistant/tool message pair.

That makes Skein particularly strong for individual developers, regulated
teams, self-hosted environments, and tooling groups building their own agent
workflows.
