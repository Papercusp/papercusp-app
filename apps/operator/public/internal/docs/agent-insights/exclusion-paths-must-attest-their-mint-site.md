# An exclusion path must attest its mint site — or reclassification silently eats the defect the metric exists to catch
URL: /internal/docs/agent-insights/exclusion-paths-must-attest-their-mint-site

WI-5391: a metric that excludes \"capacity\" failures from an error rate must require provenance-at-mint (a `via` attestation) on the exclusion evidence, cross-check excludable claims against independent state at RECORD time, and guard the READ path from undoing the write path's discrimination — otherwise the bar can be greened by relabeling alone.

## The trap, in one sentence

If a quality bar excludes a failure class ("capacity — the pool had nothing to give") from its error rate, then **any error that can get itself labeled as that class disappears from the metric** — and the labeling path becomes the metric's real gatekeeper, usually without anyone treating it as one.

Proven end-to-end on the blender `cycle-error-rate` release bar (WI-5391, 2026-07-18, evidence trail EI-15967 → EI-16104 → EI-16177).

## How the hole formed (three innocent-looking layers)

1. **The classifier trusted a reason string.** `isCapacityError` excluded on `admissionDenial.reason === 'provider-429'`. Sounds typed and safe.
2. **A mint site manufactured that reason from prose.** `classifyHttpError` attached `{ reason: 'provider-429' }` whenever a message merely *matched a rate-limit regex* — including on the `status === undefined` branch where there was no HTTP evidence at all. A pattern-match minted the same token as a real 429.
3. **The excluded class was exactly the defect under investigation.** WI-4475 is "the ideator does not fail over across the account pool" — its signature is a 429 on ONE account while others have headroom. Excluding all provider-429s therefore excluded the defect's own signature: the classifier's inversion (the WI-4541 lesson, pointed the other way).

None of these layers is wrong alone. Together they mean the metric can go green by **relabeling**, with zero behavior change.

## The fix pattern (three boundaries, each load-bearing)

1. **Provenance-at-mint, not payload completeness.** The denial now carries `via: 'governor' | 'http-429'`, stamped ONLY where the evidence actually exists: the governor stamps its own admission decisions; the HTTP branch stamps only on a real `status === 429`. The prose branch mints NOTHING. `isCapacityError` requires the stamp — an unstamped denial is evidence-free and fails CLOSED (loud error). Checking *who minted it* beats checking *what fields it has*: pool fields can be absent-but-legitimate or present-but-meaningless; mint provenance can't be pattern-matched into existence. (Peer-suggested alternative "require pool fields" would have flipped true governor walls into errors — see WI-5391 checkpoint.)
2. **Cross-check excludable claims against independent state at RECORD time.** For `via:'http-429'` denials the scheduler snapshots the gateway pool (`readScoutPoolSnapshot`, tristate — probe failure is `undefined`, never a fabricated "available") and, if the pool reports `healthyAccounts > 0`, records the tick as a LOUD error with `capacityContradicted: true` instead of gating it. A capacity claim contradicted by the pool's own stats is the defect firing, not capacity.
3. **The READ path must not undo the write path's discrimination.** `isPersistedCapacityError` refuses to re-exclude a `capacityContradicted` row. Without this, the historical-reclassification read (which exists for a good reason — EI-12148) would silently re-eat what the write path kept loud, and the discriminator would be dead on arrival.

## The corollary that bites next

Any fix that makes failures *classify more honestly* will move the metric **without fixing the underlying defect**. Here: bounding the transport retry ladder by the cycle deadline (`retryLadderDeadlineExceeded`) converts hard "cycle timed out" error ticks into excludable capacity denials — the bar can drop from 57% to near-zero with the ideator never having moved an account. That drop is *instrument* progress, not *defect* progress. The only evidence of the defect being fixed is **behavioral**: a drill positively demonstrating the recovery path (which attestation leg the denials land on + whether the caller moved accounts), never the rate alone. Agreed reading protocol: post-deploy denials arriving `via:'http-429'` are believed only because the contradiction check would catch the defect shape; governor-attested exclusions carry no snapshot and prove nothing about failover.

## Checklist for any excluded-class metric

* Who can mint the exclusion token, and does each mint site attest itself?
* Does an evidence-free mint fail OPEN (excluded) or CLOSED (loud)? It must fail closed.
* Is the excluded class cross-checked against state the failing component does NOT control?
* Can the read path re-admit what the write path rejected?
* After any labeling fix: is anyone reading the metric's movement as evidence of a behavior fix? Say out loud that it isn't.
