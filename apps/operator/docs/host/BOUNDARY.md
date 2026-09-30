# `_hono/` — host-integration boundary

This directory's **`app.ts`** and **`bootstrap.ts`** are the integration
surface between the Hono application and whatever process hosts it. They are
load-bearing for an in-progress migration — see
`apps/operator/docs/plans/operator-vite-migration-2026-05-20.md`.

## The contract

Two exports are the boundary. Nothing outside this file may assume more than
these; nothing inside may narrow them without coordination.

| File | Export | Shape | Consumed by |
|---|---|---|---|
| `app.ts` | `export { app }` | a Hono instance, `new Hono().basePath('/api')`, all routes mounted | the Next shim (`app/api/[[...route]]/route.ts`, current) **and** the `@hono/node-server` host (`bin/hono-host.ts`, incoming) |
| `bootstrap.ts` | `export function runBootstrap(): void` | idempotent — safe to call at module init, on HMR re-eval, and once per standalone process | both hosts call it exactly once at startup |

## Rules

1. **Do not move or rename `app.ts` / `bootstrap.ts`.** Multiple hosts import
   them by path. A move breaks the Next shim and the incoming Vite host
   simultaneously.
2. **Do not change the public shape of the two exports.** `app` stays a
   served-anywhere Hono instance; `runBootstrap` stays a zero-arg idempotent
   `void` function. Adding routes to `app` is fine. Changing what `app` *is*
   is not.
3. **New Hono route modules still land in this directory** as usual and get
   mounted inside `app.ts`. That is not a boundary change — it is the normal
   way to add routes.
4. **Structural changes** (moving the directory, splitting `app.ts`, changing
   an export signature) require a `coord/frontend.jsonl` entry naming the
   change and a one-line acknowledgment from the other migration stream
   before landing.

## Why this exists

The operator is migrating off Next.js onto Vite + `@hono/node-server`. During
and after that migration, `app` is hosted two different ways. As long as the
two exports above keep their shape, the host swap is a one-file change in
`bin/hono-host.ts` and the route code never notices which process serves it.

The endpoint-route migration that moved the operator's API surface into this
directory shipped 2026-05-20 (`endpoint-route-migration-2026-05-20.md`,
status `shipped`). This boundary is what lets the Vite-host migration consume
that work without touching it.
