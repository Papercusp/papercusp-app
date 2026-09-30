---
title: Fund research brief
slug: fundraise-fund-research
status: draft
---

# Fund research brief

## Now

**State:** Starter template. Installation makes this trigger pack available but does not arm it.

**Next:** Instantiate against a `sourced` pipeline deal. This target has a `manual` binding: research
is kicked off for a batch of deals rather than fired by an external event.

## Background

This is the enrichment step that makes personalization real. One line of genuine, specific,
agent-researched observation is the entire difference between a cold email that reads as considered
and one that reads as generated — and investors are the most spam-calibrated audience there is.

The brief produced here is durable and reused: the first-touch draft cites it, and the meeting-prep
plan reads it instead of re-researching. It writes no email and sends nothing.

## Phase 1 — Research

- **P-001** `todo` Read the `pipeline-deal` at `payload.plan_run.inputs.deal`. Establish the fund's stated thesis in its own published words, its recent relevant investments, its check size and stage, and the specific partner most likely to own this conversation.
- **P-002** `todo` Find the partner's own public writing — essays, talks, podcast remarks, conference material — and extract the specific claims they have made about this space. Quote exactly and record the URL for every quote. A paraphrase cannot be cited in an email; a misquote to an author who wrote the original is unrecoverable. blocked-by: P-001
- **P-003** `todo` Identify portfolio CONFLICTS honestly: companies they have backed that a reasonable person would consider competitive or adjacent. A conflict found now is a redirect; a conflict found in the meeting is a wasted slot. Record them even when they make the target look worse. blocked-by: P-001

## Phase 2 — Qualify

- **P-004** `todo` Judge the thesis match on the evidence gathered, and record it as one of `strong`, `plausible`, or `weak` with the sentences it rests on. A `weak` verdict is a useful result: it removes a target from the list and protects the tier structure. Do not inflate a match to keep a name on the list. blocked-by: P-002
- **P-005** `todo` Map the warm path: who in the owner's network can reach this partner, how strong that connection is, and what the forwardable blurb should say. If a genuine warm path exists, set `tier: 1` and populate `warmPath`; if not, `tier: 2`. Never fabricate a connection or upgrade a weak acquaintance into a referral — a connector who does not recognize the framing will decline, and the target is then burned. blocked-by: P-003
- **P-006** `todo` Where the match is `weak`, set `stage: lost`, `stageDetail: thesis-mismatch` and COMPLETE. Otherwise set `stage: qualified`. There is deliberately no tier 3: a target that is neither warm nor thesis-matched is not a target. blocked-by: P-004

## Phase 3 — Record

- **P-007** `todo` Write the brief — thesis in their words, the partner and their quoted positions with URLs, recent relevant investments, conflicts, the match verdict with evidence, the warm path, and the ONE specific observation a first touch should open with. Store it and set `researchBriefRef` on the deal. blocked-by: P-005
- **P-008** `todo` Stamp the brief with its research date. Downstream plans treat a brief older than 30 days as stale and must say so rather than presenting it as current. blocked-by: P-007

## Decisions

### D-001 — Quotes carry URLs, or they do not go in the brief
Date: 2026-08-23
The personalization line is cited to an author who will recognize their own words. An
unverifiable paraphrase is therefore not usable material, and the brief refuses to carry one.

### D-002 — A weak match is a successful outcome
Date: 2026-08-23
The tiering only means anything if targets can fail out of it. Recording `weak` and dropping the
name is the mechanism that keeps the list at 100–150 considered targets instead of a spray list.

### D-003 — Warm paths are never manufactured
Date: 2026-08-23
`tier: 1` requires a connection the connector would actually confirm. Upgrading an acquaintance into
a referral burns both the connector and the target.
