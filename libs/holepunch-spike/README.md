# holepunch-spike — Phase 0 gate for papercusp-dogfood-v5

This package is the **gate before any of the dogfood plan is implemented**. It exists to answer:

1. Do the Holepunch P2P primitives install on Node 25 / Linux x64 without manual native build? (`smoke:install`)
2. Can two Hyperswarm peers find each other and exchange data on loopback? (`smoke:swarm`)
3. Does Autobase converge a 3-writer log into a deterministic merged view? (`smoke:autobase`)
4. Does Hyperbee KV write/read survive Autobase rebases? (`smoke:hyperbee`)

If all four pass on Linux, the next step is verifying the same packages bundle into the Tauri+Node desktop build (separate item in the plan). If any fail, **trigger the named fallback** in v5: HYPERBEE bucket collapses into GIT bucket; the collaboration model still ships, with higher latency on live state.

## Why this is a standalone package

- NOT added to root `workspaces` — install + lockfile changes stay scoped to this dir.
- Easy to `rm -rf libs/holepunch-spike/` if the spike fails. No root cleanup needed.
- Native-dep failures (UDX / sodium-native) surface here without disrupting the operator install.

## Plan correction discovered during spike

The v5 plan referred to packages as `@holepunchto/hyperswarm`, etc. The actual published npm names are unscoped: `hyperswarm`, `hyperdht`, `hypercore`, `hyperbee`, `autobase`, `corestore`, `hyperdrive`, `b4a`. The `holepunchto` org is the GitHub org; npm publishes are unscoped. Verified against context7 (2026-05-23). v5 §12 needs a follow-up edit reflecting the real package names.

## Possible future amendment

Context7 also surfaced **HyperDB** — a newer abstraction over Hyperbee that adds local indexing (RocksDB for local-only, Hyperbee for P2P). May be worth evaluating as a substrate for the projection layer (§7.1 of v5) once the base spike passes. Out of scope for the gate itself.

## Run

```
cd libs/holepunch-spike
npm install
npm run smoke:all
```

## Status

- [x] `smoke:install` — **PASS on Linux x64 Node 25** (2026-05-23): 105 transitive packages installed in 7s with prebuilds, all 8 top-level packages import + resolve their default export. No native compilation toolchain required.
- [x] `smoke:swarm` — **PASS on Linux x64 Node 25** (2026-05-23): two-peer loopback discovery + payload exchange in 10.4s via public DHT + UDP holepunching.
- [x] `smoke:autobase` — **PASS on Linux x64 Node 25** (2026-05-23): two independent corestores converge on deterministic merged view, in-process replication piped, addWriter op handled correctly.
- [x] `smoke:hyperbee` — **PASS on Linux x64 Node 25** (2026-05-23): KV-over-Autobase converges, LWW deterministic across both peers, range queries work.
- [ ] macOS verification (requires macOS host)
- [ ] Windows verification (requires Windows host)
- [ ] Tauri-bundle verification (requires adding deps to `apps/operator/package.json` once base smoke passes)
