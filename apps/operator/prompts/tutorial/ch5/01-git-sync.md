---
id: ch5-01-git-sync
chapter: 5
order: 1
title: Git sync — nobody commits, everything is committed
docSlugs: system/pot-git-sync, system/repo-conventions
---

## Brief

In Papercusp workspaces, a background **git-sync** routine commits and
pushes the whole shared tree every few minutes — agents (and you) just leave
changes in the working tree. No `git add`, no commit messages, no push. It
sounds heretical; it's what makes dozens of concurrent editors workable.

## Details

The reasoning: with many agents editing one checkout, per-author commits
would serialize everyone behind git ceremony and constant conflicts.
Instead, edits are coordinated at the *file* level (the lock system), and a
routine snapshots the whole tree on a schedule. Conflicts that do arise on
the remote go to a dedicated resolver agent, not to whoever happened to be
editing.

Two corollaries worth knowing. First, work is never "uncommitted for long" —
the sync interval is minutes, and an agent can force a sync when a deploy
needs the latest work right now. Second, destructive tree-wide git commands
are forbidden and guarded, because everyone's in-flight edits share that
tree.

Your own repos outside Papercusp workspaces are untouched by this — normal
git rules apply there. This model governs the shared workspaces agents
operate in.
