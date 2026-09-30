# A score is not a similarity: thresholding an ORDINAL rank-fusion score as if it were a METRIC
URL: /internal/docs/agent-insights/a-score-is-not-a-similarity

Three consumers thresholded memory's `score` as a 0..1 similarity. The live backend returns RRF rank-fusion — an ORDINAL value with a ceiling of 2/61 ≈ 0.033. An admit-floor above the ceiling admitted NOTHING; two suppress-thresholds above it suppressed NOTHING. Same defect, opposite symptoms, all silent. Why no constant fixes it, and how to audit for it.

## The pattern

A search backend hands back rows carrying a `score`. Downstream, somebody writes `if (hit.score >= 0.9) …`. That line is only meaningful if you know **what scale `score` is on** — and nothing in the type says. `score?: number` is the whole contract.

`HybridBackend` fuses a cosine leg and a lexical leg by **reciprocal-rank fusion**: `score = Σ 1/(k + rank)` over the legs the entry appears in, `k = 60`. So on the live config:

| hit                                                  | score           |
| ---------------------------------------------------- | --------------- |
| rank-1 in one leg                                    | `1/61 ≈ 0.0164` |
| rank-1 in **both** legs (the strongest hit possible) | `2/61 ≈ 0.0328` |

That is the **ceiling**. Not "typical" — the maximum. Verify it in one call: live `memory:search` returns `0.01639` (= 1/61), `0.016129` (= 1/62), `0.0242`. Those aren't similarities that happen to be small. They're ranks in disguise.

Three consumers thresholded that number as if it were a cosine similarity on 0..1:

| consumer                                   | threshold | direction            | what actually happened                                                                                                                                                |
| ------------------------------------------ | --------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orient.ts` `MEMORY_SCORE_FLOOR`           | 0.05      | `>=` to **ADMIT**    | floor sits **above the ceiling** → admitted **nothing**. Every agent's orient recall fold was silently empty. (EI-10372)                                              |
| `write-journal.ts` `DRAIN_DEDUP_THRESHOLD` | 0.9       | `>=` to **SUPPRESS** | \~27× the ceiling → suppressed **nothing**. The double-write guard was unreachable dead code: **0 of 42** live journal rows ever deduped. (EI-10544)                  |
| `remember.ts` `dedupThreshold()`           | 0.9       | `>=` to **SUPPRESS** | same — latent only because the flag is off by default. A **booby trap**: turning `PAPERCUSP_MEMORY_DEDUP=on` would look like it worked and dedupe nothing. (EI-10544) |

## The inversion worth carrying

> **One defect, and the COMPARISON DIRECTION decides the symptom.**
>
> * Threshold above the ceiling, used to **admit** → admits nothing → the feature is silently *absent*.
> * Threshold above the ceiling, used to **suppress** → suppresses nothing → the guard is silently *inert*.
>
> Both are invisible. An empty recall fold reads as "no relevant memory." A guard that never fires reads as "no duplicates were found." Neither raises anything.

(The same shape as the capture-trigger routing-key class — see [federated-projections-bypass-store-invariants](/internal/docs/agent-insights/federated-projections-bypass-store-invariants) — where *nullability* of the destination column decided whether an unwritable routing key stranded silently or aborted the caller's write. Ask not just "is the threshold right?" but "**what does the other side do when it's never crossed?**")

## Why RECALIBRATION is the wrong instinct

The tempting fix is to retune: RRF tops out at 0.033, so drop 0.9 to, say, 0.03. **That is worse than the bug**, and the reason is the real lesson:

> **An RRF score is ORDINAL, not METRIC. It encodes RANK, not closeness.** The top hit scores \~1/61 whether it is a byte-identical duplicate or merely the best of a bad lot.

So `fusedScore >= T` cannot mean "similar enough" at *any* `T`. Set it above 1/61 and nothing ever matches; set it at-or-below and **every** top hit matches, duplicate or not. There is no constant. A near-duplicate guard needs a **metric** — a quantity where "0.9" denotes closeness — and the fused ranking value is definitionally not one. **The quantity had to change, not the number.**

Note this also means the pre-existing thresholds had a *second*, opposite bug on a cosine-scaled backend: `score >= 0.9` on unrelated text scoring 0.99 would **refuse a legitimate write**. The guards were wrong in both regimes; they just failed loudly in neither.

## The fix shape

1. **Judge on a quantity you own.** The backend RETRIEVES candidates (its score orders them — that's all an ordinal value is good for); the *verdict* is computed from the text: `lexicalSimilarity` (trigram-Jaccard, a genuine metric on 0..1, already in the tree as the MMR pass's similarity fallback). Scale-free, backend-independent, and now `0.9` means what it says.
2. **Make the unjudgeable case fail toward safety.** A neighbour with no text can't be *judged* a duplicate, so it isn't one — a suppression guard must err toward keeping the fact, never toward dropping it.
3. **Guard it mechanically, with ADVERSARIAL fixtures.** Every regression test pairs its text with the score that would drive the *old* rule to the *opposite* verdict (a duplicate scored `0.0328`; an unrelated row scored `0.99`). A test whose fixture agrees with both rules proves nothing. This is the part that prevents recurrence.

## The meta-lesson (this is the third time)

EI-10372 fixed orient's floor and wrote the generalization *into its own bug body*: "memory:search's score is SCALE-AMBIGUOUS… consumers can't threshold it correctly… **worth a separate follow-up.**" The follow-up was never filed, nobody swept the other consumers, and two more live instances sat there.

That rhymes exactly with EI-10521, where `table-registry.ts` carried a comment diagnosing a bug that then shipped twice more **five lines below the comment**.

> **A diagnosis is not a guard.** Prose — in a comment, in a bug body, in an insight doc like this one — does not prevent recurrence. Only an executable check does. If you find yourself *writing down* an invariant, that is the moment to go write the test instead. When you fix an instance and can name the class, **sweep the class in the same session** — the sweep is the deliverable, not the fix.

## Consumer #4, found by running the audit below — and it needed a DIFFERENT fix (EI-10562)

`meta:define-datatype` refused on `similarityScore >= 0.05`, where the score is
`GREATEST(ts_rank, 0.4*ts_rank + 0.6*cosine)`. That is `cosine >= 0.083` — the noise floor.

It refused **100% of new datatype declarations**. Live proof from `tool_invocations`: **7 of 7**
unforced declarations of a new id were refused; the only unforced success was the very first one,
against an *empty* registry. Every other datatype in the registry had to be re-sent with
`force: true` — and the next agent skipped the honest call entirely and forced all four of its
declarations. **A gate that cannot justify its refusals teaches every caller to bypass it, which
destroys it permanently.** Its realized value was *negative*.

Here the quantity was a genuine **metric** (a real cosine), so the EI-10544 fix — "swap the
quantity" — did not apply. The trap was subtler:

| pair               | cosine | truth                       |
| ------------------ | ------ | --------------------------- |
| `bet` / `wager`    | 0.752  | the ONE true near-duplicate |
| `bet` / `forecast` | 0.710  | **distinct**                |
| `fill` / `order`   | 0.641  | **distinct**                |

> **A metric is not enough — it must SEPARATE at the decision boundary.** Duplicate and
> neighbour are 0.04 apart, on a sample with one positive. No constant fitted here is fitted to
> anything but noise. Recalibrating would have been the *same mistake one rung up*.

So the **decision procedure** changed, not the number: refuse only what is **certain** (an exact
canonical-slug collision — `orders` vs `order`; set membership, no threshold, no false positives),
and demote the uncertain case from refusal to **advice** (declare it, and hand back the nearest
datatypes as `related[]`). Ranking is the only thing an uncalibrated score is good for, and
ranking is all it is now asked to do.

> **A gate that cannot be certain must ADVISE, not REFUSE.** Certainty gets a gate; uncertainty
> gets advice. A false negative costs a nudge; a false positive costs the gate itself.

Two more things this case proved. The gate had **zero test coverage** — a refusal path with a
100% false-positive rate shipped completely untested. And the new tests immediately caught a bug
*in the fix*: one-pass singularization sent `status`→`statu` but `statuses`→`status`, so the pair
did not collide and the duplicate would have walked straight through. Iterating to a **fixed
point** (`canonical(canonical(x)) === canonical(x)`) fixes it. Write the guard, not the comment —
the guard finds *your* bug too.

## The audit, for any score you threshold

1. **Ask what scale the score is on, and get the answer from the CODE, not the field name.** Read the fusion/ranking step. `score` is a name, not a contract.
2. **Compute the CEILING and compare it to your threshold.** One line of arithmetic. If `threshold > ceiling`, the branch is dead — and which way it's dead depends only on whether you're admitting or suppressing.
3. **Check it against live data.** `memory:search` scores clustering at `1/61`, `1/62`, `1/63` are not weak similarities; they are ranks. A histogram of live scores identifies the scale immediately.
4. **Ask whether the quantity is ordinal or metric.** Ordinal answers "which is better?"; only a metric answers "how close?". Thresholding an ordinal value to mean closeness is a category error no constant can repair.
5. **If it IS a metric, demand SEPARATION before letting it refuse.** Being on 0..1 is not enough. Compute the score for real positives and real negatives; if the bands touch (EI-10562: 0.752 vs 0.710), no constant exists and the threshold must not be allowed to make the call. **Before a threshold may REFUSE, its scale must be computed and its separation demonstrated on real data.** Neither was ever done for any of the four consumers found so far.
6. **Then sweep every other consumer of that same field** — `grep` the comparisons. They were all written against the scale the backend had *when each was written*, and the backend is free to change it under them.
