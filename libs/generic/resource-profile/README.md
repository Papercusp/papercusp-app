# @papercusp/resource-profile

Detect a host's effective compute resources **once at boot** and derive every
scale cap with explicit **floors + ceilings**, so nothing is hardcoded for one
machine. The same binary should adapt from a 2-core laptop with an embedded
Postgres to a 128-core server with a dedicated native DB.

```ts
import { configureResourceProfile, getResourceProfile } from '@papercusp/resource-profile';

// Once, at boot — inject the two domain bits the lib can't sniff generically:
configureResourceProfile({
  embeddedPg: true,        // a Postgres shares this box → the DB competes for cores/RAM
  hostRole: 'request-only' // this process serves requests but isn't the queue drainer
});

// Anywhere after — memoized; detection ran once.
const p = getResourceProfile();
p.maxSimultaneousAgents; // e.g. 1 on a laptop, 16 on a server
p.dbosQueueConcurrency;  // background queue depth
p.pgPoolMax;             // PG pool size
p.serializationWorkers;  // 0 ⇒ run inline
p.embedBatchSize;
p.backgroundInProcess;   // true ⇒ keep background work in the serving process (desktop default)
p.httpWorkers;           // 1 until a cluster exists
p.hostClass;             // 'laptop' | 'workstation' | 'server'
```

Cores come from **`os.availableParallelism()`** (cgroup-quota-aware — a 2-CPU-quota
pod on a 128-core node sees 2), **not** `os.cpus().length`. RAM from
`os.totalmem()` / `os.freemem()`.

## Formulas (each is `clamp(formula, floor, ceiling)`)

| cap                     | formula                                                        | floor | ceiling |
|-------------------------|---------------------------------------------------------------|------:|--------:|
| `maxSimultaneousAgents` | `round(cores * (embeddedPg ? 0.25 : 0.5))`, then `min` with `floor(freeGiB / 0.5)` | 1 | 16 |
| `dbosQueueConcurrency`  | `round(cores * (embeddedPg ? 0.5 : 1))`, halved if `hostRole !== 'full'` | 1 | 32 |
| `pgPoolMax`             | `maxSimultaneousAgents + dbosQueueConcurrency + 4`            | 4 | 64 |
| `serializationWorkers`  | `cores - 2` (**0 ⇒ inline**)                                  | 0 | 8 |
| `embedBatchSize`        | `32 * 2^tier` (laptop 32 / workstation 64 / server 128)       | 16 | 256 |
| `backgroundInProcess`   | `false` only on a server-class host with a dedicated (native) PG; else `true` | — | — |
| `httpWorkers` / `processCount` | `1` (no cluster yet — floor === ceiling)               | 1 | 1 |
| `hostClass`             | `cores <= 4` laptop · `<= 16` workstation · else server       | — | — |

## Generic-first

Pure derivation behind a `configureResourceProfile()` seam — no host imports. The
caller injects `{ embeddedPg, hostRole }` and may override the detected
`cores`/RAM. With no injection it auto-detects from Node's `os`. `deriveResourceProfile()`
is exported pure (no memoization, no `os`) for unit-testing the math directly.
Zero runtime dependencies; borrowable standalone.
