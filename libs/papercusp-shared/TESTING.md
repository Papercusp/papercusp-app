# TESTING — @papercusp/papercusp-shared

## What this project's tests cover

- `_admin-paths.test.ts` — path-resolution helpers (per-workspace
  `papercuspPath()` etc.) — example-based tests.
- `_admin-paths.property.test.ts` — fast-check property tests for the
  same path helpers (round-trip, idempotence).
- `src/agent/turn-error.test.ts` — the TurnError taxonomy/classifier,
  incl. the `usage_limit` vs `rate_limited` split (rate-limit-layer-v2 D-001).
- `src/resilience/{governor,retry}.test.ts` — the RateLimitGovernor pure
  core + governed retry loop: pacing, penalties, the fleet-wide global
  gate (D-004), AIMD turn-health hooks (D-005), and the staggered-resume
  wake spread (D-006, virtual-clock).
- `src/agent/governor-registry.test.ts` — shared bucket singletons + the
  fleet cap / AIMD effective-concurrency state machine (live cap edits,
  floor, clean-turn ramp).
- `src/agent/turn-robustness.fault-injection.test.ts` — fault-injection
  matrix + the P-022 acceptance: one agent's 429 parks the SHARED bucket
  for every caller, AIMD halves the fleet's effective concurrency.

## What they don't cover

- Runtime database access (this lib reaches into shared schemas via
  `search_path`; integration coverage lives in `apps/operator/test/`).
- Briefings / plugin-config persistence wired in 2026-04-28 — covered
  via operator integration tests.

## Run after editing

| Edit touches                        | Run                                                   |
| ----------------------------------- | ----------------------------------------------------- |
| Anything in this workspace          | `npm test --workspace @papercusp/papercusp-shared`     |
| Code that other workspaces depend on| `npm run test:affected` from repo root                |
| Briefings / plugin-config schema    | `npm run test:all:integration` (operator suite picks it up) |

This repository is npm-only; do not substitute `pnpm` or `yarn` for these commands.

See repo-root `CLAUDE.md` and `apps/operator/content/docs/testing/` for the full strategy.
