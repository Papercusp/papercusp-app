# How docs drift-tracking actually works (anchors → git → sweep → steward)
URL: /internal/docs/agent-insights/docs-drift-tracking-how-it-works

The full pipeline behind the Docs tab's fresh/stale badges — subject_ref anchors, git-log drift detection, the post-git-sync sweep with its GIN reverse index, and the doc-steward dispatch. Read this before touching doc freshness or answering "how do docs stay current?".

Audited end-to-end 2026-07-13 (code as the only source of truth) so the next
agent doesn't have to re-derive it. Plans: harness-docs-integration-2026-06-05,
docs-corpus-audit WS2.

## The pipeline in one paragraph

Every doc carries a typed **anchor** (`subject_ref`) declaring *what code it
documents*; drift detection is **plain git** — `git log <baseline>..HEAD -- <anchored paths>` non-empty ⇒ stale; the check runs **after every git-sync
tick** via a cheap reverse-index prefilter; and a flagged doc **closes the
loop** — generated docs get a regeneration enqueued, manual docs get a
re-verify flag, and a single **doc-steward agent** is dispatched to re-sync
the drifted batch.

## 1. Anchors — `subject_ref` (subject-ref.ts, manual-anchor.ts)

Three strategies, all reducing to concrete repo paths:

* `path` — glob(s), used verbatim as git pathspecs.
* `symbol` — `file :: name`, traced precisely with `git log -L :name:file`
  so an unrelated edit elsewhere in the same file does NOT flag the doc
  (file-level `--follow` fallback when `-L` can't run).
* `feature` — `F-NNN` / `WI-NNN`, resolved to the work-item's recorded
  implementing commits → the files those commits touched.

Manual docs declare anchors via a `documents:` frontmatter key (this very file
does); otherwise refs are best-effort **inferred from repo paths mentioned in
the body**. An unanchored doc is allowed but surfaces as **"Not
drift-tracked"** — the old silent-rot mode made visible instead of hidden.

## 2. Baseline + detection (drift.ts)

* Baseline: `generated_from_sha` for generated docs, `last_verified_sha` for
  manual docs (set by the verify action → HEAD).
* Stale ⇔ `git log <baseline>..HEAD -- <resolved paths>` returns commits.
* Honest edges (accepted in D-001): whitespace/comment-only commits can
  false-nudge (a false nudge beats silent rot); renames handled with
  `--follow`; anchors under **git submodules** are routed INSIDE the submodule
  against the gitlink-recovered baseline (else they never flag); any git/
  baseline error maps to status `unknown` ("can't tell"), never a confident
  fresh/stale.

## 3. When it runs (freshness-sweep.ts, sweep-after-sync.ts)

After each git-sync `synced`, the tick's changed paths are intersected with
the denormalised **reverse index** — per-record `anchor_paths text[]`,
GIN-indexed (migration 172) — and only the intersecting docs pay for the
precise git confirm. On-demand recompute exists per doc
(`GET /api/harness/:slug/docs?path=<docId>&recompute=1`). The whole bridge is
best-effort and swallowed on failure: it must never wedge git-sync.

## 4. Closing the loop (doc-steward-dispatch.ts)

Newly-drifted docs dispatch ONE **doc-steward** agent (gate:
`papercusp-doc-steward`; batch-capped with a dispatch cooldown per WI-2104 —
the old whole-set-per-spawn pattern burned 58% of spawns at timeout). Each
drifted doc is handed with its `anchorPaths`, the drift reason, and the
**work-items that changed the anchored code** (derived from
`git_sync_commit_attribution`, D-006) so the steward reads intent instead of
reverse-engineering diffs.

## 5. Statuses + UI (AdvDocsTab.tsx, routes/harness/docs.ts)

`fresh | stale | review | untracked | unknown` — badges "⚠ May be out of
date" / "Not drift-tracked", nav freshness dots, and the close-the-loop verbs:
`POST /api/harness/:slug/docs/{verify|regenerate|overlay|anchor}`.

## Gotchas worth knowing before you touch this

* The reverse index (`anchor_paths`) is denormalised — if you change how
  anchors resolve, the sweep prefilter and the precise confirm can disagree.
* `symbol` anchors get file-level fallback on rename/removal; expect
  occasional over-flagging there, by design.
* Docs under submodule paths are only correct because of the explicit
  submodule routing in drift.ts — don't "simplify" it away.
