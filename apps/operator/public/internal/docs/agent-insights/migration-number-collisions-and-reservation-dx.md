# Migration-number collisions: use the reservation tool; the lint's FS checks are now gated
URL: /internal/docs/agent-insights/migration-number-collisions-and-reservation-dx

Two agents racing `ls | tail` pick the same NNN-*.sql number. db:next-migration prevents this — an MCP agent-tool (also available as `npm run db:next-migration` since 2026-06-20) now open to ALL built-in roles, and (2026-07-03) with its fsMax read moved inside the advisory lock to close a TOCTOU race (EI-6852). lint:migrations catches dups + raw BEGIN/COMMIT + unreserved numbers; since 2026-07-04 (EI-6843) its two PG-free checks are gated — lint-migrations.test.ts runs them against the real sql/ dir on every test:affected / green-checkpoint run, after re-baselining ENFORCED_FROM 215→494 to grandfather already-applied ledgered history. Only the PG-backed reservation check still needs a manual run. Plus a two-dirs footgun: the canonical libs dir vs the gitignored sidecar mirror.

## What

When several agents add SQL migrations concurrently they collide on the leading
`NNN`. While implementing PR-4 (WI↔PR producer, `2026-06-20`) I wrote
`319-pr4-feature-pr-producer-identity.sql` and found a peer had **already** taken
`319` (`319-pr-review-reports.sql`) and another had taken `320`
(`320-autovacuum-high-churn-telemetry.sql`). My file had to be re-numbered to
`321`, allocated through the reservation ledger to avoid a third collision.

### What a dup number actually breaks today (verify before you assume "silent dark")

`next_migration.ts`'s docstring warns "only one of the colliding files applies, so
a table goes silently dark." That is **not** how the current boot runner behaves:
`applyPendingMigrations` (`libs/papercusp/packages/embedded-postgres-server/src/
migration-runner.js`) keys `harness_shared.schema_migrations` by **filename**, so
`319-foo.sql` and `319-bar.sql` are distinct keys and **both apply** (in
lexicographic filename order). The desktop sidecar path applies the same way (its
serve boot runs the same runner over the `db-sql` mirror). So the cited
single-apply/silent-dark is path/history-specific, not a property of today's
runner — don't propagate it as a current fact.

The **real**, verifiable damage from a dup number today:

* **`lint:migrations` goes red** (its `duplicateNumberGroups` check). Since
  `2026-07-04` that check IS gated for enforced-era numbers (see gap #3's
  resolution below): a new dup ≥494 fails `test:affected` / the green gate
  immediately; pre-494 historical dups are grandfathered (the runner keys by
  full filename, so they never collided at runtime).
* **Coordination confusion** — two unrelated features both claim "319"; tooling
  and humans that key on the number get the wrong file.
* **Possible loss at git-merge time** — when the two authors' divergent branches
  reconcile, a careless merge can drop one of the same-numbered files (a VCS
  hazard, not a runner one).

The fix layers are therefore **prevention at creation** (the reservation
tool/CLI) + **detection at PR** (the existing lint dup-check) — NOT a change to
boot-apply semantics.

## Why it keeps happening (three compounding gaps)

1. **`db:next-migration` is the safe path, but was MCP-only until 2026-06-20.** The atomic
   allocator (advisory lock + `harness_shared.migration_reservations`,
   GREATEST(max-on-disk across the serving + staging trees, max-reserved, max-applied)+1)
   lives in `next_migration.ts` as a `defineTool` agent-tool.
   ~~There is **no `npm run db:next-migration`** script.~~ **Fixed (2026-06-20)** — see
   the "How to allocate a number now" section and item #1 in the Recommended fix section.
   An agent (or human) who isn't wired into the harness MCP still does `ls | tail`
   and hand-picks — exactly the racing path the tool was built to replace.
   The lint error even says "use db:next-migration", naming a command that (before
   the fix) didn't exist as a script.

   **Role access (2026-06-25):** `db:next-migration` previously used `agentRoles: [...SU_ROLES, 'cup']` — only superuser-role agents and the generic cup could call
   it. Changed to `agentRoles: [...AGENT_ROLES]`: every built-in role (worker,
   validator, reviewer, architect, etc.) can now call the MCP tool directly and
   participate in collision-free allocation without falling back to the npm CLI.

   **fsMax TOCTOU race fixed (2026-07-03, EI-6852):** even after the advisory
   lock landed, both allocators read the filesystem max (`maxNumberOnDisk`)
   **before** entering `sql.begin(...)` — i.e. before acquiring
   `pg_advisory_xact_lock`. That left a window (a pooled-connection-acquire plus
   the lock-wait, which can run seconds under a busy fleet) during which a
   concurrent caller could write a higher-numbered `NNN-*.sql` to disk; the
   stale `fsMax` then failed to fold it in and the tool could hand out an
   already-used number. Both `next_migration.ts` (the MCP tool) and
   `scripts/next-migration.mjs` (the CLI) now compute `fsMax` **inside** the
   `sql.begin` callback, immediately before the `GREATEST(...)` read and the
   reservation insert, so all three GREATEST inputs (on-disk, reserved, applied)
   are read atomically under the same lock. `next_migration.ts` also now
   `export`s `ALLOC_ADVISORY_KEY` so the regression test
   (`next_migration.integration.test.ts`, case "EI-6852: the filesystem max is
   read INSIDE the advisory lock") can hold the lock itself to reproduce the
   race. This closes the last remaining collision window in the "supported
   path" — the collisions this doc otherwise documents are all from agents who
   bypassed `db:next-migration`/the CLI entirely.

2. ~~**The MCP client is currently dropped.**~~ **Historical note (2026-06-20):** At the
   time of discovery the harness MCP client was dropped, so even MCP-aware agents
   couldn't reach `db:next-migration` and fell back to hand-picking. The npm CLI
   (`npm run db:next-migration`) was added precisely to fix this (gap #1 fix). The
   MCP client drop is a session-specific transient; the systematic fix is the CLI +
   the per-role access expansion (see gap #1 update above).

3. **`lint:migrations` was not gated** (RESOLVED for the PG-free checks,
   `2026-07-04` — see below). `scripts/lint-migrations.mjs` already detects
   (a) duplicate `NNN`, (b) raw top-level `BEGIN;`/`COMMIT;` (which would
   end the runner's per-file wrapper txn early), and (c) numbers ≥`ENFORCED_FROM`
   absent from the reservation ledger. But it was **only an npm script** —
   referenced in neither `.github/` (CI) nor `.husky/` / `.git/hooks` — so the
   guard never ran automatically; the dup-number check (which is PG-free and
   runs fine in CI) never fired on a PR.

As of `2026-06-20`, `node scripts/lint-migrations.mjs` exited **1**: 7 files
carried raw `BEGIN/COMMIT` (`299, 300, 306, 307, 308, 312, 317`) and \~10 numbers
≥215 were unreserved (`293, 294, 298, 301, 303–307, 319, 320`).

**Re-verified `2026-07-03` — the guard is still ungated and the violation count
has grown, not shrunk** (confirming gap #3 is still open): `node
scripts/lint-migrations.mjs` still exits **1**, now with **3 duplicate-number
groups** (`357`, `375`, `460` — each has two distinct files sharing the same
leading `NNN`, exactly the collision this doc is about), **34 files** carrying
raw top-level `BEGIN;`/`COMMIT;`, and **64 numbers ≥215** on disk with no
reservation-ledger row. The tree has been shipping with the linter red for
weeks with nothing catching it at PR time — direct evidence that gap #3
(below) remains unaddressed.

**Resolved for the PG-free checks (`2026-07-04`, EI-6843):** the duplicate-`NNN`
and raw-tx-control scans now run against the REAL `libs/papercusp/libs/db/sql/`
directory inside `packages/operator-core/lib/lint-migrations.test.ts` (the
"real … sql/ directory (gate wiring)" describe block), which `npm run
test:affected` — and therefore the green-checkpoint gate — runs on every
candidate. Because the tree was red (worse than at discovery), enforcement was
re-baselined FIRST: `ENFORCED_FROM` moved 215→494, grandfathering the
already-applied, ledgered history (editing/renaming an applied file would break
its recorded checksum), and `duplicateNumberGroups` now takes an `enforcedFrom`
boundary so historical same-number pairs don't red the gate. A FUTURE violation
(≥494) fails the suite immediately. The PG-backed reservation check (c) remains
CLI-only — as of `2026-07-05` `node scripts/lint-migrations.mjs` still exits 1
with one live violation (migration `510` on disk with no reservation row), so
"clean first, gate second" still applies to that check.

## The two-dirs footgun (bonus)

There are **two** migration directories and they are NOT the same role:

* **`libs/papercusp/libs/db/sql/`** — CANONICAL. The operator auto-applies these
  on boot (`migration-drift.ts` `resolveSqlDir()`), and `db:next-migration` scans
  this dir for the on-disk max. **Write new migrations here.**
* **`papercusp-desktop/src-tauri/sidecar/db-sql/`** — a build-time MIRROR, and it
  is **gitignored inside the `papercusp-desktop` submodule** (`git check-ignore`
  confirms). A file written only here is never committed and never applied.

Both are submodules (`libs/papercusp`, `papercusp-desktop`). I initially wrote my
migration into the sidecar mirror — it silently did nothing useful. Identical
copies of `314–318` in both dirs make the mirror look authoritative; it isn't.

## How to allocate a number now (the supported path)

Use the CLI (added `2026-06-20` — works even with the MCP client down):

```bash
npm run db:next-migration -- --name add-foo-index --intent "what it does"
# → reserves the next free NNN in harness_shared.migration_reservations and prints
#   a DRAFT write-target: libs/papercusp/libs/db/sql/<NNN>-add-foo-index.sql.DRAFT
#   (+ arm_path / arm_command — see below)
# Add --dry-run to see the number without reserving it.
```

It scans BOTH dirs for the on-disk max **inside** the advisory lock (the
`2026-07-03` EI-6852 fix — see above), allocates, and records the reservation —
the same contract as the MCP `db:next-migration` tool. Then **write + iterate at
the printed `.DRAFT` path**, not the bare `.sql` name (`2026-08-02`,
EI-19366138707071397): the migration runner only ever applies files matching
`*.sql` (`migration-runner.js`'s `.filter(f => f.endsWith('.sql'))` — the same
mechanism the pre-existing `NNN-*.sql.PENDING-CODE-DEPLOY` idiom relies on), so a
`.DRAFT`-suffixed file is invisible to boot auto-apply, `db:migrate`, and the
green-checkpoint preflight while it's mid-edit — including a deliberate temporary
both-ways guard-test mutation (the "prove a guard you haven't seen fail" house
rule), which previously could race a concurrent operator restart and execute
half-finished SQL against the live DB (the migration-729/WI-7057 near-miss that
prompted this). Once it's finished and tested, **arm it** with the tool's printed
`arm_command` (`mv <path>.DRAFT <path>`) to land it at
`libs/papercusp/libs/db/sql/<NNN>-<slug>.sql` (NOT the sidecar mirror) — only then
does it auto-apply on the next operator restart. It refuses to hand out a number
when PG is unreachable (an unreserved number re-opens the race).

## Recommended fix (plan)

Small, mostly additive; each item is independent:

1. ~~**Add `npm run db:next-migration`.**~~ **DONE (`2026-06-20`)** —
   `scripts/next-migration.mjs` + the `db:next-migration` npm script. Reservation
   now works without the MCP client (the highest-leverage gap — it kills the
   `ls | tail` path at the source). Mirrors the MCP tool via the shared ledger +
   advisory key. ~~A follow-up could DRY the two onto one exported core~~ — see
   item 4 below (still open). **Also DONE (`2026-07-03`, EI-6852):** both
   allocators now read the on-disk max **inside** the advisory-lock transaction
   instead of before it, closing the TOCTOU window described above.
2. ~~**Gate `lint:migrations`**~~ **DONE for the PG-free checks (`2026-07-04`,
   EI-6843)** — not via `.github/`/`.husky` but via the vitest suite:
   `packages/operator-core/lib/lint-migrations.test.ts` scans the real sql/ dir
   for duplicate numbers + raw tx-control on every `test:affected` /
   green-checkpoint run. The required "clean first" sequencing was honored by
   RE-BASELINING instead of editing history: `ENFORCED_FROM` 215→494
   grandfathers the applied, ledgered legacy (immutable — recorded checksums),
   so the gate starts green and only a genuinely NEW violation reds it. Still
   open: the PG-backed unreserved-number check is not in the gate (needs a live
   PG; exercised only by the CLI) — backfill the missing reservation rows
   (e.g. `510` as of `2026-07-05`) before gating it. (Do NOT instead change the
   boot runner to abort on dup numbers: it currently applies both colliding
   files by filename, and altering boot-apply semantics — especially the
   `continueOnError` fleet path — is far riskier than catching the dup at PR
   time.)
3. **Mark the sidecar mirror.** Since the mirror dir is itself gitignored, a
   `README` placed in it wouldn't be tracked — put the "this is a gitignored build
   mirror; author migrations in the canonical libs dir" note where it's visible:
   the canonical dir's own README, or `migration-drift.ts` (which already owns
   `resolveSqlDir`).
4. **DRY the allocator** (low priority). Export the allocation core from
   `next_migration.ts` and have both the MCP tool and `scripts/next-migration.mjs`
   call it, instead of the two mirroring the ledger contract independently. The
   `2026-07-03` EI-6852 fix had to be hand-applied to **both** files in lockstep
   (see above) precisely because they're still two independent implementations
   of the same contract — live evidence for why this item matters, not just a
   hypothetical.

Sequencing mattered for the gating item (#2) and was honored via the
`2026-07-04` re-baseline; the same rule — clean first, gate second — applies to
any future gating of the reservation check.
