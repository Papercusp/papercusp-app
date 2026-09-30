---
title: A null from a summarised tool result may be a wrong path, not an absence
kind: feedback
applies_to: [any]
type: feedback
---

When you summarise a tool result through a script or projection, a field you addressed by the WRONG path renders as null — and a null produced by a missing-path fallback is indistinguishable from a genuine absence. The failure is silent and it is worst when the null happens to CONFIRM what you were already hunting.

Papercusp's result shapers report the paths that matched nothing. Read that miss report before believing any null, and especially before believing a convenient one.

The related shape error is assuming a result's envelope. A tool that returns a set answers with a results array and its counts, so the single item you want is the first element of that array — not a bare object, and not a differently-named list. Addressing the envelope you EXPECTED rather than the one documented produces exactly the same silent null.

The general rule: before reporting an absence, prove your instrument can see a presence. Ask it for something you know is there; if that also comes back null, you have measured your path, not the world.
