# @papercusp/ui-primitives

Self-contained, **domain-agnostic** UI primitives for admin/dashboard UIs:

- `JsonTree` — collapsible JSON viewer (react-json-view-lite based)
- `LogView` — virtualized ANSI-colored log viewer (react-virtuoso + anser)
- `MarkdownView` — markdown renderer (react-markdown + remark-gfm)
- `PlanDocumentView` — read-only Vditor plan reader with local-runtime assets,
  frontmatter, outline navigation, plan/decision refs, and jump search
- `Panel` — generic panel container with title/actions slots
- `StatCard` — stat display with label + value + optional sub
- `StatusPill` — colored status badge (icon + label)

## LogView — domain wiring via props

`LogView` carries no built-in domain knowledge; everything app-specific is
injected through props (all optional, with neutral defaults):

```tsx
<LogView
  events={events}
  // Clickable in-message ids → host CustomEvent. Omit for URL/path links only.
  appLinks={{
    pattern: /\b((?:feature|issue)_[a-z0-9-]+)\b/g,
    resolve: (tok) => ({ kind: tok.split('_')[0], id: tok }),
    eventName: 'myapp-log-link',          // default 'log-link'
  }}
  primarySource="server"                  // its tag is hidden + gets its own tab
  bookmarkKeyPrefix="myapp:logBookmarks"  // localStorage prefix (default 'logBookmarks')
/>
```

`MarkdownView` similarly takes an `emptyText` prop for its empty-state
placeholder (neutral default). No hardcoded event names, storage keys, id
patterns, or special-cased sources remain — see plan D-011.

## Repos using this lib

- `papercupai/papercup` — main monorepo (admin harness UI)
- `papercupai/papercup-public-site` — papercupai.com (public harness mirror)

Both consume this lib via git submodule at `libs/ui-primitives/`.

## Peer deps

Host app must provide: `react`, plus the runtime deps listed in `peerDependencies`.
`PlanDocumentView` defaults its Vditor runtime mirror to `/vditor`; hosts must
copy Vditor's `dist/` assets there or pass a different `assetBaseUrl`.
