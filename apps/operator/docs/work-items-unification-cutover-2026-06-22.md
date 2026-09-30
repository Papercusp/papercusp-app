# Work-item unification cutover (P-010) — execution blueprint

**Owner-attended cutover, being executed autonomously (owner asleep, full autonomy 2026-06-22).**
This is the "deferred tail #4" mig-159 flagged: make `harness_shared.work_items` the TRUE base
table, collapsing `harness_features_consolidated` (feature|research-task|chunk) + `engineer_issues`
(bug|change|task) into one row-space. Built + tested in **fresh testcontainer DBs**; activated only
through the **green-gated pipeline** (never a manual apply to the shared DB).

## Hard facts (verified via psql 2026-06-22)
- `harness_features_consolidated` PK = `(harness_slug, feature_id)`, both `NOT NULL`. ~47 cols + `item_kind` (default 'feature') + `payload jsonb` + `requeue_count`. Indexes: `hfc_item_kind_idx (workspace_id, harness_slug, item_kind)`, assignee_rank, design_status, etc.
- `engineer_issues` (mig 131 + 142/152 `kind`/`payload` + 197 `fed_ts` + `assigned_by`/`assigned_at`): PK `(workspace_id, issue_id)`, **no inbound FKs** (rides `coord_*`), **no RLS** (BYPASSRLS + in-query filter — the F7 target posture). Cols: workspace_id, issue_id, scope, title, body, severity, source, state, assignee, assigned_by, assigned_at, found_during, linked_feature_id, created_by, created_at, updated_at, author_pubkey, origin, fed_ts, kind, payload, _search(generated).
- `work_items` is currently a **VIEW** (relkind 'v') — UNION over both tables + INSTEAD OF DML (mig 159).
- Row counts: **769 features, 2837 issues**.
- Federation captures (both → `substrate_outbox`, keyed on `TG_TABLE_NAME`): features via baseline `capture_substrate_outbox` (harness_slug direct); issues via mig-197 `capture_engineer_issues_outbox('issue_id')` (derives slug from `scope`: `harness:X`→X, `operator`→workspace's single pot home, else local; stamps `harness_slug` into the wire row). Read-side: `projections/harness-features.ts` + `projections/engineer-issues.ts`, mapped by `PEER_LOG_TAG_TO_TABLE` + `feature-issue-op-keys.ts` + `table-registry.ts`.
- `emit_change_notify` (mig 368) — the generic sync-invalidate trigger; rename carries it on the feature side; issue side needs it added on the unified table.

## Resolved design decisions
- **D-U1 — PK / operator-scope NULL problem.** Keep PK `(harness_slug, feature_id)`. Operator-scoped issues (mig-159 mapped `scope='operator'`→NULL harness_slug) get **papercup `harness_slug=''`** (empty, NOT NULL — hfc has no harness_slug-nonempty CHECK, only workspace_id). The `engineer_issues` compat view maps `harness_slug=''`→`scope='operator'`, `harness_slug=<x>`→`scope='harness:'||x`. Per-harness reads (`WHERE harness_slug=$1`) still exclude operator rows ($1 is a real slug). Must grep for any `harness_slug IS NULL` reader (NULL→'' semantic change) before activating.
- **D-U2 — payload carries issue-only columns.** Backfill stuffs `severity, source, found_during, linked_feature_id, created_by, assigned_by, scope, fed_ts` into `payload` (jsonb) on the unified row; the `engineer_issues` compat view extracts them back (`payload->>'severity'` etc.). Common cols map per mig-159 (issue_id→feature_id, body→summary, state→status, assignee→taken_by, assigned_at→taken_at, kind→item_kind, created_at/updated_at→created_ts/updated_ts epoch-ms).
- **D-U3 — compat views, not drops.** Recreate `harness_features_consolidated` + `engineer_issues` as **views** over `work_items` (filtered by item_kind) with INSTEAD OF INSERT/UPDATE/DELETE triggers → keeps the ~110 + ~48 read sites + non-ON-CONFLICT writers working unchanged.
- **D-U4 — ON CONFLICT writers are the atomic-coupling.** `ON CONFLICT` can't target a view, so the engine writers that upsert `harness_features_consolidated`/`engineer_issues` (work-items.ts + a handful) must switch to `work_items` base **exactly when** the migration applies. This is the only code that can't straddle both schema states → the cutover (migration + these writers) lands as one unit.
- **D-U5 — unified federation capture.** One `capture_substrate_outbox`-style trigger on `work_items`: feature-kinds use `harness_slug` direct; issue-kinds (harness_slug=''/operator) reuse the mig-197 scope/pot-home derivation. Stamp a stable `table_name` ('work_items') and demux read-side by `item_kind`. Update `harness-features.ts`/`engineer-issues.ts` projections + `feature-issue-op-keys.ts` + `PEER_LOG_TAG_TO_TABLE` + `table-registry.ts` to the unified table. **Highest-risk piece — test the two-peer round-trip (per the hyperbee `__tests__` rigs) for BOTH families.**
- **D-U6 — one RLS posture.** No row-level RLS on `work_items` (drop hfc's if present); all access is BYPASSRLS + in-query `workspace_id` filter (matches issues, F7).

## Build phases (each tested in a fresh DB before the next; migration stays `_DRAFT-…sql` — non-applying — until the whole unit is green, then renamed to `374-work-items-unify-base-table.sql`)
1. **Schema migration** — drop view; `ALTER TABLE hfc RENAME TO work_items`; backfill 2837 issues (D-U1/D-U2 mapping); recreate hfc+ei compat views + INSTEAD OF triggers (D-U3); add `emit_change_notify` + indexes; RLS posture (D-U6). Test: applies clean on a fresh DB seeded with both families; backfill row-count + spot-checked mapping; compat-view SELECT round-trips bit-identically; INSTEAD OF INSERT/UPDATE/DELETE route correctly.
2. **ON CONFLICT writers** (D-U4) — repoint the engine upserts to `work_items`. Test: work-items.ts integration suite green against the migrated schema.
3. **Federation + CDC** (D-U5) — unified capture trigger + projection/op-key/registry updates. Test: two-peer capture→outbox→apply round-trip for a feature AND an issue (incl. operator-scope).
4. **Full sweep** — `npm run test:all:integration`; grep+fix any `harness_slug IS NULL` / hard-coded `item_kind IN (feature,…)` reader; `pull-schema.mjs`.
5. **Activate** — rename `_DRAFT`→`374-…`; the green gate (test:all:integration) blocks the deploy unless every phase is green, giving atomicity (incomplete = red = no deploy). Brief (~15 min) old-code-vs-new-schema window on `:3070` until the green deploy ships the writers — transient/loud/self-healing (acceptable per owner's "don't worry about breaking").

## Safety invariants (unsupervised)
- Never `psql`-apply the migration to the shared `:5432` DB; only the green-gated pipeline applies it.
- Keep the migration a `_DRAFT-` (non-numbered → runner skips it) until the whole cutover is built + green.
- Test every phase in fresh testcontainer DBs.
- If a phase can't be made green/correct with confidence, STOP, record on P-010, leave the draft staged, and report for the supervised final apply.
