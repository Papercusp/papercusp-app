# Claim-time invalidated-citation advisory: narrow signal, non-blocking port
URL: /internal/docs/agent-insights/claim-time-invalidated-citation-advisory

How the three work-item claim paths surface cited terminal evidence that explicitly invalidates a premise, why age or terminal state alone is deliberately insufficient, and the bounded fail-soft contract maintainers must preserve.

## The contract

A claimed work item can cite an older WI-/EI- item whose terminal evidence says the cited premise was false. The claim paths surface that evidence before implementation as `premises` plus `premisesNote`. This is an advisory re-check only: it never changes eligibility, blocks a claim, or asserts that the current item still depends on the invalidated premise.

The port is `getClaimTimePremises()` in `premises-claim-port.ts`. It is shared by all three claim surfaces:

* `work_items:claim` for named claims;
* `scheduler:get_next` for scheduler/spec pulls;
* `work_items:claim_next`, including every row of a batch pull.

Each caller must pass the claimed item ID together with title, summary, and payload. The ID is load-bearing: bodies commonly cite their own item for provenance, and self-references must be removed before the bounded probe budget is spent.

## Why the signal is deliberately narrow

Age alone is not evidence that a premise expired, and a terminal citation is not evidence of contradiction. Broad age and generic-terminal predicates matched large parts of the backlog and would train claimants to ignore the warning. The implemented predicate therefore requires BOTH:

1. the cited work item is in a terminal state; and
2. its `terminalCompletionRef` uses explicit invalidation vocabulary such as `wrong-premise`, `false premise`, or `falsified premise`.

The item may be discussing that correction rather than depending on it, so the wording tells the claimant to re-read and decide; it does not accuse the item of being wrong. This extends the general rule in `agent-insights/re-measure-a-bugs-premise-before-implementing-it` with a cheap automatic signal at the moment cost would otherwise be paid.

## Bounding and failure behavior

Reference discovery reuses `detectBodyRefs()`, the same parser used by coordination hydration. It resolves at most `MAX_PREMISE_CITATION_REFS` work-item references, probes them concurrently, and bounds the terminal-completion excerpt. Self references do not consume that budget.

The whole enrichment is fail-soft: malformed text, an unresolved cited ID, a read error, a non-terminal row, or an ordinary successful completion emits nothing. Claim success is already committed and must never be turned into a refusal because advisory hydration failed. Dynamic imports keep the work-item store out of static dependency cycles.

## Regression guard

Focused tests must pin the original EI-10203 -> WI-4329 shape, silence for live and ordinary-terminal citations, zero-probe behavior at a zero budget, self-ID filtering, failure softness, and propagation through named, scheduler, single `claim_next`, and batch `claim_next` response shapes. When adding another claim surface, reuse this port and pass `id`; do not implement another citation parser or a new eligibility floor.
