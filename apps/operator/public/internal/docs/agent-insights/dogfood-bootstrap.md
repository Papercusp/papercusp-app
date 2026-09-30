# How the papercusp-workspace + papercup-self-registration boot path works
URL: /internal/docs/agent-insights/dogfood-bootstrap

Two fire-and-forget bootstrap helpers run on every operator boot to make Papercusp dogfood itself — papercup workspace ensure + papercup repo auto-register. Idempotent + non-disruptive to existing installs.

import { Aside } from '@astrojs/starlight/components';

## What

Two helpers make Papercusp dogfood itself:

1. **`ensurePapercuspWorkspace()`** — guarantees a workspace called
   `papercusp-workspace` (literal name) exists in the workspace
   registry. Idempotent.
2. **`registerPapercupHarness()`** — if running from the papercup
   source repo, auto-registers it as a harness named `papercup`
   inside that papercup workspace, `state: private`. Idempotent
   * no-op for packaged installs.

Together: Papercusp dogfoods itself.
The user finds `papercup` in their harness dropdown when they
switch to `papercusp-workspace` — no manual `harness create` step.

Files (current boot location):

* `packages/operator-core/lib/harness/papercusp-workspace.ts`
* `packages/operator-core/lib/harness/register-papercusp.ts` (renamed from
  `register-papercup.ts`; still exports `registerPapercupHarness` + `detectPapercupRoot`
  — the fn names deliberately keep the legacy `Papercup` spelling)
* `packages/operator-core/lib/harness/ensure-papercusp-hive.ts` — the **third** helper
  (see the B-merge note above)
* `packages/operator-core/lib/harness/bootstrap-papercusp-hive.ts` — the **fourth**
  module (clone-on-first-boot; see the 2026-06-23 update below) — this one DOES have
  live boot-time callers
* `apps/operator/scripts/run-dogfood-bootstrap.ts` (one-shot manual driver)

**Update (2026-06):** The original boot wiring was the Next.js instrumentation hook
(apps/operator/instrumentation-node.ts), which is **retired** along with the Next
standalone operator. The two helper modules moved from apps/operator/lib/harness/ to
`packages/operator-core/lib/harness/`. As of this audit there is **no live
boot-time caller** of `ensurePapercuspWorkspace()` / `registerPapercupHarness()`
in the operator source — they are exercised only by the one-shot driver
`apps/operator/scripts/run-dogfood-bootstrap.ts` (npm `verify:dogfood-bootstrap`)
and their unit tests. Run the driver manually to flip dogfooding on; the rest of
this page (papercup name, the scoped-write trick, `detectPapercupRoot`) is still
accurate.

**Update (2026-06, papercup→papercusp B-merge):** `register-papercup.ts` is now
**`register-papercusp.ts`** (the exported fns `registerPapercupHarness` /
`detectPapercupRoot` keep the legacy `Papercup` spelling on purpose). The driver now
runs a **third** helper, `ensurePapercuspHive()`
(`packages/operator-core/lib/harness/ensure-papercusp-hive.ts`), shipping Papercusp as a
shared **pot** (slug `papercusp`). Because `papercusp` is that MERGED operator-home
pot, `registerPapercupHarness` keeps `LEGACY_STANDALONE_HARNESS_SLUG = 'papercup'`
(the pre-merge standalone slug, deliberately distinct from the pot) but **skips
re-creating a separate `papercup` harness** once the merged `papercusp` pot exists — so
a post-merge boot no longer dumps a duplicate `papercup` into the dropdown. The
"two helpers" framing below is therefore now **three**.

**Update (2026-06-23 → present): a LIVE boot-time caller now exists — the "run the
driver manually" advice above is stale for a packaged install.** A fourth module,
`bootstrap-papercusp-hive.ts`
(`packages/operator-core/lib/harness/bootstrap-papercusp-hive.ts`), implements
**clone-on-first-boot**: the owner decision to ship the desktop with `papercusp` as the
single default hive, Papercusp building itself out of the box. Its
`startBootstrapPapercuspHive()` (single-flight; `bootstrapPapercuspHive()` underneath)
is called from **three** trigger paths — `apps/operator/bin/host-bootstrap.ts` (the
explicit boot call, gated on `getFlag(FLAGS.DOGFOOD_PAPERCUSP_POT)`), the setup-wizard's
`POST /api/desktop/bootstrap-pot/start` (`bootstrap-pot-start.ts`, same flag gate), and
`hive-directory-boot.ts`'s `maybeTriggerCanonicalJoinOnIngest` (fired the instant the
canonical hive's announce is overheard on the global directory topic — this ONE path is
otherwise ungated, so `PAPERCUSP_DISABLE_DOGFOOD_HIVE=1` is the single, always-checked
kill-switch every path funnels through, specifically to close that gap). On a **packaged
install** with no local checkout, it clones `github.com/Papercusp/papercup` (via a baked
canonical-hive invite when present, else a `gh`-authenticated create) rather than
requiring a dev tree to already exist, restores an installer-bundled seed when shipped
(P-007/P-010/P-011, `FLAGS.POT_SEED_BUNDLE` — default on), makes `papercusp-workspace`
the active workspace so the hive is visible, and best-effort initializes the \~27
submodules in the background — before finally handing off to the SAME
`ensurePapercuspHive()` this page already describes. On a **dev checkout** (a local
`detectPapercupRoot` match), the existing three-helper path below is what actually runs;
the clone leg is specific to a packaged/no-checkout install. `run-dogfood-bootstrap.ts`
remains a valid **manual** driver (useful to verify a code change without restarting the
operator — see below) but is no longer the *only* way dogfooding gets flipped on.

## Why two helpers, not one

They do different things:

* **`ensurePapercuspWorkspace`** writes to
  `~/.papercusp-workspaces/registry.json` (file-backed) — the user's
  list of workspaces.
* **`registerPapercupHarness`** writes to PG
  (`harness_shared.harness_registry`) **scoped to** the papercup
  workspace (not the active workspace) — the harness list within
  that workspace.

Splitting them keeps each helper testable in isolation. The bootstrap
calls them in order: papercup ensure → register papercup as harness.

## The "scoped to the papercup workspace, not active" trick

When you have multiple workspaces, the harness registry is per-
workspace: each workspace has its own list of harnesses. The
operator's existing `saveHarnessRegistry()` defaulted to writing to
the **active** workspace.

If P-024 wrote to the active workspace, it would silently dump
`papercup` into whichever workspace the user happened to be looking
at — usually `default`. Bad: pollutes the user's workspace.

The fix (commit `b53185ee`): add an optional `workspaceId` param to
`saveHarnessRegistry()` (additive, 100% back-compat across 52 call
sites). The dogfood bootstrap passes `PAPERCUSP_WORKSPACE_ID`
explicitly so the write lands in the papercup workspace regardless
of which one is active.

A symmetric `wsOverride?` was already on `readOperatorState`; this
just closes the API asymmetry at the underlying `writeOperatorState`
helper.

## How the papercup-root auto-detector works

`detectPapercupRoot(start)` in `register-papercusp.ts` walks UP from
the given directory looking for both markers (now factored into the exported helper
`hasPapercupMarkers(dir)`):

```ts
existsSync(join(dir, 'apps', 'operator', 'package.json'))
  && existsSync(join(dir, 'libs', 'papercusp', 'package.json'))
```

Two markers because either alone could be coincidental in unrelated
projects. Both together pin the directory to "this is the papercup
repo." Bounded to 8 levels up so it can't unbounded-walk a weird
filesystem. When called with no explicit `start` it first checks
`process.env.PAPERCUSP_INTEGRATION_ROOT` (an explicit override for a box that runs an
integration checkout somewhere the walk-up wouldn't find) — only falling back to
`process.cwd()` + the walk-up when that's unset or doesn't carry the markers.

Returns `null` for packaged desktop installs where neither marker
exists — the bootstrap silently skips with a `state: 'skipped'`
result.

## When you touch this code

* **Renaming the papercup** (`papercusp-workspace` → anything else)?
  Bad idea: many future surfaces (Cupboard, plan dogfood docs,
  multi-machine reconciliation) hardcode the name as a stable
  reference. The constant is in `papercusp-workspace.ts` for the
  one place that needs it; don't make it a per-install variable.
* **Changing the markers** in `detectPapercupRoot`? Be conservative —
  the two-marker rule was chosen specifically to avoid false
  positives. Adding a 3rd marker is fine; removing one is risky.
* **Adding a 3rd bootstrap helper** (e.g. auto-register sub-harnesses
  for papercup's submodules)? Add it to the one-shot driver
  (`run-dogfood-bootstrap.ts`), alongside the existing two. Keep
  each helper idempotent.

## Verifying it works without restarting the operator

There's a one-shot driver at
`apps/operator/scripts/run-dogfood-bootstrap.ts`:

```bash
cd apps/operator && npx tsx scripts/run-dogfood-bootstrap.ts
```

Runs the same code paths the boot path runs. Prints the registry +
PG state. Useful when:

* You just made a change to the bootstrap helpers and want to
  verify it works against the live PG.
* The running operator predates your changes (memory rule:
  don't restart the user's running dev server). The script
  exercises your new code without touching the operator process.
* You're debugging a "papercup isn't showing up in the dropdown"
  symptom and want to confirm the PG row is there.

Sample output:

```
=== STEP 1: ensurePapercuspWorkspace ===
workspace entry: id=papercusp-workspace, name=papercusp-workspace, createdAt=...
workspaces total: 6, current: default
✓ papercup 'papercusp-workspace' present in registry
=== STEP 2: registerPapercupHarness ===
state: already-registered
path: /home/dev/papercupai-workspace/papercup
=== STEP 3: verify PG row ===
harness_registry@papercusp-workspace: 1 projects
  - papercup  →  /home/dev/papercupai-workspace/papercup
✓ papercup registered in papercup workspace
=== PASS — dogfooding flipped on ===
```

## Related

* `packages/operator-core/lib/harness/classify-tree.ts` — the 5-rule classifier
  for nested `.git` entries; uses the same `existsSync`-on-markers
  pattern. See [the classifier insight](/internal/docs/agent-insights/harness-tree-classifier).
* v5 plan Phase 1a P-014 (workspace bootstrap) + Phase 4 P-024
  (papercup self-registration).
* `packages/operator-core/lib/workspace-registry.ts` — the underlying file-
  backed registry helpers.
* `packages/operator-core/lib/operator-state-pg.ts` — `readOperatorState` /
  `writeOperatorState` with optional `wsOverride` for per-workspace
  scoping.
