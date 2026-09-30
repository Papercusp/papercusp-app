# Repro tests must be *.repro.integration.test.ts — the deploy-gate naming contract
URL: /internal/docs/agent-insights/repro-test-naming-contract

A *.repro.test.ts reproduces an UNFIXED bug and fails BY DESIGN; named as a bare unit *.test.ts it runs in the green-checkpoint's unit gate and red-gates every deploy. Repro/heavy-sidecar tests MUST be *.repro.integration.test.ts; findMisroutedReproTests + repro-test-naming-guard.test.ts enforce it.

## The contract

A `*.repro.test.ts` reproduces an **unfixed** bug — it **fails by design** until
the bug is fixed. If you name it as a plain unit `*.test.ts`, it lands in the unit
suite the hourly **green-checkpoint** gates deploys on. A fail-by-design test in
the unit gate reds the gate, and a red gate blocks **every** fleet deploy.

**Rule:** a repro test MUST be `*.repro.integration.test.ts` (integration layer —
run by `test:affected:integration`, kept **out** of the unit deploy-gate). More
broadly: any test that reproduces an unfixed bug, or that spawns real peers /
sidecars / a real swarm / outbound network, belongs in the integration layer
(`*.integration.test.ts` or `*.repro.integration.test.ts`), never a bare
`*.test.ts`.

## Why the "misnamed test fails at import" guard rail does NOT catch this

The [testing-doc §1.6](/internal/docs/testing) naming guard rail says a misnamed
integration test "fails at module-import time because the pure-Vitest (unit)
config doesn't load the testcontainers global setup." That's true **only for
tests that import the testcontainers setup**. A spawned-sidecar / real-swarm repro
test spawns child processes (the `serve.mjs` sidecar spawner) — it does **not**
import testcontainers, so under the unit config it doesn't fail at import: it just
**runs**, and fails-by-design.

That is the WI-1053 incident: 8 federation `*.repro.test.ts` files
(`federation-{all-content-types,multimember,restart-durability,revocation-kcut,security-drops,reconnect-catchup}-sidecar`,
`sidecar-joiner-owner-bootstrap-admit`, `federation-issues-assignments-matrix`)
red-gated **all** fleet deploys for \~73h before anyone noticed the naming was the
cause.

## The guard (WI-1091)

Enforcement is **naming-based** (no import-scan needed), in two pieces:

* `libs/test-config/src/vitest-config.ts` exports `MISROUTED_REPRO_TEST` (a
  `/\.repro\.test\.[cm]?[jt]sx?$/` regex that matches `.repro.test.ts` but **not**
  `.repro.integration.test.ts`) and `findMisroutedReproTests(files)`.
* `packages/operator-core/lib/repro-test-naming-guard.test.ts` is a gated **unit**
  meta-test that (a) fixture-tests `findMisroutedReproTests`, and (b) walks the
  whole monorepo and fails if any `*.repro.test.ts` reappears — with an actionable
  "rename to `*.repro.integration.test.ts`" message.

Net effect: re-introducing a misrouted repro test now reds **that one unit
meta-test** with a clear rename instruction, instead of silently red-gating
deploys. `guardLayeredTestPathUnderUnit` (same file) only catches the **reverse**
direction — a correctly-named integration test run *by path* under the unit config
— so the two guards are complementary.

## Rule of thumb

Reproduces-an-unfixed-bug, or spawns real peers/sidecars/network →
`*.repro.integration.test.ts` (or `*.integration.test.ts`). Never a bare
`*.test.ts`. If unsure, integration is the safe default — the unit gate is the one
that blocks deploys.
