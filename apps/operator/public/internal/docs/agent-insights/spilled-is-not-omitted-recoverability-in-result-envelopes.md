# \"Spilled\" is not \"omitted\": read recoverability, not just truncation, off a result envelope
URL: /internal/docs/agent-insights/spilled-is-not-omitted-recoverability-in-result-envelopes

A bounded result tells you TWO different things — that it is not the whole answer, and whether the missing bytes still exist. Conflating them is a measured, repeat defect: four independent reports across three tools read `omittedItems` on a result-door spill as data loss when the full content was sitting recoverable in the spill file, and one of them reported a field as unavailable on that basis. How to tell the two apart as a reader, and the rule for producers.

## The distinction, in one line

A bounded result answers two independent questions, and you act on them in opposite ways:

| the result says | what it means                                     | your move                                                                       |
| --------------- | ------------------------------------------------- | ------------------------------------------------------------------------------- |
| **omitted**     | those bytes were **never serialized**             | re-call narrower / `payloadTier:'full'` — nothing downstream can page them back |
| **spilled**     | the bytes were **relocated whole** to a reference | page the reference — nothing was lost                                           |

Reading the second as the first is the failure this doc exists to stop. It sends you off to
re-derive — or re-run a whole batch to recover — data that is already on disk and addressed by
a URI sitting in the same payload.

## The measured incident

`result-door.ts`'s hard-overflow route (`spillResultAsReferenceEnvelope`) serializes the
**entire** MCP content array into a scratch spill and returns a typed reference to it. If that
spill write fails, the envelope comes back `state:'error'` instead — so on the `state:'incomplete'`
branch the bytes are **always** recoverable.

It nonetheless described those relocated blocks as `omittedItems: <content.length>`. Two things
went wrong at once:

1. **`omittedItems` is the unrecoverable word.** Result-door's own fast-path notice spells it out
   for the true case: such fields "were never serialized, so nothing downstream can recover them
   and their ABSENCE HERE IS NOT EVIDENCE THEY DO NOT EXIST." The spill path borrowed that word
   for the one case that is fully recoverable.
2. **It counted MCP content blocks**, which read as domain rows. "omittedItems: 3" was reported
   back as "omitted three items".

Four independent reports, three different tools, three sessions:
`EI-21954450841272611` (`work_items:get` via `tools:invoke` — concluded the governor-hold fields
"were not safely available" when they were intact in the spill), `EI-21733745031882912`
(`dev:pipeline_position`), `EI-21573289806322713` (`plans:get`), and the umbrella that led here.

**Each of the first three was closed at its own call site** — `EI-21573289806322713` widened a
budget inside `plans/get.ts` — while the shared vocabulary went untouched and produced the next
report. That is the general shape worth remembering: *N independent reports of one condition is
evidence of an under-instrumented surface, not of N bugs*, and a fix applied narrowly to one
caller reads as already-handled to everyone who arrives after it.

## What the envelope tells you now

`OutputEnvelopeIncomplete` separates the two facts, and the spill path no longer emits
`omittedItems` at all:

```jsonc
"incomplete": {
  "reason": "aggregate-output-budget-exceeded",
  "spilledItems": 3,      // relocated intact into the reference in `content`
  "recoverable": true,    // every byte is retrievable from `content`
  "note": "Nothing was lost: ... Re-issuing this one call by itself returns it inline."
}
```

## Why `aggregate-output-budget-exceeded` is not about your result's size

This is the part that was computed and then withheld. The aggregate reservation
(`budgetBytes` / `consumedBeforeBytes` / `exceeded`) was already recorded — in
`_meta.resultDoor.aggregate`, which is not where a model reads. The envelope, which is, said only
"omitted".

The cause is **derivable, not a guess**: the cohort budget is `resultEach × resultSlots` chars, a
single result is charged at most `resultEach` (`chargedBytes = min(sourceBytes, budgetChars)`),
and `resultSlots` is a positive integer. So a call that is **first in its cohort can never exceed
the budget**. Reaching this reason therefore *proves* that sibling calls in the same turn had
already consumed it, and that your result was not oversized on its own — which is why re-issuing
that one call by itself returns it inline.

Note the sibling reason inverts the advice: `non-text-result-budget-exceeded` means a block that
cannot be sliced, so re-running alone spills again. **Page the reference; do not retry.**

There is one further consequence of the reservation arithmetic worth knowing: once a cohort is
exhausted, `remaining` is 0, so *every* later call in that turn spills — including small ones that
would comfortably have fit. A spill envelope is therefore not evidence that the result it replaced
was large.

## Rule for producers

If you are writing a bounded or overflowing result, **never describe a recoverable relocation with
the vocabulary of loss** — and state the recovery move where the reader actually reads, not only in
`_meta`. Guidance computed downstream of the thing it guides is invisible on exactly the path where
it matters.
