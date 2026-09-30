---
title: One score column, two incompatible scales — check the scale before you alarm
kind: project
applies_to: [any]
type: project
---

Papercusp's recall statistics record a top-score per call, and that ONE column carries two incompatible scales depending on which path wrote the row.

The PULL path (an explicit search) records cosine similarity on a 0..1 scale, where a relevance floor in the tenths is meaningful. The PUSH paths (context injected at turn start, on a claim, at orientation) record a post-fusion reciprocal-rank score, whose MAXIMUM POSSIBLE value is a few hundredths — rank one in a single leg is already about 0.016. Healthy push rows therefore sit near 0.03 BY CONSTRUCTION.

Comparing those rows against the cosine floor produces a catastrophic-looking finding — "almost every injection scores below the floor" — that is a units error, not a defect. A reciprocal-rank score can never reach a cosine threshold.

Two rules follow. A watchdog over such a column is UNBUILDABLE as it stands, because it cannot separate "0.03 and genuinely bad" from "0.03 and perfectly healthy" — fix the schema first, with labelled columns or a scale discriminator, and only then build the alarm. And the general tell: a suspiciously round rate across thousands of samples is usually a definitional artifact. The more damning a metric looks, the more likely you are reading the wrong scale.
