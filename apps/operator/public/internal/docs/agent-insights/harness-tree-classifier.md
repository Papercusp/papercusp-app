# The 4-kind harness-tree classifier + qualified-slug rule
URL: /internal/docs/agent-insights/harness-tree-classifier

When walking a git repo's nested .git entries, classify each as submodule / worktree / standalone / plain-dir, and derive qualified slugs for submodules. Used by the harness-creation flow to decide what becomes a sub-harness.

## What

When you point the harness-creation flow at an existing git repo
(Entries 1, 2, or 3 of the §3 create-harness wizard), it walks the
directory looking for nested `.git` entries and decides whether each
one becomes a sub-harness, a separate root harness, or part of the
parent. The classifier lives at
`packages/operator-core/lib/harness/classify-tree.ts` (papercusp-dogfood-v5
P-007).

There are **four classified kinds**, plus a fifth rule that derives the
sub-harness slug for submodules:

1. **Submodule** — `.git` is a *file* whose contents point into the
   parent repo's `.git/modules/<name>/`. → Becomes a **sub-harness**.
2. **Worktree** — `.git` is a *file* whose contents point into the
   same repo's `.git/worktrees/<name>/`. → **NOT a new harness**
   (it's an additional checkout of the same repo, which is what
   phases already are).
3. **Standalone** — `.git` is a *directory* with its own `HEAD` etc.
   → Becomes a **separate root harness**, not a sub-harness.
4. **Plain dir** (no `.git`) — just part of the parent repo. → No
   harness.
5. **Qualified slug** — a submodule's slug is path-qualified as
   `<parentSlug>/<relPath>` (for example `papercup/libs/papercusp`).
   This is a field on the `submodule` result, not a separate classified kind.

## Why distinguishing matters

The three "has-nested-.git" cases (1, 2, 3) all look superficially
the same: there's a `.git` somewhere below the root. But they mean
completely different things:

* **Submodule**: the parent repo deliberately references a separate
  upstream repo, pinned to a commit. It IS a logical sub-project of
  the parent. Sub-harness is right.
* **Worktree**: the parent repo has multiple checked-out branches
  living side by side, sharing one object store. Each worktree is
  the SAME project. Treating it as a sub-harness would duplicate
  the harness for every phase the user has materialized.
* **Standalone**: someone happened to clone an unrelated repo
  inside the parent's directory. Not part of the parent's project
  at all. Should be a separate root, not a sub of the parent.

Getting this wrong creates ghost harnesses, double-counts work, or
makes the harness tree feel arbitrary.

## How the rules detect each case

The classifier reads the first line of `<dir>/.git` and pattern-matches:

```
.git is a directory          → standalone (rule 3)
.git contents start with
  "gitdir: <abs>/.git/modules/" → submodule (rule 1)
  "gitdir: <abs>/.git/worktrees/" → worktree (rule 2)
  malformed / unknown target → plain (rule 4, conservative fallback)
```

For directories without `.git`, the walker descends into them. It also descends
into submodules by default (`recurseIntoSubmodules: true`) so sub-sub-harnesses
can be discovered; callers that only want direct children pass
`recurseIntoSubmodules: false`. Worktrees and standalone repos are never
recursed into.

## Real-world layout (papercup itself)

papercup has (after the 2026-05-31 borrowable-submodule regroup under
`libs/generic/`, the `test-config`/`testing-shell` promotions, snapshot-system
retirement, and `zero-harness` de-materialization):

* 1 tree root: the papercup repo at `/home/dev/papercupai-workspace/papercup`
* 6 direct-child submodules under `libs/`: `agent-chat`, `papercusp-db`, `papercusp-shared`, `papercusp`, `test-config`, `testing-shell` (the formerly-direct `git-graph`/`papergrid`/`sync`/`ui-primitives` submodules now live under `libs/generic/`; `zero-harness` is retired and not materialized)
* 6 plain dirs under `libs/`: `flags`, `generic`, `holepunch-spike`, `host-platform`, `marketplace-public-ui`, `papercusp-publish-auth` (`generic/` itself is plain at depth 0 — it holds the regrouped borrowable submodules below it)
* Many worktrees in siblings of the papercup repo (`papercup-backup`, `papercup-design-migration`, etc.) — those are detected if a future walk starts above papercup, but the classifier never confuses them for new harnesses.

Total direct `libs/` count: 12 dirs (6 submodules + 6 plain), exactly what the
test asserts against:

```ts
// packages/operator-core/lib/harness/classify-tree.test.ts
it('matches the libs/ layout: 6 submodules + 6 plain (borrowable submodules regrouped under libs/generic/)', ...)
```

## When you touch this code

* **Adding a 6th rule** (e.g. `git-annex` repos, fossil repos)?
  Add to the precedence list and update the test count. The classifier
  is a pure function over (path, fs) → outcome; tests are cheap.
* **Changing the walker boundary**? The current default stops
  recursion at worktrees and standalone repos, but recurses into
  submodules unless `recurseIntoSubmodules: false`. If you change that,
  you'll change whether nested submodules become visible to harness creation.
* **Changing the slug derivation**? Sub-harness slugs are
  path-qualified relative to the tree root (e.g. `papercup/libs/sync`).
  Changing this collides with existing harness registry entries.

## Related

* `packages/operator-core/lib/harness/classify-tree.ts` — the classifier
* `packages/operator-core/lib/agent-tools/plans/source.ts` — uses
  `detectPapercupRoot` (same shape) to find the papercup repo for
  Phase 4 dogfood self-registration (formerly `harness/register-papercup.ts`)
* v5 plan §2 — the architectural treatment of harness hierarchy
  reflecting submodule hierarchy
