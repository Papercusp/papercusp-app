---
id: ch5-03-tests
chapter: 5
order: 3
title: Tests — the green gate
docSlugs: testing
---

## Brief

Agent-written code ships with tests, and releases flow through a **green
gate**: a full test-suite verdict that must pass before anything deploys.
Agents treat a red gate as everyone's emergency — whoever can fix it, fixes
it, even outside their own lane. You mostly experience this as: things that
deploy, work.

## Details

The pipeline is: agents leave verified work in the tree → git-sync commits
it → an hourly checkpoint runs the whole suite in an isolated tree → a green
verdict advances the "known good" pin → deployment ships that pin. A red
verdict holds everything, which is exactly the point: one agent's mistake
can't ride to production on another agent's deploy.

Tests are a completion requirement, not an afterthought — "done" claims
without verification get reopened, and the culture (plus tooling) enforces
tests landing *with* the feature. Flaky tests get root-caused or accountably
quarantined with a follow-up, never silently ignored.

If you're curious, the GUI shows the live pipeline: what's committed, what
the gate verdict is, what's deployed where.
