# Blueprint op/role liveness is only validated if the operator passes the registries
URL: /internal/docs/agent-insights/blueprint-op-liveness-validation

validateBlueprint's `unknown-op` check is gated behind `opts.knownOps` and was DEAD — no caller passed it, so a program blueprint naming a typo'd/unregistered op validated clean then threw `requireCoordOp` deep in the durable pipeline. The fix is to pass `blueprintRegistrySets()` at the three blueprint admission chokepoints (authoring / install / PG-projection).


## What

`validateBlueprint` (`@papercusp/orchestrator/blueprint/validate.ts`) checks that a
program-mode spine's step/gate ops exist — **but only when the caller passes
`opts.knownOps`**. The pure lib deliberately doesn't own the coord-op registry
(D-001/D-004 — it lives in operator-core), so the registry header says
`coordOpNames()` is "what the operator passes to `validateBlueprint({ knownOps })`
so a program that names a nonexistent op fails at author/load time, not at run
time."

The trap: until `deterministic-blueprints-migration-2026-06-13` P-001 (brief 6),
**no caller ever passed it.** All three places a blueprint is admitted —
`agent-tools/blueprint/_resolve.ts` (the `blueprint:validate`/`blueprint:extend`
authoring tools), `blueprint/loader.ts` `resolveBlueprint` (the load path), and
`blueprint-distribution/instantiate.ts` `resolveAndValidateBlueprint` (marketplace
install) — called `validateBlueprint(bp)` with no opts. So the `unknown-op` check
was **dead in practice**. A deterministic-program blueprint (a migrated learning
loop, or any future procedure migration) could name a typo'd or unregistered op,
**validate clean**, and then throw `requireCoordOp("…")` deep inside the durable
`coordProgramWorkflow` at run time — the worst place to discover it.

The symmetric gap: P-001's text claimed the validator "asserts spine roles are
live AGENT roles." It never did — it only compared against the blueprint's own
`roles[]` (a warning, because prompt-resolve has a global persona fallback). A
classic stale-comment-vs-live-code drift.

## Why it's easy to miss

`coordOpNames()` looks wired — it's exported, documented, and exercised by a unit
test (`validate-program.test.ts` passes an explicit `knownOps` set). But `grep`
for real call sites shows it's **never** passed by production code. A
documented-and-unit-tested contract can still be dead at the seam. (See also: the
repo's own `blueprint-tools.test.ts` g3 fixture authored a "valid" program using
placeholder ops `spawn-roles`/`collect-votes` — nothing caught it, because the
authoring path skipped op validation.)

## The fix / the pattern

Pass the live registries at the **admission chokepoints**, not deep in the lib:

- operator-core `blueprint/registry-sets.ts` → `blueprintRegistrySets()` returns
  `{ knownOps: coordOpNames(), knownRoles: new Set(getKnownRoles()) }`. It imports
  the `coord-ops/index` **and** `blueprint-steps/index` registration entrypoints
  (the deterministic step-ops register there, not in coord-ops) and reads the
  registry **lazily** at call time, so it's robust to import ordering.
- The lib stays pure: `validateBlueprint(bp, { knownOps, knownRoles })`, with
  `resolveBlueprint`/`loadBlueprintFromFile`/`loadBuiltinBlueprint` +
  `resolveAndValidateBlueprint` taking an optional `registry: BlueprintValidateRegistry`.
  The no-opts default is byte-identical to before (every pre-existing caller
  unchanged), so the change is additive and the lib's own unit tests stay green.
- Wire it at exactly three places: `_resolve.ts` (authoring), `install-blueprint-core.ts`
  (install), `project-to-pg.ts` (the PG-projection that admits a blueprint to the
  runtime cache the interpreter reads).

`knownRoles` is used only to **suppress** the undeclared-role warning family for a
genuinely-live agent role (a spine may dispatch a built-in role without
re-declaring it) — warnings only, never a new error, so it can't break a shipped
blueprint that relied on the global persona fallback.

## Verify before turning it on

Enabling op-liveness at the load/projection path would break loading any **built-in**
blueprint that named an unregistered op. Guard it with a regression test that loads
EVERY built-in through the real loader and asserts no `unknown-op`
(`operator-core/lib/blueprint/registry-validation.test.ts`). Don't trust a grep of
`op:` in the yaml — `event: coordination-op:vote` trigger keys contain the
substring `op:vote` and read as false-positive "ops".
