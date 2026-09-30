# Per-pot staging→main pipeline — git as backup vs git as CI/CD
URL: /internal/docs/agent-insights/per-pot-staging-main-pipeline

The papercusp staging→main green gate is generalized per coding pot, but git plays TWO roles and only ONE generalizes the gate. Repo-as-backup (git-sync→staging) is broad; repo-as-CI/CD (green-gated FF to main + deploy) is CODING-ONLY. Per-pot seeding is flag-gated default-OFF; the operator-home (papercusp) is preserved bit-for-bit via an empty env overlay.

## What

Papercusp's own repo runs a **staging→main green gate**: agents work on `staging`;
`main` only ever fast-forwards to a `staging` commit that passed the suite
(green-checkpoint); a separate release checkout auto-deploys green `main`. Plan
`per-pot-git-and-release-gate-2026-06-29` generalizes this to **every coding pot** —
but the key insight is that **git plays two different roles**, and only one of them is the
gate:

| Role                            | Mechanism                                                          | Who gets it                                                             |
| ------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| **A. Repo as versioned backup** | git-sync → `staging` (leg 1)                                       | any pot with a repo (incl. non-coding homes that keep file artifacts)   |
| **B. Repo as CI/CD**            | green-checkpoint FF `staging`→`main` (leg 2) + auto-deploy (leg 3) | **coding pots only** — there is no suite to gate a brainstorm canvas on |

So "bring the pipeline to all pots" means **leg 2 for coding pots**, leaning on leg 1
(already per-harness). Leg 3 (auto-deploy) stays opt-in (`releaseGate.deploy`) and is
currently **deferred** — the systemd unit + health probe are operator-home-specific.

## How it's wired

* **The signal is the blueprint.** The `coding` blueprint sets `knobs.requiresRepo: true` +
  `knobs.releaseGate.enabled: true`; the non-coding `work` blueprint sets both off
  (`output.kind: artifacts`, `acceptance.kind: judge` — nothing to test). A coding pot that
  would be repo-less is rejected at `pot:create` (`hive_requires_repo`), keyed off
  `output.kind === 'repo-commit'` (an independent, non-circular signal).
* **`greenCmd` reuses the existing `testCommand` knob** (detected by
  `harness:generate-from-repo`) → the gate runs the SAME command agents write tests for; a
  repo with no tests falls back to build (`npm run build`), never an unconditional FF.
* **release-config.ts is untouched.** It's already fully env-overridable, so per-pot config
  rides that seam: `resolveHiveReleaseEnv(slug, ws)` (operator-core, where the registry +
  blueprint resolution live) computes a per-pot env overlay
  (`PAPERCUSP_INTEGRATION_ROOT` = the pot's registry path, namespaced
  `<slug>-checkpoint`/`<slug>-release` roots, branches + `greenCmd` from the gate) and the
  `system:green-checkpoint` handler passes it to the green-checkpoint subprocess via
  `runScript`'s `extraEnv`. The subprocess's `releaseConfig()` re-derives everything from env.
* **The operator-home (papercusp) is preserved bit-for-bit.** `resolveCheckpointRouting`
  returns an EMPTY overlay for the operator-home slug, so its live `:3070` pipeline runs
  exactly as before. A non-gated `installSlug` (gate disabled / no repo) → the handler skips
  (records a `skipped-disabled` pipeline event), never running a suite for it.
* **Fresh coding pots get a real repo.** `pot-repo-init.ts` makes the initial commit on
  `staging` + marks the registry entry `self_repo:true` (without it git-sync freezes the home
  as `'hive_home'` — the 2026-06-20 incident) and, by default, publishes a PRIVATE GitHub
  remote when `gh` is authed (else local-only; the local gate still runs). `_create.ts` step
  6f then seeds git-sync + (flag-gated) the green-checkpoint for the home.

## Rollout posture (IMPORTANT)

Per-pot green-gate seeding is **flag-gated `PER_HIVE_RELEASE_GATE`, DEFAULT-OFF (dark)**. With
the flag off, only the operator-home (papercusp) release routines run — the live pipeline is
untouched. To enable a pot: flip the flag on, then `seedHiveReleaseRoutines({ sql,
workspaceId, hiveSlug })` (it self-skips the operator-home, non-coding, and repo-less pots).
Verify a live green-checkpoint fast-forwards only THAT pot's `main` before broadening.

## Agents don't need to be told the gate by hand

The staging→main contract (work lands on `staging`; `main` is green-only; a red suite
freezes it; never push `main`; tests gate promotion; watch `/admin/git`) is rendered from the
live config by `renderPromotionModelSection()` and spliced into the SU playbook at the
`<!-- PAPERCUSP-SU:PROMOTION-MODEL -->` marker — so the prompt can never describe a gate the
routines don't run, and a non-coding pot renders nothing. Don't hand-write branch facts into
prompts; change the config/renderer.
