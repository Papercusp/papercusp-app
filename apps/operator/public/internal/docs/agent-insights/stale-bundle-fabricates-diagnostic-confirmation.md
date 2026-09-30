# A stale pre-built bundle doesn't just lose data — it fabricates a clean confirmation
URL: /internal/docs/agent-insights/stale-bundle-fabricates-diagnostic-confirmation

Why verifying an experiment rig's instrumentation against source (node_modules, the patch file) is not enough — the check must run against the artifact actually executed.

## The defect (EI-18683847182779973)

An investigation rig runs a large pre-built serve bundle (esbuild inlines every
dependency into one file). When a diagnostic patch is applied to
`node_modules` **after** the bundle was built, the rig silently executes
**without** the instrumentation — and the absent field does not fail loudly.
It reads `undefined`, which every ordinary render (`?? false`, a falsy check,
`JSON.stringify` of an absent key) converts into a plausible-looking,
**legitimate** value.

This is worse than an ordinary stale-build bug. The value it fabricates is not
random — it is systematically the **falsy** one, which in a diagnostic
context is usually the "nothing unusual happened" reading. So the failure
mode is not "the run errors" or "the number looks weird"; it is **the run
produces a clean confirmation of whatever hypothesis predicted the falsy
value**. A stale build here doesn't lose data — it manufactures agreement.

## Concrete instance (verified by timestamp + grep)

* `patches/hyperdht+6.32.0.patch` — adds `udxRelayed` / `udxServerAddress` /
  `udxClientAddress` to the connection via `Object.defineProperty`.
* The candidate bundle under test was built **before** that patch landed.
* `grep -c 'udxRelayed' <bundle>` → `0`. The bundle inlines hyperdht, so it
  carries its own pre-patch copy of `connect.js`/`server.js`.
* `node_modules/hyperdht/lib/connect.js` **was** live-patched — so every
  source-level check an agent performs says the instrumentation exists. Only
  the artifact the rig actually executes lacks it.

Had the run proceeded, `socket.udxRelayed` would have been `undefined` on
every connection, rendered as not-relayed, and read as a clean confirmation
of a prediction the investigation had already committed to.

This was the **second** occurrence of the same class in the same
investigation — `bytesReceived: 0` across 101 failing connections earlier had
to be defended against exactly this reading (was it a real measurement, or
`undefined ?? 0`?), costing a dedicated control-arm analysis to resolve. Two
independent absent-vs-zero traps in one investigation is a strong signal this
is structural, not bad luck.

## Root cause

There is no gate asserting that **the artifact being executed contains the
instrumentation the experiment depends on**. The build step and the patch
step are each independently correct; nothing checks their ORDER, and nothing
checks the produced binary. Verification performed against source
(`node_modules`, the patch file, the repo) is exactly where the check passes
even when the run is broken — the source and the running artifact have
silently diverged.

## The guard

`packages/operator-core/lib/dev/assert-bundle-markers.ts` —
`assertBundleContainsMarkers({ bundlePath, requiredMarkers })` — greps the
bundle you are about to execute for every symbol/field name your diagnostic
depends on and throws a loud, specific error naming exactly which marker(s)
are missing if any are absent. Cheap (one file read + substring scan); fails
at **launch**, before you burn a run, instead of after — where the very
question you needed to ask ("was this instrumented?") is unanswerable from
the logs alone.

```ts
import { assertBundleContainsMarkers } from '@papercusp/operator-core/lib/dev/assert-bundle-markers';

assertBundleContainsMarkers({
  bundlePath: '/tmp/wi5837-patches/cand7_full.serve.mjs',
  requiredMarkers: ['udxRelayed', 'udxServerAddress', 'udxClientAddress'],
});
// throws immediately if the bundle predates the hyperdht relay patch —
// never silently runs the experiment on stale instrumentation.
```

Call it immediately before spawning/executing **any** pre-built bundle whose
output you plan to use as evidence for a diagnostic conclusion — not just for
hyperdht/P2P work. This applies to any ad hoc investigation rig that
pre-builds a bundle and expects a `patches/` or source edit to be reflected
in it.

## Bundle provenance stamping — NOW IMPLEMENTED for the sidecar (EI-19446480107603858)

This section used to say provenance stamping was unimplemented and worth doing
by hand. For the **sidecar** input set it now exists, so do *not* hand-roll it:

* `papercusp-desktop/bin/build-desktop-sidecar.sh` records
  `build-provenance.json` (the shared `emit-build-provenance.sh` schema — git
  head, build sha, UTC timestamp) into every sidecar it publishes.
* `papercusp-desktop/bin/check-sidecar-freshness.js` (logic in
  `bin/lib/sidecar-freshness.js`) is called by **both** cross-build legs, which
  previously gated the sidecar on existence + arch only — loud when it was
  MISSING, silent when it was merely OLD, which is the common case because
  rebuilding it is a separate manual step.

It deliberately does **not** decide staleness the way the old text above
proposed. Two design constraints, both learned the expensive way:

* **Not by mtime** — the original objection here still stands, and
  `bin/lib/spa-freshness.js` documents the same finding independently: a
  packaging copy refreshes the stale file's mtime, so timestamps call it
  current.
* **Not by "sidecar gitHead != repo HEAD"** — that is the obvious fix and it is
  wrong here. This is one shared checkout edited by the whole fleet, so HEAD
  moves every few minutes and such a rule fires on essentially every build for
  every agent. A guard that cries wolf is worse than none, because it trains
  the bypass.

So it splits into an always-on half and an opt-in half:

1. **A banner, unconditionally** — the sidecar's recorded age, gitHead and
   buildSha, printed by every consuming build. The silence *was* the defect: in
   WI-3307 a bundle shipped a 9-hour-old operator while its other half (the
   rsync'd source tree) was current, so every acceptance criterion passed on the
   fresh half. "built 9h ago from `ebb8505`" would have stopped it before \~73
   minutes of cargo zigbuild.
2. **`PAPERCUSP_REQUIRE_SIDECAR_CONTAINS=<sha>`** — assert "this cut must carry
   commit X" and the build refuses when the sidecar's provenance does not
   contain it (git ancestry, exit 4; override `PAPERCUSP_ALLOW_STALE_SIDECAR=1`).
   Because it only fires when someone asserted something, it has no false
   positives. This is the "grep the built artifact for a symbol only my fix
   introduces" check — the thing that actually caught the WI-3307 staleness —
   promoted from a shell snippet each caller had to remember into a precondition
   every caller inherits. Remembering was the property that failed.

**The half-fresh artifact is the generalisable lesson.** When an artifact is
assembled from inputs with *different refresh policies*, "I rebuilt it" is not a
claim about any particular input, and the partly-fresh case is far more
deceptive than the wholly-stale one because the evidence of freshness is real.
Before trusting a build to carry your fix, grep the OUTPUT for a symbol only
your fix introduces — seconds, against a \~73-minute build.

## The guard this still does NOT implement — worth doing by hand

1. **Never let a diagnostic field collapse to a falsy default.** When you
   write instrumentation into a patch, prefer an explicit sentinel
   (`'absent'` / `null` with a distinct shape) over letting the reader default
   an absent key to `false`/`0`/`undefined`. Then absent-vs-zero is decidable
   from the log alone, and no control-arm analysis is ever needed to recover
   it after the fact — this is what the `bytesReceived: 0` occurrence in the
   same investigation cost to resolve.

## When you'll hit this again

Any time you: (a) pre-build a bundle that inlines its dependencies (esbuild,
webpack, ncc, pkg, …), AND (b) iterate on a `node_modules` patch or source
edit that the bundle is supposed to pick up on the next build, AND (c) the
experiment's conclusion depends on a field that only exists because of that
edit. If any of (a)–(c) hold, assert on the artifact before you trust its
output.
