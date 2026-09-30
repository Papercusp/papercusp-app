# @papercusp/plugin-wit

Canonical WIT (WebAssembly Interface Type) definitions for the Papercusp plugin protocol.

## Why this exists

Plugins compile to a `.wasm` component built against a specific WIT package version. The host loads the same `.wasm` either via:

- **JS host** (`@papercusp/plugin-loader`) — jco-transpiled to ESM at install time
- **Rust host** (`papercup-rust-server/crates/papercup-plugin-host`) — wasmtime + `bindgen!` macro

Both paths must consume the **identical** WIT bytes or plugins built against one runtime won't load on the other. This package is the single source of truth.

## Layout

```
wit/
  v0_1_0/          # current
    plugin.wit
  v0_2_0/          # future — never edit a published version in place
    plugin.wit
```

Each version is independent. The host's loader picks the matching versioned directory based on the plugin's `[plugin.protocol] papercup-plugin = "<range>"` manifest pin.

## Cross-runtime sync

The Rust crate currently lives in a separate repo (`papercup-rust-server/crates/papercup-plugin-wit/`). Until that's unified into this monorepo, the canonical source is **here** and the Rust side mirrors.

**Bump procedure** (rev3 plan rule):
1. WIT bumps go through the plugin agent only.
2. New version → new directory under `wit/` (never edit existing).
3. Update `SHIPPED_VERSIONS` + `CURRENT_VERSION` in `src/index.ts`.
4. Cross-post in `coord/plugin.jsonl` so both runtimes pull on next sync.
5. Existing plugins continue to load via their pinned older version; new plugins target the new version.

## Usage

```ts
import { witPath, CURRENT_VERSION } from '@papercusp/plugin-wit';

const path = witPath(CURRENT_VERSION);
// → /abs/path/to/packages/plugin-wit/wit/v0_1_0/plugin.wit

// Pass to jco / bindgen / whatever needs the WIT bytes.
```
