# Skein Product Benchmark

This is a capability and workflow comparison, not a claim that products use
the same models or pricing. It was reviewed on 2026-07-25 against public
product documentation.

## Positioning

Skein's strongest differentiators are provider independence, local-first
storage, an auditable permission/checkpoint model, reviewable durable memory,
and a real terminal UI that remains usable in narrow terminals. The product
already has more safety and context plumbing than a thin model wrapper.

The main opportunity is workflow clarity. Mainstream agents make the path from
"understand" to "plan" to "execute" to "review" explicit, and they expose
parallel work, code intelligence, trust boundaries, and sharing as first-class
product surfaces.

## Evidence-Based Comparison

| Area | Mainstream signal | Skein today | Product implication |
| --- | --- | --- | --- |
| Context | Auggie automatically indexes projects and offers context-aware interactive and print modes. Its MCP Tool Search avoids loading every remote schema up front. See [Auggie overview](https://docs.augmentcode.com/cli/overview) and [integrations](https://docs.augmentcode.com/cli/integrations). | Local BM25/path/symbol retrieval with language-aware chunks, current-file freshness checks, diversity-aware token packing, progressive Skills, and hard token caps. MCP uses local `search → inspect → trust → activate`; remote `listTools` stays lazy and at most eight relevant schemas load. Activation receipts compare eager and selected schema estimates plus the lexical top match. | Keep the deterministic schema/selection fixture and add real-model tool-choice evaluation before claiming general accuracy gains. |
| Tool result economy | FastCtx argues for structured file/search tools, explicit pagination, bounded output tiers, and persistent background-job logs so the model spends fewer turns on shell mechanics. See the [FastCtx repository](https://github.com/yc-duan/fastctx) and its [LINUX DO introduction](https://linux.do/t/topic/2612425). These are design signals, not independent evidence that every model becomes more accurate. | Native tools use closed schemas, adaptive output receipts, and session-scoped readback. Optional durable jobs now persist bounded stdout/stderr with incremental cursors, restart discovery, process-group cancellation, and unconditional live-human start/kill; asynchronous mutation evidence remains unresolved. | Measure whether background logs reduce tool turns before broadening the adapter; keep arbitrary external capabilities behind MCP and existing trust gates. |
| Workflow modes | Claude Code documents isolated subagents, agent teams, hooks, code intelligence, Skills, MCP, and plugins in one extension model. See [Claude Code extensions](https://code.claude.com/docs/en/features-overview). Copilot CLI exposes Plan and Autopilot modes. See [Copilot CLI](https://github.com/features/copilot/cli). | Ask, Plan, and Build modes are explicit. Plan is read-only and produces an approval-oriented proposal without granting mutation authority. | Keep mode changes, live-human approval, and deterministic completion evidence separate as the workflow expands. |
| Code intelligence | Claude Code advertises language-server-backed symbol navigation and live type errors. | Retrieval remains local and independent; an optional trusted stdio LSP adapter now provides bounded definition, references, and diagnostics without rename or mutation actions. | Calibrate supported servers and error recovery before considering more LSP methods; keep the offline index as the default. |
| Parallel work | Claude documents isolated subagents and agent teams; Copilot CLI offers background delegation and fleet-style parallel work. | Routed multi-model councils share bounded reports and a responsive Team Cockpit. One opt-in writer lane isolates either the native API writer or a cost/timeout-bounded Claude CLI writer in a disposable worktree; API review, patch SHA, human integration, checkpoint, and rollback gates remain visible. | Collect real self-build evidence before expanding beyond one writer or adding non-Claude external writers. |
| Trust and execution | Gemini CLI documents sandboxing and trusted folders; Claude exposes lifecycle hooks and permission events. See the [Gemini CLI repository](https://github.com/google-gemini/gemini-cli) and [Claude hooks](https://code.claude.com/docs/en/hooks). | Category permissions, project trust, checkpoints, hooks, audit trails, per-manifest MCP trust review, persistent disable/revoke, sensitive-field redaction, and unsupported-mutation evidence degradation are present. Process sandboxing remains incomplete. | Add an optional OS/container sandbox without weakening manifest, permission, or completion-evidence gates. |
| Collaboration | Auggie supports integrations and conversation export; Copilot supports GitHub-native MCP and shareable workflows. | Session export and resumability are local. A deterministic redacted review bundle binds fixed scope, changed files, verification and audit evidence without copying source or credentials; there is still no hosted sharing service or user-exportable signed share artifact. | Keep review artifacts local until an explicit export contract, redaction audit, and user-controlled sharing boundary exist. |
| Distribution and recovery | Competitors provide guided installation, auth, update channels, and workflow-specific entry points. | Package/release verification is reproducible; `skein doctor` reports project/user namespace and interrupted-operation state; the manager-aware self-update path shows bounded release highlights and requires explicit non-interactive confirmation. Shared live-process leases and exclusive mutation leases keep migration, rollback, and recovery crash-safe. | Add a unified first-run capability review, then define the measured legacy-alias window and platform packaging that reuses the verified artifact. |

## Prioritized Roadmap

1. **P0 reliability:** keep the CI green on the actual Node SQLite baseline and
   configure `main` to require the stable `check` status.
2. **P1 Plan mode:** shipped in this change as a read-only, approval-oriented
   mode for both interactive and headless use.
3. **P1 storage migration (compatibility window pending):** `.skein/` and `SKEIN_HOME` are
   recognized canonical names, while existing `.mosaic/` state remains active
   until an explicit `skein migrate --yes`. The command emits a hash-bearing
   manifest, blocks conflicts/symlinks, copies through a temporary directory,
   and retains the legacy source. `--rollback` verifies hashes before atomically
   quarantining the canonical copy; `--recover` handles interrupted operations;
   `--home` covers user-level state. Shared leases cover live managed writers,
   while namespace mutation requires an exclusive crash-released lease.
4. **P1 MCP trust hardening:** per-server review, capability manifests,
   activation telemetry, persistent revoke, and required-server isolation are
   delivered; optional stdio sandboxing remains.
5. **P1 scheduler and isolation:** cancellation propagation, deterministic
   integration gates, and the single-writer/worktree boundary are shipped for
   the native and bounded Claude writer lanes. Keep broader writer expansion
   blocked on real self-build evidence and the existing live-human gate.
6. **P1 code intelligence:** optional definition/reference/diagnostics are now
   shipped without making the local index mandatory; calibrate server coverage
   before adding rename or mutation actions.
7. **P2 trust and sharing:** memory privacy/export/delete controls and the local
   redacted review bundle are shipped. Remaining work is a unified first-run
   capability review, optional sandbox adapters, and a user-exportable share
   artifact with an explicit redaction and consent contract.

The benchmark deliberately does not copy cloud execution, vendor lock-in, or
autonomous mutation defaults into Skein. Those can be integrations later; the
core product should remain local, reversible, inspectable, and provider-neutral.

## Dependency Maintenance Note

`@modelcontextprotocol/sdk@1.29.0` still declares
`@hono/node-server@^1.19.9`, whose entire 1.x line is affected by
[GHSA-frvp-7c67-39w9](https://github.com/honojs/node-server/security/advisories/GHSA-frvp-7c67-39w9).
Skein only imports MCP client transports, so the package currently applies a
scoped override to `@hono/node-server@2.0.11`. The real SDK interoperability
test guards this decision. Remove the override when the supported MCP v1 SDK
publishes a patched dependency range; do not start using Hono's server adapter
through the overridden major version.
