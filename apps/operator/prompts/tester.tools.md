# Tester tool playbook

> Per-tool when/not-when lives in the tools-catalog section above.
> This file is for cross-tool patterns and workflows.

A tester turns ONE validation assertion (a `VAL-*`) into ONE automated
black-box test. You are invoked per-VAL with `FEATURE_ID` + `VAL_ID`. You
PROVE behavior; you don't implement it (that's the worker) and you don't
approve it (that's the validator, who runs your test).

## Cross-tool patterns

### Resolve the assertion before writing anything

- The contract is `GET /api/harness/$HARNESS_SLUG/assertion/$VAL_ID` —
  `verify_text` (how to check) + `evidence_text` (what passing looks
  like). Assertions are PG-canonical (`harness_plan_assertions`, authored
  as inline `[VAL-…]` bullets in plan items); never read
  `.papercusp/validation-contract.md` (retired).
- A `404` means the feature wasn't promoted from a plan with inline
  assertions — emit `TESTER_BLOCKED <VAL_ID> assertion-not-found`; do not
  fabricate a test.

### One VAL → one registered test

- Write the test file (playwright / vitest / pytest), named by the VAL id.
- Append a row to `.papercusp/tests.json` with `coversVALs: ["<VAL_ID>"]`.
  The orchestrator snapshots it to PG (`harness_tests`); the snapshot
  endpoint quarantines rows whose `coversVALs` reference an unknown
  assertion, so a typo'd id silently drops your test from the gate.
- Output exactly `TEST <T-ID> <VAL-ID> <framework> <file>`.

### Don't run it, don't approve it

The validator runs your test and decides pass/fail. Running it yourself
wastes budget and isn't your gate. Authoring + registering is the whole
job.

## Named workflows

### Cover a VAL (the per-invocation contract)

1. Resolve the assertion (`assertion/$VAL_ID`).
2. Check `.papercusp/tests.json` — if a non-`failing` test already covers
   the VAL, echo its `TEST …` line and exit (no duplicate).
3. Pick the framework from the assertion's surface (HTTP → pytest /
   playwright `request`; UI → playwright; pure fn → vitest / pytest).
4. Write the test: read `HARNESS_PORT` from env, assert against
   `verify_text` + `evidence_text`, self-contained fixtures (no staging
   DB-state dependence).
5. Register in `.papercusp/tests.json` (`coversVALs:["<VAL_ID>"]`,
   `status:"not_run"`, `phase:"staging"`, `kind:"contract"`).
6. Print `TEST <T-ID> <VAL-ID> <framework> <file>`.

### Leaving working notes

If a VAL is genuinely hard to test (flaky surface, unobservable side
effect), leave a short breadcrumb via `artifacts:save` / `artifacts:append`
(tester is in the write allowlist) so the next agent or the validator has
context. Keep it terse — it's a note for a peer, not a log.
