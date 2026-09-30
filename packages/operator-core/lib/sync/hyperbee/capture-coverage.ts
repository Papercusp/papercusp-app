/**
 * capture-coverage — the write-side capture inventory for the Model B substrate
 * (shared-hive-hardening-2026-06-13 P-011).
 *
 * Every `sync:'peer-log'` table (the registry's federated set, `PEER_LOG_TABLES`)
 * must have EXACTLY ONE producer that puts its local writes onto the peer-log:
 *
 *   - PG-FIRST (CDC): a `capture_substrate_outbox` / `capture_hive_members_outbox`
 *     trigger enqueues local writes into `substrate_outbox`; the drain
 *     (`outbox-drain.ts`) appends them to the own Hypercore log. The set is
 *     `CDC_CAPTURED_TABLES` (derived from the drain's `TABLE_NAME_TO_TABLE_TAG`).
 *   - LOG-FIRST: the application appends the op DIRECTLY to the own log; PG state
 *     is materialized purely from the read-merge. The set is
 *     `LOG_FIRST_PRODUCED_TABLES` (each entry names its producer fn).
 *   - ACCEPTED-UNFEDERATED: classified `sync:'peer-log'` but intentionally NOT
 *     produced, with a documented reason (`ACCEPTED_UNFEDERATED_TABLES`).
 *
 * `checkPeerLogConsistency` (harness-state) already guards the READ side
 * (registry ↔ projection tags). This is its WRITE-side dual: it catches the
 * EI-382 class at the data layer — a NEW federated table added to the registry
 * with a read projection but NO producer would silently never federate (its
 * local writes drop on the floor). The unit test (`__tests__/capture-coverage.
 * test.ts`) pins `checkSubstrateCaptureCoverage().ok`, so that omission fails CI.
 *
 * Substrate-free split (mirrors `checkPeerLogConsistency`): the pure invariant
 * lives in `harness-state/projection-engine.ts` (`checkCaptureCoverage`, params
 * only); the canonical SETS — which live next to the producers — live here.
 */

import { PEER_LOG_TABLES } from '../../harness-state/table-registry';
import { checkCaptureCoverage, type CaptureCoverage } from '../../harness-state/projection-engine';
import { CDC_CAPTURED_TABLES } from './feature-issue-op-keys';

/**
 * PG tables whose LOCAL writes reach the peer-log by a DIRECT `ownLog.append` in
 * application code — NOT a `substrate_outbox` CDC trigger. Value = the producer
 * fn(s), so a reader can find the write site. A table here MUST NOT also appear
 * in `CDC_CAPTURED_TABLES` (a PG-first table's own-log op is a replay of a row PG
 * already authored — the EI-117 echo-storm shape; `checkCaptureCoverage` flags
 * any such double-capture).
 */
export const LOG_FIRST_PRODUCED_TABLES: Readonly<Record<string, string>> = {
  feature_claims: 'orchestrator/feature-claim.ts claimFeature → ownLog.append',
  feature_queue: 'sync/hyperbee/write-feature-queue.ts enqueueFeature/dequeueFeature → handle.append',
  feature_working_set: 'sync/hyperbee/write-working-set.ts setActiveFeature/clearActiveFeature → handle.append',
  contributors: 'sync/hyperbee/write-contributor-row.ts publishContributorRow → handle.append',
  shared_presence: 'sync/hyperbee/presence-announce.ts announceLocalPresence → handle.append',
};

/**
 * Tables the registry classifies `sync:'peer-log'` but which are intentionally
 * NOT produced onto the peer-log — a documented, accepted gap (NOT the EI-382
 * bug). Each entry MUST carry the reason it is safe to leave unfederated.
 *
 * Currently EMPTY. `harness_feature_prs` was the sole entry — a Phase-5a
 * aspiration to move PR state onto Hyperbee — but it never had a producer (no
 * CDC trigger, no log-first append; the poll daemon was never built), so the
 * projection never fired. EI-479 retired that orphan projection + reclassified
 * the table `sync:'none'` (PR state is GitHub-derived + re-polled per-machine,
 * so PG is the local store-of-record and federation is redundant). A new entry
 * here would name a genuinely `sync:'peer-log'` table that is deliberately left
 * unproduced, with the reason it is safe.
 */
export const ACCEPTED_UNFEDERATED_TABLES: Readonly<Record<string, string>> = {};

/**
 * The bound coverage check for the live substrate: assert every `PEER_LOG_TABLES`
 * entry has exactly one producer (CDC trigger, log-first append, or a documented
 * accepted-unfederated entry) and that no producer points at a non-federated
 * table. `.ok === true` is the invariant the unit test pins.
 */
export function checkSubstrateCaptureCoverage(): CaptureCoverage {
  return checkCaptureCoverage(
    PEER_LOG_TABLES,
    CDC_CAPTURED_TABLES,
    Object.keys(LOG_FIRST_PRODUCED_TABLES),
    Object.keys(ACCEPTED_UNFEDERATED_TABLES),
  );
}
