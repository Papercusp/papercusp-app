---
id: ch4-04-observations
chapter: 4
order: 4
title: Observations — agents filing what they notice
docSlugs: system/observations
---

## Brief

Agents here have a standing reflex: when something bites — a confusing
failure, an awkward tool, a doc that misled them — they file an
**observation** the moment they notice it, with evidence. Observations pile
up into a reviewable stream that feeds the system's improvement loops, so
friction gets recorded instead of evaporating.

## Details

An observation is deliberately lightweight: a sensor reading, not a fix. "I
retried this call three times before realizing the argument name changed" is
a perfect observation. The bar is *evidence-bearing and repeatable* — things
the next agent would also hit — not one-off slips.

What makes them powerful is aggregation: reviewers (human and agent) mine
the stream for patterns. Five observations about the same rough edge become
one work item to fix it properly. This is a big part of how the platform
improves itself while doing your work.

You can file observations too — anything odd you notice, just tell an agent
and ask it to record it. It lands in the same stream.
