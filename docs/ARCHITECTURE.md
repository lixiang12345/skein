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
3. Run the Intent Sufficiency Gate. Clear requests execute; repository-derived
   gaps route to inspection; only user-owned product choices create a persisted
   `needs_input` state. Shell/Git/network approval remains a separate policy.
4. Combine product rules, project rules, retrieved spans, mentions, current plan,
   and conversation history.
5. Call the model with the tools allowed by the current mode.
6. Evaluate every requested tool against workspace and permission policy.
7. Create a checkpoint before the first mutation in a tool batch.
8. Execute tools, emit events, and append their grounded results to the model
   conversation.
9. Record a bounded, content-free token receipt for the model request and
   persist actual provider counters separately from local estimates.
10. Continue until the model returns a final response or the turn limit is hit.
11. Before the first substantive write, run the warning-only repository reuse
    gate. It binds current candidate/read evidence to the request, index
    generation, and change sequence without retaining source text.
12. Capture content-free TS/JS function fingerprints from that pre-write index
    generation. After the write succeeds, compare only newly added or at least
    1.5x-expanded functions before refreshing changed index paths. Exact
    normalized hashes identify Type-1/2 clones; winnowed 10-token shingles and
    Jaccard similarity identify Type-3 candidates. The repository-owned fixture
    matrix calibrates threshold 0.55: unsuppressed Type-1/2 matches block the
    existing completion gate, while Type-3 remains warning-only. Type-4 semantic
    equivalence is explicitly outside this deterministic contract.
13. Run configured verification commands after changes. The completion gate accepts
   only current successful test, typecheck, lint, build, check, or `git diff
   --check` evidence recorded after the last mutation. An early final response
   receives one bounded recovery turn; the runtime persists `verified`,
   `unverified`, or `verification_failed` instead of trusting completion claims
   in model text.
14. Persist the outcome and expose the same status through the TUI, text, JSON,
    and JSONL surfaces.

## Long-session epoch ledger

A user-visible session has two different token boundaries:

- `agent.maxEpochTokens` (default 250,000) bounds one internal reasoning epoch.
- `agent.maxSessionTokens` (default 1,000,000) is the hard lifetime ceiling
  across every epoch and resume.

Crossing the epoch boundary never clears lifetime usage or changes the session
id. The runner optionally compacts only when predicted reuse has positive net
savings, then persists a content-free handoff containing the Task Contract
criterion states and evidence references, unresolved failure circuits, changed
files, and last-run verification receipts. The next epoch starts with zero
epoch usage while the transcript and lifetime ledger remain intact. Generated
narrative is fallible; deterministic handoff facts and fresh tool evidence keep
precedence. Epochs, pending clarification, and their public reason codes are
backward-compatible optional session fields and contain no hidden reasoning.

A logical `session fork` binds the new session to the exact source-session
snapshot and source-workspace identity by SHA-256. It preserves bounded
transcript and task facts, starts a fresh usage ledger and epoch, drops stale
last-run recovery state, and does not duplicate session-bound oversized tool
artifacts. With explicit `--branch`, `--worktree`, and `--yes`, Skein asks Git
to create a sibling worktree from `HEAD` using argv execution rather than a
shell, then persists the fork inside that worktree. Branch creation never runs
implicitly and a worktree target inside the source repository is rejected.

External composer editing is a user-triggered terminal action, not a model
tool. `VISUAL`/`EDITOR` is parsed into a bounded argv vector; the executable
must resolve on a trusted PATH outside the workspace, provider and relay
secrets are omitted from its environment, and the only supplied file is an
owner-only temporary draft with a 120 kB limit and post-edit regular-file
check.

Optional LSP code intelligence is a user-trusted local adapter, not part of the
index. A configured extension selects one stdio server; Skein resolves its
executable outside all workspace roots, launches it without a shell or provider
credentials, bounds source/protocol/result sizes, and exposes only definition,
reference, or diagnostic facts that re-resolve inside the workspace. Untrusted
project configuration removes the entire adapter and missing servers degrade
without changing normal startup.

Optional durable jobs use a separate session-owned store under the active
project namespace. Each start has a one-time HMAC-bound descriptor, content-free
command fingerprint, bounded owner-only stdout/stderr, incremental byte cursor,
runtime/log/concurrency/history limits, heartbeat recovery, and a control-file
cancel path. The detached worker holds the namespace lease and receives a
minimal environment without provider or relay secrets. Model-initiated start
and kill are unconditional live-human actions; a start reports unresolved
mutation tracking, so a background process cannot authorize completion. POSIX
cancellation targets the spawned process group; Windows uses the direct child
process boundary.

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

The duplication baseline reuses the current local-index chunks and generation;
it does not add a persisted index schema or external parser service. The runtime
reconstructs hash-verified file content in memory, extracts ordinary TS/TSX/JS/
JSX/MJS/CJS functions, then retains only path, symbol, line range, token count,
exact hash, and winnowed hashes. The generation cache is cleared on load, full
build, targeted upsert, and deletion. Audit receipts never retain source,
normalized tokens, literal contents, prompts, or raw retrieval failures.

Duplication findings are folded into the existing completion record rather than
creating a parallel completion state. Fixture benchmarks establish the required
precision for calibrated Type-1/2 blocking; Type-3 remains warning-only. Active
matches receive stable, bounded ids; the optional `duplication_audit` read tool
is exposed only while unsuppressed findings exist. Suppression is exact-match,
reason-coded, and persisted as a content-free audit receipt. Repaired/deleted/
small functions produce a `clear` receipt for paths that previously carried an
active finding, so the summary cannot retain stale warnings. Legacy receipts
without ids remain readable and are never suppressible.

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

The governance plane separates content-free review from contentful export.
`memory privacy` exposes only aggregate scope, kind, lifecycle, candidate,
provenance-risk, and owner-only file-permission facts; content, tags, scope keys,
and the database path are absent by construction. `memory export` selects
`user`, one exact workspace, or all scopes and writes atomically with owner-only
permissions after rejecting destination symlinks. `memory clear` applies the
same scope selector, requires explicit headless confirmation, enables SQLite
`secure_delete`, and attempts FTS optimization, WAL truncation, and `VACUUM`.
Logical deletion remains successful if compaction is temporarily busy and that
distinction is reported. SQLite contents are not encrypted by Skein at rest.

Workspace Skills are another persisted trust boundary. Discovery hashes the
exact `SKILL.md`; activation requires a user-owned decision bound to the
resolved workspace, source-path hash, and content hash. Source or content drift
becomes `changed`, revocation becomes `revoked`, and both states fail closed.
User-owned and explicitly configured external locations remain trusted by
source. The workflow catalog is built in, trusted, and read-only; each workflow
declares whether running it stays read-only or enters the single-writer lane.

## Relay transport and model catalog

New primary connections target third-party compatible relays only. A named
connection binds one explicit transport: `openai-responses` (the default),
`openai-chat`, or `anthropic-messages`. Skein never infers transport from a URL
or model name and never retries an inference request through another protocol,
because doing so can duplicate work and billing.

The inference `baseUrl` and OpenAI-shaped `modelsBaseUrl` are separate. This
models gateways where OpenAI and Anthropic SDKs append different paths as well
as gateways that publish every protocol below one root. Inference authentication
is `bearer`, `x-api-key`, or connection-wide `none`; catalog authentication is
independently `bearer`, `x-api-key`, or `none`. Explicit catalog `none` skips
both credential resolution and credential headers, preventing an inference key
from crossing into a public or separately hosted catalog. Omission preserves
the prior behavior of inheriting inference authentication.

Provider-hosted tools use an intersection of trusted connection capability and
route opt-in. Today only Responses `web_search` is supported. It does not grant
the worker a local network tool: the provider returns content-free search-call
events and bounded citation identities, and Skein removes URL credentials,
queries, and fragments before persistence while retaining a SHA-256 binding to
the exact URL.

Route costs come only from user-configured relay prices. Receipts bind detailed
usage, protocol-specific cache semantics, price source, and a pricing hash;
missing prices are `unpriced`. Team Run v4 adds an optional, content-addressed
provenance bundle that binds report artifacts, route fingerprints, cost and
hosted-tool/source receipt hashes, peer handoffs, review verdicts, criterion
evidence, writer state, and human arbitration without retaining hidden
reasoning.

## Evidence review and arbitration

Team Run v4 separates three authorities:

1. Deterministic oracles bind content-addressed receipts to Contract criteria.
2. A blind Reviewer judges only bounded anonymous artifacts and admissible
   evidence, with Author/Reviewer route and model-family correlation audited
   outside its prompt.
3. A live human may resolve only an open criterion bound to the current
   Contract and artifact SHA.

Oracle failures cannot be overridden. Oracle passes take precedence when a
Reviewer disagrees, while the disagreement remains judge-calibration evidence.
Unknowns, unresolved model conflicts, and insufficient high-risk independence
produce `needs_review`; JSON/JSONL exits with status 9 instead of accepting or
retrying indefinitely. Artifact or Contract drift invalidates old verdicts and
human decisions.

Human arbitration is distinct from permission approval. Writer integration,
Git push, npm publish, deployments, migrations, destructive commands, and
external mutations require a live-human approval path. Model votes, config
allow rules, `--yes`, and ordinary session grants cannot mint that identity.

## Capability drift and replay plane

The project-local Capability Registry v2 keeps a stable logical route identity
separate from six behavior components: model/protocol, endpoint, auth
reference, profile prompt, tool catalog, and generation/budget policy. A change
to any component opens a labelled epoch and invalidates a full-fingerprint pin.
Version 1 files migrate in memory and gain complete component metadata on the
first current-route touch.

Each task + route fingerprint has an independent deterministic health state:

```text
healthy -- failure --> degraded -- failure --> quarantined
   ^                       |                       |
   +------- success -------+---- two canaries ----+
```

Quarantine affects only the shadow recommendation: it cannot retarget a live
run. A normal success can clear `degraded`, but a quarantined route requires two
distinct passing `capability_canary` evidence receipts. Evidence hashes are
bounded and duplicate signals are idempotent.

Verified capability observations may bind the request-level Token Ledger.
Token totals are derived from linked actual/estimated receipts and mismatched
caller totals fail closed. The Registry retains only receipt hashes and bounded
aggregates; it does not duplicate request IDs, prompts, schemas, retrieval
details, tool names, provider output, or source.

The offline replay plane accepts strict content-free fixtures and reports route
regret, success, token use, provider/tier coverage, Token Ledger coverage,
judge position/verbosity/self-preference stability, and exact health-state
transitions. Local replay source labels are not external attestation. Replay
never writes the Registry, calls a provider, or enables automatic routing.

## Security boundaries

- File tools resolve and validate paths against configured workspace roots.
- Read, write, shell, Git, and network have independent policies.
- Repository-local configuration is treated as data-only by default: hooks,
  custom executables, LSP/background adapters, verification commands, checkpoint overrides, and
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
- LSP and background executables resolve outside workspace-controlled paths,
  use direct argv, and receive minimal environments. LSP is read-only;
  background mutation evidence is always unresolved and start/kill cannot reuse
  config, `--yes`, or session approval in a model run.

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
is disabled by default, removed from untrusted project configuration, treats
server annotations as untrusted, and applies argument, schema, result,
server-count, timeout, and transport limits. A common declarative capability
vocabulary describes source, version, tools, permission categories, network,
commands, paths, sensitive fields, background/process-tree effects, and
completion-evidence support. Tool definitions carry the same source,
activation, permission, and evidence metadata so `/tools` can distinguish the
built-in, memory, workflow, agent, and MCP surfaces.

Normal chat exposes three bounded controls: `mcp_search` and `mcp_inspect` read
only local redacted manifests; `mcp_activate` connects only a manifest whose
workspace-bound SHA-256 fingerprint the user trusted. The model cannot write
the trust store. Remote discovery stays true-lazy and activation registers at
most eight query-relevant schemas. Once a manifest names tools, undeclared
remote schemas are rejected. Disable and revoke decisions persist and unload
registered adapters. Optional server failures remain isolated; only an
explicitly required, trusted server is checked during runtime initialization
and allowed to block it.

Every MCP call retains `network` permission even for stdio. Declared write,
shell, and Git effects add rather than replace permission categories. Sensitive
argument fields are redacted before terminal, TUI, JSON, or approval events.
External mutations receive complete change tracking only when Skein created the
pre-call checkpoint and the server returns that exact id with workspace-valid
changed files, artifact receipts, and completion evidence. Other mutation
results set tracking to `unresolved`, preventing an unsupported completion
claim.

A configured stdio server is still an external program with the user's
operating-system privileges; cwd and environment validation are not a process
sandbox. Marketplace-style packages must compose data-only Skills, workflows,
profiles, and explicitly trusted MCP servers rather than load arbitrary code
into the Skein process. An optional OS/container subprocess sandbox remains a
future hardening layer.
