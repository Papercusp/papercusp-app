# Verify a fresh install CONSUMES the hive seed (does NOT cold-clone) headlessly — you don't need a full AppImage build
URL: /internal/docs/agent-insights/verifying-seed-consumption-headless

The WI-4487 acceptance leg — 'a seeded install must not cold-clone' — is what 0.0.9 AND 0.0.10 both silently failed (shipped a seed that did nothing). You can prove/disprove it in ~40s against a REAL cut seed WITHOUT building or booting the AppImage: run the exact consumer path (resolveSeedDir -> restoreHiveSeed -> open the target corestore OFFLINE and read its length) via `node --import tsx/esm`. Decompose the verdict into three independently-checkable parts so a 'cold-clone' failure tells you WHICH layer broke (bad seed vs bad packaging vs bad consumer) — those have completely different fixes.

## The question that keeps silently shipping wrong

A packaged install is supposed to CONSUME the bundled corestore seed (the hive's
plans/work-items/coordination) so first boot pre-positions the data locally and the
join only transfers the live delta. **0.0.9 AND 0.0.10 both silently cold-cloned** —
shipped a seed that did nothing, the full data came over the network, and nobody
noticed until after publication (the cut exits 0; the seed is just unused). The cut
side (WI-4487) is only half — the other half is proving a fresh install actually
consumes a *good* seed.

## You do NOT need to build/boot the AppImage to answer it

The consumption is done by the **operator sidecar (Node)**, not the Rust/Tauri layer.
Tauri only sets env vars and spawns the sidecar. So the decisive verdict runs headless
against a REAL cut seed in \~40s, no cargo, no xvfb:

```ts
// run: cd packages/operator-core && node --import tsx/esm <script>.ts
import { resolveSeedDir, restoreHiveSeed } from './lib/sync/hyperbee/restore-hive-seed';
import Corestore from 'corestore';
const SEED = '<abs path to a cut seed dir with manifest.json>';
// 1. RESOLVER — the exact channel main.rs uses: PAPERCUSP_SEED_DIR = <parent-of-sidecar>/seed
resolveSeedDir({ env: { PAPERCUSP_SEED_DIR: SEED } }); // expect source:'env' (or 'autodetect:*')
// 2. RESTORE — corestore restores; an ENCRYPTED git store DEFERS (needs the post-admission key)
const res = await restoreHiveSeed({ seedDir: SEED, targetRepoDir, targetStoreDir });
// expect ran:true, outcomes:[{kind:'corestore',ok:true}], deferred:['git']
// 3. BOOT READ — open the target store OFFLINE (no replication peer) and read the core length.
//    Populated to the manifest coreLength + block[0]/block[len-1] present with wait:false
//    => the data is LOCAL from the seed, i.e. NOT cold-cloned.
```

A pass looks like: `resolveSeedDir` returns `source:'env'`, `restoreHiveSeed`
restores the corestore and defers git, and the target core opens offline at exactly
the manifest `coreLengths[<key>]` (e.g. 95,812) with its first and last blocks
readable `wait:false`. (Proven live 2026-07-15 against a real 335 MiB corestore cut.)

## Decompose the verdict — a bare "it cold-cloned" is useless

Three layers can independently cause a cold-clone, and each has a different fix:

1. **Bad SEED** — the cut shipped a stale/absent/short corestore (e.g. the
   `readOnly:true` point-in-time-snapshot ordering bug WI-4487 fixed; or a git-only
   seed with no corestore at all). Check the seed's `manifest.json` has a `corestore`
   store with a non-zero `coreLengths`. **Fix lives in the cut (cut-seed-cli).**
2. **Bad PACKAGING** — the seed isn't where the consumer looks. `resolveSeedDir`
   returns `null`/`env-missing`/`none`. This was the 0.0.9/0.0.10 WI-2902 bug: the Rust
   side passed `<sidecar>/seed` while the bundle held `<resourceRoot>/seed`. Now
   `main.rs` computes `seed_dir = <parent-of-sidecar>/seed` and `build-appimage.sh`
   places the seed at `usr/lib/<product>/seed` — **they agree by construction** (a
   static code proof). **Fix lives in main.rs / build-appimage.sh.**
3. **Bad CONSUMER** — the resolver finds it and restore runs, but the store lands
   where boot doesn't read it, or restore fails. Check `restoreHiveSeed` outcomes +
   that `targetStoreDir` == `join(workspacesRoot(), 'papercusp-workspace',
   '.papercusp', 'papercusp', 'hyperbee')` (seedTargetDirs, WI-3232). **Fix lives in
   the consumer.**

The seed-restore path only runs when the **canonical invite is baked** (it is —
COMMITTED in `canonical-hive-invite.ts`, not release-env-injected, so even a bare
build takes the join+seed path) AND `detectPapercupRoot` finds no local checkout (a
fresh install / isolated HOME). git is encrypted at rest and DEFERS to post-admission
by design — "corestore restored, git deferred" is the correct healthy state, not a
half-failure.

## The sandbox can't build the AppImage — the literal smoke belongs to the pipeline

The agent `capability_bash` sandbox makes only the project subtree + `/dev/shm`
writable: the cargo target lives on read-only `/mnt/data` (89G), so `tauri build`
can't write; the `tsx` CLI can't `listen(2)` (EPERM) — use `node --import tsx/esm`;
vitest works only if `TMPDIR` stays the default `/tmp/claude` (an in-repo TMPDIR makes
`vitest-config` force the read-only `/tmp/pcv`). So the **literal** end-to-end
install smoke (AppImage → operator boot → plans/work-items visible) must run via the
release **pipeline / a VM**, not an agent shell (EI-12725). The headless consumer
verdict above is what an agent CAN — and should — produce in-sandbox before then.

## Existing CI guards (don't re-add)

The resolver's exact bug surface is already covered:
`restore-hive-seed.test.ts` — "autodetects the GRANDPARENT `<resourceRoot>/seed` …
packaged .deb/.app layout" + every branch; `seed-second-consumer.test.ts` — cut →
restore → populated-offline → delta-replicate both halves. The genuine remaining gap
is the literal packaged-install smoke (the heavy `PackagedInstallMeasure` seam in
`seed-e2e-measurement.ts` is unimplemented) — a release-gate step, not a unit test.
