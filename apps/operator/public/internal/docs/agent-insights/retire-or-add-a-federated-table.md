# Retiring (or adding) a peer-log federated table — the six surfaces three drift guards force in lockstep
URL: /internal/docs/agent-insights/retire-or-add-a-federated-table

A sync:'peer-log' table is wired across six files. Three independent drift guards each enforce a different pair, so you cannot touch one surface without the others — change them together or the green gate reds one guard at a time. The exact map, learned removing the orphan harness_feature_prs projection (EI-479).

## What

A `sync:'peer-log'` table (the cross-machine Model-B federation set) is
wired across **six** surfaces. Three independent drift guards each pin a
**different pair** of them, so adding or retiring a federated table is an
all-or-nothing edit: change one surface and you red a guard; change the
right six together and the gate stays green. The guards are good — they
make the omission *fail CI* instead of silently dropping writes — but they
fire one at a time, so it's easy to play whack-a-mole if you don't know the
full set up front.

This is the map, reverse-engineered while retiring the orphan
`harness_feature_prs` projection (it was classified `sync:'peer-log'` with a
read projection but **no producer** — the poll daemon was never built, so it
never federated; EI-479 reclassified it `sync:'none'`).

## The six surfaces

For a table `T` with Hyperbee tag `tag` and key prefix `tag/`:

1. **Registry classification** — `harness-state/table-registry.ts`: `T` in
   `PEER_LOG_LIVE` (or `PEER_LOG_WORKSPACE_OWNED`). Removing it lets `T` fall
   through to `DEFAULT_SPEC` = `{ key:'slug-shared', sync:'none' }`.
2. **Read projection tag → table map** — `harness-state/projection-engine.ts`:
   `PEER_LOG_TAG_TO_TABLE[tag] = 'T'`.
3. **Projection registration** — `sync/hyperbee/projections/register-all.ts`:
   `tag` in `REGISTERED_PROJECTION_TAGS` **and** `buildTProjection(opts)` in
   `buildHarnessProjections` (+ the import).
4. **The projection itself** — `sync/hyperbee/projections/<tag>.ts`
   (`tableTag`, `composeKey`, `writeToPg`/`deleteFromPg`).
5. **Hyperbee key shape** — `harness/hyperbee-key-types.ts`: `tag` in
   `HYPERBEE_TABLE_TAGS`, both prefix maps, the `keyX` composer, the
   `ParsedHyperbeeKey` union variant, and the `parseHyperbeeKey` branch.
6. **Write-side producer** — `sync/hyperbee/capture-coverage.ts`: a CDC trigger
   (`CDC_CAPTURED_TABLES`), a log-first append (`LOG_FIRST_PRODUCED_TABLES`),
   **or** a documented `ACCEPTED_UNFEDERATED_TABLES` carve-out.

## The three guards and which pair each enforces

* **`checkPeerLogConsistency`** (projection-engine, pinned by
  `projection-engine.test.ts`) ties **#1 ↔ #2+#3**: every `PEER_LOG_TABLES`
  entry needs a registered projection tag mapping to it, and every registered
  tag must map to a still-`sync:'peer-log'` table. Drop #1 but keep #2/#3 →
  `orphanTag`; drop #2/#3 but keep #1 → `missingProjection`.
* **`checkCaptureCoverage`** (projection-engine, pinned by
  `capture-coverage.test.ts`) ties **#1 ↔ #6**: every federated table needs
  exactly one producer; a producer pointing at a non-federated table is an
  `orphanProducer`. So you can't drop `T` from the registry while leaving its
  `ACCEPTED_UNFEDERATED_TABLES` entry.
* **The superset invariant** in `register-all.test.ts` ties **#3 ↔ #5**:
  `REGISTERED_PROJECTION_TAGS ⊇ HYPERBEE_TABLE_TAGS` (minus `features-by-status`).
  So you cannot remove a tag from #3 without also removing the key shape from
  \#5 — and vice versa. This is the surface agents miss: retiring the
  projection forces editing `hyperbee-key-types.ts`, which isn't obviously
  part of "the federation wiring."

## So

To **retire** a federated table: remove it from all six (delete the projection
file + its test; empty/keep the `ACCEPTED_UNFEDERATED_TABLES` mechanism). The
table itself **stays in PG** — `sync:'none'` just means PG is the local
store-of-record and it never crosses machines. **No migration** is needed (you
are not dropping the table), and **independent PG read paths stay**: the
sync-resolver `table-to-query-names` invalidation map + any read route /
`useSyncQuery` are about PG→client reads, not federation — leave them.

To **add** one: do the same six in reverse, and pick #6 deliberately — a
PG-first table uses a CDC trigger; a log-first table appends directly. A table
must have **exactly one** producer (a CDC + log-first double-capture is the
EI-117 echo-storm shape and `checkCaptureCoverage` rejects it).

Run the affected suites together: `npx vitest run` over
`harness/hyperbee-key-types.test.ts`,
`sync/hyperbee/__tests__/capture-coverage.test.ts`,
`harness-state/projection-engine.test.ts`,
`harness-state/table-registry.test.ts`,
`sync/hyperbee/projections/__tests__/register-all.test.ts`.
