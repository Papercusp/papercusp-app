# Across a submodule boundary, git answers a question you did not ask — and the answer is always the safe-sounding one
URL: /internal/docs/agent-insights/verifying-a-change-across-a-submodule-boundary

The superproject stores a GITLINK, not submodule file content. So `git show <sha>:<submodule-path>/file` prints nothing, `git status --porcelain <submodule-path>/file` prints nothing, and `git ls-files` says the path is unknown to git — while the file exists, is committed, and is live. Every one of those empties reads as 'absent' or 'clean', and they compose into a confident false negative in the most expensive direction: 'my instrumentation is not in this build, abort the run.' Resolve the gitlink (git ls-tree) or ask dev:pipeline_position; never grep across the boundary.

## The shape of the bug

This is the [empty-log-reads-as-a-clean-run](/internal/docs/agent-insights/an-empty-log-reads-as-a-clean-run)
failure class, pointed at `git`. A verification collapses two claims into one number —
*the question was valid* and *the answer is no* — and across a submodule boundary the
first claim is false while the number still comes back `0`.

`papercusp-desktop` and most of `libs/**` are **submodules**. A superproject commit does
not contain their files; it contains a **gitlink** (mode `160000`) naming one commit in
another repository. Ask the superproject about content it does not store and git does not
error usefully — it returns nothing:

```bash
# ALL THREE ARE THE WRONG QUESTION. None of them is a negative answer.
git show <superproject-sha>:papercusp-desktop/bin/lib/scenarios/b3-revocation.sh | grep -c revoke.live
#   => 0            ...but the file has 4 occurrences and always did.

git status --porcelain papercusp-desktop/bin/vm-federation.sh
#   => (empty)      ...reads as "clean, committed". Real uncommitted submodule work
#                      prints exactly the same empty output.

git ls-files papercusp-desktop/bin/vm-federation.sh
#   => "did not match any file(s) known to git"
```

Both wrong answers are the **safe-sounding** ones, which is what makes them compose. On
2026-07-26 they composed into: *"the in-flight live-federation gate was built WITHOUT the
revoke diagnostics, so it cannot answer the question it is running to answer."* The action
that follows is telling the rig owner to abort and re-run a \~30-minute decisive gate. The
gate was fine. (Near-miss, caught before it cost the run — EI-18715870370005934.)

The same boundary bites attribution: `git blame` / `git log -- <submodule-path>` from the
root look clean even when your edit is real, which is a second reason
[blame is not attribution here](/internal/docs/agent-insights/attributing-a-change-despite-git-sync-squash).

## Ask the tool, not git

`dev:pipeline_position` is the blessed "is my edit live?" answer and it is submodule-aware —
it resolves the path into the submodule, and (since EI-18715870370005934) resolves a
**superproject sha** against the gitlink so a cross-boundary probe reports the *pinned*
commit instead of `no commit found`:

```
dev:pipeline_position { path: 'papercusp-desktop/bin/vm-federation.sh',
                        sha:  '<superproject-sha>' }
```

It returns `submodulePin: { superprojectSha, submoduleSha }` whenever the sha you asked
about is not the sha the positions describe — the substitution is never silent.

> Before the fix this same call returned `targetSha: null`, all four positions `false`,
> `summary: "no commit found."` **and** an `awaitable` hint advising `deploy:await` — i.e. it
> told you to park on a deploy for a commit that was already pinned and live. A false
> negative that also hands you a next action is the expensive kind.

## Doing it by hand

Two steps, and the first is the one everybody omits:

```bash
# 1. Which submodule commit does this superproject commit PIN?
git ls-tree <superproject-sha> papercusp-desktop
#   => 160000 commit 151cfdb3357a4ae03d34e8a32b89b8355656c356  papercusp-desktop

# 2. Ask THAT repo, at THAT commit.
git -C papercusp-desktop show 151cfdb3357a:bin/lib/scenarios/b3-revocation.sh | grep -c revoke.live
```

For working-tree status, run `git status --porcelain` **inside** the submodule — and note it
is on its own default branch (`papercusp-desktop` tracks `main`), not `staging`. From the
root the only thing you will ever see is a bare ` m papercusp-desktop` gitlink-moved line.

## The rule

**A cross-boundary `grep -c` that returns 0 has told you nothing.** Before believing any
absence about a path under a submodule, confirm you asked a repo that could have answered:
resolve the gitlink, or `git -C <submodule>`, or let `dev:pipeline_position` do it. An
absence is only evidence once you have proven the question was addressed to something that
stores the answer.
