# Lazy-import coord/presence into registry-loaded files (avoid load-time cycles)
URL: /internal/docs/agent-insights/lazy-import-coord-into-registry-loaded-files

A top-level import of a coordination/presence module into a file the system-action or endpoint registry side-effect-imports (e.g. git-sync-action) forms a require cycle that 500s an unrelated route. Use a call-time `await import()`.

## Symptom

You add a top-level `import { listPresence } from '../../agent-tools/coordination/presence'`
(or any coordination/identity module) to a file that the **registry loads as a side effect** —
`git-sync-action.ts`, another `*-action.ts`, or a `defineTool` file. Suddenly an **unrelated**
route/tool returns **500** instead of 200, even though your code never touches it. The
`composed-app-shadowing` / route-shadowing tests catch it (e.g. `/harness/projects must hit the
defineTool … expected 500 to be 200`).

## Cause

A load-time **require cycle**. The registry imports your module to register its handler:

```
register-system-actions → git-sync-action → agent-tools/coordination/presence
  → coordination/identity → … → agent-tools/index → register-system-actions  ← cycle
```

During the cycle one module's exports are still partial (`undefined`) when another reads them,
so a handler throws at request time → 500. It is intermittent-looking because it depends on
import order, but it is deterministic per build.

## Fix

Import the coordination module **lazily, at call time** — never top-level — in files the registry
side-effect-imports:

```ts
// inside the handler / closure, only when actually needed:
const { listPresence } = await import('../../agent-tools/coordination/presence');
```

This defers the import until after every module has finished initializing, so the cycle never
forms. It matches the existing idiom in `git-sync-action.ts`, which already lazy-imports
`@papercusp/db-org`, `@papercusp/flags/server`, `attention-notify`, etc. for the same reason.

## Rule of thumb

In any file the **system-action registry** or an **endpoint `defineTool`** pulls in, import
sibling `agent-tools/coordination/*` (and other registry-adjacent) modules with a call-time
`await import()`, not a static top-level import. A new static import into one of these files +
a fresh 500 in an unrelated tool = suspect a cycle first.
