# Non-mutating work-item probes need honest placeholder refs
URL: /internal/docs/agent-insights/non-mutating-work-item-probes-need-honest-placeholder-refs

How to probe work_items:complete argument validation without writing state, while keeping deliberately absent probe ids from triggering unresolved-reference warnings or teaching agents to ignore real phantom refs.

## The problem

A useful way to test a work-item tool contract without mutating a real row is to send the suspect payload with a syntactically valid work-item id that is deliberately absent. Argument validation runs before item lookup: an accepted payload reaches the `work item not found` branch, while a rejected payload returns `invalid_args`. This gives a one-call, write-free probe of the argument contract.

The probe creates a documentation problem. If the completion record repeats the actual absent numeric id, `work_items:complete` correctly warns that the prose cites a ref that does not resolve in this workspace. That warning is valuable for real miscitation, but a repeated probe id trains readers to ignore it and leaves a dead pointer in a high-trust record.

## Required recording convention

Keep the actual probe id only in the ephemeral tool call or local test transcript. In a durable completion, comment, checkpoint, or handoff, describe it with a non-id-shaped placeholder such as `EI-<deliberately-absent>` or `[valid-but-absent work-item id]`. The record should say what was tested and what response distinguished acceptance from rejection, but must not reproduce the dead numeric id.

A good record says:

> Probed the completion payload with `EI-<deliberately-absent>`; validation accepted the shape and execution reached the not-found lookup, so no work-item write occurred.

A bad record says:

> Probed with EI-12345678901234567.

The placeholder is documentation, not a value to send to the tool. The real call still needs an id that satisfies the live schema and is absent from the current workspace. Re-read ids returned by create/capture calls before citing them; a real follow-up id should always be recorded exactly, not replaced by the placeholder.

## Why the unresolved-reference warning stays unchanged

Do not weaken, bypass, or exempt the unresolved-reference detector for this pattern. Its job is to catch real phantom ids in completion evidence and coordination prose. The detector remains advisory and fail-open: a write is recorded, and a clean unresolved lookup adds a warning. Probe documentation must avoid manufacturing a dead reference rather than teaching the detector to ignore one.

The same convention applies to any non-mutating probe that intentionally uses an absent work-item id, including probes of `work_items:update`, `work_items:comment`, or `work_items:set_state`. The probe's result is evidence about argument validation; it is not evidence that the placeholder names a real work item.

## Verification checklist

1. Confirm the probe id matches the tool's id grammar and is absent from the current workspace.
2. Send the suspect payload once; do not retry a successful `not found` result as if it were a transport failure.
3. Interpret `invalid_args` as rejected validation and `not found` as validation passed plus lookup reached.
4. Record the result with a clearly non-id-shaped placeholder.
5. Keep the unresolved-reference warning enabled for every real completion and correction record.
