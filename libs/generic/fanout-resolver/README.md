# @papercusp/fanout-resolver

A generic, **pure** generative fan-out core — the "list → N items" engine, with
zero I/O and zero domain coupling.

A *fan-out* has two halves:

1. **Resolve** a fan-out **spec** to its item-set.
   ```ts
   import { resolveFanout } from '@papercusp/fanout-resolver';

   await resolveFanout({ items: ['a', 'b'] });                     // ['a','b']
   await resolveFanout({ glob: 'app/api/**/route.ts' }, { runGlob }); // injected runner
   await resolveFanout({ sql: 'SELECT id FROM todo' }, { runSql });   // injected runner
   await resolveFanout({ deferred: 'F-SCAN' });                    // throws — resolved later, by the host
   ```
   The spec is **data**, not a generator function. `glob` / `sql` runners are
   **injected**, so the resolver names no host (no repo, no database). The result
   is trimmed, deduped, non-empty. Over the cap → `FanoutCapError`; any failure
   (bad glob, query error, missing runner, a `deferred` spec) → `FanoutResolverError`.
   Both mean **escalate** — never a silent truncation or a silent zero.

2. **Expand** the item-set into N outputs.
   ```ts
   import { expandFanout, shortHash } from '@papercusp/fanout-resolver';

   expandFanout(items, (item) => ({
     id: `JOB-${shortHash(`${plan}:${item}`)}`,   // deterministic → idempotent re-expansion
     title: `Handle ${item}`,
   }));
   ```
   Items are deduped + trimmed + capped first; the builder owns the output shape
   and derives ids with `shortHash` (djb2 → 7 url-safe base-36 chars) so a
   re-expansion of the same input mints the same id.

## Why injected runners

`glob` and `sql` are the two places a fan-out touches the outside world. The lib
takes them as `ResolveFanoutCtx.runGlob` / `runSql` callbacks rather than
importing a glob library or a database client — so the core stays unit-testable
and any project can borrow it by supplying its own runners.

## API

| Export | What |
|---|---|
| `resolveFanout(spec, ctx?)` | spec → deduped/trimmed/capped item list (async) |
| `expandFanout(items, build, opts?)` | item list → N built outputs, deduped/capped |
| `shortHash(s)` | deterministic djb2 short hash for idempotent ids |
| `dedupeTrim(items)` | trim + drop-empty + dedupe a string list |
| `isFanoutSpec(x)` / `isDeferredFanout(spec)` | shape guards |
| `FanoutCapError` / `FanoutResolverError` | escalation errors |
| `DEFAULT_FANOUT_CAP` | `200` |
| `FanoutSpec` / `ResolveFanoutCtx` | types |

Pure — zero I/O, zero timers, zero deps. The first consumer is Papercusp's
promote-policy generative waves (`for_each: { items | glob | sql | from_feature }`),
mapped onto this seam by a thin operator-side adapter.
