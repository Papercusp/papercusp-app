# Operator v5
URL: /internal/docs/spec/operator-v5

The Operator panel — proactive workspace concierge. Tier-classified suggestions, server-authoritative auto-dispatch, lifecycle telemetry, plugin-authored sources.

import { Aside } from '@astrojs/starlight/components';

The Operator is the always-on concierge accessed from the chrome's Operator
button. It scans the workspace, surfaces up to \~5 next-action suggestions
per scan, and dispatches the safe ones automatically while routing the
risky ones for explicit user approval.

This page documents the v5 architecture (May 2026).

The v5 **classification data layer** still ships and is accurate: the 3-variant
suggestion union + tier resolver (`packages/operator-core/lib/operator-suggestion-schema.ts`,
`resolveActualTier` / `clampSuggestion`), the substrate tier table
(`packages/plugin-sdk/src/tier-table.json` + `lookupTier` in `tier-table.ts`),
plugin-tier resolution (`operator-plugin-tier.ts`), plugin-authored suggestions
(`operator-plugin-suggestions.ts` + the `contributeOperatorSuggestions` hook in
`@papercusp/plugin-sdk`), and the budget / rate-limit / trigger-state / fuzzy-dedup /
ack-latency / standing-candidates / message-status / audit / preferences modules.

Several things have moved or been superseded since this page was written, so treat the
lower sections as design-of-record rather than a live file map:

* **Paths moved.** Operator libs are now under `packages/operator-core/lib/operator-*.ts`
  (prefixed `operator-`), not `apps/operator/lib/operator-*`. The HTTP routes are
  Hono handlers under `packages/operator-core/lib/endpoint-route/routes/agent-mcp/operator-*.ts`
  (+ `routes/operator/`), not Next.js `app/api/.../route.ts`. Migrations `014`/`015`
  are squashed into `libs/papercusp/libs/db/sql/000-baseline.sql` (incrementals now
  start at `107`).
* **Persisted state moved filesystem → PG.** The Operator's per-workspace state is
  no longer a folder of files under `<papercuspRoot>/system/operator/`. It is now
  JSONB rows keyed by `workspace_id`: `harness_shared.operator_preferences`
  (migration 022), `harness_shared.operator_budget` (migration 020),
  `harness_shared.operator_rate_limit` (migration 031, also the 503 breaker), and
  `harness_shared.operator_standing_candidates`. The file-layout table below is the
  superseded design — read it for the *shape* of each blob, not for paths.
* **Standalone scanner data layer torn down.** Migration `167-drop-operator-scanner-tables.sql`
  (the scanner teardown, `unify-agent-launches-as-blueprints-2026-06-04` D-005)
  drops the six scanner-owned tables — `operator_scans`, `operator_dismissed_cards`,
  `operator_scan_locks`, `operator_last_scan`, `operator_idle_snapshot`,
  `operator_scanner_session`. They were created in `000-baseline.sql` but `167`
  runs after it, so the live end-state has them **gone**. Proactive scanning is now a
  scheduled `scan` launch blueprint whose findings land as tracked `work_items`, not a
  separate operator-card feed. Modules like `suggestion-parser`, `scan-lock`,
  `idle-snapshot`, `card-reconstruction`, `last-scan`, `dismissed-cache`, and the
  client-side `OperatorBackgroundScanner` no longer exist as named files; there is no
  `operator-scan` or `operator-last-scan` route under `endpoint-route/routes/`.
* **`OperatorPanel.tsx` still exists.** It is still the SSE scan panel (\~92 KB —
  kicks off the scan, streams events, renders suggestion cards, imports
  `findFuzzyDuplicate`, `OperatorReactorCore`, `OperatorScanOverlay`); it was restored
  after a botched teardown (see the `unify-agent-launches-as-blueprints-2026-06-04`
  recovery notes). The converse/chat surface (`OperatorChat.tsx`,
  `OperatorConversationProvider.tsx`) ships alongside it; the operator also runs as a
  privileged blueprint (the `pot`, `kind: 'pot'` — see the Pot/operator-as-blueprint spec).

## Pipeline at a glance

```
LLM emits <suggestion> JSON
       ↓
Zod validates against discriminated-union schema  ← bad blocks dropped
       ↓
Server-side tier lookup (substrate → plugin tierMap → cap-string heuristic → fail-safe high)
       ↓
Compare LLM-claimed tier vs server-derived (mismatch → degraded flag, force authoritative)
       ↓
Derive auto_dispatch from (actualTier, preferences standing approvals)
       ↓
Append to scan SSE stream (the persisted last-scan / idle-snapshot store
                            was removed in the 167 scanner teardown)
```

## Action variants (3)

The schema is a discriminated union on `action`:

| `action`         | `capability`     | Tier                 | Behavior                                   |
| ---------------- | ---------------- | -------------------- | ------------------------------------------ |
| `send_directive` | `messages:write` | substrate-classified | dispatches a Directive to `target_harness` |
| `navigate`       | `null`           | always `low`         | renders an `Open <resource>` link          |
| `inform`         | `null`           | always `low`         | renders body text in the card              |

The earlier v4 had 4 variants (`draft`, `advise`); v5 collapsed them into
`inform` because they did the same thing.

## Tier table — substrate-authoritative

`packages/plugin-sdk/src/tier-table.json` is the single source of truth for
substrate-defined capabilities. The Operator pipeline calls
`lookupTier(capability)` and forces the LLM's claim to match. Wildcard entries
(`secrets:read:*`, `data:read:*:*`) only match capabilities with the **same
number of colon-separated segments** (`tier-table.ts` skips any wildcard whose
segment count differs); on a tie the **most-specific** match wins — the one with
the most concrete (non-`*`) segments.

Plugin-defined capabilities (`http:fetch:slack.com`, `compute:exec:my-tool`)
fall through to `null` from the substrate. The full resolution priority
(`resolvePluginAwareTier` in `operator-plugin-tier.ts`) is a four-step chain:

1. **Substrate `tier-table.json`** — authoritative for substrate caps.
2. **Plugin-declared `Plugin.tierMap`** (added in v5) — walked from each loaded
   plugin manifest. A plugin **cannot downgrade** a substrate-known capability;
   that override is silently ignored.
3. **Capability-string heuristic** (`operator-cap-tier-heuristic.ts`, imported
   as `heuristicTier`) — codifies the catalog's naming conventions:
   `secrets:*` → `high`, `compute:exec:*` → `high`, `*:read` → `low`, etc., with
   high-risk patterns matched first so a trailing `:read` can't downgrade them.
4. **Fail-safe `high`** — anything still unresolved returns `null` and the
   suggestion parser applies `high` (always asks).

The heuristic exists because the live tool catalog has \~84 mostly
plugin-defined capabilities; a bare fail-safe would force the operator to ask on
nearly every plugin-cap suggestion, making auto-dispatch useless on
plugin-heavy workspaces.

## Lifecycle reducer

The diagram below is the **original v5 design-of-record**. After the
card-lifecycle collapse (commit `e46ba9c`) the panel only emits four audit
kinds — `accepted`, `ignored`, `accept_failed`, `undo_cancel` (see Telemetry).
The eight older states are retained by the audit writer as legacy back-compat
(un-migrated callers + replayed history), not actively written.

```
                          ┌─→ dismissed (deliberate, with optional reason)
                          │
                          ├─→ superseded (newer scan with same id)
                          │
suggestion arrives ──→ pending  ──→ dispatched ──→ consumed
                          │            │              │
                          │            │              ├─→ escalated
                          │            │              │
                          │            │              └─→ rejected
                          │            │
                          │            └─→ failed
                          │
                          └─→ undo-cancelled (audit-only, no preferences entry)
```

`unconsumed` is **not a state** — it's a UI rule: when a card has been
in `dispatched` for longer than the per-harness threshold (median ack
latency × 1.5, computed from `audit_log`), the card shows a warning
glyph. v1.5 (current) computes thresholds adaptively per
`target_harness`; the static fallback is 4 minutes when there's no
sample.

### Receiving-state derivation

After a successful `send_message` dispatch, the panel captures the
returned `messageId` and polls `papercusp_shared.messages.status` every
10s. Mapping (`operator-message-status.ts`):

* `pending` → still `dispatched`
* `acknowledged` / `actioned` / `archived` → `consumed`

`escalated` is detected when the recipient harness sends a new message
TO `system:operator` (referencing the original) — the polling effect
flips the card and writes an `operator.escalated` audit row.

The canonical schema is `papercusp_shared`, not `papercup_shared` —
migration `332` renamed `papercup_shared → papercusp_shared` (the old
name now survives only as compat views). The query itself is correct;
the card-based receiving-state flow it feeds is design-of-record (the SSE
scan route and last-scan store were removed in the scanner teardown).

## Telemetry — every flip lands in `audit_log`

Audit rows land in `harness_shared.audit_log` with
`actor='system:operator'` and `action='operator.<kind>'`. After the
card-lifecycle collapse (`e46ba9c`) the panel itself only emits **four**
kinds — `accepted`, `ignored`, `accept_failed`, `undo_cancel`. The eight
older kinds (`dispatched`, `acked`, `consumed`, `escalated`, `rejected`,
`failed`, `dismissed`, `superseded`) are still accepted by the writer
(`OperatorAuditKind` in `operator-audit.ts`) as **legacy back-compat** for
un-migrated callers and replayed history — not actively written by the
panel.

Each row also records `details.actor_method` — `voice` / `click` / `api`
/ `null` — so retrospective analytics can break down how an action was
initiated (voice utterance vs UI click vs CLI/API). It defaults to `null`
for back-compat.

The minimum needed for the Path-(a) escalation criterion (>25% of cards
dispatched-pending-ack for >2× cadence over a week) is `dispatched_at` +
`acked_at`.

## Persisted state blobs (was `<papercuspRoot>/system/operator/`)

This was originally a folder of files. The state is now **PG-backed JSONB
keyed by `workspace_id`** — `preferences` in `harness_shared.operator_preferences`
(migration 022), `budget` in `harness_shared.operator_budget` (migration 020),
and `standing-candidates` in `harness_shared.operator_standing_candidates`. The
`last-scan` / `idle-snapshot` / `dismissed` blobs (and their tables) were removed
in the scanner teardown (migration 167). The table below documents the **shape**
of each blob — the old filenames are kept only as labels.

| Blob (old filename)                                    | Purpose                                                                                                         | Lifecycle                                                                               |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `prompt-user.md`                                       | User-editable voice/tone, free-form prefs                                                                       | edit at `/settings/operator`                                                            |
| `preferences` (was `preferences.md`)                   | Workspace-scoped learned preferences; PG, migration 022 (JSONB `{ content }` holding the markdown body)         | append-only via dismiss-with-reason + standing-approval; per-entry remove from settings |
| `last-scan` (was `last-scan.json`)                     | Most recent scan's emitted cards                                                                                | **removed** — `operator_last_scan` dropped in migration 167                             |
| `idle-snapshot` (was `idle-snapshot.json`)             | Cached cards keyed by trigger-state fingerprint                                                                 | **removed** — `operator_idle_snapshot` dropped in migration 167                         |
| `dismissed` (was `dismissed.json`)                     | Local cooldown cache (1h default)                                                                               | **removed** — `operator_dismissed_cards` dropped in migration 167                       |
| `first-run.json`                                       | `{shownAt, shownToUserIds}` for the intro modal                                                                 | per-(workspace, user) gate                                                              |
| `budget` (was `budget.json`)                           | Daily cap + last-7-days spend; PG, migration 020 (`{ dailyCapUsd, spend[] }`)                                   | sized at first launch via Light/Active/Heavy modal                                      |
| `standing-candidates` (was `standing-candidates.json`) | (capability, target) pairs Operator wants to standing-approve; PG `harness_shared.operator_standing_candidates` | recomputed after every dispatched audit-write                                           |

The substrate-owned Operator system prompt (the `scanner` role — tier
rules, schema, anti-patterns) is canonically
`libs/papercusp/packages/harness/blueprints/base/prompts/scanner.md`, a built-in role
prompt alongside `architect.md` / `scoper.md` / etc.
`packages/operator-core/lib/operator-prompt-system.ts` reads that file at
module load and re-exports it as a string (so Turbopack bundling and
FS-less callers keep working) and carries an inline fallback synced to the
canonical file; drift is caught by the `lint:scanner-prompt` check. Neither
can be edited from the UI.

## Server-side policies

| Concern                               | Module                        | Behavior                                                                                                                                                                                              |
| ------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-tab dedup *(removed)*           | `operator-scan-lock.ts`       | design-of-record: PG row in `operator_scan_locks` (60s TTL); the table + module were dropped in the scanner teardown (migration 167)                                                                  |
| Per-workspace rate limit              | `operator-rate-limit.ts`      | 2 background scans/min default; manual rescans bypass. **PG-backed** (migration 031) — a single JSONB row per workspace in `harness_shared.operator_rate_limit`; was previously a process-local `Map` |
| 503 circuit breaker                   | `operator-rate-limit.ts`      | 5 consecutive PG 503s → 10 min cooldown; manual scans surface errors (same PG row)                                                                                                                    |
| Idle short-circuit *(partly removed)* | `operator-trigger-state.ts`   | still computes a stable trigger-state digest (unconsumed\_events + project statuses + operator inbox); the `operator-idle-snapshot.ts` consumer + its table were dropped in migration 167             |
| Daily budget                          | `operator-budget.ts`          | first-launch sizing prompt; 402 from scan route on overrun (PG, migration 020)                                                                                                                        |
| Dismissed cooldown *(removed)*        | `operator-dismissed-cache.ts` | design-of-record: 1h default per id, PG-mirrored; the `operator_dismissed_cards` table + module were dropped in migration 167                                                                         |
| Suggestion fuzzy dedup                | `operator-fuzzy-dedup.ts`     | Levenshtein-on-normalized-titles, 0.82 similarity threshold                                                                                                                                           |
| Plugin-tier resolution                | `operator-plugin-tier.ts`     | walks loaded plugin manifests; substrate caps cannot be downgraded                                                                                                                                    |

## Client-side surfaces

`OperatorBackgroundScanner` was a chrome-layout component that polled
`/api/agent-mcp/operator-trigger-state` every 30s and scheduled a 60s
debounced background scan (max-stall 5 min) on a fingerprint change, with
auto-fire suggestions surfaced as Sonner toasts (5s Cancel countdown,
pause-aware, suppressed while the panel is open). **It no longer exists**
in source — it was removed in the scanner teardown; only plan/markdown
history references it. The description here is design-of-record.

`OperatorPanel.tsx` still ships (the SSE scan panel — kicks off the scan,
streams events, renders suggestion cards). The reopen-hydration flow
described in v5 read from `/api/agent-mcp/operator-last-scan`, merging
`audit_log` lifecycle events with dismissed cooldown. **That route no
longer exists** (no `operator-last-scan` handler under
`endpoint-route/routes/`; the `operator_last_scan` store was dropped in
migration 167), so this rehydration path is design-of-record, not live.

## Plugin-authored suggestions

A plugin can implement `contributeOperatorSuggestions(ctx)` (in
`PluginHooks`) to inject deterministic suggestions into every scan.
Returns are validated against the same Zod union the LLM is held to,
then enriched through the same tier + auto\_dispatch pipeline. Cards
get `provenanceFlags.pluginAuthored: true` for UI display. Per-plugin
errors are isolated — a thrown hook never blocks LLM output.

Use case example: a Linear plugin can synthesize a suggestion when a
PR comment goes unanswered for >24h, without relying on the LLM to
notice it.

## Preferences learning

| Trigger                                                 | Provenance tag                                            | Effect                                                       |
| ------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------ |
| User dismisses with reason                              | `[USER-TYPED] [DISMISS]`                                  | appended to `preferences.md` + recent-undo strip in settings |
| User edits a directive then dispatches (Phase 4 future) | `[USER-TYPED] [EDIT]`                                     | appended                                                     |
| User pauses Operator mid-scan (Phase 4 future)          | `[USER-TYPED] [PAUSE]`                                    | appended                                                     |
| 3 silent dispatches of (capability, target) in 24h      | `[OPERATOR-PROPOSED-USER-CONFIRMED-…] [STANDING-APPROVE]` | candidate appears in settings; user approves                 |
| Undo-window cancel of an auto-fire toast                | (audit only)                                              | NOT a learning event — only `audit_log`                      |

The settings page (`/settings/operator`) renders the preferences with
per-entry remove + filter (All / User-typed / Operator-proposed). Recent
entries (last 24h) get an additional undo strip so a single misclick
doesn't lock in a wrong learning.

A CLI exists at `apps/operator/scripts/audit-prefs.ts` for users with
many entries:

```sh
npx tsx apps/operator/scripts/audit-prefs.ts list --filter user-typed
npx tsx apps/operator/scripts/audit-prefs.ts remove <key>
npx tsx apps/operator/scripts/audit-prefs.ts purge --before 2026-01-01
```

## Migrations

The Operator's **live** tables in `libs/papercusp/libs/db/sql/000-baseline.sql`
are `operator_budget` (migration 020), `operator_preferences` (022),
`operator_rate_limit` (031), and `operator_standing_candidates` — all
`harness_shared`, all RLS-scoped to `app.workspace_id`.

The original v5 scanner tables — `operator_scan_locks` (was `014`),
`operator_dismissed_cards` (`015`), plus `operator_scans`,
`operator_last_scan`, `operator_idle_snapshot`, and
`operator_scanner_session` — were created in the squashed baseline but are
**dropped** by `167-drop-operator-scanner-tables.sql`
(`unify-agent-launches-as-blueprints-2026-06-04` D-005), which runs after
the baseline. So the live end-state has all six gone; proactive scanning is
now the scheduled `scan` launch blueprint, whose findings land as tracked
`work_items` rather than scanner rows.

## What's NOT in v5 (and why)

* **Auto-dispatch for `tier=high`** — would defeat the safety model.
* **Editable substrate prompt (`scanner.md`)** — would defeat substrate guardrails.
* **`dispatch_role` (Path a)** — held as documented fallback; activation criterion is measurable via lifecycle telemetry.
* **`pending_events`-based dispatch (Path c)** — substrate orchestrator polls (`TICK_INTERVAL_MS=30_000`) rather than `LISTEN`-ing, so this path is *slower* than `send_message`, not faster. Becomes viable when substrate is rewired.
* **Embedding-based suggestion dedup** — Levenshtein dedup ships in v5; embedding upgrade adds a service dependency for marginal gain.
* **Multi-workspace Operator view** — product/UX decision, not implementation gap.

## Module map

Live modules (`packages/operator-core/lib/operator-*.ts`). Entries marked
**(superseded)** were named in the original v5 design but no longer exist as
files — the scan/card pipeline they implemented was folded into the
converse/chat operator + the `pot` blueprint (see the caution box above).

```
packages/operator-core/lib/operator-*
  operator-prompt-system.ts    ← re-exports scanner.md (read-only) + inline fallback
  operator-prompt.ts           ← assembles substrate + user + prefs
  operator-preferences.ts      ← preferences parser + writer (PG, migration 022)
  operator-suggestion-schema.ts ← Zod 3-variant union + resolveActualTier/clampSuggestion
  operator-budget.ts           ← daily cap + spend (PG, migration 020)
  operator-rate-limit.ts       ← per-workspace + 503 breaker (PG, migration 031)
  operator-cap-tier-heuristic.ts ← capability-string tier heuristic (heuristicTier)
  operator-trigger-state.ts    ← {events, projects, inbox} digest
  operator-audit.ts            ← writes to harness_shared.audit_log
  operator-message-status.ts   ← polls papercusp_shared.messages.status
  operator-ack-latency.ts      ← median ack latency per harness
  operator-fuzzy-dedup.ts      ← Levenshtein on normalized titles
  operator-plugin-tier.ts      ← walks Plugin.tierMap (substrate-protected)
  operator-plugin-suggestions.ts ← gathers contributeOperatorSuggestions
  operator-standing-candidates.ts ← detector for auto-upgrade prompts
  (removed in mig-167 teardown) suggestion-parser / scan-lock /
               idle-snapshot / card-reconstruction / last-scan / dismissed-cache

Hono route handlers (packages/operator-core/lib/endpoint-route/routes/)
  agent-mcp/operator-config.ts          ← prompt-user + preferences read/write
  agent-mcp/operator-budget.ts
  agent-mcp/operator-preferences.ts     ← list/append/remove
  agent-mcp/operator-standing-approvals.ts
  agent-mcp/operator-audit.ts
  agent-mcp/operator-trigger-state.ts
  agent-mcp/operator-message-status.ts
  agent-mcp/operator-dispatch.ts
  operator/card-response.ts, operator/state-snapshot.ts, …

apps/operator/app/_components/ (operator UI — now converse/chat, not a scan panel)
  OperatorChat.tsx, OperatorConversationProvider.tsx, OperatorActionLog.tsx, …
```
