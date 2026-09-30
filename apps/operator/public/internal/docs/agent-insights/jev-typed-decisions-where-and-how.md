# Jev typed decisions: where papercusp uses them, where it never may, and how to re-check them
URL: /internal/docs/agent-insights/jev-typed-decisions-where-and-how

The three places papercusp asks TypeSafe Jev for a typed judgment (the owner's memory-injection filter, the memory conflict judge, the doc-contradiction judge), the surfaces Jev must never decide (D-001), how every call fails open (D-002), how to read harness_shared.decision_model_calls, and the exact bench commands to re-run when the pinned Jev version changes (D-004).

# Jev typed decisions in papercusp

Jev is TypeSafe's "System One" model. You send it a piece of state and a set of typed questions (yes/no, or a choice between named options) and it returns a probability per answer. Papercusp calls it through one generic client, `libs/generic/decision-model` (`@papercusp/decision-model`), pinned to `jev-1.13.0` at `https://api.typesafe.ai/v1/systemone`.

The design record is plan `jev-decision-model-integration-2026-09-29`. Its decisions are the authority; this page is the map.

## The key, and what storing it means

* The Jev key is entered in the Jev section of the Memory settings page (`apps/operator/app/settings/user/memory/JevSection.tsx`) and stored encrypted as `TYPESAFE_API_KEY` in `operator_integration_credentials`. It is not a tree file, and not `setup:save_key` (that verb only takes the four platform keys).
* **Storing the key is the recorded consent** to send turn, memory and doc text to TypeSafe (D-003, D-008). Clearing it withdraws that consent, and every consumer below goes back to its pre-Jev behaviour.
* There is no feature flag. The memory filter has its own user setting (below). The two judges switch on when the key is present.

## Where papercusp uses Jev

| Consumer                                     | Code                                                                                                 | When it calls Jev                                                            | What Jev decides                                                                           | Ledger `consumer`   |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------- |
| Memory injection filter (the owner's opt-in) | `memory/injection.ts` → `runJevMemoryGate` in `memory/jev-memory-gate.ts`                            | Only when the effective mode is `shadow` or `on` (see below)                 | Which floor-admitted memories are relevant to the turn                                     | `memory-injection`  |
| Memory conflict judge                        | `memory/conflict-judge.ts` `resolveConflictJudge` → `memory/jev-conflict-judge.ts`                   | On `memory:remember` and knowledge-pack writes, whenever a Jev key is stored | Whether a new memory contradicts, duplicates, refines or is unrelated to each neighbour    | `memory-conflict`   |
| Doc-contradiction judge                      | `search/doc-contradiction-scan.ts` `resolveContradictionJudge` → `search/jev-contradiction-judge.ts` | When `runContradictionLeg` runs and a Jev key is stored                      | Whether two overlapping doc passages give opposite instructions                            | `doc-contradiction` |
| Weekly memory-precision monitor              | `memory/bench/precision-monitor.ts`                                                                  | Only when the workspace's effective mode is `on`                             | Replays the same gate the injector runs, so the weekly row measures what production admits | `memory-bench`      |

### The memory injection filter (setting: Off / Log only / On)

The switch is `harness_shared.operator_settings` key `jev_memory_injection:<workspace>`, values `off | shadow | on`, **default `off`** (D-008). `resolveJevMemoryInjection` in `memory/jev-settings.ts` computes the *effective* mode: it is `off` unless the owner chose `shadow` or `on` **and** a key is stored.

* **Off**: today's system exactly. Zero Jev calls. A test pins this path.
* **Log only** (`shadow`): Jev is asked once per turn and the verdict is logged to the ledger. Injection is unchanged.
* **On**: candidates Jev judges irrelevant are dropped. The operating point is D-013: the `instructions` encoding (memory text inside each question), keep when P(yes) ≥ 0.3 (`JEV_MEMORY_ENCODING`, `JEV_MEMORY_ADMIT_THRESHOLD`).

The measured result behind On (D-013, 2026-09-30, jev-1.13.0): 0 to 1 of 30 hard-negative queries admit anything, against 8 of 30 for today's floors, with no measurable recall loss. The improvement is borderline at n = 30. The recommended default stays **Off**; it is the owner's setting and an agent does not switch it (D-012, D-013).

### The two judges

Both resolvers use the same order: **Jev when a Jev key is stored, else the Anthropic judge when `ANTHROPIC_API_KEY` resolves, else no judge**, reported as unavailable rather than as "no conflicts".

* **Memory conflict judge** (D-015 bar, D-016 verdict): only the `contradicts` label drives anything. A flagged write is refused until it is superseded or forced, which is recoverable. The other three labels are recorded but gate nothing, because their boundaries are soft.
* **Doc-contradiction judge** (D-017 bar, D-018 verdict): `runContradictionLeg` reports `judgeBackend`. As of 2026-09-30 it has **no production caller**; the runner is `guidance-overlap-contradiction-scan-2026-08-08` P-006. So adopting Jev changed what a future runner gets, not a live path.

## Where Jev must never be used (D-001)

Jev may only **rank, filter or label** inputs whose worst-case misjudgement is recoverable. A wrongly dropped memory is still reachable through `memory:search`; a wrongly refused memory write can be forced.

Jev must never decide:

* PreToolUse gates, or any other tool-call gate
* file locks
* modes or authority
* turn provenance
* owner-directive capture
* acceptance grading or scorecards
* any permission or final-authorization decision

There are two reasons. First, authority in papercusp is computed from the registry and enforced as code (the kernel rule). Second, Jev's answers move when the judged state contains adversarial or injected text. TypeSafe's own Jev 1.13 limitations page says so, and a published measurement moved a block-`rm` decision from 0.76 to 0.48 with one fake pre-approval field. A "Jev gates bash" middleware is therefore out of scope; the deterministic rails already cover that surface.

If you are adding a new Jev consumer, check it against this list first. If a wrong answer cannot be undone by the user or by another lookup, it is not a Jev decision.

## Every call fails open (D-002)

Every call has a hard deadline: 400 ms on the memory injection path (`JEV_MEMORY_TIMEOUT_MS` in `jev-settings.ts`), 3 s for the memory conflict judge (`JEV_CONFLICT_TIMEOUT_MS`), and 10 s for the doc-contradiction judge (`JEV_CONTRADICTION_TIMEOUT_MS`). The generic client's own default is 2 s. Any failure returns a typed `inconclusive { reason }`, never an empty verdict. The reasons are in `libs/generic/decision-model/src/types.ts` `InconclusiveReason`:

`not-configured`, `no-key`, `invalid-request`, `unauthorized` (401), `rejected` (422), `rate-limited` (429 after retries), `overloaded` (529 after retries), `http-error`, `timeout`, `aborted`, `network-error`, `malformed-response`.

None of them means "the model said no". On inconclusive, each consumer does exactly what it did before Jev: injection keeps every floor-admitted candidate, and a judge reports the pair as unjudged. Collapsing inconclusive into "no conflicts found" is the silent-no-op bug that shipped twice in the contradiction scan before this contract existed.

## Reading `harness_shared.decision_model_calls`

One row per call, written fire-and-forget by `decision-model-ledger.ts` from the client's `onCall` observer (migration `1246-decision-model-calls.sql`).

**It stores hashes and ids, never raw text (D-006).** `state_sha256` is the sha256 of the judged state; `subject_ids` are the memory, doc or neighbour ids, which resolve in Postgres. Raw turn text would be a second, unbounded copy of owner prompts. `inconclusive_detail` holds only client-written messages; a provider error body is never stored.

Columns worth knowing:

| Column                                      | Meaning                                                                                                                                                         |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `consumer`                                  | Which caller (table above). Filter on it: bench rows (`memory-bench`, `memory-conflict-bench`, `doc-contradiction-bench`) are not live traffic.                 |
| `requested_model` / `returned_model`        | The pin sent, and the model the provider says **answered**. Watch `returned_model` for silent version changes (D-004).                                          |
| `outcome`                                   | `answered` or `inconclusive`. A CHECK forbids a third state: answered rows carry `answers` and `returned_model`; inconclusive rows carry `inconclusive_reason`. |
| `answers`                                   | Per-question probabilities.                                                                                                                                     |
| `questions_schema_sha256` / `option_order`  | The question set's hash is order-insensitive; `option_order` holds the order actually sent. Group by the hash and compare orders to see order sensitivity.      |
| `latency_ms`, `attempts`, `http_status`     | Timing and retries.                                                                                                                                             |
| `input_tokens`, `output_tokens`, `cost_usd` | Usage.                                                                                                                                                          |

Typical reads (use `dev:pg_query`):

```sql
-- Live health by consumer over the last day
SELECT consumer, outcome, inconclusive_reason, count(*),
       percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_ms
  FROM harness_shared.decision_model_calls
 WHERE created_at > now() - interval '1 day'
   AND consumer IN ('memory-injection', 'memory-conflict', 'doc-contradiction')
 GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;

-- Has the answering model changed under the pin?
SELECT requested_model, returned_model, min(created_at), max(created_at), count(*)
  FROM harness_shared.decision_model_calls
 WHERE outcome = 'answered'
 GROUP BY 1, 2 ORDER BY 3;
```

A table with no `memory-injection` rows is expected while the owner's setting is Off. That is the setting working, not a broken writer.

## When the pinned Jev version changes (D-004)

Production calls use the versioned id `JEV_PINNED_MODEL = 'jev-1.13.0'` in `libs/generic/decision-model/src/jev.ts`. Never `jev-latest`, which moves with each TypeSafe release. Every bench reads the same constant; there is no `--model` flag.

To evaluate a new version:

1. Take a file lock on `libs/generic/decision-model/src/jev.ts` for the whole evaluation (`locks:acquire`), so the git-sync sweep does not commit the candidate pin. Change `JEV_PINNED_MODEL` to the new versioned id.
2. Run the four benches. Each writes a report to `.papercusp/bench-reports/` and ledger rows under its bench consumer.

```bash
# Memory filter, P-004: arms A/B/C/D against the gold set, on the adopted encoding
npx tsx packages/operator-core/lib/memory/bench/jev-admission-cli.ts --encoding instructions --fresh
# Memory filter, P-005: order flips, repeat noise, encodings, self-promoting memories
npx tsx packages/operator-core/lib/memory/bench/jev-robustness-cli.ts --encoding instructions --threshold-b 0.3
# Memory conflict judge, P-009 (bar D-015)
npx tsx packages/operator-core/lib/memory/bench/conflict-judge-bench-cli.ts
# Doc-contradiction judge, P-010 (bar D-017); the incumbent is reached through the local gateway
npx tsx packages/operator-core/lib/search/bench/doc-contradiction-bench-cli.ts --incumbent-base-url http://127.0.0.1:8788
```

3. Judge each report against its **pre-registered** bar, unchanged: D-007 (with the D-013 operating point) for the memory filter, D-015 for the conflict judge, D-017 for the doc-contradiction judge. Do not relax a bar after seeing the numbers; if a criterion fails, the old pin stays.
4. If every bar holds, record a plan Decision with the report paths and keep the new pin; the Settings card's measured claim must be updated to match. If any bar fails, revert the pin before releasing the lock.

Two cheap signals tell you a re-check is due: `returned_model` in the ledger differs from `requested_model`, or the weekly precision monitor's Jev-gated row appears under a new model label on the Learning tab (D-014 puts the answering model in the row's shape, so a model change never reads as drift against the old baseline).

## Related

* Plan: `jev-decision-model-integration-2026-09-29` (D-001 to D-018)
* Bench reports: `.papercusp/bench-reports/jev-*.md`
* Settings card: `apps/operator/app/settings/user/memory/JevSection.tsx`
