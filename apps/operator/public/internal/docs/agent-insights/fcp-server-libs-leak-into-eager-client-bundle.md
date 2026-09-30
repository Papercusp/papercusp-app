# High FCP: server/eval libs leak into the eager client bundle via barrels
URL: /internal/docs/agent-insights/fcp-server-libs-leak-into-eager-client-bundle

The operator SPA's ~2s first-contentful-paint was server-only heavy libs (js-tiktoken, the TypeScript compiler) dragged into the eager boot graph by barrel re-exports. How to diagnose (sourcemap attribution) + fix (lazy import / barrel hygiene / route code-splitting).

import { Aside } from '@astrojs/starlight/components';

## Symptom

The operator `/adv` shell's **first-contentful-paint sat at \~2s** (reload, prod
bundle) while the doc server response was \~43ms — i.e. it was **all JS
parse/exec**, not network. Measured on `bin/desktop-preview-prod` (real
`React.production`, the only honest FCP harness; a debug `tauri dev` build
auto-opens devtools which inflates RSS and skews timing).

## Root cause (recurring — it hit twice)

The eager boot bundle was **\~14 MB raw** (entry `<script>` + the whole
`modulepreload` graph, which executes before React renders). Two **server- /
eval-only heavy libs** were dragged into it by **barrel re-exports of
server-only code that the webview transitively imports**:

* **`js-tiktoken` (5.5 MB BPE tables)** — `packages/agent-mcp/src/delta-eval-harness.ts`
  did `import { getEncoding } from 'js-tiktoken'` + `const enc = getEncoding('o200k_base')`
  at **module top-level** (an eager side-effect), for an eval-only `tokens()`.
  The agent-mcp barrel (`index.ts`) re-exports that module, and the webview
  imports the barrel (e.g. `chat/LocalCardHost`) → 5.5 MB eager.
* **The TypeScript compiler (3.4 MB)** — `libs/generic/tooldef/src/code-orchestration/parse-check.ts`
  did `import ts from 'typescript'` for a server-side AST walk (`checkScript`,
  the `code:run` parse-check). Both the `tooldef` **and** `agent-mcp` barrels
  re-export `code-orchestration`, and the webview imports both barrels → the
  whole compiler eager. **162 of 163 tooldef-barrel importers never use
  code-orchestration** — they paid 3.4 MB for nothing.

Contributing: **TanStack Router `autoCodeSplitting` was OFF**, so all \~81 route
`component`s were statically imported into `routeTree.gen.ts` → the entry chunk
(turning it on dropped the entry 2.5 MB → 281 KB, but the barrel leaks above
dominated FCP).

## How to diagnose (don't guess — attribute)

Grepping minified chunks for lib names is unreliable (`"plate"` matches
`"template"`; app code is mangled). **Attribute via the sourcemap `sources`:**

```sh
cd apps/operator-vite && npx vite build --sourcemap true
# then, for the biggest EAGER chunk (entry + modulepreload from dist/index.html):
python3 - <<'PY'
import json, collections
m = json.load(open('dist/assets/<biggest-src-chunk>.js.map'))
agg = collections.Counter()
for i, s in enumerate(m['sources']):
    parts = [p for p in s.replace('../','').split('/') if p not in ('','.')]
    grp = ('nm/'+parts[parts.index('node_modules')+1]) if 'node_modules' in parts else '/'.join(parts[:3])
    agg[grp] += len((m.get('sourcesContent') or [None]*len(m['sources']))[i] or '')
for g, n in agg.most_common(15): print(f'{n//1024:>7} KB  {g}')
PY
```

Compute the **eager set** = the entry `<script src>` + every `modulepreload`
`href` in `dist/index.html` (those execute before paint), then sum their file
sizes. The rolldown build also prints `INEFFECTIVE_DYNAMIC_IMPORT` warnings —
each names a module whose dynamic-import split was defeated by a competing
static import (more leak candidates, e.g. `operator-core/lib/work-items.ts`).

## The fix pattern

For a heavy lib reachable from the eager client graph but only used
server/eval-side, **make the import lazy** so it splits into its own chunk
fetched only when that path runs:

* **Async consumer** → just `const { x } = await import('heavy-lib')` inside the
  function (see `delta-eval-harness.ts`: `tokens`/`evalSnapshotTransition`
  became async; their only callers were tests).
* **Consumer must stay sync** (e.g. `checkScript`, exercised by a \~20-call test
  suite) → **lazy-warmup singleton**: a `let _lib`, an async
  `ensureXReady()` that does the dynamic `import()` once, and a sync accessor
  that throws if not warmed. Call `await ensureXReady()` at the (already-async)
  runtime entry points; tests warm in `beforeAll`. Keeps the sync API + avoids
  an async cascade through every caller. Use `import type` for the lib's types
  (erased) so type annotations don't re-pull it. (See `parse-check.ts`.)
* **Routes** → set `autoCodeSplitting: true` on the `tanstackRouter` vite plugin.
* **Barrel hygiene** (the deeper fix): don't `export *` server-only subtrees
  (`code-orchestration`) through a barrel that clients import; deep-import in the
  few real server consumers instead.

Verify on `bin/desktop-preview-prod` (prod React) and re-attribute the eager
set — the FCP number alone is load-noisy on the shared box (grade the **eager
bundle bytes**, which are load-independent, plus FCP medians). Confirmed wins
(2026-06-23 E2E sweep): eager bundle **13.86 MB → 2.35 MB (−83%)**, FCP
**1927 → 932 ms (−52%)**.
