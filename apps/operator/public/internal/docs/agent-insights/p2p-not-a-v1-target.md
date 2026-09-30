# P2P / shared-pot federation is NOT a V1 target (owner directive)
URL: /internal/docs/agent-insights/p2p-not-a-v1-target

Owner directive 2026-07-06: don't spend V1 release-readiness effort testing or prepping P2P/cross-machine federation; the single-box desktop app is V1. P2P is post-V1.

# P2P / shared-pot federation is NOT a V1 target

**Owner directive — 2026-07-06 (ownerhandle8).** Verbatim intent: *"Why are we testing P2P mode — we are not getting P2P mode ready for V1."*

## The rule

**P2P / shared-pot / cross-machine federation is out of scope for V1.** Do **not** spend V1 release-readiness effort testing, verifying, or prepping any P2P / federation / multi-box / 2-box-rig feature. It is **deferred to post-V1**. Do not treat P2P readiness as a V1 release blocker.

## What is OUT of V1 (post-V1)

Cross-machine / peer-to-peer coordination and everything built to make it release-ready, e.g.:

* The `shared-pot-p2p-release-readiness-2026-07-03` plan and `p2p-work-distribution-2026-07-02` plan (and their design docs: per-fleet federation scope, foreign-worktree git plumbing, foreign-work isolation sandbox, etc.).
* 2-box / cross-machine **rig verifies** — e.g. `WI-2119` (THIS box ↔ Mac VM seat-delegation), the LIVE-1 parity-rig runbook.
* **Federation-crypto** items worked *for release gating* — `WI-2003` (epoch-key divergence), `WI-1981`, `WI-183`. These stay tracked, but as **post-V1** work, not V1 blockers.
* Substrate/holepunch peer connectivity, cross-machine seat delegation, shared-pot convergence — all post-V1.

## What IS in V1 (stays fully in scope)

The **single-box Tauri desktop app** — the shipping product:

* Local operator sidecar, embedded PG, migrations.
* Local fleet / agents on one machine.
* **Desktop SSE sync** — the desktop's *local* sync path. **This directive does NOT touch it.** "Sync" ≠ "P2P": SSE desktop sync is core V1; only *cross-machine* P2P/federation is out.
* Onboarding, the operator UI, everything a single desktop install does on its own.

## Common misread to avoid

Do **not** over-apply this to the desktop's local data-sync layer (`@papercusp/sync`, SSE). That is V1. The line is **single-box (V1) vs. cross-machine P2P/federation (post-V1)** — not "anything with the word sync/pot in it."

## If you lead a P2P-for-release plan

Re-scope it out of V1 (park items / pause the plan with this reason), and pick up V1-scoped backlog. Don't re-derive scope from the older P2P design/plan docs — they predate this directive.

## Durable anchors

* Standing fact `p2p-not-a-v1-target` (workspace + harness:papercusp scope) — folds into every orient.
* mem0 (project / papercusp).
* Broadcast to all agents 2026-07-06 (msg `mr9ujyz0`).
