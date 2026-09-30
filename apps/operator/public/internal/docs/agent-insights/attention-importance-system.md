# The attention/importance system (Planning tab)
URL: /internal/docs/agent-insights/attention-importance-system

How plan-item importance + the unified AttentionItem feed fit together, and two non-obvious gotchas — parseWarnings become lint ERRORS, and (historically) the Plans tab had no in-app chat host (now superseded by the inline PlanChat host).

:::caution\[Superseded — Gotcha 2 no longer holds]
The "Plans tab has no in-app chat host" gotcha below is **out of date**. The
Plans tab now ships a dedicated inline chat host, so Chat there is no longer a
no-op:

* `apps/operator/app/admin/plans/PlanChat.tsx` creates a harness-scoped chat
  (`POST /api/harness/:slug/agent-chats`, lines 39–63) and mounts
  `<ChatPanel slug chatId mode="discuss" />` **inline** (line 84) — exactly the
  host the original Gotcha 2 said was missing (inbox-cards-unification D-006).
* It is wired into the Plans UI: `PlanItemPreview.tsx:192`
  (`{chatOpen ? <PlanChat harnessSlug={harnessSlug} label={…} /> : null}`) and
  `DiscussPanel.tsx:75` (`<PlanChat harnessSlug={item.harnessSlug} label={chatLabel} />`).
* The no-harness case is handled with a clear message
  (`PlanChat.tsx:65–71`), not a silent no-op.
* `PlanChatModal` and the bespoke `InboxItemActions` toolkit are **retired**
  (`PlanItemPreview.tsx:15–17`). The plan the original section pointed at as
  "open work," `planning-attention-importance-2026-05-31` P-017, is **done**.

Gotcha 1 (parseWarnings → lint errors) and the importance axis described in
**What it is ¶1** remain accurate. The attention-feed source list in **¶2** has
drifted (`plans-awaiting-review` was retired, `types.ts:171`; the feed gained
operator-report / improvement / standing-approval / conversation / scout-grade
kinds, `types.ts:22–34`) — treat that enumeration and the UI facet labels as
point-in-time, not load-bearing. The original narrative is preserved below for
history.
:::

## What it is

Plan items carry an **importance** — a 4th axis orthogonal to status:
`urgent | high | normal | low` (default `normal`), written as an
`importance:` keyword on the item line and parsed glyph-agnostically like
`blocked-by:`. It drives the Planning-tab sort/badges, the orchestrator's
halt-on-`urgent`, and (eventually) the push threshold. Source of truth:
`@papercusp/plan-parser` (`IMPORTANCE_LEVELS`, `PlanItem.importance`); spec
at [plan-format §Importance](/internal/docs/spec/plan-format#importance).

The Planning tab also shows a **unified attention feed**: one
`AttentionItem` read-model (`packages/operator-core/lib/attention/`) that every
"needs the human" surface adapts into — plan items, coord escalations,
coord messages-to-human, smoke-test failures, plans-awaiting-review. The
`plans:attention` tool unions them (best-effort per source), grouped by
plan + a synthetic per-harness "Alerts" bucket, importance-sorted. The UI
filter facets are ToDos / Needs Human / Blocked (plan-item statuses) +
Escalations / Messages / Smoke / Reviews (the non-plan-item kinds).

## Gotcha 1 — parseWarnings become lint ERRORS

`plans:lint` turns **every** `parsed.parseWarnings` entry into a hard
`parse_warning` **error** (`lint.ts`). So the parser must NOT push a
parseWarning for a recoverable condition like an unknown `importance:`
value — that would fail CI on a typo. Instead:

* the parser **degrades silently** to `normal` (no parseWarning), and
* `plans:lint` re-scans the item's `rawLine` and emits a soft
  `unknown_importance` **warning** (never an error).

If you add another tolerant item-keyword, follow the same split: degrade
in the parser, warn (don't error) in lint.

## Gotcha 2 — the Plans tab has no in-app chat host

The in-app agent chat (`ChatPanel` via `AdvChatPanel`) is hosted **only by
the `/adv` HarnessesDock**, opened by an `OPEN_CHAT_EVENT` that the dock
listens for (`openFeatureChat` → `POST /api/harness/:slug/agent-chats` →
dispatch event). The **Plans admin tab is not inside that dock**, so an
`openFeatureChat`-style call there creates a chat that opens nowhere
visible. The PlanItemPreview/PlanOtherList "Chat" buttons fall back to
`launchAgent` (an external OMP/claude terminal session), which on desktop
is invisible/no-op if the agent isn't configured — hence "Chat does
nothing."

To make Chat work in the Plans tab you must add a host (e.g. a modal that
creates a chat and renders `<ChatPanel slug chatId />` directly), and a
chat needs a **harness** (`agent_chats` is per-harness-schema) — pure SU
plans with no harness can't host one. This is the open work in
`planning-attention-importance-2026-05-31` P-017.

## Related: the unified owner Inbox (2026-07-17)

`owner-inbox-single-pane-2026-07-17` widens this same `AttentionItem` feed
with more sources (every kind's `needs_human`/blocked work-items, registered
owner-walls, pending dark-flag ratifications, hook- and transcript-derived
owner-gates from any client) and adds reply routing back to a live asker plus
a session chat popup on top of the feed described above — see
[owner-inbox-single-pane-capture-architecture](/agent-insights/owner-inbox-single-pane-capture-architecture).
