---
id: ch4-07-self-learning
chapter: 4
order: 7
title: The self-learning system — closing the loop
docSlugs: system/knowledge-packs
---

## Brief

Everything in this chapter feeds one loop: observations and gradings
accumulate → pattern-mining agents digest them → the strongest signals
become proposals (new features, fixes, doc updates) → proposals get triaged,
built, and shipped — often by the autonomous system itself. Papercusp literally
improves itself using the same queue and agents that do your work.

## Details

The mining side runs on a schedule: dedicated agents read the accumulated
corpus (observations, insight docs, scorecards, state-of-the-system digests)
and ask "what pattern is behind these? what's missing?". Their output is
ideas — filed as reviewable proposals with the evidence that motivated them,
never silent changes.

Ideas then flow through grading (multiple perspectives score each one) and
triage into the normal work queue, where they're built like any other work —
with tests, review, and disclosure. Learning that would change something
sensitive stays gated behind human approval.

The honest caveat: this is the most ambitious part of the platform and it's
still maturing. The pipes all exist and run; how *good* the self-improvement
is depends on the quality of what gets filed — which is why the filing
culture in the previous sections matters so much.
