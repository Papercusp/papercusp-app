-- 497-harness-features-shared-fallback-view.sql
--
-- WI-2668 — packaged/federated embedded operator lacks per-harness schemas, so
-- the legacy UNQUALIFIED `harness_features` name never resolves and PG logs
-- `relation "harness_features" does not exist` in a tight loop (measured: 644 of
-- the last 4000 server-log lines on the Mac dogfood VM — the single dominant log
-- error, a direct violation of the "no log errors" release bar).
--
-- ## Root cause
-- `getHarnessPg(slug)` (connection.ts) opens a per-harness client with a
-- CONNECT-TIME `search_path = [harness_<slug>, harness_shared, papercusp_shared,
-- public]` so that the ~20 legacy call sites issuing unqualified
-- `SELECT * FROM harness_features WHERE harness_slug = ?` resolve to
-- `harness_<slug>.harness_features` (connection.ts:611). On TOWER every harness
-- owns a real `harness_<slug>` schema, so the name resolves. On the PACKAGED /
-- FEDERATED operator (the shipping Mac/Windows app, and the dogfood VM) there are
-- NO per-harness schemas at all — the whole feature/work-item corpus lives in the
-- unified `harness_shared.work_items` table, surfaced feature-shaped through the
-- view `harness_shared.harness_features_consolidated`. With no `harness_<slug>`
-- schema in the search_path AND no `harness_shared.harness_features`, the
-- unqualified name is unresolvable and every poll (parseFeatures, features routes,
-- projects-data, promote-issue, …) throws server-side before the JS `try/catch`
-- can swallow it — a caught JS error still leaves a logged PG `ERROR:` line.
--
-- ## The fix
-- Provide the missing fallback relation: a pass-through VIEW
-- `harness_shared.harness_features` over `harness_features_consolidated`. Because
-- `harness_shared` is ALWAYS the next entry in every per-harness search_path,
-- the unqualified `harness_features` name now resolves EVERYWHERE:
--   • TOWER  — the real `harness_<slug>.harness_features` table comes FIRST in the
--     search_path and SHADOWS this view, so tower behaviour is byte-for-byte
--     unchanged (zero risk).
--   • PACKAGED / FEDERATED — no per-harness schema exists, so the name falls
--     through to this view, which filters by the caller's existing
--     `WHERE harness_slug = ?`. The query SUCCEEDS → no more `relation ... does
--     not exist` ERROR log line.
-- This is a schema COMPLETION of the unqualified-name contract that connection.ts
-- already documents, not a back-compat shim: on a consolidated-only operator,
-- `harness_features` SHOULD name the consolidated projection.
--
-- Read-only by design. The authoritative feature/work-item WRITE path on a
-- consolidated-only operator is `harness_shared.work_items` directly (the
-- work_items:* verbs; the mig-452 `capture_work_items_outbox` trigger rides
-- work_items, not this view). The legacy unqualified `harness_features`
-- INSERT/UPDATE/DELETE sites are TOWER's per-harness feature pipeline, which runs
-- against the real per-harness table (shadowing this view); they are not exercised
-- on the federated replica. If a write path is ever found to reach this view on a
-- consolidated-only operator it will fail LOUDLY (cannot modify a read-only view)
-- rather than silently — surfacing a real "writing features on a federated
-- replica" bug instead of masking it. That redirect (INSTEAD OF → work_items) is a
-- separate follow-up, intentionally out of scope for this log-spam fix.
--
-- View owner is the migration/admin role (RLS-bypassing), so underlying
-- work_items access is not workspace-filtered — the poll gets the same rows it
-- would from a per-harness table. Grants mirror `harness_features_consolidated`'s
-- SELECT grantees (harness_app — the per-harness client role — and harness_zero).
--
-- Idempotent: CREATE OR REPLACE VIEW + idempotent GRANTs. The runner provides the
-- transaction — NO BEGIN/COMMIT here (lint:migrations). `harness_features_consolidated`
-- exists (mig 142 work-items-unify + descendants); harness_app / harness_zero exist.

CREATE OR REPLACE VIEW harness_shared.harness_features AS
  SELECT * FROM harness_shared.harness_features_consolidated;

COMMENT ON VIEW harness_shared.harness_features IS
  'WI-2668 fallback: makes the legacy unqualified `harness_features` name resolve on '
  'consolidated-only (packaged/federated) operators that have no per-harness '
  '`harness_<slug>` schema. On tower the per-harness table shadows this view in the '
  'search_path, so tower is unaffected. Read-only; feature writes go through '
  'harness_shared.work_items.';

GRANT SELECT ON harness_shared.harness_features TO harness_app;
GRANT SELECT ON harness_shared.harness_features TO harness_zero;
