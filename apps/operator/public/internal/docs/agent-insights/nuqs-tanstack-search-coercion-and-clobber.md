# nuqs ↔ TanStack Router search params — number coercion + the stock-adapter clobber
URL: /internal/docs/agent-insights/nuqs-tanstack-search-coercion-and-clobber

Why ?dock=1 / ?switch=1 were unreachable, and why nuqs writes dropped TanStack-native search params. Normalize flag params to the number 1; use a functional-search nuqs adapter.

import { Aside } from '@astrojs/starlight/components';

## Symptom

`/harness/<slug>?dock=1` always redirected to `/adv` (the dock shell was
unreachable), and `/login?switch=1` never entered switch-account mode — even
though the URL clearly carried the param. Diagnostic logs showed
`window.location.search = "?dock=1"` while the route's `validateSearch` saw
`search.dock === undefined`.

The `/harness/<slug>` route tree (the `?dock=1` example above) was **retired**
(`design-simplification-2026-07-09` P-008) — `/harness/` is now redirect-only
to `/adv`, and the old per-slug dock shell moved to `_retired/harness-dashboard/`.
The underlying TanStack-coercion + stock-adapter lessons below are still live
and load-bearing: `/login?switch=1` (`apps/operator-vite/src/routes/login.tsx`)
still uses the exact number-`1` normalization this doc describes, and
`__root.tsx` still mounts the custom adapter.

## Two independent root causes (both Next → TanStack-Router migration regressions)

### 1. TanStack coerces `?dock=1` to the **number** 1; `=== '1'` is false

TanStack Router's default search parser JSON-parses each value, so `?dock=1`
becomes `dock: 1` (a **number**). The migrated `validateSearch` kept the Next
check `search.dock === '1'` (Next gave a **string**) → `1 === '1'` is `false`
→ `dock` resolves to `undefined` → the loader redirects.

**Do NOT "fix" it by normalizing to the string `'1'`.** TanStack's default
*stringifier* JSON-encodes strings, so `dock: '1'` serializes to `?dock="1"`,
which then re-parses/re-stringifies and **drifts** (`"1"` → `"\"1\""` → …)
until the value is the quoted string `"1"` and the `=== '1'` check fails again
— intermittently, which is maddening to debug.

**Fix:** normalize flag params to the **number** that the URL naturally parses
to. `dock: 1` round-trips as `?dock=1` with no quoting and is stable:

```ts
validateSearch: (search): { dock?: 1 } => ({
  dock: search.dock === 1 || search.dock === '1' ? 1 : undefined,  // accept '1' too, self-heal
}),
// consumers: if (search.dock === 1) …   // number, not '1'
```

### 2. The stock `nuqs/adapters/tanstack-router` clobbers + double-encodes

When this app mixes nuqs (`useQueryState('ws')`, tabs, …) with TanStack-native
typed search (`validateSearch` + `useSearch` for `dock`/`switch`/`slug`), the
stock adapter is hostile to the native params. Its `updateUrl` does:

```ts
navigate({ to: pathname + renderQueryString(search) })  // search = WATCHED keys only, as a STRING
```

Two failures fall out:

* **Clobber:** it rebuilds the whole query string from only the nuqs-*watched*
  keys, so any TanStack-native param (`?dock=1`) is **dropped on every nuqs
  write**. The WorkspaceSwitcher mount effect writes `?ws=<active>` on load →
  that single write wipes `?dock=1`.
* **Encoding loop:** because it hands TanStack a `to` string, TanStack
  re-stringifies it with its own JSON encoder, so already-encoded values get
  re-encoded and params duplicate (`?tab=x&tab=x`).

**Fix:** a custom adapter (built on `nuqs/adapters/custom`'s
`unstable_createAdapterProvider`) whose `updateUrl` uses TanStack's
**functional search updater** so TanStack owns serialization exactly once and
non-nuqs params survive:

```ts
updateUrl: (nuqsSearch, options) =>
  navigate({
    to: pathname,
    search: (prev) => applyNuqsToSearch(prev, watchKeys, nuqsSearch), // {...prev minus watched, ...nuqs}
    replace: options.history === 'replace',
  });
```

See `apps/operator-vite/src/lib/nuqs-tanstack-router-adapter.tsx` (+ its unit
test) and `src/routes/__root.tsx` (imports the custom `NuqsAdapter`, not the
stock one).

## How to recognise it

* A search param is in `window.location.search` but `Route.useSearch()` /
  `validateSearch` reports it `undefined` → suspect number/string coercion.
* A nuqs write (often a mount-effect sync like `?ws=`) makes an unrelated
  search param vanish, or params start duplicating / gaining `%22` quotes →
  suspect the stock tanstack adapter. Instrument `updateUrl`'s `to`/merge.

Only 6 of \~90 operator-vite routes use `validateSearch`; the rest pass search
through, so nuqs params survive there — the clobber only bit routes that mix
both systems.
