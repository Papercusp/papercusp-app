# Operator card lifecycle — simplified plan
URL: /internal/docs/design/operator-card-lifecycle-plan

Final plan after design discussion. Card lifecycle collapses to 3 states (pending / dispatched / ignored) with a non-status failure chip. No harness coupling, no parent_id schema, no auto-timeout.

> **Superseded (kept as design history).** The operator-card recommendation
> stream this plan governs was **torn down** in the scanner teardown
> (`unify-agent-launches-as-blueprints-2026-06-04` D-005; the scanner tables
> were dropped in migration 167). `OperatorPanel.tsx`, the panel that rendered
> the cards (referenced throughout §3), was **unwired/orphaned** in that
> teardown — nothing mounts it anymore (`ChromeShell` renders only
> `OperatorChatSidebar` behind the testing flag) — but the file itself was
> **not deleted**: it still exists on disk (≈2,188 lines) as dead code pending
> removal. The live operator chat surface is now `OperatorChat.tsx` /
> `OperatorChatSidebar.tsx`. (Note: in the codebase's own naming, "the Deck" is
> `OperatorPanel`'s root `.operator-panel` element, which sat *behind* the chat
> sidebar — the chat surface and the Deck are distinct, so don't read the chat
> sidebar as "the Deck.") Proactive findings land as tracked **work\_items in the
> self-improvement backlog** (`improvements:capture` / `improvements:digest`),
> not as a card feed.
>
> The 3-state model below (pending → accepted/ignored) did reach code:
> `OperatorPanel.tsx` defines `LifecycleState` as exactly
> `'pending' | 'accepted' | 'ignored'` and `SuggestionCard` carries the §2
> failure-chip fields (`failedAttempts`, `lastFailureReason`, `lastFailureAt`).
> That surface was then orphaned by the scanner teardown — so the lifecycle was
> shipped, then unwired, rather than never shipped.

This is the final shape after the back-and-forth in chat. Earlier
audit + 8-phase plan is superseded; the model is dramatically smaller
because we no longer track what the harness does after a directive
ships.

***

# 1. The new state machine

Three states. Two terminal. Two buttons on every card.

```
                 click Accept
        ┌────── action OK ─────────────▶  accepted     (terminal)
        │
  pending ── click Accept ── action error ──▶ pending  (with failure chip)
        │
        └────── click Ignore ─────────▶  ignored        (terminal)
```

| State      | Meaning                                       | Terminal? |
| ---------- | --------------------------------------------- | --------- |
| `pending`  | Card is waiting for the user's decision.      | no        |
| `accepted` | User clicked Accept and the action succeeded. | yes       |
| `ignored`  | User clicked Ignore.                          | yes       |

**Two buttons on every card, always.** What `Accept` *does* depends on the card's `kind`:

| Kind        | What `Accept` does                               | Success criterion        |
| ----------- | ------------------------------------------------ | ------------------------ |
| `directive` | POST `/api/admin/execute-action` (sends message) | HTTP 200 + messageId set |
| `navigate`  | Open the URL in a new tab                        | window\.open succeeded   |
| `inform`    | No side effect (audit-log only)                  | always succeeds          |

**Once a card lands in `accepted` or `ignored`, it never moves again.** The operator does not attempt to track what the harness did with the directive afterwards. That's a deliberate choice — the prior model tried to and couldn't (3 of 4 advance paths from the post-dispatch state were unreachable in code, see prior audit).

# 2. Failure chip on pending cards

When an Accept click fails (HTTP error on directive cards, or `window.open` blocked on navigate cards), the card stays in `pending` and gains two tracked fields (kept on the card, **not** part of `status`):

```ts
interface SuggestionCard {
  // ...existing fields
  failedAttempts?: number;          // count of failed dispatch clicks
  lastFailureReason?: string;       // human-readable error from the last try
  lastFailureAt?: number;           // timestamp of last failure
}
```

UI: a small amber chip rendered on the card meta strip, alongside tier and harness:

> ⚠ Last attempt failed: HTTP 500 — try again

Behavior:

* The card stays in the same pending bucket as never-tried cards.
* All filters / sorts / search treat it identically to a clean pending card.
* The Dispatch button is unchanged — clicking it retries.
* On a successful retry, `failedAttempts` and the chip don't appear on the now-dispatched card (status flipped to `dispatched`; the chip render is only for `pending`).

The chip is informational only. It doesn't gate behavior; it just surfaces context the user needs.

# 3. What gets removed

This is *mostly a deletion* of code that's either unwired or wired to non-existent producers.

### From `OperatorPanel.tsx`

* `LifecycleState` union shrinks from 8 members to 3.
* `consumed`, `escalated`, `rejected`, `failed`, `dismissed`, `superseded` references throughout — all deleted or replaced.
* The Zero receiving-state watcher (lines \~720-755) — deleted. Already only fires for `dispatched → consumed/escalated/rejected`, all of which we're removing.
* The REST receiving-state poller (lines \~760-790) — deleted. Same reason.
* `lifecycleLabel`, `lifecycleLabelForCard`, `lifecycleClassForCard` — collapsed (or deleted; we may not need separate labels at all when there are only three states).
* `matchesMetricFilter` — only handles `pending` (no other filters needed).
* The 4-pill metric filter row (`pending / in-flight / attention / resolved`) — collapses to a 2-pill toggle (`Pending / Done`), or one filter that splits Decisions vs. Activity. (Aligns with mock at /operator-mock.)
* `dispatchedAt` field — kept (used for sort order and audit), no longer used for any timeout.
* `unconsumedThresholdFor` and the "unconsumed" warning glyph — deleted.

### From `lib/`

* `lib/operator-message-status.ts` — **entire file deleted.** No consumer.
* `app/api/agent-mcp/operator-message-status/route.ts` — **deleted.** No consumer.
* The `STATUS_MAP` mapping `acknowledged/actioned/archived → consumed` — gone with the file.

### From the schema

* **No new migration** for `parent_id`. It was for escalation detection, which is no longer a thing.
* `papercup_shared.messages.status` — operator stops reading or writing it. Other systems may use the column for their own purposes; we don't care.

### From the audit log

* `consumed`, `escalated`, `rejected` audit kinds — operator stops emitting them.
* `accepted`, `ignored`, `accept_failed` are the only kinds operator writes from now on.
* (Other actors — users, harness roles — can still write whatever audit kinds they want; the audit log isn't operator-exclusive.)

### From voice announcements

* "Harness consumed/escalated/rejected the directive" announcements — deleted. They were tied to the now-removed receiving-state watcher.

# 4. What stays / what's added

* **Card emission from scans** — unchanged. New cards land as `pending`.
* **Dispatch flow** — same `/api/admin/execute-action` POST, same `messageId` capture. The card flips to `dispatched` on HTTP 200. On error, `failedAttempts++` and `lastFailureReason` set; card stays pending.
* **Hard-fail when 200 but no messageId** *(was Phase 5)* — kept. Treated as a dispatch error: increment `failedAttempts` + chip, don't flip status.
* **Auto-fire detachment from panel-open** *(was Phase 4)* — kept. Background scanner needs to be able to fire auto\_dispatch cards without the panel being open.
* **`pending → pending` reconciliation on rescan** — unchanged. New scan with same `card.id` replaces the prior pending card's content in place. Already works.
* **`pending → terminal` is one-way.** Once you Ignore or successfully Dispatch, the card is permanent. New scans don't re-emit it (different reasoning, different ID; if operator emits a fresh card later for a related issue, that's a new pending card).
* **Failure chip rendering** — new. Small amber chip on cards with `failedAttempts > 0`.

# 5. The Activity view

The "Activity" right-rail today shows recent operator decisions from the audit log (see prior conversation). Under the new model:

* Decisions log shows `accepted` and `ignored` events.
* No more `consumed/escalated/rejected/failed/superseded` rows. The audit log has no producer for them anymore (operator stops writing).
* Activity rail still queries the same `harness_shared.operator_decisions` view; the view is unchanged. It just sees fewer kinds of action.

# 6. Implementation phases (drastically smaller)

| Phase | What                                                                                                                                                                            | Effort     | Why                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------- |
| **1** | Schema: add `failedAttempts` + `lastFailureReason` + `lastFailureAt` to `SuggestionCard` interface; render failure chip; on dispatch error, increment + set, don't flip status. | 30 min     | Implements the core "pending stays pending on failure" model. |
| **2** | Collapse `LifecycleState` union to 3 members. Replace every `consumed/escalated/rejected/failed/dismissed/superseded` reference: deleted / collapsed to `ignored`.              | 1-2h       | Mostly mechanical.                                            |
| **3** | Delete `lib/operator-message-status.ts` + the API route + the Zero watcher + the REST poller in `OperatorPanel.tsx`.                                                            | 30 min     | Pure deletion.                                                |
| **4** | Collapse the 4-pill filter strip (`pending / in-flight / attention / resolved`) to a 2-pill toggle (`Pending / Done`).                                                          | 30 min     | Visual simplification matches the new model.                  |
| **5** | Hard-fail dispatch when 200 returns no messageId — treat as dispatch error (Phase 1's flow).                                                                                    | 15 min     | Already-spec'd defensive guard.                               |
| **6** | Move auto-fire from panel-effect into BackgroundScanner so cards auto-fire even when panel is closed.                                                                           | \~half day | Independent of the rest; can ship separately.                 |
| **7** | Verify audit log writes match the new model (`dispatched`, `ignored`, `dispatch_failed` only). Update `logAudit` callers.                                                       | 30 min     | Bookkeeping.                                                  |

**Total: \~half day** for phases 1-5+7. Phase 6 is a separate \~half-day chunk.

# 7. What's NOT in this plan

* **Anything about what the harness does after dispatch.** Not our problem. The operator's job ends at "successfully sent the directive." If the user wants to know whether the harness completed it, they look at the harness directly (HarnessDashboard, run.log, etc.).
* **Reclassification audit on rescan.** The old plan had a phase for this (Gap 8). With the simplified model: `pending → pending` rescan replaces in place silently; we don't track the diff. If you want the diff later, add it as a follow-up; not part of this pass.
* **Granular harness states.** Was Phase 8 of the old plan (deferred); now permanently deferred unless we revisit the model.
* **Standing-approval interaction.** Standing approvals turn certain card patterns into auto-dispatch. The auto-dispatch path goes through the same `pending → dispatched` flow on HTTP 200, same failure-chip on error. No special handling.
* **Voice flips.** Operator stops announcing "consumed/escalated/rejected" because those states no longer exist. Voice still announces "dispatched X to harness Y" and "ignored X" if those preferences are on.

# 8. Resolved decisions from the design discussion

* **Buttons on every card:** `Accept` and `Ignore`. Two buttons, always, regardless of card kind. The kind determines what `Accept` does under the hood; the user-facing affordance is uniform.
* **Status name:** `accepted` (matches the button), not `dispatched`. The button-and-status alignment makes the audit log read naturally.
* **Navigate-card behavior:** `Accept` opens the URL in a new tab. Keeps the panel state intact.
* **Inform-card behavior:** `Accept` is audit-log only. No side effect, always succeeds — the failure-chip path can never trigger for inform cards.
* **`Ignore` is uniform:** every card kind gets the same Ignore button, same `ignored` terminal, same audit kind.

# 9. Ready to code?

If you're happy with §1-§8, I'll start Phase 1. If you want to redline anything in this doc first, send the redlines.
