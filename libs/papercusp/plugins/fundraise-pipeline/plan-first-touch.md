---
title: First touch — draft the initial outreach
slug: fundraise-first-touch
status: draft
personalScopes: personal:gmail
---

# First touch — draft the initial outreach

## Now

**State:** Starter template. Installation makes this trigger pack available but does not arm it.

**Next:** Instantiate against a `qualified` pipeline deal that already has a research brief. This
target has a `manual` binding: a first touch is always deliberate.

## Background

This is the email the whole system exists to earn the right to send, and the one where an automated
feel is fatal. Investors are the most spam-calibrated audience there is, so the standard here is not
"personalized enough to pass" — it is that a partner reading it cannot tell it was assembled by an
agent, because every specific in it is true and sourced.

The draft never sends. Sending requires a recorded human approval bound to this exact draft; see
`evaluateOutreach` in `packages/operator-core/lib/fundraise/outreach-approval.ts`. Tier 1 goes out
through a warm intro rather than this path wherever a warm path exists.

## Phase 1 — Refuse to draft on a weak footing

- **P-001** `todo` Read the deal and its `researchBriefRef`. STOP and request research first if there is no brief, if the brief is older than 30 days, or if the thesis match is recorded as `weak`. A first touch built on stale or absent research is the exact failure this pack is designed to prevent, and sending it burns a target permanently.
- **P-002** `todo` If the deal is `tier: 1` with a populated `warmPath` and no intro has been requested yet, STOP and draft the CONNECTOR blurb instead of a cold email: a forwardable paragraph the connector can send with one line of their own. Warm intros dominate venture; spending a warm path on a cold email wastes the most valuable asset in the pipeline. blocked-by: P-001

## Phase 2 — Compose

- **P-003** `todo` Open with ONE specific, verifiable observation from the research brief — something the partner wrote, said, or backed, quoted accurately with its source recorded on the deal. Never open with flattery, never with "I've been following your work", and never with a claim you cannot cite. If the brief yields no such observation, the research is incomplete: go back to P-001 rather than substituting a generic opener. blocked-by: P-002
- **P-004** `todo` State what the company does in two sentences a partner can repeat to their colleagues verbatim. Optimize for repeatability over completeness — the pitch that survives is the one they can restate, not the one that says the most. blocked-by: P-003
- **P-005** `todo` Include exactly one link: the live proof artifact at `payload.plan_run.inputs.proofArtifactUrl`, showing the workflow that produced this very email — pipeline board, research notes, draft history. The hook is that the fundraise is being run by the product. Do not attach a deck to a first touch. blocked-by: P-004
- **P-006** `todo` Close with one specific, low-cost ask — a named time window or a single question — never "let me know if you'd like to chat". Total length under 150 words. blocked-by: P-005

## Phase 3 — Draft and request approval

- **P-007** `todo` Verify every factual claim in the draft against the deal record and the research brief. Traction numbers, customer names, round size, committed investors, and timelines may appear ONLY if they are recorded facts. Omit rather than estimate: a number a partner later finds to be inflated ends the conversation and the relationship. blocked-by: P-006
- **P-008** `todo` Create the draft with `mail:draft`: `to` is the counterparty address recorded on the deal's `contacts`, with `addressee` declaring that provenance, plus the `subject` and `text` from P-004..P-007. A first touch is a new email, so there is no thread to reply into; `mail:draft` never sends. Complete only after the tool returns a `draftId`, and check that its echoed recipients are exactly the counterparty. blocked-by: P-007
- **P-009** `todo` Set the deal's `outreachApproval` to `{ state: 'pending', scope: 'first-touch', draftRef: <the created draft id> }`. Never write `state: 'approved'` — approval is a human act, and an agent granting itself approval defeats the only control standing between the pipeline and a partner's inbox. blocked-by: P-008
- **P-010** `todo` Notify the owner with `notifications:send_owner` on a stable `dedupeKey`: counterparty, the opening observation and its source, the ask, and that the draft awaits approval. Leave `stage` at `qualified` and `lastOutboundAt` unset — both move only when a human actually sends. blocked-by: P-009

## Decisions

### D-001 — The agent requests approval; it never grants it
Date: 2026-08-23
P-009 writes `pending` and only `pending`. The gate binds an approval to a specific `draftRef`, so
even a granted approval cannot transfer to regenerated content. An agent that could write
`approved` would make the entire send-approval design decorative.

### D-002 — A warm path is never spent on a cold email
Date: 2026-08-23
Tier 1 exists because a warm intro converts where a cold email does not. P-002 diverts those deals
to a connector blurb rather than consuming the relationship on a cold send.

### D-003 — Omit rather than estimate
Date: 2026-08-23
Every number in a first touch is checkable by the recipient. An estimate presented as a fact is
discovered at exactly the moment it is most expensive, so the draft carries only recorded facts.
