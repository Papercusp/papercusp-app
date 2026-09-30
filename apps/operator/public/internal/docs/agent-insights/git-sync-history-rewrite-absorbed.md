# git-sync absorbs history rewrites — you cannot force-push a shared pot
URL: /internal/docs/agent-insights/git-sync-history-rewrite-absorbed

A force-push (rewind / rebase / amend) to a shared-pot origin is NOT honored — the next peer's git-sync re-merges its own history back and fast-forwards origin, so dropped commits REAPPEAR. An unrelated-history (orphan) rewrite instead LOUDLY errors (refusing to merge unrelated histories → git-sync-error escalation), never a phantom merge-resolver or a loop. GitHub is the authority of record; the tree only moves forward.

## What

On a **shared pot** (multiple peers pushing to one GitHub origin via per-peer
git-sync), **a history rewrite never sticks**. If a peer force-pushes a rewind,
rebase, or amend that drops or rewrites commits, the very next peer's git-sync
tick **absorbs (reverts) it**:

* the peer still holds the dropped commits in its own checkout;
* its `git merge origin/<branch>` of the rewound tip is a no-op (the rewound tip
  is an *ancestor* of the peer's HEAD) or a clean re-merge;
* its push **fast-forwards origin back up through the dropped commits** — they
  **reappear** on origin.

So the rewrite is silently undone. This is correct and intended: **GitHub is the
authority of record and the tree only moves forward** — concurrent edits are
reconciled by git + the per-peer merge-resolver, so nothing is ever lost, and a
"clean up history" force-push by one peer cannot delete another peer's work.

## Why it matters (don't try to force-push)

Agents and humans sometimes reach for `git push --force` to "fix" a shared-pot
branch (collapse WIP, drop a bad commit, rebase). **It won't take** — another
peer re-pushes the old history within a tick, and you've just added churn. To
actually remove something from a shared pot you must coordinate every peer
(pause their git-sync routines) — there is no unilateral rewrite. (On the
`papercup` dev tree this is doubly true: `main` is automation-only behind a
pre-push hook, and `staging` is swept by git-sync — see `CLAUDE.md`.)

## The three rewrite shapes (run-git-sync behavior)

`run-git-sync.ts`'s `syncOneRepo` does commit → fetch → `merge --no-edit
origin/<branch>` → push (with one non-FF re-fetch+re-merge retry). Against a
rewritten origin that shares an ancestor with the peer:

| Rewrite                                                             | Peer's merge                                                                                               | Outcome                                                                                                                                                              |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Rewind / drop a commit** (reset back to an ancestor, force-push)  | no-op (rewound tip is an ancestor) → FF push re-introduces the dropped commits                             | `synced` — **absorbed**, dropped content reappears                                                                                                                   |
| **Conflicting rewrite** (rewrite touches a file a peer also edited) | conflict                                                                                                   | `conflict` → ordinary escalation + merge-resolver (no loop)                                                                                                          |
| **Unrelated history** (orphan root force-push, no common ancestor)  | `git` refuses ("refusing to merge unrelated histories") → a merge that failed with **no conflicted paths** | `error` → the **loud EI-18 `git-sync-error` escalation**, NOT a `conflict` (so **no merge-resolver is dispatched at an unresolvable history**) and NOT a silent loop |

The third row is the important guard: an unrelated-history rewrite is classified
`error`, not `conflict`, by the "merge failed with no unmerged paths" check
(`run-git-sync.ts`) — so a human is alerted via the error escalation instead of a
merge-resolver being thrown at a merge it can never complete.

## Where this is pinned

`packages/operator-core/lib/harness/git-sync/multi-peer-convergence.test.ts`
(shared-pot-hardening-2026-06-13 P-005) — the rewind-absorbed, conflicting, and
orphan-error cases, with real git. Multi-peer convergence (P-004: 3+ peers,
cross-peer submodule conflicts) lives in the same file; the two-peer escalation /
`last_resolver` dedup lifecycle is in `two-peer-convergence.integration.test.ts`
(D-007).

Related: `[[git-sync-live]]`, the resolver-dispatch restart-liveness (P-006 —
`isResolverInFlight` re-dispatches a dispatch orphaned by an operator restart on
the next tick instead of waiting out the 20-min TTL, `git-sync-action.ts`).
