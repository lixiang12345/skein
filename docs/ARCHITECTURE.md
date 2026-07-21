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
│ ContextEngine CLI          │  │ workspace boundary           │
│ local BM25/path/symbol     │  │ allow / ask / deny           │
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
2. Ask the selected context engine for task-relevant spans under the configured
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

## Context selection

`context.engine: auto` is the recommended setting.

```text
              contextengine executable healthy?
                         /          \
                       yes          no
                       /              \
        hybrid external retrieval    local incremental index
        symbols + vectors + graph     BM25 + path + symbol boosts
                       \              /
                        token-budget pack
```

The fallback is intentional. A missing database, embedding endpoint, or external
binary should reduce retrieval quality, not make the coding agent unusable.

## Storage

Project-local data is kept in `.mosaic/` and ignored by default:

- `config.json` — project overrides;
- `index.json` — local fallback index;
- `sessions/` — auditable conversation and tool state;
- `checkpoints/` — pre-mutation file snapshots and manifests.

No source content is sent anywhere except the model endpoint selected by the
user. With local-compatible model and local retrieval endpoints, the complete
stack can remain self-hosted.

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
