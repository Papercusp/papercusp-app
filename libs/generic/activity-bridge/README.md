# @papercusp/activity-bridge

Normalize **cross-CLI coding-agent hook events** into a uniform activity record, and
persist them through an **injected telemetry store**. Pure normalizer + a narrow
ingest seam — zero host coupling.

Different CLIs (Claude Code, Codex, OMP-style agents) emit native tool calls,
lifecycle transitions and todo snapshots in differing shapes. A host that wants one
fleet/activity view forwards the raw event and normalizes it here, so there is **one**
summary implementation shared by every CLI's hook.

## Two pieces

- **`normalize.ts`** — pure. A raw native tool call / lifecycle / todo snapshot →
  `{ kind, summary, detail }`. Recognises edit / read / shell / search / spawn / todo
  tools across CLIs (case-insensitive name sets), extracts the salient path / command /
  pattern, and caps payloads so a giant `Write` body never bloats the stored detail.
- **`store.ts`** — the `TelemetryStore` ingest seam (`append(record)`) plus
  `recordActivity(store, report)`, the generic normalize→append flow. Reading records
  back is host-shaped (filters, time windows, wire format) and deliberately **not**
  part of the port — keep the ingest seam narrow.

## Usage

```ts
import { recordActivity, type TelemetryStore } from '@papercusp/activity-bridge';

// The host implements the store over its own backend (PG / SQLite / memory).
const store: TelemetryStore = {
  async append(record) {
    const id = await db.insertActivity(record);
    return { id };
  },
};

// On each hook event (the host maps its hook payload onto RawActivityReport):
await recordActivity(store, {
  owner: 'agent-123',
  agent: 'claude',
  toolName: 'Edit',
  toolInput: { file_path: '/repo/src/gen.ts' },
});
// → store.append({ ..., kind: 'tool', summary: '✎ gen.ts', detail: { file: '/repo/src/gen.ts' } })
```

You can also call `normalizeReport(report)` directly to get the store-ready
`ActivityRecord` without persisting, or `summariseActivity(...)` for just the
`{ kind, summary, detail }` display shape.

## Design notes

- **Pure normalizer, injected store.** The lib decides what a raw event *means* and
  what to *store*; the host owns persistence (and reads). Inject the store; the lib
  names no consuming app.
- **Zero runtime dependencies.** Borrowable standalone.

First consumer: the Papercusp cross-CLI fleet view (the per-CLI hooks → `activity:report`
→ a Postgres-backed `TelemetryStore`). The lib is consumer-agnostic.
