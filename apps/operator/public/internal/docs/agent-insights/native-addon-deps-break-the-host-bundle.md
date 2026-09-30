# A dep with a native (.node) addon silently breaks the host bundle — tests can't see it
URL: /internal/docs/agent-insights/native-addon-deps-break-the-host-bundle

esbuild has no .node loader, so importing a package with a native addon makes bundle-host.sh fail. Nothing in the test suite runs the bundler, so it greens — then :3170 crash-loops at the next restart and the deploy dies. Externalize the package; the lint:host-bundle-builds guard now catches it.

import { Aside } from '@astrojs/starlight/components';

## The trap

`bin/hono-host.ts` is **esbuild-bundled** to `dist-host/hono-host.mjs` by
`apps/operator/bin/bundle-host.sh`, which runs at the service's `ExecStartPre` and
during the release deploy — **never during tests**.

esbuild has **no loader for `.node` files**. So the moment any module reachable from
the host graph imports a package that ships a native addon, the bundle fails:

```
✘ [ERROR] No loader is configured for ".node" files:
    ../../node_modules/onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node
```

`npm run test:affected`, `tsc --noEmit`, **and the green-checkpoint gate all stay
green** — they load the module under tsx/vitest, which resolves native addons
natively. Nothing in the suite runs the bundler. So the gate happily promotes the
commit, and the failure only detonates at the **next service restart** (`:3170` down
for the whole fleet) and in the **release deploy**.

## How it bit us (2026-07-12, P-009)

`voice-node/kokoro-local.ts` dynamic-imports `@huggingface/transformers` for
in-process Kokoro TTS. transformers `require()`s onnxruntime-node's binding through a
**template specifier**:

```js
require(`../bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node`)
```

esbuild resolves that template into **all five** platform binaries and dies. A dynamic
`import()` does **not** save you — esbuild still walks it.

Result: `:3170` was down \~2 minutes, and the in-flight green-checkpoint was about to
green the commit and promote a host that **cannot build**.

## The fix: externalize, don't inline

Add the package to `NATIVE_PKGS` in **both** build scripts — they are separate lists
and both matter:

| script                                           | why it matters                                      |
| ------------------------------------------------ | --------------------------------------------------- |
| `apps/operator/bin/bundle-host.sh`               | the dev/release **host** (`:3070`/`:3170`)          |
| `papercusp-desktop/bin/build-desktop-sidecar.sh` | the **packaged desktop app** — the shipping product |

Externalizing `@huggingface/transformers` also stops esbuild **at the package
boundary**, so the whole onnxruntime graph leaves the bundle. The sidecar build then
closure-copies the real package in, so it still resolves at runtime.

### Watch the packaging layout too

`prune_foreign_prebuilds()` only understands the `prebuilds/<platform>-<arch>/`
convention. onnxruntime-node uses `bin/napi-v6/<platform>/<arch>/` — a different
layout — so the closure-copy would have shipped **all 5 platforms (211 MB)** into the
AppImage and re-armed [WI-807](/internal/docs/agent-insights/): `linuxdeploy` ldd-walks
every ELF under the AppDir and aborts on a foreign-arch `.so`. Hence
`prune_foreign_onnx_bins()`. `onnxruntime-web` (134 MB) is skipped in the closure walk
entirely — it is the browser backend and can never execute on the node path.

## The guard

```bash
npm run lint:host-bundle-builds     # scripts/check-host-bundle-builds.mjs, ~10s
```

It invokes the **real** `bundle-host.sh` against a throwaway outfile — deliberately
never a reimplementation, so the externals list has one source of truth and cannot
drift from what actually ships. Wired into `.github/workflows/test.yml` beside its
siblings.

Falsification-tested: with the externals removed it exits 1 with exactly the five
`.node` loader errors; with them, it builds clean.

`lint:no-self-referential-export`, `lint:smart-quotes` and `lint:no-conflict-markers`
were each born from *one instance* of the same class — "something broke
`bundle-host.sh` and we only found out at restart". They pattern-match their instance;
this guard is the **direct detector** for the whole class. If you find yourself about
to add a fourth pattern-lint for a bundle break, check whether the bundle guard already
catches it.

## Rule of thumb

Before adding any dependency, ask whether it ships a `.node` addon (`find
node_modules/<pkg> -name '*.node'`). If it does, and anything in `packages/operator-core`
or `apps/operator` can reach it: **add it to both `NATIVE_PKGS` lists in the same
change**, and run `npm run lint:host-bundle-builds` before you call the work done.
