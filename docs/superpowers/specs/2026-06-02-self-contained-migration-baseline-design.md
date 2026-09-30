# Design — Self-contained migration baseline + `ensure-schema` removal + integration-test tier

**Date:** 2026-06-02
**Author:** psu engineer session
**Status:** Approved (design); implementation plan to follow via writing-plans
**Related plan items:** `production-readiness-test-coverage-2026-05-30` — **D-005** (fresh-migrate gate / owed baseline rebuild), **P-002** (integration globalSetup), **P-015/016/017** (integration tool-suites), **P-006** (run full suite once)

---

## 1. Problem

The Papercup schema is built by **two un-unified sources**, so applying migrations to an
empty Postgres does **not** produce a working schema:

1. **Hand-written SQL migrations** (`libs/papercusp/libs/db/sql/*.sql`, 115 files) — applied by
   the runner (`embedded-postgres-server/src/migration-runner.js`). These build only a fraction
   of `harness_shared`.
2. **`ensure-schema.ts`** (operator, ~2,150 lines; + `ensure-schema-dogfood.ts` ~836 lines;
   + an inline CREATE in `autoloop.ts`) — **idempotent `CREATE TABLE IF NOT EXISTS`** run
   **lazily at runtime**, each consumer module ensuring its own table on first use. This creates
   **~78 `harness_shared` tables**, plus **62 indexes, 43 ALTERs, 6 RLS policies, 1 trigger**.
   Restricted to `harness_shared` (runtime roles can DDL there but not per-harness schemas).

Two further artifacts are **downstream reflections**, not sources of truth:
- **Drizzle** (`schema.ts`, `generated.reference.sql`) — `drizzle-kit pull` (introspect) against
  the live DB, for TS types + Zod. `drizzle.config.ts` forbids `generate`/`push`.
- **Seed dump** (`PAPERCUSP_PG_SEED_DUMP_PATH`) — a `pg_dump` restored on fresh embedded-pg
  installs, after which migrations are pre-marked applied (the production fast-boot path).

### Why this blocks test coverage

The integration-test tier wants a Vitest `globalSetup` that stands up a real Postgres and builds
the **full schema once per run**. That is impossible while half the schema lives in lazy,
scattered runtime TypeScript. Concretely, `apps/operator/test/fresh-migrate.integration.test.ts`
is a *tripwire* asserting the current failure (empty→head does not complete). It blocks
**P-002**, which blocks **P-015/016/017** and **P-006**.

### Investigation findings (2026-06-02, empty→head against a scratch DB)

- **105 migrations applied OK**, **6 skipped** via the runner's `42P01`-tolerance, **3 re-thrown
  failures**.
- The 3 re-thrown: `016-harness-admin-bypassrls` (**probe artifact** — `ALTER ROLE … BYPASSRLS`
  needs a real superuser; the boot/testcontainers run as one); `098-auditor-g2-admission`
  (**cascade** of `097`, which fails on `feature_queue` — an ensure-schema table); `081-memory-canonical`
  (**real-ish** — `060` creates the `vector` extension but `081` can't resolve the unqualified
  type; search_path/extension-schema issue).
- The 6 `42P01` skips point at the core of D-005: tables created by `ensure-schema`, not migrations
  (`harness_experts`, `operator_turns`, `harness_decisions`, `autoloop_state`, `feature_queue`;
  `memory_canonical` is a cascade of `081`).
- **`ensure-schema` creates ~78 tables out-of-band** — the 6 that *surface* are only those a later
  migration happens to `ALTER`; the rest are simply absent from a migration-built schema.

> This is exactly the design fork D-005 named: *rebuild the migration set so it is self-contained,
> OR formally bless seed-restore as the only supported path.* This design takes the **rebuild**.

---

## 2. Goal & success criteria

Make the **migration set the single source of truth** for the `harness_shared` (+ `papercup_shared`)
schema, and unblock + populate the integration-test tier.

**Done when:**
1. `empty PG → apply migrations → head` builds the **complete** schema (matches a fully-booted
   operator's schema), is **idempotent** on re-run, and records one tracker row per migration.
2. `ensure-schema.ts` + `ensure-schema-dogfood.ts` + the `autoloop` inline CREATE + all 54 operator
   call sites are **deleted**; the app boots and works without them.
3. `fresh-migrate.integration.test.ts` is the **STRICT SUCCESS GATE** (not the failure tripwire).
4. Seed-restore path is **retired** (the single idempotent baseline is the fresh-boot path).
5. Drizzle types refresh cleanly from the baseline-built schema.
6. **P-002** integration `globalSetup` builds the full schema; **P-015/016/017** tool-suite tests
   are authored and green.
7. Governance documented: schema changes are migrations only; no runtime DDL.

---

## 3. Decisions (locked with the user)

| # | Decision | Choice |
|---|---|---|
| D1 | Restructure strategy | **Squash** to one idempotent baseline; archive 001–103 |
| D2 | Fate of `ensure-schema` | **Delete entirely** (operator code; generic-lib ensure APIs stay) |
| D3 | Scope | **Full** — through authoring the P-015/016/017 tool-suite tests |
| D4 | Baseline generation | **Clean reference build (B)** — apply migrations + invoke all ensures → `pg_dump` |
| D5 | Seed dump | **Retire** the seed-restore path (baseline is the fast fresh-boot path) |

---

## 4. Phased design

### Phase 0 — Reference-build generator (the oracle)

New generator at `libs/papercusp/libs/db/scripts/build-reference-schema.*` (sibling to
`pull-schema.mjs`):

1. Scratch PG; create framework roles + the three extensions the migrations use —
   `pgcrypto` (027/039), `pg_trgm` (059), `vector` (060).
2. Apply all 115 current migrations in order (tolerating current `42P01` skips).
3. Invoke **all 65 `ensureXxx()`** + the dogfood/autoloop ensures so every table/index/policy exists.
4. `pg_dump --schema-only --schema=harness_shared --schema=papercup_shared`.
5. **Sanitize → idempotent**: `CREATE TABLE/INDEX IF NOT EXISTS`, `DROP POLICY IF EXISTS` + `CREATE
   POLICY`, DO-block guards; strip ownership/GRANT/role noise.

→ `libs/papercusp/libs/db/sql/000-baseline.sql`.

**Open implementation question (resolve first in the plan):** step 3 needs the operator's module
resolution (`@papercusp/*` + `@/` aliases). Options: a `tsx` codegen entrypoint inside
`apps/operator` that imports all 65 exported functions; or boot an operator sidecar against the
scratch DB and trigger an ensure-all path. Mechanism choice does not alter the design shape.

### Phase 1 — Land the baseline (app still works)

- Add `000-baseline.sql`; move the 115 incremental files (the `001`–`103` numbering range, incl.
  lettered sub-files) → `sql/archive/` (readable, out of the runner glob). **Keep**
  `002-per-harness-template.sql` (separate per-harness mechanism — already skipped by the runner's
  filename filter). New migrations continue at `104+`. Archived `040-plugin-configs-backfill.sql`
  (MANUAL_ONLY data backfill) is historical.
- Move framework-role + extension + `BYPASSRLS` setup into the embedded-pg **boot** pre-migration
  step (cluster-level, not in a schema-only dump).
- **🔒 Verification gate (linchpin):** build a fresh DB from `000-baseline.sql` alone, dump it, and
  **schema-diff** against the reference-built DB (migra or normalized-pg_dump diff). Must be
  **identical**. Only a clean diff authorizes Phase 2.
- `ensure-schema` still present → harmless no-ops. **Deployed DBs are safe** — the idempotent
  baseline no-ops on already-populated live/embedded DBs and is just marked applied. Commit.

### Phase 2 — Delete `ensure-schema` (proven redundant)

- Remove `ensure-schema.ts` + `ensure-schema-dogfood.ts` + the `autoloop.ts` inline CREATE + all
  **54 call sites** (each an `await ensureXxx()` guard → delete line + import).
- **Scope guard:** operator code only. The generic borrowable libs (`@papercusp/coordination/*`)
  keep their ensure APIs (other host projects consume them); the operator simply stops calling them.
- Remove the runner's `42P01`-tolerance → empty→head must apply with **zero skips**.
- Re-verify: Tauri desktop boot + smoke per `/internal/docs/testing` + `agent-e2e` (app works with
  no lazy ensures).

### Phase 3 — Strict gate + regen + governance

- Replace the `fresh-migrate.integration.test.ts` tripwire with the **STRICT SUCCESS GATE** already
  sketched in that file (clean apply + idempotent re-run + one tracker row each).
- Refresh Drizzle via `pull-schema.mjs` against a baseline-built DB (expected ≈ no-op diff).
- **Retire seed-restore** (`PAPERCUSP_PG_SEED_DUMP_PATH`): remove the seed-restore branch from the
  embedded-pg boot; the single idempotent baseline is the fresh-boot path.
- Governance docs: schema changes = a new migration (`104+`), **no runtime DDL**, run `pull-schema.mjs`
  after migrating. Update `storage-policy.mdx` + `CLAUDE.md` + testing docs (new-table dev workflow:
  "add an ensure fn" → "add a migration").

### Phase 4 — Integration tier (the payoff)

- **P-002:** Vitest `globalSetup` boots a testcontainers PG, applies `000-baseline.sql` (+ roles +
  extensions) once per run → full schema for the tier.
- **P-015/016/017:** author the integration tool-suite tests on top of the working globalSetup.

---

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Baseline misses something `ensure-schema` made → silent breakage after deletion | **Phase-1 schema-diff gate** must be identical before any deletion |
| Concurrent churn in `sql/` + `libs/papercusp` submodule (097/098 fixes landing now) | `coord:declare-intent` + `locks:acquire` on `sql/` during the squash; freeze 001–103 only after churn settles |
| `vector`/extension ordering on fresh boot | Boot creates extensions before migrations; baseline tables reference them post-extension |
| Deployed DBs re-running the baseline | Baseline is fully idempotent (`IF NOT EXISTS` / `DROP…CREATE POLICY`) → no-op on populated DBs |
| Retiring seed-restore slows fresh boot | One ~125-CREATE idempotent file is fast; measure boot time; keep regenerated dump as fallback only if measurably needed |
| 54 call-site removal introduces a missed `await` race | Per-file review + Tauri smoke + `test:affected`; the tables exist before any query now |

---

## 6. Testing

- **Unit:** baseline sanitizer (idempotency transform).
- **Integration:** the STRICT SUCCESS GATE (empty→head clean + idempotent + tracker rows); the
  Phase-1 schema-diff as a one-time verification (and optionally a retained drift guard).
- **Desktop smoke:** Tauri boot + core flows after `ensure-schema` deletion.
- **P-015/016/017:** the integration tool-suite tests.
- Run `npm run test:affected` throughout; `npm run test:all:integration` for the schema-touching
  changes (per CLAUDE.md, `libs/papercusp/libs/db/**` affects every workspace).

---

## 7. Out of scope

- Per-harness schema (`harness_<slug>`, `002-per-harness-template.sql`) — a separate scaffold
  mechanism, untouched.
- The generic borrowable libs' ensure APIs (`@papercusp/coordination/*`) — kept for other hosts.
- The `restart` P-015 promote dogfood (a different plan/item entirely).

---

## 8. Sequencing & landing

Phases are sequential; each commits on `main` per-turn. The irreversible-ish step (Phase 2
deletion) is gated behind the Phase-1 schema-diff proof. Given total size, Phase 4's tool-suite
tests may land as a final wave once Phases 0–3 are green (kept in scope, not deferred).
