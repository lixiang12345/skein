# Skein Product Benchmark

This is a capability and workflow comparison, not a claim that products use
the same models or pricing. It was reviewed on 2026-07-22 against public
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
| Context | Auggie automatically indexes projects and offers context-aware interactive and print modes. Its MCP Tool Search avoids loading every remote schema up front. See [Auggie overview](https://docs.augmentcode.com/cli/overview) and [integrations](https://docs.augmentcode.com/cli/integrations). | Local BM25/path/symbol retrieval, optional ContextEngine adapter, progressive Skills, and token caps. MCP schemas are registered eagerly. | Make context selection and MCP tool discovery lazy, measurable, and visible. |
| Workflow modes | Claude Code documents isolated subagents, agent teams, hooks, code intelligence, Skills, MCP, and plugins in one extension model. See [Claude Code extensions](https://code.claude.com/docs/en/features-overview). Copilot CLI exposes Plan and Autopilot modes. See [Copilot CLI](https://github.com/features/copilot/cli). | Ask and Build modes exist; Ask is read-only but does not produce a named approval-ready plan. | Add an explicit Plan mode. Keep it read-only and require approval before Build. |
| Code intelligence | Claude Code advertises language-server-backed symbol navigation and live type errors. | Retrieval is lexical/BM25/path/symbol index based; no LSP diagnostics or rename graph. | Add an optional LSP adapter after storage and scheduler foundations. |
| Parallel work | Claude documents isolated subagents and agent teams; Copilot CLI offers background delegation and fleet-style parallel work. | Routed multi-model councils now share bounded reports, run reviewer acceptance/revision, and appear in a responsive Team Cockpit. The main agent remains the only writer. | Add per-route budgets and worktree-isolated writers without weakening the visible review gate. |
| Trust and execution | Gemini CLI documents sandboxing and trusted folders; Claude exposes lifecycle hooks and permission events. See the [Gemini CLI repository](https://github.com/google-gemini/gemini-cli) and [Claude hooks](https://code.claude.com/docs/en/hooks). | Category permissions, project trust, checkpoints, hooks, and audit trails are strong; process sandboxing and first-run trust inspection are incomplete. | Explain trust before activation and offer an optional OS/container sandbox. |
| Collaboration | Auggie supports integrations and conversation export; Copilot supports GitHub-native MCP and shareable workflows. | Session export and resumability are local; no shareable artifact or review bundle. | Add a deterministic redacted session/review bundle before any hosted sharing. |
| Distribution and recovery | Competitors provide guided installation, auth, update channels, and workflow-specific entry points. | Package/release verification is reproducible; `skein doctor` reports project and user namespace state, while `skein migrate` provides verified migration and rollback without deleting changed canonical data. | Add capability review and upgrade UX, then define the measured legacy-alias window. |

## Prioritized Roadmap

1. **P0 reliability:** keep the CI green on the actual Node SQLite baseline and
   configure `main` to require the stable `check` status.
2. **P1 Plan mode:** shipped in this change as a read-only, approval-oriented
   mode for both interactive and headless use.
3. **P1 storage migration (in progress):** `.skein/` and `SKEIN_HOME` are
   recognized canonical names, while existing `.mosaic/` state remains active
   until an explicit `skein migrate --yes`. The command emits a hash-bearing
   manifest, blocks conflicts/symlinks, copies through a temporary directory,
   and retains the legacy source. `--rollback` verifies hashes before atomically
   quarantining the canonical copy; `--home` covers user-level state.
4. **P1 MCP progressive disclosure:** search and activate remote tool schemas
   on demand instead of placing every schema in every model request.
5. **P1 scheduler and isolation:** enforce budgets, cancellation, deterministic
   aggregation, and single-writer/worktree boundaries.
6. **P1 code intelligence:** add optional LSP diagnostics and symbol actions
   without making the local index or external ContextEngine mandatory.
7. **P2 trust and sharing:** first-run capability review, sandbox adapters,
   redacted review bundles, and explicit privacy/export/delete controls.

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
