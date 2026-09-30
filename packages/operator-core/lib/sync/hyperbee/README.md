# `apps/operator/lib/sync/hyperbee/` — P-030 + P-031 substrate

Phase 5a — Hyperbee plumbing. Wires Corestore + Autobase + Hyperbee
into the operator process per `papercusp-dogfood-v5 §7.1` and the
phase plan's P-030/P-031 sub-acceptances.

## Modules

- `corestore.ts` — per-harness Corestore factory at
  `<workspace>/<harness>/hyperbee/`. Tracks open stores so cleanup
  on harness-close is deterministic.
- `autobase-setup.ts` — wraps a Corestore in an Autobase with the
  `apply` function the dogfood arc uses (addWriter ops + opaque
  `put`/`del` ops appended to the merged view).
- `schema-version.ts` — D-024 enforcement: every op carries
  `schema_version BIGINT`; unknown-newer ops are ignored + a
  `schemaVersionAlert` event fires.
- `boot-gate.ts` — P-031a gate: projection refuses to start until
  BOTH ensure-paths (SQL migrations + `ensure-schema.ts` runtime
  ensure) report complete. Uses a `globalThis` flag set by each
  ensure-path on completion, matching the Phase 1a P-013 pattern.
- `projection.ts` — interface for the bidirectional PG ↔ Hyperbee
  projection. The wiring is *stubbed* in this commit (interface +
  registration mechanics + LWW conflict-resolution helper); the
  per-table PG read/write hooks land in a follow-up because each
  table needs the PG row contract independently.

## What's NOT in tree yet (follow-up work)

- The per-table PG row writers — `harness_features`, `contributors`,
  `feature_queue`, `prs`, `issues`, `presence`, `usage`, `claims`.
  Each one is ~50 LOC of PG insert/update + a Hyperbee write hook.
- The Hyperswarm replication step. Holepunch-spike confirmed the
  primitive works; wiring the swarm in is straightforward but
  intentionally deferred so this commit ships pure substrate +
  same-process convergence tests (no network dependence in CI).
- The actual boot wiring in `instrumentation-node.ts`. Same reason
  — substrate first, boot wiring after the per-table contracts
  exist so the operator doesn't bring up a partial substrate.

## Tests

- `__tests__/convergence.test.ts` — two writers in one process,
  replicated through piped streams (mirrors the holepunch-spike
  `smoke:hyperbee` smoke verbatim, but inside Vitest with timeouts).
- `__tests__/schema-version.test.ts` — drops + alerts on
  newer-than-known versions.
- `__tests__/boot-gate.test.ts` — refuses to start without ensure
  flags; consumes flags on subsequent start.

## Phase-5a wiring sequence

1. ✅ Substrate in tree (this commit).
2. Per-table read/write hooks (one PR per table; each ~50 LOC + 2
   tests). Order: `contributors` first (smallest contract), then
   `harness_features`, then the rest.
3. `instrumentation-node.ts` boot wiring — gated on the boot-gate
   flags being set by the SQL + runtime ensure paths.
4. Hyperswarm replication step — same `corestore.replicate()`
   pattern from the spike, attached to a Hyperswarm topic per
   harness's `.papercusp/shared.json:topic`.
5. UI surfaces (Phase 5b P-066 bootstrap progress indicator,
   P-035 clobber-toast).
