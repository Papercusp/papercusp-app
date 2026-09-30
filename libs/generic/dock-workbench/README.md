# @papercusp/dock-workbench

Host-agnostic [Dockview](https://dockview.dev) workbench shell: a panel
registry, a logical layout schema, dockview adapters, pluggable layout
persistence, and a React `DockWorkspace` component. Zero domain coupling — the
host registers its own panels and injects its own layout store; the library
names no consuming app.

## Why this exists

Papercusp's operator grew a bespoke harness dock (panel registry + a
hand-rolled dockview-serialization adapter + a layout store) inside the app.
When a second app (Oddsmith) needed the same multi-pane workbench, the whole
thing was copied verbatim — two byte-identical trees destined to drift. This
package is the extraction: the generic dock shell lives here once, behind
seams, and each app maps its own panels and persistence onto it.

Both consumers are thin adapters:

- **Papercusp** — `apps/operator/app/harness/dock/HarnessDock.tsx` registers the
  harness panels and uses `createFetchDockLayoutStore('/api/dock-layouts')`.
- **Oddsmith** — `apps/desktop/src/dashboard/Dashboard.tsx` registers the
  trading panels and uses `createLocalStorageDockLayoutStore(...)`.

## Public surface

```ts
import {
  // React
  DockWorkspace,          // the workspace component (props: layoutName, store, registry, …)
  useDockLayout,          // the load/save/reset state hook the component is built on

  // panel registry
  createPanelRegistry, PanelRegistry, panelRegistry,

  // logical layout schema + validation
  type LayoutDoc, type GroupNode, type TabStrip, type PanelInstance, type FloatingGroup,
  validateLayoutDoc, isWellFormedLayout, LayoutValidationError,
  CURRENT_LAYOUT_SCHEMA_VERSION, OPAQUE_SCHEMA_VERSION,

  // dockview adapters
  toDockviewJson, toLayoutDoc, roundTrip, type DockviewLayout,

  // persistence stores (pick one, or implement DockLayoutStore yourself)
  type DockLayoutStore, type DockLayoutRow,
  createFetchDockLayoutStore,        // REST: GET/PUT/DELETE /api/dock-layouts/:name
  createLocalStorageDockLayoutStore, // browser localStorage, seeded on first load
  DockLayoutConflictError,           // optimistic-concurrency (if-match) conflict
} from '@papercusp/dock-workbench';
```

### Layout schema

A `LayoutDoc` is a host-neutral logical tree (`group` nodes split row/col,
`tabs` leaves hold `panel` instances) plus optional `floating` groups. The
adapters convert it to/from dockview's own serialized grid so the host never
touches dockview's wire format. `schemaVersion: 0` (`OPAQUE_SCHEMA_VERSION`)
marks a passthrough blob the validator does not inspect.

### Persistence seam

`DockLayoutStore` is the only I/O seam: `load(name)`, `save(name, layout, opts)`
(optimistic `expectedUpdatedTs` → `DockLayoutConflictError` on mismatch), and
`reset(name)`. Two implementations ship; any backend (PG, IndexedDB, …) can
implement the interface.

## Usage

```tsx
const registry = createPanelRegistry();
registry.register('my:panel', MyPanel, { title: 'My Panel' });

const store = createLocalStorageDockLayoutStore({
  keyPrefix: 'myapp:dock',
  seed: () => myDefaultLayout(),
});

<DockWorkspace layoutName="main" store={store} registry={registry} />
```

## Peers

`dockview` / `dockview-react` (^5 || ^6) and `react` / `react-dom` (^18 || ^19)
are peer dependencies — the host owns the versions.

## Test

```
npm test            # vitest run
```

Pure-logic suites (layout validation, dockview adapter round-trip, panel
registry, layout stores) run in `node`; the few DOM-dependent suites opt into
jsdom via a per-file `// @vitest-environment jsdom` pragma.
