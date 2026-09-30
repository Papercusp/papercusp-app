# \"Federation joiner test flakiness\" root cause: silent schema drift in a hand-rolled test DDL, masked by a catch-all in the epoch-key drain
URL: /internal/docs/agent-insights/federation-joiner-test-flake-silent-schema-drift

pot-late-join-epoch-decrypt-federation.integration.test.ts (WI-894) was reported as \"keeps flaking\" — actual root cause was a deterministic (not racy) schema mismatch: the test's own minimal DDL for harness_plans never got the owner_author_pubkey column migration 414 added, so the real projection writer's INSERT threw a real Postgres error that drainQueuedEpochContent's best-effort catch{} silently swallowed, surfacing only as a downstream count mismatch.

## The symptom

Two duplicate research tasks (WI-1472/WI-1473) were filed asking to root-cause "why
federation joiner tests keep flaking." A PG scan of `harness_shared.test_runs` showed
one currently-red joiner test:
`packages/operator-core/lib/sync/hyperbee/__tests__/hive-late-join-epoch-decrypt-federation.integration.test.ts`
(WI-894), with **different assertion lines failing on different historical runs**
(`reconcile.distributed` count, `keyRowCount` count, `reapplied` count) — the classic
signature agents read as "flaky/racy."

## The actual root cause — NOT a race, 100% deterministic at any fixed commit

Running the test 6× in a row at HEAD failed **6/6, always at the identical line**
(`drainQueuedEpochContent` returning 1 instead of 2). It is not intermittent; it is
fully deterministic — the *appearance* of flakiness across historical runs came from
the code evolving underneath the test over time (this repo's tree is edited
concurrently by a large agent fleet), so the exact assertion that failed shifted as
other parts of the reconcile/drain chain were fixed independently.

The real defect: this test hand-rolls a **minimal, "prod-faithful" DDL** for
`harness_shared.harness_plans` (`CONTENT_AND_KEY_DDL` at the top of the file) instead
of running real migrations. Migration `414-harness-plans-owner-author.sql` later added
an `owner_author_pubkey TEXT` column that `projections/harness-plans.ts`'s real
`writeToPg` now includes in every INSERT — but the test's hand-rolled DDL was never
updated to match. So when the test's drain step calls the **real** plans projection
writer against its own throwaway PG, the INSERT throws:

```
PostgresError: column "owner_author_pubkey" of relation "harness_plans" does not exist
```

That exception is thrown *inside* `drainQueuedEpochContent`'s per-op loop
(`hive-epoch-op-gate.ts`), which wraps every re-apply in a **deliberately silent**
`catch {}` (documented as "a re-apply failure must not abort the merge pass" — correct
production behavior for resilience, but it means a genuine schema bug downstream
degrades to a silent no-op rather than a loud failure). The work\_item op (a different
table, `engineer-issues`, whose DDL happened to still match) applies fine, so the test
sees `reapplied === 1` instead of the expected `2` — a numeric mismatch with zero
indication of *why*.

## How this was diagnosed

1. `dev:pg_query` over `harness_shared.test_runs` filtered to `%federation%` /
   `%joiner%` / `%cross-peer%` file paths, ordered by `created_at DESC` — this is the
   fast way to find which joiner test is *actually* red right now vs. historical
   engineer\_issues noise (many past joiner incidents are already `resolved`/`closed`).
2. Ran the specific failing test 6× back-to-back — instantly showed it's
   deterministic, not racy, at this commit.
3. Read `hive-epoch-op-gate.ts::drainQueuedEpochContent` and found the silent
   `catch {}` — the signal that whatever failed here would never surface a reason.
4. Temporarily added a `console.error` inside that catch (and on the success path),
   re-ran once, got the real Postgres error, then reverted the debug instrumentation.
   This is far faster than guessing from a static read of async crypto/reconcile code
   that turned out to be a total red herring (the crypto/epoch-key distribution logic
   is correct; the bug is a stale test fixture).

## The fix

Add the missing column to the test's DDL (one line):

```sql
owner_author_pubkey text,
```

Verified 4/4 green after the fix (was 6/6 red before).

## The generalizable lesson

* **A hand-rolled "minimal, prod-faithful" DDL fixture drifts silently as real
  migrations land** — there is no compile-time or lint-time check tying a test's
  inline `CREATE TABLE` to the real migration history. `grep -rl "CREATE TABLE IF NOT
  EXISTS harness_shared.harness_plans" .` found **5 other test files** with the same
  hand-rolled `harness_plans` DDL; only the ones that actually exercise
  `buildHarnessPlansProjection`'s write path (this one, plus
  `federation-content-matrix.repro.integration.test.ts`, which currently still passes
  because its scenario doesn't hit the same code path) are at risk. Worth a follow-up:
  a lint/test rule that diffs a hand-rolled fixture schema against
  `information_schema.columns` for the real table, or — better — a shared test helper
  that creates these tables FROM a real migration subset instead of re-declaring them.
* **A best-effort `catch {}` around a re-apply/retry path is correct for production
  resilience but actively hides root causes in tests.** When diagnosing a "flaky"
  count-mismatch assertion inside code with a swallowed catch, add temporary
  instrumentation INSIDE the catch before spending time reasoning about the
  surrounding async/crypto logic — the actual defect is very often several layers away
  from where the crypto/business logic looks suspicious.
* **"Keeps flaking" reported across widely-separated dates can mean "keeps breaking in
  different ways as the code around it changes,"** not a single racy root cause. Always
  re-run the CURRENTLY-red test fresh (`dev:pg_query` on `test_runs`, then `vitest run`
  several times) before trusting historical engineer\_issues prose — most of the
  historically-filed "joiner roster empty" issues in this area (WI-1378/1379/1380/1422/
  1460/1519/1534/1544/1585) are unrelated, already-resolved, LIVE 2-machine-rig
  incidents, not this hermetic unit-test's bug.
