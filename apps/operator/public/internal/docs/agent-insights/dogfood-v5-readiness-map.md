# Dogfood v5 readiness map — what's wired, what's gated, what's user-driven
URL: /internal/docs/agent-insights/dogfood-v5-readiness-map

Concrete index of every Phase 5a / 5b / 6 / 8 / 9 surface shipped during the autonomous loop. For each plan item — file path, test coverage, and the exact condition that activates it.

## How to read this

Three categories per item:

* **Wired** — code shipped + tested + idempotently dormant until the gate flips.
* **Gated** — wired, but never actually fires until `PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE=1`.
* **User-driven** — requires a behavioural decision (e.g. "run a feature", "deploy Cupboard") only the user can make.

Path convention below (updated post-`operator-core` extraction): UI surfaces
(`app/**/*.tsx`, `scripts/*`) are in **`apps/operator/`**; every non-`app`
`lib/**` path moved to **`packages/operator-core/lib/**`** (so `lib/sync/hyperbee/…`
→ `packages/operator-core/lib/sync/hyperbee/…`, `lib/orchestrator/…`,
`lib/harness-insights/…`, `lib/user-profile/…`, etc.). Routes are HTTP paths
registered in `packages/operator-core/lib/endpoint-route/routes/index.ts`. The
`instrumentation-node.ts` boot-wiring rows are **retired** (the Next.js
instrumentation hook is gone) — see the Phase-5a note below.

## Phase 5a — Substrate boot

| Status            | What                                                             | Where                                                                          |
| ----------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Wired (always-on) | Boot wiring                                                      | `apps/operator/bin/host-bootstrap.ts` (was `instrumentation-node.ts`, retired) |
| Wired             | Boot composer                                                    | `lib/sync/hyperbee/boot.ts`                                                    |
| Wired             | Boot orchestrator (idempotent map, inflight races)               | `lib/sync/hyperbee/boot-all.ts`                                                |
| Wired             | Status enumerator                                                | `listBootedHandles` in `boot-all.ts`                                           |
| Wired             | Boot-history tracker (event timeline, FIFO 200-entry)            | `lib/sync/hyperbee/boot-history.ts`                                            |
| Wired             | Admin status endpoint                                            | `GET /api/admin/dogfood-substrate-status`                                      |
| Wired             | Admin boot-history endpoint                                      | `GET /api/admin/dogfood-substrate-boot-history`                                |
| Wired             | Pure-UI status pill                                              | `app/harness/insights/SubstrateStatusBadge.tsx`                                |
| Wired             | Polling client                                                   | `app/harness/insights/SubstrateStatusBadgeClient.tsx`                          |
| Wired             | Boot-history table                                               | `app/harness/insights/BootHistoryTable.tsx`                                    |
| Wired             | Boot-history table client                                        | `app/harness/insights/BootHistoryTableClient.tsx`                              |
| Wired             | Admin diagnostic page (3 indicators + main table + boot-history) | `app/admin/dogfood-substrate/page.tsx`                                         |
| Wired             | Combined health verdict                                          | `lib/sync/hyperbee/health.ts`                                                  |
| Wired             | Workspace summary aggregator (worst-verdict + counts)            | `lib/sync/hyperbee/summary.ts`                                                 |
| Wired             | Health endpoint (returns summary + harnesses)                    | `GET /api/admin/dogfood-substrate-health`                                      |
| Wired             | Health pill                                                      | `app/harness/insights/SubstrateHealthPill.tsx`                                 |
| Wired             | Health pill client                                               | `app/harness/insights/SubstrateHealthPillClient.tsx`                           |
| Wired             | Workspace summary card                                           | `app/harness/insights/SubstrateSummaryCard.tsx`                                |
| Wired             | Workspace summary card client                                    | `app/harness/insights/SubstrateSummaryCardClient.tsx`                          |
| Wired             | CLI verdict formatter (pure logic)                               | `lib/sync/hyperbee/format-cli.ts`                                              |
| Wired             | CLI script                                                       | `scripts/substrate-status.ts` (`npm run substrate:status`)                     |
| Wired             | In-process composer (non-HTTP callers)                           | `lib/sync/hyperbee/in-process-status.ts`                                       |
| Gated             | Real boot succeeds                                               | only with flag on + valid workspace                                            |

## Phase 5b — Hyperbee UI integration

| Status             | What                                    | Where                                                       |
| ------------------ | --------------------------------------- | ----------------------------------------------------------- |
| Wired              | Bootstrap-progress tracker (pure logic) | `lib/sync/hyperbee/bootstrap-progress.ts`                   |
| Wired              | Bootstrap-progress poller               | `lib/sync/hyperbee/bootstrap-progress-poller.ts`            |
| Wired (in boot.ts) | Poller start/stop lifecycle             | `boot.ts` `startBootstrapProgressPoller`                    |
| Wired              | Bootstrap-progress endpoint             | `GET /api/harness/:slug/bootstrap-progress`                 |
| Wired              | Bootstrap-progress indicator            | `app/harness/insights/BootstrapProgressIndicator.tsx`       |
| Wired              | Bootstrap-progress indicator client     | `app/harness/insights/BootstrapProgressIndicatorClient.tsx` |
| Gated              | Real merge counts > 0                   | only with flag on AND active substrate ops                  |

## Phase 6 — Distributed claim

| Status      | What                                            | Where                                                                        |
| ----------- | ----------------------------------------------- | ---------------------------------------------------------------------------- |
| Wired       | Claim-handle adapter (substrate → orchestrator) | `lib/orchestrator/claim-handle-adapter.ts`                                   |
| Wired       | Claim handle lookup                             | `lib/orchestrator/get-claim-handle.ts`                                       |
| Wired       | Distributed-claim wrapper                       | `lib/orchestrator/distributed-claim.ts`                                      |
| Wired       | Strategy decision helper                        | `lib/orchestrator/get-claim-strategy.ts`                                     |
| Wired       | Claim audit reader                              | `lib/orchestrator/load-claim-attempts.ts`                                    |
| Wired       | Claim-attempts endpoint                         | `GET /api/harness/:slug/claim-attempts`                                      |
| Wired       | Claim attempt stats pill                        | `app/harness/insights/ClaimAttemptStatsPill.tsx`                             |
| Wired       | Claim attempt stats pill client                 | `app/harness/insights/ClaimAttemptStatsPillClient.tsx`                       |
| User-driven | Production orchestrator wiring                  | swap `claim_feature` for `if (getClaimStrategy() === 'distributed') { ... }` |

## Phase 8 — Sidebar, Insights, Profile

### Visual primitives

| Item                               | File                                                     | Tests   |
| ---------------------------------- | -------------------------------------------------------- | ------- |
| P-069a `ClaimStatusBadge`          | `app/_components/ClaimStatusBadge.tsx`                   | shipped |
| `BindingStatusBadge`               | `app/_components/BindingStatusBadge.tsx`                 | shipped |
| P-071 `ContributorBadge`+Row       | `app/_components/ContributorBadge.tsx`                   | shipped |
| P-069b `SettingsBanner`            | `app/harness/SettingsBanner.tsx`                         | 8       |
| P-069c `ExistingBindingAlert`      | `app/harness/ExistingBindingAlert.tsx`                   | 9       |
| P-069d `ProvisionalOwnerExplainer` | `app/_components/ProvisionalOwnerExplainer.tsx`          | 8       |
| P-069e `ClaimCTA`                  | `app/harness/ClaimCTA.tsx`                               | 10      |
| P-049 `PrReviewerSettings` modal   | `app/harness/PrReviewerSettings.tsx`                     | 14      |
| P-049 trigger                      | `app/harness/PrReviewerSettingsTrigger.tsx`              | 6       |
| P-048 `ContributorsTab`            | `app/harness/ContributorsTab.tsx` + `ContributorRow.tsx` | 13      |

### Insights tab — pure UI

| Card                         | File                                          | Tests |
| ---------------------------- | --------------------------------------------- | ----- |
| P-073a `ProjectCard`         | `app/harness/insights/ProjectCard.tsx`        | 8     |
| P-073b `ActivityFeedCard`    | `app/harness/insights/ActivityFeedCard.tsx`   | 10    |
| P-073c `PeopleCard`          | `app/harness/insights/PeopleCard.tsx`         | 10    |
| P-073d `YourPlaceCard`       | `app/harness/insights/YourPlaceCard.tsx`      | 10    |
| P-073e `HowItWorksHereCard`  | `app/harness/insights/HowItWorksHereCard.tsx` | 11    |
| P-073f `SpendCard` (Tier D)  | `app/harness/insights/SpendCard.tsx`          | 10    |
| P-073 `InsightsTab` assembly | `app/harness/insights/InsightsTab.tsx`        | 1     |

### Insights tab — data layer

| Loader              | File                                      | Tests |
| ------------------- | ----------------------------------------- | ----- |
| Activity            | `lib/harness-activity/load.ts`            | 9     |
| People              | `lib/harness-insights/load-people.ts`     | 7     |
| YourPlace           | `lib/harness-insights/load-your-place.ts` | 7     |
| Spend               | `lib/harness-insights/load-spend.ts`      | 6     |
| All-in-one composer | `lib/harness-insights/load-all.ts`        | 5     |

### Insights tab — routes + pages + clients

| Surface        | Path                                                   |
| -------------- | ------------------------------------------------------ |
| JSON           | `GET /api/harness/:slug/insights`                      |
| JSON           | `GET /api/harness/:slug/activity`                      |
| SSR            | `/harness/:slug/insights`                              |
| Client wrapper | `app/harness/insights/InsightsTabClient.tsx` (6 tests) |

### Phase 8 P-074 — first-visit gate (end-to-end)

| Item              | Where                                                       |
| ----------------- | ----------------------------------------------------------- |
| Helpers           | `lib/harness-insights/first-visit.ts` (10 tests)            |
| Endpoints         | `GET/POST /api/harness/:slug/insights-first-visit`          |
| Client gate       | `app/harness/insights/InsightsFirstVisitGate.tsx` (7 tests) |
| SSR mark-on-visit | `/insights/page.tsx` calls `markInsightsSeen`               |

### Phase 8 P-072 — user profile (real data)

| Item                                                        | Where                                         |
| ----------------------------------------------------------- | --------------------------------------------- |
| PG loader (header + per-harness + claimed + privacy filter) | `lib/user-profile/load.ts` (10 tests)         |
| Cross-harness recent activity loader                        | `lib/user-profile/load-activity.ts` (7 tests) |
| Canonical SSR page                                          | `app/users/github/[id]/page.tsx`              |
| Username redirect                                           | `app/users/[login]/page.tsx`                  |
| JSON endpoint                                               | `GET /api/users/github/:id`                   |
| Marketplace `publishedBy` link → Papercusp profile          | `app/marketplace/[slug]/page.tsx`             |

## Chrome composers

| Component                   | What it bundles                                                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `HarnessChromeHeaderBadges` | `SubstrateStatusBadgeClient` + `SubstrateHealthPillClient` + `BootstrapProgressIndicatorClient` + (opt-in) `ClaimAttemptStatsPillClient` |

Drop into the harness chrome header for the full substrate view. Each
child toggleable via `hideSubstrateBadge` / `hideHealthPill` /
`hideBootstrapProgress` / `hideClaimStats` (default true).

## Pure-UI ↔ client wrapper symmetry

Every dogfood pure-UI component now has a self-fetching client wrapper:

| Pure UI                      | Client                             |
| ---------------------------- | ---------------------------------- |
| `SubstrateStatusBadge`       | `SubstrateStatusBadgeClient`       |
| `SubstrateHealthPill`        | `SubstrateHealthPillClient`        |
| `BootstrapProgressIndicator` | `BootstrapProgressIndicatorClient` |
| `SubstrateSummaryCard`       | `SubstrateSummaryCardClient`       |
| `BootHistoryTable`           | `BootHistoryTableClient`           |
| `ClaimAttemptStatsPill`      | `ClaimAttemptStatsPillClient`      |
| `InsightsTab`                | `InsightsTabClient`                |

Any consumer drops a surface into any client-rendered context with
zero data-fetch boilerplate.

## Pure-logic primitives (always live, not gated)

| Helper                                              | Where                                     |
| --------------------------------------------------- | ----------------------------------------- |
| `assessHarnessSubstrateHealth`                      | `lib/sync/hyperbee/health.ts`             |
| `summariseWorkspaceSubstrate`                       | `lib/sync/hyperbee/summary.ts`            |
| `attemptDistributedClaim`                           | `lib/orchestrator/distributed-claim.ts`   |
| `getClaimStrategy`                                  | `lib/orchestrator/get-claim-strategy.ts`  |
| `recordBootEvent` / `listBootHistory`               | `lib/sync/hyperbee/boot-history.ts`       |
| `recordMergedOps` / `getBootstrapProgress`          | `lib/sync/hyperbee/bootstrap-progress.ts` |
| `formatSubstrateStatus` (CLI verdict formatter)     | `lib/sync/hyperbee/format-cli.ts`         |
| `loadUserProfile` + `loadUserRecentActivity`        | `lib/user-profile/`                       |
| `loadHarnessInsights`                               | `lib/harness-insights/load-all.ts`        |
| `loadHarnessActivity`                               | `lib/harness-activity/load.ts`            |
| `loadRecentClaimAttempts` + `loadClaimAttemptStats` | `lib/orchestrator/load-claim-attempts.ts` |

Every loader takes an injectable `runQuery` so tests fake PG. Every
loader is defensive against missing tables (returns empty / zero
shape rather than throwing). Test seams (`_setNowForTests`,
`_resetForTests`) on every in-memory tracker.

## Gated by `PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE=1`

> **Update (2026-06):** This gate is **removed** — the
> `PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE` opt-in was dropped in the Model-B
> substrate rewrite (Stage 4d). The per-peer-log substrate **always boots**
> from `apps/operator/bin/host-bootstrap.ts` now (not `instrumentation-node.ts`,
> retired); there is no longer a "Gated" tier. The items below still describe
> *what activity writes which rows*, but none of it is flag-gated any more.

* Substrate boot in `apps/operator/bin/host-bootstrap.ts` (always-on).
* `bootstrap-progress` records (poller only runs after boot).
* `claim-audit` rows (only the distributed-claim path writes them).
* Real claim races (only `attemptDistributedClaim` triggers them).

## User-driven

* Phase 4 P-026: run a feature end-to-end on the dogfood harness.
* Phase 9 P-051b: deploy Cupboard server (DNS + Cloudflare credentials).
* Swap `InsightsPanel` → `InsightsTabClient` in HarnessDashboard (UI verification).
* Wire `HarnessChromeHeaderBadges` into the harness chrome header.
* Wire `attemptDistributedClaim` into the production orchestrator path.

## Verification flow once flag is on

1. `/admin/dogfood-substrate` → green pill + at least one row per booted harness.
2. Each row's health verdict → `healthy`.
3. After ANY substrate activity → bootstrap-progress shows merge count.
4. After ANY claim attempt → claim-attempt-stats pill grows.
5. `<HarnessChromeHeaderBadges slug={...} />` in a header → three live pills.
