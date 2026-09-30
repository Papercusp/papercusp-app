# `app/harness/dock` — Dockview migration foundation

Status: **Phases 0–2 + 4 + 6 complete, 3 and 5 ready to integrate when
paperclip pauses.** Demo at `/harness/<slug>/dock-preview` exercises the
full stack end-to-end. The remaining integration is dropping
`<HarnessDock>` into `HarnessDashboard.tsx` / `ChromeShell.tsx` — pure
mount work; foundation is built, tested, and live-verified.

See `apps/operator/docs/dockview-migration-plan-v4.md` for the full plan.

**80 tests green** (71 unit + 9 integration).

## Layout

```
dock/
├── panel-registry.ts            # type → component, late-register notify
├── useNavHistory.ts             # per-panel back/forward stack
├── useNavShortcuts.ts           # Cmd+[/] → focused panel
├── useLayoutResetShortcut.ts    # Shift+Esc 1s → reseed
├── useDockLayout.ts             # client hook for /api/dock-layouts/:name
├── useRegisterPluginPanels.tsx  # /api/plugins/<slug>/contributions → panelRegistry
├── useFocusedPanelTracker.ts    # focused panel → ?focusSlug= (§3.4)
├── HarnessDock.tsx              # root DockviewReact + persistence + all hooks
├── layout-adapter.ts            # LayoutDoc ↔ dockview JSON
├── dock-actions.ts              # openPanel/focusPanel/listPanels (singleton api)
├── MissingPanel.tsx             # fallback for unregistered types
├── IframePanel.tsx              # portal-pattern wrapper (§7 of plan)
├── iframe-host.ts               # off-DOM iframe registry (no reload on drag)
├── NavChevrons.tsx              # back/forward UI + per-panel nav registry
# (HarnessSelectorChip.tsx removed by user decision e4c965f5 — useFocusedPanelTracker
#  keeps ?focusSlug= in sync from the focused panel, so the explicit chip was redundant.)
├── RealFeaturesPanel.tsx        # real panel — fetches /api/harness/:slug/status
└── sample-panels.tsx            # registerSamplePanels() — stubs + DocsSamplePanel
```

Adjacent files outside `dock/`:

```
apps/operator/lib/dock-layouts.ts              # LayoutDoc + CRUD + validation
apps/operator/lib/dock-layout-migrators.ts     # schema_version migration runner
apps/operator/app/api/_hono/dock-layouts.ts    # Hono route registrations
apps/operator/app/harness/[slug]/dock-preview/page.tsx  # interactive demo

libs/papercusp/libs/db/sql/071-dock-layouts.sql       # PG table
libs/papercusp/libs/db/sql/072-harness-phase-last-used.sql
```

## How to mount a dock

```tsx
'use client';
import { useEffect } from 'react';
import { HarnessDock } from './dock/HarnessDock';
import { registerSamplePanels } from './dock/sample-panels';

export default function MyDockPage() {
  useEffect(() => { registerSamplePanels(); }, []);
  return <HarnessDock layoutName="my-named-layout" />;
}
```

## How to register a real panel type

```tsx
import { panelRegistry } from './dock/panel-registry';
import type { PanelComponentProps } from './dock/panel-registry';

function MyPanel({ params, api }: PanelComponentProps) {
  return <div>My panel for slug={String(params.slug)}</div>;
}

// Register once at module load or on plugin onLoad.
panelRegistry.register('my:type', MyPanel, { keepAlive: true });
```

## How to open / focus / close a panel from anywhere

```ts
import { openPanel, focusPanel, closePanel } from './dock/dock-actions';

const id = openPanel({
  type: 'data:features',
  params: { harnessSlug: 'sheets' },
  title: 'Features',
  floating: { width: 480, height: 360 },  // optional — docked by default
});
focusPanel(id);
closePanel(id);
```

## How to opt into back/forward chevrons

```tsx
import { useNavHistory } from './dock/useNavHistory';
import { NavChevrons } from './dock/NavChevrons';

function DocsPanel({ params, api }: PanelComponentProps) {
  const nav = useNavHistory<{ doc: string }>(
    { doc: 'index' },
    { params, setParams: api.setParams, capacity: 50 },
  );
  return (
    <div>
      <NavChevrons nav={nav} />
      <h1>{nav.current.doc}</h1>
      <button onClick={() => nav.push({ doc: 'next' })}>Next</button>
    </div>
  );
}
```

Cmd+[ / Cmd+] dispatch to the focused panel automatically via
`useNavShortcuts` (mounted by `HarnessDock`).

## Persistence model

- `/api/dock-layouts/:name` (Hono routes in `app/api/_hono/dock-layouts.ts`)
- Table: `harness_shared.harness_dock_layouts` (migration 071)
- PK: `(workspace_id, user_id, layout_name)`
- Body: `LayoutDoc` (schemaVersion=1) for new dock, or opaque
  `schemaVersion=0` for pi-tab's raw dockview JSON
- Optimistic concurrency via `If-Match: <updatedTs>` → 409 on stale
- Seed-on-miss: `defaultDashboardLayout()` (or empty for pi)
- Reset: DELETE → next GET reseeds

## Tests

```bash
# Unit (63 tests)
cd apps/operator && npx vitest run app/harness/dock/ lib/dock-layouts.test.ts

# Integration (9 tests, requires operator running on :3055)
cd apps/operator && npx vitest run --config vitest.integration.config.ts \
  app/api/_hono/dock-layouts.integration.test.ts
```

## What's shipped vs. still TODO

| Phase | Item | Status |
|-------|------|--------|
| 0 | migrations 071+072 applied | ✅ shipped, auto-applies on boot |
| 0 | dockview 5→6.2.2 + ResizeObserver polyfill | ✅ shipped |
| 1 | pi-tab still works on v6 | ✅ shipped |
| 2 | pi-tab dual-writes localStorage + PG | ✅ shipped |
| 3 | dashboard internal dockify | ⏸️ ready to mount, needs paperclip pause |
| 4 | HarnessSelectorChip | ⛔ dropped by user (e4c965f5) — redundant with focused-panel tracker |
| 4 | useFocusedPanelTracker → ?focusSlug= | ✅ shipped |
| 4 | harness_phase_last_used API | ✅ shipped |
| 5 | iframe portal pattern (no reload on drag) | ✅ shipped |
| 5 | dock-actions agent dispatch surface | ✅ shipped |
| 5 | Shift+Esc layout reset | ✅ shipped |
| 5 | ChromeShell mount of root dock | ⏸️ needs paperclip pause |
| 6 | useNavHistory + Cmd+[/] shortcuts | ✅ shipped |
| 6 | NavChevrons UI | ✅ shipped |
| 6 | plugin panels[] synthesis from dashboardTabs[] | ✅ shipped |
| 6 | useRegisterPluginPanels client hook | ✅ shipped |
| §4.6 | layout schema_version migrator | ✅ shipped |

## What integration still needs (when paperclip pauses)

The dock foundation is independent, tested, and live-verifiable today
via `/harness/<slug>/dock-preview`. Two mount points remain:

1. **Phase 3 mount**: replace `react-resizable-panels` block in
   `HarnessDashboard.tsx:~4481` with nested `<HarnessDock layoutName="dashboard:<slug>" slug={slug} />`.
   Each former resizable panel becomes a panel type already registered
   in `sample-panels.tsx` (Features uses real impl, others use stubs).
   Mechanical replacement; risk is paperclip's concurrent edits to the
   same file.

2. **Phase 5 mount**: in `ChromeShell.tsx`, render
   `<HarnessDock layoutName="default" slug={slug} />` when
   `pathname.startsWith('/harness/')` and remove the top-level tab strip
   + `ReactActivity` switching. Default layout already seeds correctly.

3. ~~**HarnessSelectorChip mount**~~ — dropped (e4c965f5). Skip; `useFocusedPanelTracker` handles `?focusSlug=` from panel focus already. Original sidebar mount in `OperatorChatSidebar`
   header sub-row. Requires deciding the harness list source (currently
   91 harnesses in dev — needs filtering).

The current preview demonstrates everything works. Mounting is the
final step.
