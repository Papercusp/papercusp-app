# papercusp-data-sync — composition GUIDE

**Papercusp Official: Data Sync.** This aspect template wires the sync
generic-library family into a composed app: live server→client state sync,
event-maintained read models, burst control, and resumable large-asset
transfer. Everything here is **Tier A** (plain libraries) — compose and modify
freely; the MUSTs are about wiring shape, not code ownership.

## MUST — consult the live papercusp docs when this GUIDE is not enough

You are building ON a live papercusp install (we dogfood papercusp in
papercusp). If anything in this GUIDE is insufficient — a component's API, a
seam convention, a release step — do NOT guess:

- read the papercusp documentation served on your install at **`/internal/docs`**
  (start with the `agent-insights` section; this template's `template.yaml`
  `docs:` list names its canonical pages), and
- inspect the **operator app** itself — it is a running reference instance of
  every pattern these templates encode.

## The construction (orientation)

The sync plane has four legs, cheap→rich; take only what the app needs:

1. **Server push** — `@papercusp/sse`: an SSE response builder that drops into
   the sidecar's Hono host, an in-process channel bus, and a PG NOTIFY bridge
   so table changes stream to subscribed clients without polling.
2. **Client transport** — `@papercusp/sync`: schema-agnostic subscribe with
   reconnect + backpressure. Pairs with the SSE leg by default; a Zero
   transport exists for bidirectional needs.
3. **Read models** — `@papercusp/projection-index`: feed it source records as
   they change; it keeps derived, queryable indexes current (no rebuild jobs).
   Guard its delivery with `@papercusp/debounce-coalesce` (per-subscriber wake
   floor + burst coalesce) so change storms never stampede consumers.
4. **Large assets** — `@papercusp/resumable-download`: HTTP Range resume with
   streaming checksum verification, for models/media/archives.

## MUST

- Live surfaces stream over the sidecar host (the `hono-host` pattern from
  `papercusp-tauri-desktop-shell`) — do NOT open a second server for sync.
- Every synced surface gets a burst policy (wake floor / coalesce window). An
  unbounded change stream into a UI is the classic self-inflicted outage.
- Declare every component you keep as a real dependency — the
  `components-integrated` check fails a composition that was wired "on paper".

## SHOULD

- Prefer SSE over Zero unless the app genuinely needs client-originated sync
  (decision point `sync-transport`).
- Keep the projection set small and queryable; a projection nobody reads is
  rot with a maintenance cost.

## FREE

- Which tables sync, projection shapes, channel naming, retry/backoff tuning,
  and whether the large-asset leg exists at all (drop `resumable-download`
  from your composition if the app moves no big files).

## Checks

`checks/components-integrated.test.ts` — configure the `components` section of
your `TEMPLATE_CHECKS_CONFIG` with the package names you kept. Unconfigured it
skips; see `checks/README.md`.
