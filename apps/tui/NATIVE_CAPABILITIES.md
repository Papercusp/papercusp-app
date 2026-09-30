# First-party PUI capability replacement

Implementation contract for `pui-first-party-public-release-2026-09-07`, P-001
(WI-10000417). The owner-approved scope and decisions live in that plan,
especially D-002, D-003, D-004, D-007 and D-008.

This inventory describes required outcomes and reusable source boundaries. A
source surface is not installed-product acceptance. Every row remains required;
none is excluded from release. Claude, Codex and OMP are execution backends, and
their native interfaces must remain closed during the user journeys below.

## Evidence baseline

The existing installed-binary PTY suite now checks `/api/tui/identity` before
starting the UI and uses the current composer controls. Its old `s` sequence
opened global Sessions rather than the obsolete new-conversation picker.

After correcting that sequence, the installed PUI accepted the unique draft
`PUI-E2E-1788763043914-success` into its visible transcript. The captured frame
then showed `SU session · starting`, `failed-orphaned`, a 404 from
`/su-session/events`, and `Running — input locked`. No correlated reply arrived.
The operator identity and workspace preflight passed. The protocol banner in an
earlier frame was not proof that startup identity was broken.

Reproduction:

```sh
npm run test:file -- packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts -t 'restored non-chat'
```

At this baseline the test is expected to fail before a reply. It still carries
the earlier provider fixture, which is not an acceptance substitute for an
actual SU engine. P-003 through P-005 must replace that boundary with the
production attached-engine path and prove an actual model/tool response.

The source trace is:

1. `src/main.rs::open_su_session_task` creates a chat and sends `defer_spawn:true`.
2. `launch-su` records a deferred workbench launch and returns no native runtime.
3. PUI subscribes to that chat's typed SU-session stream while retaining the
   initial turn for its identity snapshot.
4. The stream route only retrieves or rehydrates a registered host. Rehydration
   explicitly provides no command executor; it cannot establish engine readiness.
5. The backend matrix supplies the missing process launch and adapter attachment
   itself. That proves adapter behavior but does not exercise this PUI handoff.

The ordinary composer therefore depends on native workbench materialization
that a plain terminal cannot supply. Fix the shared launch/attachment boundary;
increasing an SSE retry count cannot provide the missing executor.

## Required replacement matrix

Each probe must name the binary digest, source generation, engine, project,
session and turn. A missing or skipped leg is unverified. P-012 joins these rows
into the release check; P-014 reviews the exact candidate independently.

| Capability inherited from a native client | PUI home and durable contract | Work | Installed-product probe |
| --- | --- | --- | --- |
| First prompt and streamed response | Composer and transcript; typed SU-session create/commands/events; host-owned command identity and attached executor | P-003, P-004, P-005 | Type a unique greeting through a real PTY; observe the matching reply in PUI without an external pane or direct adapter attachment |
| Persona, tools and permissions | Same SU identity, project scope and tool plane used by managed sessions; the engine adapter supplies execution | P-003, P-006 | Ask for a harmless scoped file read, observe the real tool call/result and verify the assigned identity |
| Editable task list | Context task pane and editor; existing `tasks:ops`, session task store and agent-chat task bridge | P-007, P-016 | Owner adds/edits/reorders tasks; a real agent starts and completes the same IDs; owner blocks/unblocks/reopens/drops tasks; restart preserves them |
| Plans and work-item links | Context pane; conversation-context projection and existing task `for`/`relates` links and promotion | P-008, P-016 | Promote a selected task, inspect its exact link, then switch sessions without leaking another project's work |
| Multiline prompt editing | PUI composer, draft and history state in `src/app.rs`; accepted turn receives the exact submitted content | P-007 | Unicode paste, cursor editing, undo, history navigation and an unsent draft during streaming retain exact text |
| Transcript navigation and copying | PUI transcript and markdown/tool renderers, backed by canonical conversation history | P-007, P-008 | Scroll/search long history, copy a selected result and reopen the same conversation with its content preserved |
| Tool requests and command output | Inline semantic tool cards and results; typed session events correlated to the owning turn | P-006, P-007 | Run a harmless command and inspect its request, output, terminal status and final response in the same conversation |
| Code changes and diffs | Expandable tool/change cards in the contextual work surface | P-007 | Modify a fixture file and inspect the corresponding diff entirely within PUI |
| Approvals and permission scope | Inline approve/deny controls; exact request and session correlation through the existing approval/card response boundaries | P-006, P-007 | Deny prevents the action; allow executes only the displayed action; an unrelated pending request remains untouched |
| Interactive questions | Inline choice/free-text cards; response routes to the matching waiting turn | P-006, P-007 | Answer a real engine question in PUI and observe the correlated continuation |
| New/switch/rename/archive sessions | In-PUI session picker and session controls; shared launch configuration and agent-chat lifecycle APIs | P-008, P-010 | Create and name sessions with different projects, switch and archive, then resume the selected one |
| Legacy history continuation and fork | Explicit Continue in new session/fork controls; preserve source conversation provenance and runtime identities | P-008, P-009 | Open legacy history, continue into a writable session and verify its source link without mutating the historical identity |
| Interrupt, end and recovery | Visible lifecycle/recovery actions; typed host controls, durable acceptance and runtime reconciliation | P-005, P-009 | Interrupt and continue; restart PUI/operator/engine at declared failure points; reconcile uncertain delivery without duplicate execution; end leaves no orphan |
| Model/account/effort/mode settings | PUI controls using `src/session_config.rs` and shared launch configuration values | P-006, P-008, P-010 | Display selections before sending, exercise supported changes and show precise explanations for unsupported engine controls |
| Context, usage and compaction | Selected-session context pane; authoritative engine measurements and carry state | P-006, P-008, P-009 | Switch sessions, observe the correct context; missing token/cost data reads unknown; resumed carry retains the selected scope |
| Commands, help, skills and plugins | PUI command palette/help plus supported extension actions, reusing existing command and plugin inventory | P-008 | Discover and invoke a harmless supported command/extension without native-client help or a terminal fallback |
| Files and attachments | Project-scoped file/attachment selection in the composer | P-007, P-010 | Select a fixture file, inspect the explicit attached reference and verify that another project's file is not silently selected |
| Authentication and first-run setup | In-product project/endpoint/engine/account setup; existing secure auth/configuration paths | P-010 | Empty profile reaches the composer with visible selections and ordinary consent; absent auth offers a usable remedy |
| Installation, update and support | Versioned binary/manifest/install path; preserve configuration/history and redact support data | P-011, P-013, P-015 | Clean install without source/Cargo/private dotfiles; upgrade/rollback/uninstall; inspect redacted diagnostics; repeat through the approved public download |

## Reuse and gaps established by source

- `src/agent_chats.rs::AgentChatTaskAction` and the operator's `task-ops` route
  currently expose add, edit, check, drop, clear-blocker and promote. Context
  keyboard handling currently routes check/drop/clear-blocker/promote. P-016 must
  make the complete owner editing workflow explicit, including ordering,
  start/block/reopen semantics and failed-edit preservation.
- `session-tasks.ts` owns the durable statuses and task operations; extend this
  model and its revision/transaction rules. Do not create a separate TUI list or
  infer task updates from assistant prose or scraped native task panels.
- `src/app.rs` already retains composer, history and draft state. Extend its
  editor and focus handling. The baseline's obsolete picker key demonstrates why
  reducer tests alone cannot certify the installed keyboard journey.
- SU adapter capability descriptors are declarations, not parity measurements.
  Each engine still needs the same installed greeting/tool/approval/resume and
  task-editing evidence. Conditional support must be visible and truthful.
- The design registry query for ecosystem `ratatui` returned no components.
  P-002 should reuse the existing Rust renderer/editor and the preserved Surface B
  reference at `docs/mockups/pui-agent-cockpit.html`, with terminal-specific
  interaction validation. The empty registry is not permission to replace the
  existing application scaffold.
- Linux x86_64, macOS arm64/x86_64 and Windows via WSL2 are approved targets, not
  current compatibility claims. Existing voice/fleet capabilities remain in
  Advanced. Only combinations with candidate-specific installed evidence may be
  advertised.

## Source boundaries

- `src/main.rs`, `src/app.rs`, `src/ui.rs`, `src/su_session.rs`,
  `src/session_config.rs`, `src/agent_chats.rs`, `src/card_view.rs`,
  `src/semantic_tool_cards.rs`, `src/transcript.rs`
- `packages/operator-core/lib/endpoint-route/routes/adv/launch-su.ts`
- `packages/operator-core/lib/endpoint-route/routes/agent-chats/su-session.ts`
- `packages/operator-core/lib/su-session-host.ts` and
  `su-session-{claude,codex,omp}-adapter.ts`
- `packages/operator-core/lib/session-tasks.ts`,
  `agent-tools/tasks/ops.ts`, `agent-tools/tasks/runtime.ts`,
  `endpoint-route/routes/agent-chats/task-ops.ts`,
  `conversation-context-projection.ts`
- `packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts` and
  `su-session-real-backend-matrix.integration.test.ts`
- `apps/tui/TESTING.md`, `apps/tui/scripts/install-update.sh`
