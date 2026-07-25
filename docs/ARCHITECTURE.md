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
2. Classify the task evidence surface and ask the local context engine for
   task-relevant spans under an adaptive budget capped by configuration.
3. Combine product rules, project rules, retrieved spans, mentions, current plan,
   and conversation history.
4. Call the model with the tools allowed by the current mode.
5. Evaluate every requested tool against workspace and permission policy.
6. Create a checkpoint before the first mutation in a tool batch.
7. Execute tools, emit events, and append their grounded results to the model
   conversation.
8. Record a bounded, content-free token receipt for the model request and
   persist actual provider counters separately from local estimates.
9. Continue until the model returns a final response or the turn limit is hit.
10. Run configured verification commands after changes. The completion gate accepts
   only current successful test, typecheck, lint, build, check, or `git diff
   --check` evidence recorded after the last mutation. An early final response
   receives one bounded recovery turn; the runtime persists `verified`,
   `unverified`, or `verification_failed` instead of trusting completion claims
   in model text.
10. Before the first substantive write, run the warning-only repository reuse
    gate. It binds current candidate/read evidence to the request, index
    generation, and change sequence without retaining source text.
11. Persist the outcome and expose the same status through the TUI, text, JSON,
    and JSONL surfaces.

## Interactive startup gate

New interactive sessions establish local context readiness before creating or
saving a session. Resumed sessions keep their existing transcript-first startup
and rely on the same per-turn retrieval freshness checks:

1. Inspect and schema-check the persisted local index.
2. Compare its manifest with the current workspace.
3. Incrementally scan, chunk, and write only when the index is missing, stale,
   or first-run setup explicitly requests a visible build.
4. Reload the written artifact from disk and match generation, file count,
   chunk count, and manifest freshness.
5. Pass the immutable readiness snapshot to the TUI; only then enable the
   composer and initialize session extensions.

An empty workspace produces a valid zero-file generation. Validation failures
stay in a retry/exit state and occur before an empty session is persisted.
Headless runs retain non-animated lazy indexing so structured automation does
not acquire terminal-only behavior.

Known mutations take a narrower path: the runner validates tool-reported
`changedFiles`, marks them dirty, targeted-upserts or deletes only those paths,
and atomically persists the new generation before returning the tool result.
Manifest reconciliation additionally compares ctime, closing same-size changes
whose mtime is restored without hashing every source file on an empty query.

### Prompt layers

The runner keeps the cacheable system prefix separate from mutable task state:

1. Stable prefix: safety rules, workspace roots, trusted project rules, and the
   selected expert role.
2. Dynamic turn state: intent directive, current plan, working memory, compacted
   handoff, workflow instructions, activated Skills, retrieved memories, and
   current code evidence.
3. Conversation: recent user/assistant/tool messages. Every new tool result is
   bounded before it enters this layer; old tool output is replaced by compact
   receipts when conversation pressure later triggers compaction.

This lets providers reuse stable prompt prefixes while ensuring a changed plan
or newly retrieved file is visible on the next turn. Every retrieved or generated
state block is marked as untrusted context and cannot authorize a tool call.

## Tool output boundary

Tool output crosses three independent limits:

1. Shell uses bounded capture and reports the stdout/stderr bytes it observed
   and whether that limit omitted source bytes. After an MCP SDK call returns,
   normalization applies a separate 5 MiB ceiling and preserves both ends. It
   limits what reaches the runner; it does not sandbox the MCP process or bound
   bytes already materialized by the transport.
2. The runner sanitizes terminal control sequences, redacts credential-shaped
   values, estimates CJK and non-CJK token cost, and derives a 1,024–8,192 token
   model-visible budget from active context and remaining session headroom.
3. If the sanitized captured result is complete and at most 5 MiB, the runner
   can retain it outside the transcript. The model receives a head/tail receipt
   with status, size, failure/exit/changed-file signals, hash, expiry, and a
   bounded `read_tool_artifact` continuation.

Artifacts are stored beneath the active project namespace, capped at 20 MiB in
total, evicted oldest-first, and expired after seven days. File names are hashes
of validated session/tool-call identities. Reads validate the session binding,
file identity, byte count, and SHA-256; symlinks and corrupt records fail closed.
At the start of a run, expired files are pruned and persisted session receipts
are reconciled against storage before the readback tool can be exposed. Deleting
a session removes its artifact directory. Session JSON and JSONL events carry
only receipts and bounded previews, never artifact contents.

## Token ledger and adaptive retrieval

Each model request appends a maximum-256-entry token ledger to its session. A
receipt contains only a request ID, turn, timestamp, partition counts, actual
provider counters when present, measurement source, loaded tool names, and
retrieval selection metadata. It never contains prompt text, workspace rules,
source snippets, tool schemas, arguments, results, or credentials. Legacy
sessions without provenance remain readable and are labelled `unknown` rather
than being reported as actual usage.

The local context ceiling is allocated by task shape: 2k for focused evidence,
4k for ordinary work, 8k for cross-module or repository-wide work, and 12k only
for explicitly exhaustive multi-part work. Each receipt reports its reason and
the number of candidate, selected, overlapping, and budget-capped spans. These
are estimated provider-neutral planning values, not billing claims.

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

The fresh-session TUI consumes the same verified readiness snapshot. Wide
terminals expose it in a factual workspace rail alongside the selected model,
mode, permission posture, tool/Skill/MCP counts, and memory state. Narrow
terminals collapse to one column, and team activity takes precedence over this
welcome-only rail.

## Storage

Project-local data is kept in `.mosaic/` and ignored by default:

- `config.json` — project overrides;
- `index.json` — local retrieval index;
- `sessions/` — auditable conversation and tool state;
- `tool-artifacts/` — redacted, expiring oversized tool results scoped to a
  saved session;
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
- Dynamic shell commands with no statically resolvable target use bounded
  before/after content-fingerprint snapshots across workspace files. Incomplete
  observation is persisted as unknown mutation tracking and forces an
  unverified completion rather than a false no-change result.
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
