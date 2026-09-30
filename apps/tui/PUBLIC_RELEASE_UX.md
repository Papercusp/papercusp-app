# PUI public-release UX contract

Status: P-002 implementation contract for
pui-first-party-public-release-2026-09-07.

This contract turns the approved Surface B direction into one buildable
terminal product. It covers the first-run journey, Agent Chat, Context and task
editing, sessions, settings, approvals, recovery, compact terminals, exact
copy, and the release platform/backend matrix. Later plan items implement and
test this contract; they may not silently narrow it.

## Authority and reuse

The governing plan decisions are D-002 through D-008:

- PUI owns ordinary session setup and the complete user-facing workflow.
- PSU remains a separate CLI and an explicit Advanced action, not the ordinary
  launcher UI.
- Claude, Codex, and OMP are execution backends. Their native interfaces are
  not the PUI user experience and must stay closed during installed-product
  acceptance.
- The installed PUI journey, not adapter-only tests, is release authority.
- The primary information architecture is Surface B: conversation plus its
  contextual work surface.
- The task list, sessions, tools, approvals, settings, and context are core PUI
  scope.

Reuse these existing surfaces rather than creating a second UI system:

| Contract surface | Existing source to extend |
| --- | --- |
| App state, focus, composer, palette, keyboard routing | src/app.rs |
| Layout, Agent Chat, overlays, help, compact rendering | src/ui.rs |
| Context projection and task rows | src/plans_board.rs |
| Session identity, lifecycle, reconciliation | src/su_session.rs |
| Live server-owned model/account/effort/mode menus | src/session_config.rs |
| Questions and inline interaction cards | src/card_view.rs |
| Semantic tool/work cards | src/semantic_tool_cards.rs |
| Conversation/task/approval wire models | src/agent_chats.rs |
| First-run persistence | src/tutorial.rs |
| Accepted Surface B reference | ../../docs/mockups/pui-agent-cockpit.html |
| Full capability and evidence map | NATIVE_CAPABILITIES.md |

The live design-registry lookup for ecosystem ratatui returned no components.
React/Tailwind registry results are not portable to this binary. That empty
registry is not permission to hand-roll a parallel scaffold: the Rust renderer,
state reducers, typed host APIs, card system, and Surface B reference above are
the component library for this work.

## Resolved launcher conflict

The old rule in app.rs says PSU is the sole launcher UI and Sessions n launches
an external PSU picker. That rule is superseded for ordinary PUI workflows.

The release behavior is:

1. First run and Sessions > New open the same in-PUI New session form.
2. PUI reads projects, endpoint state, engines, account routes, models, effort
   levels, and modes from the maintained server configuration. It does not
   hardcode provider menus.
3. Role is SU. The form shows every effective value before launch, including
   inherited defaults.
4. Start session calls the shared launch/configuration boundary and waits for
   the typed host-ready identity. It must not open a Claude, Codex, OMP, PSU, or
   zellij picker as an unannounced second interface.
5. A first message entered during setup is retained and submitted once, only
   after the host is ready. Uncertain delivery reconciles by turn identity
   before any retry.
6. Open advanced PSU launcher remains available under Advanced and in the
   command palette. It is visibly a separate workflow and never the default.

The obsolete tutorial claims “Launch a native agent into a pane” and “Agents
run at full fidelity in their own zellij panes.” Release copy must instead say
that PUI runs the selected backend through the shared Papercusp host. Workbench
and native-client panes remain optional Advanced capabilities.

## Release platform and backend matrix

Every Required cell is a release commitment, not a current compatibility claim.
It becomes advertisable only after candidate-specific installed evidence exists
for that exact cell.

| Public target | Packaging/runtime | Claude | Codex | OMP |
| --- | --- | --- | --- | --- |
| Linux x86_64 | Native PUI binary | Required | Required | Required |
| macOS arm64 | Native PUI binary | Required | Required | Required |
| macOS x86_64 | Native PUI binary | Required | Required | Required |
| Windows 11 via WSL2 x86_64 | Linux PUI binary inside WSL2 | Required | Required | Required |

Native Windows outside WSL2 is not in this release. Other architectures and
platforms are unverified, not “best effort.” Voice and fleet controls remain
available under Advanced where their dependencies exist; they do not substitute
for any Required cell.

## Information architecture

### Wide terminal: 160 columns by 24 rows or larger

- Agent Chat is the primary surface.
- Surface B keeps conversation and Context visible together. Agent Chat owns
  the flexible main area; Context owns a 40-column rail.
- On non-chat destinations, the destination owns the main area and the same
  Agent Chat remains in the 40-column dock.
- Context begins with selected project/session identity, engine, model, account
  route, mode, lifecycle, declared intent, and reconciliation state. It then
  shows tasks, plan/work links, approvals, and held resources supplied by the
  shared context projection.
- There is one transcript, one composer state, and one context projection.
  Multiple render sites never create duplicate conversations or local copies.

### Compact terminal: 80–159 columns or 20–23 rows

- Show one primary surface at a time; do not squeeze a second pane into an
  unreadable sliver.
- o always returns to Agent Chat. Ctrl-T opens Context. Ctrl-S opens Sessions.
- Status condenses to project, session/lifecycle, and pending-owner count.
- Overlays use the available viewport and remain dismissible with Esc.
- No capability disappears. A hidden rail becomes a reachable full-screen
  surface with the same canonical state.

### Below 80 columns or 20 rows

Render a stable blocking view instead of clipped controls:

> Terminal too small — resize to at least 80×20. Your session and draft are safe.

Ctrl-C and q may still exit; resize resumes the prior surface and draft.

## First run and new session

First-run setup readiness and the dismissible tutorial are separate states.
Reopening or skipping the tutorial must not fabricate credentials, mark setup
ready, or delete history.

The in-PUI form has three steps:

1. Context
   - Project: searchable current projects; no stale list cursor becomes launch
     authority.
   - c registers an existing directory through the shared project-registration
     API. The form shows the selected operator, project name and absolute host
     path, and requires a separate Register confirmation. A successful response
     refreshes the list; the new project still requires explicit selection.
   - Operator endpoint: effective URL plus Connected, Checking, or Unavailable.
   - e edits the endpoint; Tab selects masked operator-token entry. Reconnect
     replaces this PUI's connections together and retains the exact first draft.
     A changed endpoint never receives the previous endpoint's token. Entered
     tokens stay in process configuration, outside repository files.
   - A bound conversation, queued turn, or attachment refuses endpoint reconnect
     with a repair path; opening another PUI preserves that existing context.
   - Continue stays disabled until both values are valid, with the reason shown.
2. Runtime
   - Engine: Claude, Codex, or OMP.
   - Account route, model, effort, and mode come from live configuration.
   - Unsupported choices remain visible but disabled with the server reason.
   - Defaults are explicit: Default system account, Server default model,
     Default effort, and Manual mode unless the server says otherwise.
   - Native approval prompts are required for new PUI sessions and resumed
     runtimes. Setup refuses operators that do not advertise this capability.
     This policy is independent of the agent's Manual/Auto mode.
3. Review
   - Show project, endpoint, engine, account, model, effort, mode, and optional
     first message.
   - Start session is the sole primary action.
   - Back preserves every field. Esc closes Sessions > New but never discards a
    typed first message without a confirmation.

An unavailable operator still opens the setup form from a clean workbench.
? opens scrollable help with endpoint, token, TLS, engine and account recovery
instructions, including the selected operator's existing account settings URL.

Successful launch lands in Agent Chat and changes Starting to Ready before the
composer unlocks. A pending first message is then submitted exactly once.

## Agent Chat

The transcript renders, in order:

- user text exactly as sent;
- assistant markdown and streaming cursor;
- model/engine/account provenance;
- reasoning only when the backend and policy expose it;
- semantic tool, diff, command, question, and approval cards;
- terminal tool outcome and correlated lifecycle transitions.

The composer is four rows when space permits. It retains its draft across
streaming, session refresh, transient transport failure, and a switch away from
Agent Chat. Enter sends. Alt-Enter or Ctrl-J inserts a newline. Bracketed paste
preserves Unicode and newlines. Up/Down reaches history only when the cursor is
at the first/last logical line. Esc leaves compose mode without clearing the
draft.

During a blocking question or approval, the card owns input and the composer
states why it is paused. During streaming, the title reads:

> Running · Ctrl-X interrupt

Read-only history keeps the draft copyable and says:

> Read-only — continue in a new session to send this draft.

The selected action must open the in-PUI New session form with the source
conversation/fork provenance already shown.

Transcript selection uses y to copy the focused rendered block and Shift-Y to
copy its raw payload when available. Copy success is acknowledged without
moving selection. Secrets and redacted fields stay redacted in both forms.

## Context task list and editor

The task list is the canonical server-backed session list from the shared
context projection and session task store. Never infer task progress from prose
or scrape a native-client task panel.

Each row shows stable ID, status, content/active form, blocker, plan/work links,
revision conflict, and the last durable update. Statuses are Todo, In progress,
Blocked, Completed, and Dropped.

When Context is focused:

| Key | Action |
| --- | --- |
| j/k or arrows | Move selection |
| a | Add task below selection |
| e or Enter | Edit content, active form, and links |
| s | Start selected task |
| x | Complete selected task |
| b | Block with required blocker reference and explanation |
| u | Clear blocker |
| r | Reopen completed or dropped task |
| Shift-J / Shift-K | Reorder transactionally |
| d | Drop after confirmation |
| Shift-P | Promote/link to a durable work-item |

Add/edit/block/reorder use an inline editor. A failed write leaves the draft and
server revision visible and offers Reload or Retry after review. It never
optimistically lies about canonical state. Agent updates to the same stable IDs
arrive through typed frames and preserve selection.

## Sessions

Ctrl-S is the global fast switcher over live, parked, ended, and recorded
sessions. It provides fuzzy search, j/k movement, Tab MRU cycling, Enter route,
and Esc close. Enter reuses the existing attach/focus/resume route.

Sessions is the exploratory destination. It keeps state, fleet, agent, and time
facets, transcript preview, full-text search, and exact lifecycle markers.
Ended and recorded sessions are first-class results, not omissions.

Sessions n opens the in-PUI New session form. Conversation l switches among
existing chat records. Rename, archive, resume, continue, and fork act on the
displayed stable identity and show capability-disabled reasons rather than
silently disappearing.

## Settings, help, and command palette

The chat shortcuts l/m/e/a/u open Conversation, Model, Effort, Account route,
and Mode pickers. Menus are live server-owned inventories:

- Inherit/default is named.
- Unsupported values remain visible with the exact reason.
- A change that cannot apply to the running engine says “Applies to a new
  session” and offers that in-PUI route.
- Secrets are never rendered.

The colon palette is the single command surface. It may search the live tool
catalog and existing recipes, but does not duplicate a second settings store.
Every destructive or outward action previews scope and requires its normal
confirmation. ? opens context-sensitive help; F1 reopens the tutorial.

## Approvals and interactive questions

A pending approval is a parked state, never a spinner. Its card shows tool,
operation, project/session, exact target, argument summary, correlation ID, and
queue count.

- Ctrl-Y approves this request once.
- Ctrl-N denies this request.
- Enter expands full non-secret details.
- A broader remembered permission is a separate secondary choice only when the
  backend advertises it; the exact rule and lifetime must be displayed.
- Resolving one request cannot resolve another queued request.

Choice cards use arrows or number keys and Enter. Checkboxes use Space. Free
text preserves the draft. Esc declines only when the card says decline is
allowed; otherwise it leaves the card open and explains why.

## Error, reconnect, and recovery

Use the host lifecycle and reconciliation enums directly:

- Lifecycle: Starting, Ready, Running, Waiting for owner, Interrupted,
  Compacting, Resuming, Ended, Failed.
- Reconciliation: Pending, Attached, Rematerializing, Runtime replaced, Ended
  archived, Failed orphaned.

Every non-ready state shows what happened, whether the draft/turn was accepted,
and the next safe action. Reconnecting shows the last applied event sequence.
Rematerializing shows measured replay progress. Unsupported actions stay
visible but disabled with the backend reason.

Recovery actions are capability-checked:

- Ctrl-X interrupts the current turn.
- R resumes or safely reattaches.
- K forks/continues into a new session.
- F focuses an existing native workbench pane only when the user explicitly
  chose that Advanced route and the pane exists.
- E ends after confirmation.

An uncertain send must reconcile by session, turn, and command identity before
Retry becomes available. PUI never duplicates a possibly accepted message.

Exact high-value copy:

| State | Copy |
| --- | --- |
| Checking endpoint | Checking operator endpoint… |
| Endpoint unavailable | Cannot reach the operator endpoint. Check the address or retry. |
| Starting | Starting the SU session… Your draft is safe. |
| Ready | Ready |
| Reconnecting | Connection lost — reconnecting from the last confirmed event. |
| Uncertain delivery | Delivery is uncertain — reconciling before retry. |
| Failed orphaned | Runtime missing — resume, fork, or end this session. |
| Read-only history | Read-only — continue in a new session to send this draft. |
| Empty task list | No tasks yet. Press a to add one. |
| No session match | No sessions match this filter. |
| Approval parked | Waiting for your decision; the agent is paused. |

## Files, installation, and support

When the composer is focused, @ opens a project-scoped file/attachment picker.
Every selected attachment is shown above the draft by project-relative path,
kind, and stable reference. Removing an attachment does not alter the file.
Cross-project and unreadable paths are refused with the reason; PUI never falls
back to a similarly named file.

About PUI in the colon palette shows the PUI version, build/source identity,
installed artifact identity and rollback target, update channel, and effective
operator endpoint. There is no separate Settings screen; the same palette
exposes Check for updates, Update, Roll back, Diagnostics, and Uninstall. Update, rollback, and uninstall preview the exact version/path,
preserve configuration and history by default, and require confirmation.
Diagnostics previews its redacted contents before saving or copying.

## Validated 80×24 frame and journey

The compact design budgets the exact 24 terminal rows:

| Rows | Contents |
| --- | --- |
| 1 | Destination strip with Agent Chat selected |
| 2–19 | Agent Chat body: lifecycle/provenance plus scrollable transcript |
| 20–23 | Four-row composer, or the blocking card plus its action hint |
| 24 | Project/session status and o / Ctrl-T / Ctrl-S / ? affordances |

At 80 columns the Context rail and presence rail are not allocated, so the
composer retains all 80 columns. The same context projection opens full-screen
with Ctrl-T; o returns to the same transcript and draft.

The required keyboard walkthrough is:

1. Press o from another destination; Agent Chat opens and focus reaches its
   existing composer state.
2. Press i, enter Unicode plus two logical lines using Alt-Enter or Ctrl-J, and
   confirm the four-row composer keeps the draft visible.
3. Press Enter; exactly one owner turn is accepted, the lifecycle changes to
   Running, and Ctrl-X is advertised.
4. Press Ctrl-T while idle; Context opens full-screen with the same session
   identity and tasks. Press o; the transcript and draft state are unchanged.
5. Press Ctrl-S; the global live/parked/ended/recorded switcher overlays the
   compact frame. Esc closes only the overlay.
6. Open a blocking question/approval; it replaces the composer action area,
   retains transcript visibility, and returns focus after the decision.

This row budget and journey are represented in the companion UI IR and were
validated against UI-IR v0.1. They preserve the Surface B relationship without
forcing two unreadable panes into 80 columns.

## Capability replacement interaction map

Every row in NATIVE_CAPABILITIES.md has an explicit in-PUI interaction:

| Required capability | PUI interaction |
| --- | --- |
| First prompt and streamed response | Agent Chat i focuses the composer; Enter sends once; the same transcript streams the correlated reply. |
| Persona, tools and permissions | Context shows SU/project identity and effective backend; tool and approval cards expose the same scoped tool plane. |
| Editable task list | Ctrl-T opens Context; a/e/s/x/b/u/r/Shift-J/Shift-K/d/Shift-P perform the canonical task operations. |
| Plans and work-item links | Context renders stable badges and Shift-P promotes/links the selected task without changing its identity. |
| Multiline prompt editing | The four-row composer supports cursor editing, Alt-Enter or Ctrl-J newline, Unicode bracketed paste, undo/history, and draft preservation. |
| Transcript navigation and copying | j/k and PgUp/PgDn navigate; search filters; y copies rendered content and Shift-Y copies the available raw payload. |
| Tool requests and command output | Semantic transcript cards show request, arguments, output, terminal state, and correlation; Enter expands the focused card. |
| Code changes and diffs | Change cards open an in-PUI scrollable diff with file/path/hunk context and the same y/Shift-Y copy contract. |
| Approvals and permission scope | Parked approval cards show exact scope; Ctrl-Y allows once, Ctrl-N denies, and remembered scope is a separately labelled choice. |
| Interactive questions | Number/arrows select, Space toggles checkboxes, free text retains a draft, and Enter answers only the correlated card. |
| New/switch/rename/archive sessions | Sessions n opens in-PUI New session; Ctrl-S switches; the Sessions destination owns rename/archive/resume. |
| Legacy history continuation and fork | Ended/recorded Sessions rows open read-only transcripts; Continue in new session and K preserve source provenance. |
| Interrupt, end and recovery | Ctrl-X interrupts; R reconciles/resumes; K forks; E confirms end; unsupported controls remain visible with reasons. |
| Model/account/effort/mode settings | l/m/e/a/u open live server-owned pickers; restart-required changes route through the in-PUI New session form. |
| Context, usage and compaction | Context renders authoritative lifecycle/context/usage/carry measurements; missing values read Unknown; supported compaction is capability-checked. |
| Commands, help, skills and plugins | : opens the one palette; live catalog/recipe search discovers commands, skills, plugins, and tools; ? and F1 explain the focused surface. |
| Files and attachments | Composer @ opens the project-scoped picker and displays exact stable references before send. |
| Authentication and first-run setup | The three-step in-PUI setup validates endpoint/project and exposes live engine/account choices with a repair path. |
| Installation, update and support | Palette About PUI plus lifecycle actions expose version, update, rollback, uninstall, and redacted diagnostics. |

## Keyboard precedence

Input is dispatched to the most specific active surface:

1. blocking approval/question;
2. open inline editor or composer;
3. open modal/picker/palette;
4. focused pane;
5. global navigation.

Esc closes or cancels exactly one layer. It never quits. Ctrl-C interrupts an
active turn when Agent Chat is focused; otherwise it exits only after the normal
quit confirmation. q exits only outside an editor/modal. Keys advertised in a
footer must work in that state; hidden shortcuts are not acceptance evidence.

## Acceptance crosswalk

| P-002 requirement | Evidence in this contract |
| --- | --- |
| First-run UX | In-PUI three-step setup and exact state copy |
| Chat UX | Transcript/composer, streaming, multiline, copy, read-only behavior |
| Task-list/editor UX | Canonical task model, full mutation keymap, conflict handling |
| Session-picker UX | Ctrl-S fast switcher, Sessions browser, in-PUI New |
| Settings/command palette UX | Live server-owned pickers and one palette |
| Approval UX | Parked, correlated, scoped approve/deny and question rules |
| Error/recovery UX | Lifecycle/reconciliation mapping and safe actions |
| Compact-terminal UX | Wide, compact, and too-small contracts |
| Launcher conflict | PUI-owned ordinary launch; PSU is explicit Advanced |
| Release matrix | Four target rows × three required backends |
| Keyboard and copy | Precedence, scoped keymap, exact copy table |

The companion UI IR is
../../docs/mockups/pui-public-release-ux.ir.json. The Markdown is authoritative
for behavior and exact copy; the IR is the machine-validated layout/state index.
