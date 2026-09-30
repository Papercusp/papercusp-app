# CI runner reds: the dev-box-parity failure classes (and the provisioning recipe)
URL: /internal/docs/agent-insights/ci-runner-dev-box-parity-failure-classes

The GitHub nightly's first real executions failed ~50 files across FIVE distinct environment-dependence classes, none of them regressions: transitive default-:5432 PG pools, the ~/autonomous-harness symlink convention, binaries assumed on PATH (kopia/omp), per-box state files (workspace registry), and shared-tree commit skew. Diagnosis order + the dev-box-parity PG recipe (scripts/ci-provision-pg.mjs) that cleared the dominant class.

## The mistake this prevents

A "unit"-tier suite that is green on every dev box can still be **environment-
dependent, not hermetic** — the box silently provides PG on `:5432`, a `~`
symlink, binaries on PATH, and state files. The first time CI actually executed
the suites (WI-123, 2026-06-11), \~50 files failed across five classes and **zero
of them were code regressions**. Without the taxonomy below, each red looks like
a mysterious individual failure and burns an investigation hour; with it, one
glance at the error signature names the class.

## The five failure classes (by error signature)

1. **`ECONNREFUSED ::1:5432 / 127.0.0.1:5432` across many unrelated files** —
   NOT tests connecting to PG. App code they import opens a pool against the
   default `postgresql://…@localhost:5432/papercusp`
   (`libs/papercusp/libs/db/src/connection.ts` resolution chain: env →
   discovery file → native fallback). Per-test reclassification is impractical
   because the dependency is transitive (module-load side effects in dozens of
   imported modules). **Fix: give the runner a dev-box-parity PG** (below).
2. **`MEMORY_MAP references roles that don't exist on disk`** killing a dozen
   endpoint-route suites — `harnessPackageDir()` used to resolve env →
   `~/autonomous-harness` (a dev-box symlink convention) → nothing, so
   `getKnownRoles()` returned zero roles on any fresh clone. Fixed with an
   in-repo fallback (`packages/operator-core/lib/harness-paths.ts`); if a
   path-shaped "X doesn't exist" error appears only in CI, suspect a
   home-dir convention the repo assumes.
3. **`spawn <binary> ENOENT` / spies called 0 times** — tests that drive a real
   binary (kopia) or whose source does pure-Node PATH scanning the mocks no
   longer intercept (omp, after audit P-080 removed the `command -v` shellout).
   Fix: module-load probe + `describe.skipIf(!available)` for
   genuinely-binary-driving suites; plant stub binaries in a temp PATH dir for
   suites that are supposed to be fully mocked.
4. **Per-box state files** — e.g. `unknown workspace default`: the workspace
   registry (`~/.papercusp-workspaces/registry.json`) exists on every dev box,
   never on a runner, and `activeWorkspaceId()` falls back to an unregistered
   `'default'`. Fix: the test registers what it needs and cleans up.
5. **Shared-tree commit skew** — git-sync sweeps peers' *in-flight* work into
   the nightly's checkout, so a red can be a peer's half-landed change (e.g.
   `column "model_spec" … does not exist` from a code-INSERT landing before its
   test-fixture DDL). Check whether it's red **locally at HEAD** before treating
   it as a CI problem; if it is, it's a lane question, not an env question.

## The dev-box-parity PG recipe

`scripts/ci-provision-pg.mjs` + a `pgvector/pgvector:pg18` service (bumped
from `pg16` 2026-07-05, WI-2942, to match the shipped/embedded operator's
PostgreSQL 18.3 — see `libs/test-config/src/pg-container.ts`) on
`5432:5432` in `test-nightly.yml` / `test.yml`. The script mirrors the
fresh-migrate strict gate exactly: the 3 framework roles
(`harness_app`/`harness_admin`/`harness_zero`), the `papercusp` DB, the 3
baseline extensions (`pgcrypto`/`pg_trgm`/`vector`), then
`applyPendingMigrations` from
`embedded-postgres-server/src/migration-runner.js` — the REAL boot-path
runner, fail-loud, idempotent (\~4s, 122 files). **No test env vars are set**:
suites reach the service through the documented native-`:5432` default
fallback, exactly like a dev box, and the testcontainers integration tier is
untouched. An empty-but-schema-complete DB was proven sufficient (153/153
across 6 previously-failing suites) — the class needs schema, not seeded data.

## Diagnosing a new CI-only red

Run it locally at HEAD first. Green locally → diff the environments in this
order: PG reachable? path conventions (`~` symlinks, env)? binaries on PATH?
state files under `~`? checkout SHA vs your HEAD? One of the five almost
always names it. Full forensics: WI-123's thread.
