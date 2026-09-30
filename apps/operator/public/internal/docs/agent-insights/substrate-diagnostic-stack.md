# Substrate diagnostic stack — what to use when the Hyperbee flag flips
URL: /internal/docs/agent-insights/substrate-diagnostic-stack

The full flag-gated substrate boot + claim + bootstrap-progress + admin diagnostic stack. What each piece does, what URL surfaces them, and how to verify a substrate-enabled harness end-to-end.

import { Aside } from '@astrojs/starlight/components';

The `PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE=1` opt-in gate **was removed** — the
Model B substrate now **always boots** in-process (verified: `in-process-status.ts`

* `share-finalize.ts` only mention the var in "the gate was removed" comments;
  no code reads `process.env.PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE` anymore, and
  `.env.local` setting it is a no-op). `substrateActive` is constant-`true` at
  runtime; it is `false` ONLY when a test forces `forceDisabledForTest`. So the
  diagnostic surfaces below are still real and useful, but the "set the env var
  and restart" framing throughout this page is stale — there is no flag to flip.
  Read the surfaces as "always-on diagnostics," not "flag-gated."

## What this is

The Model B substrate gives every workspace a per-harness Hyperbee +
Autobase substrate running in-process. Several diagnostic surfaces let
you verify the substrate is alive, ops are merging, and the orchestrator
is using the distributed claim engine.

The pieces are layered so each can be exercised in isolation. If you
have to debug a substrate problem, walk the layers top-down until you
find the one that's silent.

## The layers, top to bottom

### 1. `/admin/dogfood-substrate` — one URL to verify everything

SSR page that composes every diagnostic surface below. Shows:

* Top: `<SubstrateStatusBadge>` reflecting `enabled + bootedCount`.
* Table row per booted `(workspaceId, harnessSlug)` with:
  * `<BootstrapProgressIndicator>` (live merge progress)
  * `<ClaimAttemptStatsPill>` (won/lost/error counts)

If this page says "Substrate off," nothing else below it will produce
data — set the env var and restart.

### 2. `GET /api/admin/dogfood-substrate-status`

JSON read of the in-process boot map:

```json
{ "enabled": true,
  "booted": [{ "workspaceId": "ws-1", "harnessSlug": "papercup" }],
  "bootedCount": 1 }
```

Used by the admin page + `<SubstrateStatusBadgeClient slug={...}/>`
in chrome headers.

### 3. `GET /api/harness/:slug/bootstrap-progress`

Per-harness live merge progress:

```json
{ "progress": { "mergedOps": 7, "highestSeen": 12,
                "lastChangeMs": 1700000000000, "caughtUp": false }}
```

Drives `<BootstrapProgressIndicatorClient slug={...}/>`. Returns
`{ progress: null }` when the substrate hasn't recorded merge
activity for this harness yet — the client renders nothing in that
case (so the badge is invisible until there's something to show).

### 4. `GET /api/harness/:slug/claim-attempts`

Two read modes via query param:

* `?stats=1` → `{ stats: { total, won, lost, error } }`
* (default) → `{ attempts: ClaimAttemptRow[] }`

Reads `harness_shared.claim_audit`. Used by the admin page and any
debug surface that wants to see claim outcomes. Defensive against
missing table — returns empty / zero.

### 5. Orchestrator decision

Production claim path branches on `getClaimStrategy({ workspaceId,
harnessSlug })`:

* `'single-writer'` → legacy claim path (unchanged).
* `'distributed'` → `await attemptDistributedClaim({ ... })`.

`attemptDistributedClaim` returns one of three reasons:

* `'substrate-not-booted'` (handle missing) → caller falls back.
* `'pubkey-unresolved'` (handle present but `local.key` missing).
* `'attempted'` (real result; includes `won` + audit outcome).

### 6. Substrate boot

`bootHarnessSubstrate({ workspaceRoot, workspaceId, harnessSlug })`
(`packages/operator-core/lib/sync/hyperbee/boot.ts`):

1. Open per-harness corestore.
2. Build Autobase view with schema-version filter.
3. Register all per-table PG projection writers via
   `registerAllHarnessProjections` (`projections/register-all.ts` —
   the `buildHarnessProjections` array is the single source of truth
   for the set; it has grown well past the original 8, so trust the
   array, not any "N projections" comment).
4. Start `startBootstrapProgressPoller`. Polls `base.view.length`
   every 1s and calls `recordMergedOps`.

`close()` reverses in inverse order (poller stop → autobase close →
store close).

Boot is invoked during the join/default-boot wiring, gated by the env var.

## End-to-end verification checklist

1. (No flag to set — the substrate always boots.) Open
   `/admin/dogfood-substrate` — top badge should be green
   "Substrate live (N harnesses)".
2. Per-row bootstrap pill should appear once any ops merge.
3. Trigger a feature claim race. The claim-audit pill should grow
   `won` and (if multi-writer) `lost` counts.
4. Pick a slug → curl `/api/harness/<slug>/claim-attempts` — rows
   should match the pill.

## Gating (historical — the flag is gone)

**Update:** this section described the now-removed
`PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE` gate. With Model B / Stage 4d the
substrate always boots, so the "inert when unset" behavior no longer
exists. The orchestrator still falls back to the single-writer path
**per (workspace, harness) when a substrate handle is absent** —
`getClaimStrategy` returns `'distributed'` only when `getBootedHandle`
finds a booted handle, else `'single-writer'`, and `attemptDistributedClaim`
still returns `substrate-not-booted` when the handle is missing — but
that is now driven by boot success, not by a flag.
