# Runbooks: the official definition and convention for procedural insights
URL: /internal/docs/agent-insights/runbooks-convention

A runbook is a PROCEDURAL agent-insight — ordered steps to execute for a known operational situation — as opposed to a post-mortem insight (root cause + lesson) and a recipe (machine-executable procedure, recipes:run). The convention: slug ends -runbook, frontmatter tag `runbook`, the word runbook appears in the title or description (so docs:search ranks it lexically), body shape = preconditions → ordered steps → verify → rollback/failure modes, with executable legs pointed at recipes.

## What "runbook" means here (owner-ratified 2026-07-11)

Agents across sessions independently converged on the word **runbook** — standard
SRE vocabulary for "an ordered, operational procedure for handling a known
situation" — and the system's own prompt surfaces already used it informally
("insights — procedural memory (the runbook)"). This page makes it official.

**A runbook is a procedural agent-insight: a doc whose body is ordered steps you
execute**, not an explanation you absorb. It is one of three related concepts:

| Concept     | What it is                                                           | Where it lives                       |
| ----------- | -------------------------------------------------------------------- | ------------------------------------ |
| **recipe**  | machine-executable, parameterized procedure                          | `recipes:run` / `recipes:list`       |
| **runbook** | agent/human-readable procedure doc (ordered steps)                   | agent-insights MDX, slug `*-runbook` |
| **insight** | explanation: incident, root cause, lesson, "what this means for you" | agent-insights MDX (everything else) |

A runbook often *composes* recipes — e.g. `papercusp-desktop/RELEASE-RUNBOOK.md`
is executed through `recipes:run release-verify-provenance` /
`release-vm-preflight` — and an incident insight often *ends* in a short runbook
section. The genre label follows the dominant shape of the page.

## The convention

When you write a procedural doc (via `docs:author` or by hand):

1. **Slug** ends in `-runbook` (e.g. `embed-sidecar-runbook`,
   `federation-rig-restart-runbook`).
2. **Tag** `runbook` in the frontmatter `tags` list.
3. **Say "runbook" in the title or description.** This is what makes the genre
   searchable *today*: `docs:search` scores title ×4 / description ×2, so
   `docs:search { query: "runbook <topic>" }` ranks procedures above
   post-mortems with zero new engine machinery.
4. **Body shape**: preconditions / when-to-run → numbered steps → how to verify
   it worked → rollback / known failure modes. Point any executable leg at the
   recipe (`recipes:run <id>`) instead of duplicating its commands.
5. Everything else follows the normal insight rules — frontmatter
   `documents:` for drift-tracking, written in the same turn the procedure is
   proven, indexed automatically (`npm run gen:doc-insights-index`).

Existing procedural insights that predate this page should be tagged
opportunistically when next touched — do not mass-retag.

## Why a genre, not a new surface (D-001)

Runbooks stay **inside** agent-insights on purpose. Insights already have the
machinery a separate "runbooks" section would have to duplicate: drift tracking
(`insight-staleness.ts` watches the `documents:` anchors), the generated index
(`reference/agent-insights-index`), prelude injection, and `docs:search`
coverage. A parallel section or a `runbooks:*` tool family would fragment
search for zero capability gain. If the corpus ever outgrows lexical search,
the upgrade path is a tag-aware filter in `packages/docs-engine` — not a new
surface.

## Finding runbooks

* `docs:search { query: "runbook <topic>" }` — the convention guarantees the
  word is in the ×4/×2 scoring fields.
* The [agent-insights index](/reference/agent-insights-index) lists tags —
  scan for `runbook`.
