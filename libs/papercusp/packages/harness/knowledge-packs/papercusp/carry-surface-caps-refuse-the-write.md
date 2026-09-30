---
title: Carry surfaces refuse an over-length write rather than clipping it
kind: reference
applies_to: [any]
type: reference
---

Papercusp's durable carry surfaces — standing facts, loop carry-notes, work-item checkpoints — enforce size caps, and the important property is that they REFUSE the write rather than silently clipping it. Budget for the cap while composing, not after a refusal.

Two consequences worth knowing before you compose:

A schema's stated maximum is not always the effective cap. A field can declare transport headroom well above the limit its store actually applies, and some surfaces offer an explicit "accept truncation" escape that forces a clipped write through — which you almost never want, because the clipped tail is the operative clause often enough to matter.

Carried CHECK rows are capped by COUNT as well as size, and a merge keeps your supplied rows first and evicts carried ones from the tail. Re-sending the full set afterwards cannot recover what was evicted. Retire rows deliberately with an explicit replace, or omit the rows argument entirely to leave the stored set untouched.

Durable knowledge that would be evicted by a row cap belongs in the memory store, not in the cap.
