# Architecture

```text
┌──────────────────────────────────────────────────────────────┐
│                    CLI / interactive TUI                     │
│ prompt · stdin · JSONL · permissions · sessions · telemetry │
└─────────────────────────────┬────────────────────────────────┘
                              │
┌─────────────────────────────▼────────────────────────────────┐
│                        Agent runner                          │
│ stable rules → dynamic context → model → tools → verify     │
│                  → persist / summarize                       │
└──────────────┬──────────────────────┬────────────────────────┘
               │                      │
┌──────────────▼─────────────┐  ┌─────▼────────────────────────┐
│       Context fabric       │  │         Trust layer          │
│ local BM25/path/symbol     │  │ workspace boundary           │
│ language-aware chunks      │  │ allow / ask / deny           │
│ @file resolver             │  │ command policy · hooks       │
│ token-budgeted packer      │  │ checkpoints · audit events   │
└──────────────┬─────────────┘  └─────┬────────────────────────┘
               │                      │
┌──────────────▼──────────────────────▼────────────────────────┐
│                       Capability tools                       │
│ read · list · search · write · patch · shell · git · tasks  │
└─────────────────────────────┬────────────────────────────────┘
                              │
┌─────────────────────────────▼────────────────────────────────┐
│                        Model gateway                         │
│       OpenAI · Anthropic · Gemini · compatible HTTP         │
└──────────────────────────────────────────────────────────────┘
```

## Agent turn

1. Resolve `@path` mentions inside configured workspace roots.
2. Ask the local context engine for task-relevant spans under the configured
   token budget.
3. Combine product rules, project rules, retrieved spans, mentions, current plan,
   and conversation history.
4. Call the model with the tools allowed by the current mode.
5. Evaluate every requested tool against workspace and permission policy.
6. Create a checkpoint before the first mutation in a tool batch.
7. Execute tools, emit events, and append their grounded results to the model
   conversation.
8. Continue until the model returns a final response or the turn limit is hit.
9. Run configured verification commands after changes and persist the session.

### Prompt layers

The runner keeps the cacheable system prefix separate from mutable task state:

1. Stable prefix: safety rules, workspace roots, trusted project rules, and the
   selected expert role.
2. Dynamic turn state: intent directive, current plan, working memory, compacted
   handoff, workflow instructions, activated Skills, retrieved memories, and
   current code evidence.
3. Conversation: recent user/assistant/tool messages, with old tool output
   replaced by structured receipts when context pressure rises.

This lets providers reuse stable prompt prefixes while ensuring a changed plan
or newly retrieved file is visible on the next turn. Every retrieved or generated
state block is marked as untrusted context and cannot authorize a tool call.

## Local context selection

The context boundary is deliberately in-process and local:

```text
workspace files
      |
manifest + freshness checks
      |
language-aware chunks + BM25/path/symbol/CJK signals
      |
verified, diverse spans under token budget
      |
untrusted evidence block for the model
```

Index state is persisted in the active project namespace. Search results are
revalidated against current files before packing, so a stale index reduces
recall rather than silently injecting old code.

## Storage

Project-local data is kept in `.mosaic/` and ignored by default:

- `config.json` — project overrides;
- `index.json` — local retrieval index;
- `sessions/` — auditable conversation and tool state;
- `checkpoints/` — pre-mutation file snapshots and manifests.

No source content is sent anywhere except the model endpoint selected by the
user. With a local-compatible model, the complete stack can remain self-hosted.

Durable memory uses SQLite in WAL mode with FTS5 and bounded lexical fallback;
it does not require a hosted vector service. Records carry scope, kind,
confidence, provenance, revision, supersession, verification, and expiry. Model
inferences enter `memory_candidates` first. Approval promotes a candidate into
the durable table and can archive a conflicting older fact. Rejected or expired
candidates never enter retrieval. This write → manage → read loop keeps memory
useful without silently accumulating guesses.

## Security boundaries

- File tools resolve and validate paths against configured workspace roots.
- Read, write, shell, Git, and network have independent policies.
- Repository-local configuration is treated as data-only by default: hooks,
  custom executables, verification commands, checkpoint overrides, and
  permission changes require `--trust-project-config` or an explicit config.
- Project API keys and remote provider/endpoint overrides also require explicit
  trust; loopback compatible settings are retained for local-model workflows.
- `skein init` stores only a path-bound SHA-256 fingerprint in user-owned
  Skein state. It allows those model routing fields while invalidating the
  narrow trust after any model-setting edit; hook and permission trust is never
  persisted.
- Destructive commands are denied before ordinary approval rules are evaluated.
- Allow-listed commands cannot contain shell control or substitution syntax.
- Allow rules do not override derived write or network permission categories.
- Ask and Plan modes remove mutating capabilities from autonomous execution.
  Plan mode additionally injects a read-only, approval-oriented planning
  directive; Build mode is required before workspace mutation is possible.
- Hooks are bounded subprocesses and receive structured environment metadata.
- Checkpoint restore validates paths before writing snapshots back.
- Session and checkpoint directories reject symlinked `.mosaic` storage paths;
  local index files are schema-checked and out-of-root entries are discarded.
- Project-declared workspace roots must be existing, non-symlink directories
  whose real paths remain inside the primary project.
- Git execution uses a subcommand allow-list, disables repository hooks and
  external config overrides, resolves its executable outside workspace-owned
  `PATH` entries, and reports non-zero exits as failed tool results. Operations
  that can invoke transport, signing, merge, or checkout helpers also require
  shell permission.

## Capability extension policy

Skein keeps a small built-in tool kernel: read, list, search, write, patch,
shell, Git, tasks, and working memory. Built-ins use closed input schemas,
explicit permission categories, workspace-root resolution, bounded inputs and
outputs, cancellation, checkpoints for known writes, and persisted audit
events. New built-ins must satisfy the same contract; a convenience wrapper is
not enough reason to enlarge the kernel.

Skills and workflows are the preferred plugin surface for reusable guidance.
They are data-only prompt additions, carry their source and trust state, and
cannot grant permissions or execute code by being loaded. Arbitrary in-process
JavaScript plugins are intentionally unsupported because they would share the
CLI's full filesystem, environment, and process privileges.

MCP is the interoperability boundary for external executable capabilities. It
is disabled by default, removed from untrusted project configuration, exposes
namespaced tools, treats server annotations as untrusted, and applies argument,
schema, result, server-count, timeout, and transport limits. Every MCP call
currently requires the network permission category. A configured stdio server
is still an external program with the user's operating-system privileges; cwd
and environment validation reduce accidental exposure but are not a sandbox.
Only reviewed user-owned configuration should enable one.

Before any marketplace-style plugin support, add a declarative capability
manifest, first-run review, lazy tool-schema activation, per-server permission
scopes, and an optional process sandbox. Plugin packages should compose Skills,
workflows, and MCP servers rather than load arbitrary code into the Skein
process.
