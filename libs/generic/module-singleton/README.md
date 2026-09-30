# @papercusp/module-singleton

Pin a module's mutable state to the realm — and **count how many times the module
body was evaluated**, so a split singleton reports itself instead of quietly
halving every reader's view.

```ts
import { pinModuleState } from '@papercusp/module-singleton';

const state = pinModuleState('@scope/pkg.state', () => ({ registry: new Map() }));
```

## The hazard

A module holding mutable state in module scope is a singleton only while the
loader produces exactly **one** module record for it. These ordinary seams break
that silently:

- a tsx/ts-node CJS preflight running alongside the ESM loader,
- the same file reached by both a bare specifier and a relative path,
- `node_modules/@scope/*` symlinked into a monorepo (two real paths),
- a bundled copy beside the source copy.

Each record gets its own state. Nothing throws. The symptom is a *partial* view
that is indistinguishable from a complete one.

## Why counting, not just pinning

Pinning to `globalThis` fixes correctness — both records share one object. But it
also makes the duplication **invisible**, so the packaging fault survives
forever. This library does both at once: `pinModuleState` returns the shared
state, and `listModuleDuplications()` names every key whose module body ran more
than once.

```ts
import { listModuleDuplications, formatModuleDuplicationWarnings } from '@papercusp/module-singleton';

for (const w of formatModuleDuplicationWarnings()) console.warn(w);
```

Observed live: `@papercusp/scheduled-registry` was evaluated twice inside one
process. A timer armed against instance A fired every 2 minutes while being
absent from the inventory served by instance B — same pid. It went unnoticed for
6+ days because the surface meant to report the timers was the surface that had
gone blind (EI-19451658870832332, EI-19463700807328229).

## Contract

**Call once, at module scope.** `evaluations` counts *calls*, so it is only a
module-record count if the call happens exactly once per module evaluation.
Calling it from a function that runs repeatedly makes the count meaningless.

**Namespace the key** with the package name (`'@scope/pkg.state'`). Two unrelated
modules sharing a key would share state.

**`moduleEvaluationCount(k) === 0` means "never evaluated", not "healthy".** A
caller reporting on a module it expects to be loaded must not read `0` as a
singleton.

## API

| export | purpose |
| --- | --- |
| `pinModuleState(key, init)` | Pin state to the realm; returns the shared value. `init` runs at most once. |
| `listModuleDuplications()` | Every key evaluated more than once, worst first. |
| `moduleEvaluationCount(key)` | Evaluation count for one key (`0` = never evaluated). |
| `listPinnedModuleKeys()` | All pinned keys, duplicated or not. Diagnostics. |
| `formatModuleDuplicationWarnings(dups?)` | One human line per duplication. |
| `resetPinnedModuleStateForTest()` | **Test only.** Detaches live state from existing holders. |

## Testing note

The suite ships a **calibration control**
(`module-scoped-control.fixture.ts`) that deliberately does *not* pin its state
and therefore *must* split across `vi.resetModules()`. Without it, "two module
records share one state object" would pass trivially if the harness ever stopped
producing a second module record — one record shares state with itself. Control
splits **and** subject shares is the only informative combination.
