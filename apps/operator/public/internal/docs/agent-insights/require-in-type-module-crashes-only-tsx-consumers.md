# A `require()` in a "type":"module" package crashes only fresh tsx/ESM consumers — not the long-running operator, and vitest can mask it
URL: /internal/docs/agent-insights/require-in-type-module-crashes-only-tsx-consumers

>-

## What

A `"type": "module"` package (check its `package.json`) is pure ESM. A bare
CommonJS `require(...)` anywhere in its runtime code throws at the point it
executes:

```
ReferenceError: require is not defined in ES module scope, you can use import instead
```

This bit `libs/generic/resource-profile/src/index.ts`, which had:

```ts
// inside a "type":"module" package
const os = require('node:os') as typeof import('node:os');
```

`getResourceProfile()` is called by the `rate-limit-config.maxSimultaneousAgents`
getter **at module-import time**, so *any* fresh tsx/ESM process that imports
anything pulling in `rate-limit-config` (every `packages/operator-core/lib/external-bench/_xbench_*.ts`
launcher) died at startup with the stack ending in `detectResourceSignals`.

## Why it hid (passed review + the green-checkpoint)

The crash is **import-time and process-fresh**, so the usual safety nets miss it:

* **The long-running operator stays up.** `:3070`/`:3170` loaded the module
  (or reached it via a CJS/bundled path) *before* the bad line landed, so they
  keep serving with the old code in memory. No hot-reload → no crash there.
  "Works on the running server" ≠ "works in a fresh process."
* **vitest can be green.** If a test mocks the module, or the suite never drives
  the real `detectResourceSignals` under the ESM loader, the unit run passes.
  The green-checkpoint went green while every tsx launcher was broken.
* **It's the inverse of the more famous trap.** The existing insight
  *new-package-cjs-family-type-module-trap* is about a new package wrongly
  *setting* `type:module`; this is about CJS `require` left *inside* a package
  that is already `type:module`.

So the only thing that surfaces it is **running the real thing under tsx** — which
an agent benchmark launcher does and a `vitest run` may not.

## The fix

Use `createRequire(import.meta.url)` — the repo's established pattern (6+ call
sites, e.g. `plugin-host-runtime.ts`). It is ESM-valid (a `type:module` package
always has `import.meta.url`) and keeps the lazily-loaded builtin **out of the
static import graph**, preserving a "pure derivation + types usable in a non-Node
bundle" contract that a static top-level `import 'node:os'` would break:

```ts
import { createRequire } from 'node:module';
// ...
const os = createRequire(import.meta.url)('node:os') as typeof import('node:os');
```

(If the function may be async and the call chain tolerates it, `await import('node:os')`
is the other ESM-correct option. Here the whole `maxSimultaneousAgents` getter
chain is synchronous, so `createRequire` is the right tool.)

## How to spot it

* A tsx script dies at **startup/import** with `require is not defined in ES module
  scope`, stack pointing into a `libs/generic/*` or other `"type":"module"` package.
* The same code "works" when probed against the already-running `:3070`/`:3170`
  (stale process) — don't trust that; restart-or-fresh-process is the real test.
* Before trusting "tests are green," confirm the failing path actually runs under
  a real ESM/`tsx` process, not only a mock-heavy vitest run.
