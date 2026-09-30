# @papercusp/sse

Spec-compliant Server-Sent Events primitives. Zero base deps. Optional React
and `postgres` peers via subpath imports.

## Why this exists

Until this package landed, the operator had 18 SSE producers + 10+ EventSource
consumers + 4 near-identical in-process buses, with no shared library.
Wire-format formatters were inlined per route. Heartbeat, abort handling, and
headers were reimplemented each time. The production desktop sync path
(`zero-harness/sse/route.ts` ↔ `SSEAdapter.tsx`) had the most-mature pattern
in the repo, but lived alongside ad-hoc imitations.

`@papercusp/sse` extracts the production patterns into one place. Migration is
opportunistic — existing producers keep working until each is touched again.

## Public surface

### Server

```ts
import {
  sseResponse,
  parseLastEventId,
  getChannel,
  type BusChannel,
  type SseSink,
  SYNC_MAX_DURATION_SEC,
  ACTION_MAX_DURATION_SEC,
} from '@papercusp/sse';
```

### React client

```ts
import { useEventSource } from '@papercusp/sse/react';
```

### Framework-free client

```ts
import {
  createResilientEventSource,
  parseSseStream,
  type ResilientEventSource,
  type ParsedSseEvent,
} from '@papercusp/sse';
```

### Postgres bridge

```ts
import { pgListenChannel, type PgBusChannel } from '@papercusp/sse/postgres';
```

## Quick start — sync-style producer

```ts
// app/api/zero-harness/sse/route.ts
import { sseResponse, parseLastEventId, SYNC_MAX_DURATION_SEC } from '@papercusp/sse';
import { pgListenChannel } from '@papercusp/sse/postgres';
import type { SyncSseEventVocabulary } from '@papercusp/sse';
import { getOrgPg } from '@papercusp/db-org';

export const maxDuration = SYNC_MAX_DURATION_SEC;
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ch = await pgListenChannel<SyncSseEventVocabulary['update'] | SyncSseEventVocabulary['invalidate']>({
  sql: getOrgPg().sql,
  channel: 'harness_sync_events',
});

export async function GET(req: Request) {
  return sseResponse<SyncSseEventVocabulary>({
    signal: req.signal,
    lastEventId: parseLastEventId(req),
    replay: () => ch.recentSince(parseLastEventId(req) ?? 0).map((e) => ({
      name: 'data' in e.event ? 'update' : 'invalidate',
      data: e.event as never,
      id: e.id,
    })),
    setup: async (sink) => {
      for await (const { id, event } of ch.subscribe()) {
        sink.event('data' in event ? 'update' : 'invalidate', event, { id });
      }
    },
  });
}
```

## Quick start — React consumer

```tsx
import { useEventSource } from '@papercusp/sse/react';

function Live({ url }: { url: string }) {
  const { status } = useEventSource(url, {
    handlers: {
      update:     (data) => console.log('update', JSON.parse(data)),
      invalidate: (data) => console.log('invalidate', JSON.parse(data)),
      heartbeat:  () => {},  // already resets watchdog internally
    },
  });
  return <span>{status}</span>;
}
```

## Wire-format stability contract

This contract is normative. Changes require a major version bump AND a
coordinated migration of every shipped desktop client. Tested by
`wire-format-snapshot.test.ts` — that file is the canonical reference.

```
=== Frame separator ===
\n\n (LF LF). Never \r\n\r\n.

=== Field order within a frame ===
id:    <numeric-or-string>    (optional — present when frame.id !== undefined)
event: <name>                 (optional — omitted only when name === 'message')
data:  <line>                 (one data: line per \n in payload; required)
retry: <ms>                   (optional — usually absent; rely on resilient client)

=== Required event vocabulary (SyncSseEventVocabulary) ===

event: update
data:  {"name":"<queryName>","args":<args>?,"data":<payload>,"tsMs":<unixMs>?}

event: invalidate
data:  {"name":"<queryName>","args":<args>?,"tsMs":<unixMs>?}

event: heartbeat
data:  {"tsMs":<unixMs>}

event: resync                 (control — emitted only when `resumeBounds` is wired)
data:  {"reason":"gap"|"ahead","fromId":<int>,"floorId":<int>,"maxId":<int>}
       Client's Last-Event-ID is unrecoverable from the buffer ('gap' = evicted,
       'ahead' = past source max after a restart). Client MUST discard local state
       and refetch the full snapshot, then resume live. Partial replay is skipped.

=== id field ===
Monotonic numeric. Assigned by sink/channel. Present on update/invalidate.
Absent on heartbeat + resync (control events, not part of the resumable event log).

=== Encoding ===
UTF-8, no BOM.
```

## Channel key conventions

To avoid namespace collisions in the global `getChannel()` map, callers
SHOULD prefix keys with their domain:

| Prefix | Owner |
|---|---|
| `branch-action:` | harness branch action runner |
| `harness-log:` | harness log streaming |
| `provision:` | provisioning audit |
| `run-chunk:` | command run output chunks |
| `harness-sync:` | desktop Zero sync transport |
| `backup:` | per-workspace kopia operations |
| `dev:` | /dev terminal command streaming |

Per-domain wrapper functions (e.g. `getActionChannel(channelKey)`) provide
type safety and document the prefix.

## Known limitations

- **PG NOTIFY payload limit:** 8KB. Larger payloads should use
  "invalidate-only + REST refetch" — the `invalidate` event vocabulary
  is designed for this.
- **Single-process bus.** Channels don't sync across processes. For
  multi-process (worker pool, multiple operator instances), each process
  has its own bus.
- **In-memory id counter resets on operator restart.** Pure in-memory
  channels accept this (events are ephemeral). `pgListenChannel` should
  use a PG sequence for durable ids — passed via the `backfill` callback.
- **Ring buffer overflow.** Slow subscribers can miss events if the ring
  wraps. They should reconnect with `Last-Event-ID` to recover via
  `recentSince()` / `backfill()`.

## Status

Initial implementation 2026-05-11. See `apps/operator/providers/HarnessSyncProvider.tsx`
for the canonical desktop-vs-web transport-selection rule that this library serves.
