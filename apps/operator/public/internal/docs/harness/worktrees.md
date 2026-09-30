# Worktrees & isolation
URL: /internal/docs/harness/worktrees

Where git worktrees are (and deliberately are not) used today — phase worktrees, transient scratch envs for verification, and the shared-tree rule for the dev fleet.

The first-generation harness used a git worktree per parallel lane
(`.harness/worktrees/<feature-id>/`) so concurrent workers couldn't race each
other's `git checkout`. That mechanism retired with the bash loop, but the
underlying idea — *give a unit of work its own filesystem view instead of
fighting over HEAD* — survives in three distinct, narrower forms.

## 1. Phase worktrees (staging / testing / production)

A harness project can have up to three phased worktrees
(`packages/operator-core/lib/harness-phases.ts`):

* **staging** → the project's main path
* **testing / production** → an explicit per-phase `path` override carried on
  the project's workspace-registry entry, falling back to a sibling checkout
  at `<path>--testing` / `<path>--production` when no override is set. The
  override takes precedence; the sibling is the default. The override lives on
  the registry `phases` blob and is not read from `config.json`
  (`deprecate-harness-config-json-2026-06-06`).

Every `?phase=` API route resolves through `phasePath()`. The FS watcher is
phase-aware — it walks all three phases' `.papercusp/` directories — but as of
`fs-watcher-retirement-2026-05-10` its only remaining mirror is proposals
(`harness_shared.harness_proposals_shared`, keyed by `(harness_slug, phase,
proposal_id)`). Every other former mirror (tests, escalations, git log,
decisions, checkpoints, hook logs, screenshots, plan review, smoke, branch
actions, and the `harness_phases` mirror itself) is now retired: that state is
written to PG at *producer* time (POSTs to `/api/internal/*`) rather than
mirrored from disk. Agents resolve a phase's absolute path with the
`harness:phase_path` tool. The multi-phase surface is gated by the
`papercusp-harness-phases` [feature flag](/internal/docs/posthog/feature-flags).

## 2. Transient scratch worktrees for verification

The worker chunk loop wants to typecheck a worker's pending edits **before**
committing them, in a tree that can't see other concurrent workers' WIP. The
primitive is `scratch-env.ts`
(`libs/papercusp/packages/orchestrator/src/scratch-env.ts`): create a
transient git worktree at integration HEAD, apply the worker's pending edits
for its locked files, symlink the heavy gitignored cache dirs
(`node_modules`, `.turbo`, …) back to the main repo so caches stay warm, run
the check, tear down. Setup is \~60 ms; `git worktree prune` at setup
self-heals orphans from crashed runs; many workers can hold scratch envs
simultaneously.

The verification check runs shell-free: the config-sourced command is
whitespace-split into a plain argv and spawned without a shell (audit P-030).
A command containing shell metacharacters is rejected (exit 126), and missing
or non-executable commands map to 127 / 126 — all of which route to the
"unrunnable / fail-open" lane. A misconfigured gate therefore never blocks a
commit.

This is the direct descendant of the legacy lane-worktree insight: parallel
workers sharing one working tree contaminate each other's verification
signal, and a cheap throwaway worktree is the cleanest cross-platform fix.

A sibling primitive, `tmpfs.ts`, hands subprocesses RAM-resident scratch
*directories* for their inputs (`/dev/shm` on Linux) — state is PG-canonical,
but external agent CLIs still need a path on disk to read.

## 3. What deliberately does NOT use worktrees: the dev fleet

For Papercusp's own development, concurrent agents work **one shared checkout
on `staging`** — no per-agent worktrees, no feature branches. Isolation comes
from coordination instead of tree-splitting: the per-edit file-lock hook
serializes same-file edits (`locks:*`), declared intents make work visible
(`coord:*`), and a background git-sync routine owns commit + push. The
trade — messy interleaved history for zero merge-reconciliation tax — is
deliberate; see the repo guide (`CLAUDE.md`, "Branch discipline").

The two models coexist because they solve different problems: worktrees
isolate *machine verification* (a typecheck must not see foreign WIP);
locks + coord serialize *human-scale collaboration* (two agents shouldn't
edit one file at once, but they *should* see each other's work immediately).

## Historical note: competition mode

The bash harness briefly ran a Conductor-inspired **competition mode** — N
workers attacking the same feature in sibling worktrees, the validator
picking a winner. It was replaced pre-cutover by the **synthesizer** (read
every lane's diff, compose one shipping branch), which has itself been
dormant since the legacy run-loop retired
(`libs/papercusp/_retired/orchestrator-run-loop/`). Today's analogue for
"multiple independent attempts, judged" is work-item **redundancy**
(replica dispatch + `work_items:judge_redundancy`), which operates at the
work-item layer rather than the git layer.

## Related

* [Decision log](/internal/docs/harness/decisions/log) — the original
  worktree decision and its rationale
* [Storage policy](/internal/docs/system/storage-policy) — why state moved
  off the filesystem even as worktrees stayed for code
