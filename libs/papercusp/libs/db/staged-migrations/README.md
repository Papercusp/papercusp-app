# Staged migrations — NOT auto-applied

Files here are **drafts for an owner-gated apply window**. They live in a
sibling of `../sql/`, so the boot-apply runner — which does a flat,
non-recursive `readdirSync` on `.../sql/` and only applies entries ending in
`.sql` (`packages/operator-core/lib/migration-drift.ts:isRunnerMigration`,
`packages/operator-core/lib/db-boot-migrate.ts`) — **never sees them**. The
`.sql.draft` extension is a second guard. To apply one, an owner moves it into
`../sql/` with the next free integer prefix, having first run its diagnostic and
filled its table list (see below).

---

## `workspace-identity-restamp-completion` — the mig-295 follow-through

**Brief 4 items this discharges:** `data-scoping-audit P-007` +
`workspace-data-isolation-leaks P-002` + `workspace-data-isolation-leaks P-006`.
The audit determined these three are **one** migration: completing the WI-148
workspace-identity re-stamp (mig **295**) for the harness-keyed tables 295 did
*not* cover, which still carry rows stranded under `workspace_id='default'`.

### Why this is staged, not landed

The move is **not** a blanket `'default' → 'papercusp-workspace'` papercup swap
(that is the *coord*-plane restamp, migs 361/391 — already shipped). It is a
**registry-driven, collision-safe, per-harness remap** (295's contract): each
`'default'` row moves to its harness's *unique* non-default workspace, resolved
from the live `harness_registry` payload, and a slug that maps to zero or >1
non-default workspaces is **left untouched** (fail-safe).

That mapping cannot be authored from the repo alone. Two things require the
**live database**, which was unavailable when this was staged (papercusp /
papercusp-su MCP disconnected):

1. **Which tables still hold `'default'` harness-keyed residue.** Dozens of
   `harness_shared` tables carry `harness_slug`; only a handful actually have
   `'default'` rows 295 missed. Hand-picking is unreliable — the diagnostic
   computes the real set dynamically.
2. **The per-slug collision check** against the *current* registry (a slug that
   was unique at 295 time may not be now).

It also moves **live fleet data** (17 active coordinating agents at staging
time), so it is owner-gated regardless of the data gate — apply during a window,
paired with the same restart lockstep 295/391 used.

### Run order (owner window, db up)

1. **`295-completion-diagnostic.sql`** — *read-only* (SELECT / RAISE NOTICE only;
   zero writes). Run it (`psql -f`) to print, per residual table: the
   `'default'` row count, the harness key column (`harness_slug` vs
   `scope='harness:…'`), and how many of those rows are **movable** (slug maps to
   exactly one non-default workspace) vs **left** (collision/orphan). The movable
   totals are the real "~68K" figure. Safe to run anytime.
2. **Fill the template** `425-workspace-identity-restamp-completion.sql.draft`:
   paste one `UPDATE` per residual table the diagnostic reported as having
   movable rows, using the demarcated `harness_slug`-keyed or `scope`-keyed shape
   already written there. Set the guard's critical-harness check to whatever the
   window must not strand.
3. **Review** the filled migration against the diagnostic's movable/left counts.
4. **Apply**: renumber to the next free integer (fleet had reached **424** at
   staging — confirm current max with `db:next_migration` or
   `ls ../sql | tail`), drop into `../sql/`, deploy with the coord/identity
   restart lockstep (migrations-before-serve, health + path-verify,
   rollback-on-fail — same as 295's deploy).

### Rollback

Inverse of 295: the resolver flip is the fast kill-switch; to move data back, run
the per-table inverse `UPDATE … SET workspace_id='default' … WHERE workspace_id =
m.real_ws AND <key> = m.slug` over the same `_wsmap`. Document the exact inverse
in the migration header at fill time (295's header has the shape).

---

## Sibling note — P-004 (data-scoping-audit) is **not** a migration

The audit's P-004 reads, in the prior-window summary, as "drop the dead
`bee_claim_specs.hive_slug` column." That premise is **false against the repo**:
`bee_claim_specs` (mig 372 + mig 389's `id_only` add) has columns
`workspace_id, bee_id, spec, revision, id_only, updated_by, updated_at` — there
is **no `hive_slug` column on it**, never created, never altered in, and zero
TS/SQL references (`grep -rni hive_slug … | grep bee_claim` → empty). So there is
nothing to drop. P-004 is a **won't-do disposition** ("`bee_claim_specs` needs no
pot scope — nothing writes or reads one; `bee_id` is the global identity"),
which is a one-line plan-status flip via `plans:set-status`, **MCP-gated** — no
code artifact. Do not write a DROP COLUMN for a column that does not exist.
