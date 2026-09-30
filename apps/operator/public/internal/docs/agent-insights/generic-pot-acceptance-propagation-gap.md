# Generic-pot acceptance/output doesn't gate deliverables yet — the pot↔member finalize split
URL: /internal/docs/agent-insights/generic-pot-acceptance-propagation-gap

A live P-021 smoke found that a generic-pot's acceptance.kind=judge / output.kind=artifacts is declared on the POT harness, but deliverables finalize in MEMBER harnesses (research/review/vote) that don't inherit it — so the judge gate (P-009) + artifacts output (P-010), though correctly built + unit-tested, do not fire end-to-end. The fix is propagating the pot's domain profile to its members.

## What the smoke found

`pot-blueprint-generalization` P-021 (the live smoke) was meant to prove a
`generic-pot` reaches DONE repo-less via **judge acceptance + artifacts output**.
Standing one up on the live operator confirmed the *create* path end-to-end:

```bash
# (raw MCP — see "Gotcha: stale client schema" below)
pot:create { slug, blueprintId: 'generic-pot' }
# → a home harness whose .papercusp/blueprint.yaml is `extends: generic-pot`,
#   inheriting acceptance.kind=judge / output.kind=artifacts / affinity=topic-overlap.
```

But the judge gate **never fires for the actual deliverables**, because of an
execution-model split:

* The **pot harness** runs the pot blueprint: `spine.decider: mug`,
  `workItem.kind: pot-wake` (idPrefix `POT`). Its work items are the Mug's
  **placement/wake triggers**, NOT deliverables. Its finalize path only ever
  processes `pot-wake` items.
* **Deliverables** (a report, analysis, decision) are placed by the Mug as
  feature-family items into **member harnesses** — the `research` / `review` /
  `vote` pipelines (`generic-pot`'s `dependencies.blueprints`). They run + finalize
  under the **member's** blueprint.
* A member blueprint (`research`, …) declares **no `acceptance`** ⇒
  `harnessAcceptanceKind(memberProjectDir)` is `undefined` ⇒ the finalize gate is the
  plain coding/straight-through path. The pot's `acceptance.kind=judge` is on the
  *pot* harness, which the deliverable never finalizes in.

So **P-009 (judge hard-gate) and P-010 (artifacts output) are correct mechanisms —
built, unit-tested, byte-identical-for-coding — but unwired to where deliverables
actually finalize.** The domain profile is declared on the pot; the work finalizes
in the members.

## The fix (the wiring that's missing)

The pot's `acceptance` / `output` (and `affinity`/`lexicon`) profile must
**propagate to the member harnesses** a generic-pot spawns, so a `research` member
*of a generic-pot* finalizes under judge + artifacts. Candidate seams (pick one):

1. **At member creation** — when the Mug spins up a member (`harness:create` for a
   pot-owned pipeline), overlay the pot's `acceptance`/`output` onto the member's
   resolved config. Cleanest "the pot governs its members" model.
2. **At the finalize gate** — make `harnessAcceptanceKind` / `harnessOutputKind`
   for a member that BELONGS to a pot fall back to the owning pot's profile
   (needs the member→pot link at finalize time).

Until then, a generic-pot's deliverables finalize like any research task (no judge,
no artifacts sink). The `VERIFICATION_STANDARD` preamble swap (P-008) DOES reach the
member's cups (it reads the member's own blueprint — but the member has no `judge`
acceptance either, so a research member's cup gets `TESTING_STANDARD` unless the
member inherits the pot profile too — same propagation gap).

## Gotcha: a long-lived client session has a STALE tool schema

The su MCP client snapshots tool **schemas at session start**. `pot:create` gained
its `blueprintId` arg mid-session (P-006), so an old session's
`mcp__papercusp-su__hive_create` lacks it and can't create a generic-pot. The
operator itself is current (it resolves `@papercusp/operator-core` from **source**
`./lib`, not a build). Workarounds: start a fresh client session, or call the
operator's MCP directly — `POST :3070/api/mcp?superuser=1&client=<uiClientId>` with
`{method:"tools/call",params:{name:"pot:create",arguments:{…,blueprintId}}}` (the
real tool name is colon-form `pot:create`; the handler needs the `&client=` id or it
errors `resolveAgentIdentity: superuser context is missing uiClientId`).

## Status of the surrounding work

Built + unit-tested + correct, just unwired end-to-end: P-009 judge hard-gate
(`parseAcceptanceVerdict` + the finalize-loop skip-onDone-on-`revise`), P-010 output
tagging, P-008 preamble swap. The create path + domain-profile inheritance are
**live-proven**. The propagation above is the remaining step to make the gate fire on
real deliverables. Plan: `pot-blueprint-generalization-2026-06-15` (P-021).
