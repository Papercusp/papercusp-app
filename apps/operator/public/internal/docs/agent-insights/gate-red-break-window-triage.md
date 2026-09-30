# Gate-red triage: the break-window recipe + the five drift classes
URL: /internal/docs/agent-insights/gate-red-break-window-triage

How the 2026-07-05 6-red gate was greened: check the failing SET for one shared cause first, then classify each remaining red as fixture-drift, deliberate-engine-evolution test drift, env-reroute, chronic, or collateral console-warn damage — each has a mechanical fix.

The green gate went 6+ consecutive reds on 2026-07-05 (\~23 failing test files). One
agent greened it in one session because almost every red fell into one of FIVE
recurring classes with mechanical fixes. This is the recipe.

## Step 0 — look at the SET before you look at any file

**Do this first, every time.** Everything below is per-file, and that framing is itself a
trap: N reds are not always N problems. Before triaging anything, ask whether the failing
files share ONE cause (Class 5) — because the per-file loop cannot see it by construction,
and neither can the watchdog, which files one "Test failing repeatedly: `<file>`" item per
collaterally-damaged suite with no hint they are related.

Measured 2026-08-03: that produced three separate work-items across unrelated subsystems,
and **three agents independently re-derived the same single root cause**. Reading one full
failure tail would have answered it for all three.

The tell is cheap: **identical failure fingerprints across UNRELATED suites** — same
failure counts, same shas, same last-pass sha. Unrelated suites do not regress and
self-heal in lockstep. When you see that, go to Class 5 before running step 1.

## The recipe (per red file)

1. **Reproduce ALONE, serially** (`vitest run <file>` — add `--fileParallelism=false`
   for batches). A red that vanishes standalone is parallel-contention noise, not a fix
   target. A file that **skips** standalone is env-gated — reproduce with the gate's env.
2. **Find the break window**: last `pass` → first `fail` in `harness_shared.test_runs`
   (status values are `pass`/`fail`, NOT `passed`). Then
   `git log -S <symbol> --since '<last pass>'` on the engine surface the assertion touches.
3. **Classify** (below) and apply the class's fix. Never band-aid: a test updated to a
   new engine contract keeps equivalent coverage; a fixture fix is prod-faithful, not
   minimal.
4. Verify the file green locally, let git-sync sweep it, and only then re-fire the verdict.

> Note: the green-checkpoint's "quiet-cut" judges the newest commit **≥240s old** (not the
> tip) by default — so a fix landed in the last few minutes may not be in the candidate
> the next verdict judges; wait out the quiet-cut window (or fire a fresh
> `release:checkpoint-run` once your fix is past it) before reading a red as still-unfixed.

## Class 1 — fixture-completeness drift (the D-014 trap)

Engine starts reading/writing a NEW column/table; test fixtures carry a stale subset.
Symptoms: `column "X" does not exist`, `relation "Y" does not exist`,
`null value in column "Z" violates not-null`.

* A **stunted stub** (`CREATE TABLE IF NOT EXISTS` with a column subset) is worse than
  none: a later real-migration apply **silently no-ops** and its indexes then fail
  (WI-2118's `plan_item_claims` stub broke `plan-item-convert` this way). Stubs must be
  the FULL prod shape with test-friendly defaults.
* Grep for OTHER fixtures of the same table before declaring done — the 2026-07-05 gate
  had the mig-495 `drained_log_key` column missing from FIVE separate fixtures.
* postgres-js gotcha: `${JSON.stringify(x)}::jsonb` double-encodes (stores a jsonb
  *string*); use `::text::jsonb`.

## Class 2 — deliberate engine evolution, stale test expectations

The engine changed ON PURPOSE; the test pins the old contract. Confirm intent (the
change carries an EI/WI/plan reference in comments or git log), then update the test to
assert the NEW contract **and add coverage for what the old test proved**:

* EI-7066: explicit SID (`?client=`/header) now outranks `Mcp-Session-Id` — same-client
  different-transport is ONE owner (kept a no-SID fallback test for per-connection isolation).
* WI-840: bridged trigger events share the explicit-notify 90s dedupe — two same-key
  fires seconds apart legitimately suppress the second (scope one fire's args to split keys).
* Flag-default flips reroute code paths: `PLAN_PART_FEDERATION` default-ON made the
  whole-blob LWW writer bootstrap-only, so its guard suite trivially passed on
  `DO NOTHING` — pin the flag OFF in the suite that guards the OFF path
  (`isFlagOn: () => false`) and let the flag-ON suite own the other branch.
* Renames (P-016 pot lexicon) leave `mcp__papercusp__hive_*` style literals in tests.

## Class 3 — env/host-class reroute (the WI-1666 pgbouncer trap)

`pgbouncerEnabled()` defaults **POOLED on a `server`-class host** (dev box, gate runner).
A test that `delete process.env.PAPERCUSP_PGBOUNCER` to "get the direct path" gets the
OPPOSITE: its org-pool URLs reroute to the box-wide `:6432`, which fronts the box's
native PG — not the test's private container. Symptoms: `password authentication
failed`, LISTEN/NOTIFY silently dropped (transaction pooling), wrong-database reads.

Fix: pin `process.env.PAPERCUSP_PGBOUNCER = '0'` explicitly (never `delete`);
`libs/papercusp/libs/db` now pins it package-wide via `vitest.integration.setup.ts`.

Related: `libs/test-config/src/console-noise-filter.ts` silences a small, growing set of
DELIBERATE best-effort `console.warn`/`error` messages that are fatal ONLY under the
gate's full forks-pool run (never standalone or whole-file) — the WI-1660 attribution
race misattributes the warn to whichever unrelated test is live in the same forks-pool
worker when it fires. Each entry is an exact-message match with its own provenance
comment; as of 2026-07 the list covers: `[seed:git] skipping submodule` (no checked-out
submodule in the checkpoint tree), `[hive-directory] failed to publish hive` /
`[hive-directory] boot-join skipped for workspace` (best-effort hive-directory wiring,
WI-2994), and `[docs-engine] MDX parse failed for` (a malformed-MDX doc self-heals via
the git-sync content guard regardless, WI-3842). Never broaden this list for a message
that ISN'T a proven, deliberately-caught best-effort warn — it exists to remove
misattributed noise, not to weaken the gate.

## Class 4 — chronic reds (NOT yours to block on)

A file failing since BEFORE the break window, with the gate green meanwhile, is a
chronic — the gate absorbed or skipped it. Check `test_runs` history FIRST; file a WI
instead of blocking the greening (2026-07-05: `composition-chaos` reconcile-winner
nondeterminism WI-2923, `observation-source-pot-backfill` view-era re-run WI-2924).
A test that re-runs a HISTORICAL migration body at head schema breaks the moment a later
migration restructures its target (mig 383 dropped 366's trigger; mig 374 made
`engineer_issues` a view) — guard the CURRENT contract, not the retired one.

## Class 5 — collateral console-warn damage (N unrelated suites, ONE commit)

The repo runs `vitest-fail-on-console`, so **any** `console.warn`/`error` reached on a
widely-imported path becomes a HARD failure in every suite that transitively touches it.
One unconditional warn therefore reds a set of suites with nothing functionally in common,
and each looks like its own regression.

**Recognition** — the fingerprints are identical across unrelated suites (see step 0).
**Confirmation is one read:** open the full captured failure tail of ONE red. If it is a
`vitest-fail-on-console` stack, it names the warn directly. Then:

```bash
git log -S'<the exact warn text>' -- <the file the stack names>   # the introducing commit
```

That is the whole diagnosis for the entire set — no per-file bisect, no break-window walk.

**Fix** at the warn, not in the tests: gate it behind the established seam

```ts
if (!process.env.VITEST || process.env.PAPERCUSP_<OPT_IN>) console.warn(...)
```

Prior instances, all fixed this way: `embed-sidecar-spawn.ts:334` (2026-08-03, commit
`115b49e203`, red-pinned 5-8 suites across scheduler / work-items / mcp-handler gating /
knowledge-tier dedup), `hive-directory-boot.ts:221`/`:249`, `session-compacted-events.ts:28`.
The 2026-08-03 warn fired on a condition its own message called *expected* ("This is
expected for hosts with no sidecar story") — a warn describing a normal state is the
highest-risk shape, because nothing about the call site looks wrong.

> ⚠ **Do NOT propose a lint for unguarded `console.warn` — measured and rejected.**
> Re-measure before arguing with this; the command is the claim:
>
> ```bash
> # call sites in operator-core production (non-test) code
> grep -rn 'console\.\(warn\|error\)' --include=*.ts packages/operator-core/lib \
>   | grep -v node_modules | grep -v '\.test\.ts' | grep -v '__tests__' | wc -l
> ```
>
> **1800** on 2026-08-03, and only a small fraction are VITEST-gated (12 with a 2-line
> `grep -B2 … | grep -c VITEST` window — the exact number depends on how far up you look for
> the guard, which is itself the point: there is no reliable syntactic marker). So a blanket
> lint fires on the overwhelming majority of a \~1800-site population, nearly all of them
> legitimate. Blast radius depends on IMPORT REACHABILITY, not on the call site's syntax, so
> there is no cheap static discriminator between a harmless warn and one that reds five
> suites. Recognition is the affordance that pays here; detection already works (the suites
> do go red).

**Also check** `agent-insights/dispatch-postinvoke-seam-tables-in-hermetic-tests` — same
`vitest-fail-on-console` signature, different cause (missing seam tables). Matching the
signature alone is not the diagnosis; read which warn the stack names.

## Verdict mechanics that bite

* `release:checkpoint-run` takes NO args — calling it FIRES a run (self-locked:
  `skipped-locked` when one is live). There is no `op:'status'`.
* **Quiet-cut**: the run judges the newest commit **≥240s old** — fire too soon after
  your fix commit and the verdict is on the PRE-fix candidate. Wait out the window
  (`until [ $(($(date +%s) - $(git log -1 --format=%ct))) -ge 245 ]; do sleep 15; done`).
* `checkpoint:await` with no args arms `release:green`/`green-checkpoint:red`
  **globally** — a wake may be ANOTHER pipeline's verdict (lineage-check
  `payload.sha`/`payload.pipeline` before acting). Since EI-7646, pass
  `{ pipeline: 'papercusp' }` (the integration root's basename) to arm the
  pipeline-scoped keys and wake only on YOUR gate.
* The gate ABSORBS load-flakes (red under 8-fork load, green on isolated re-run) — an
  absorbed advance lists `flakeSuspects`; don't chase those as real reds.
