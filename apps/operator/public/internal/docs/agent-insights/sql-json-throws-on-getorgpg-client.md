# JSON/JSONB binding on canonical postgres-js clients — the hybrid serializer supports both shapes
URL: /internal/docs/agent-insights/sql-json-throws-on-getorgpg-client

Canonical db-org clients install a sticky hybrid serializer for postgres-js JSON/JSONB OIDs: strings pass through and raw JS values are JSON.stringify'd. Both sql.json(value) and pre-stringified casts are supported; the historical getOrgPg throw is retained here as incident history, not current guidance.

## Current contract

Canonical clients created by `buildClient` install `restoreRawJsonbSerializer` for postgres-js JSON OID 114 and JSONB OID 3802. The serializer is both **hybrid** and **sticky**:

* a string is passed through unchanged, covering a pre-stringified `${JSON.stringify(value)}::jsonb` or `::text::jsonb` bind;
* any other JS value is serialized once with `JSON.stringify`, covering `${sql.json(value)}`;
* accessor-backed `get`/`set` properties prevent a later `drizzle(client)` or runtime `drizzle(tx)` wrap from replacing the hybrid serializer with drizzle's transparent serializer.

Therefore both binding shapes are supported on every canonical db-org client (`getOrgPg`, `getOrgPgApp`, and `getHarnessPg`). Do not rewrite a working `sql.json(value)` call merely because it uses a canonical client.

For code that may also run on a hand-rolled fresh `postgres()` client **without** `restoreRawJsonbSerializer`, keep the existing cross-client convention: a raw pre-stringified value should use `::text::jsonb`, while `sql.json(value)` uses postgres-js's own JSON parameter typing. The relevant question is which serializer the client installs, not whether the receiver is named `sql`.

## Historical incident

Before `restoreRawJsonbSerializer` landed, the canonical shared client could be left in a serializer state where `sql.json(object)` reached `Buffer.byteLength` as an object and threw, while a pre-stringified value could double-encode under the opposite serializer state. The old version of this document and the old `lint:no-sql-json` implementation treated that incident as a permanent ban on `sql.json`.

That guidance is superseded by EI-18698602043482898. The root fix is the sticky hybrid serializer, not rewriting every consumer to one call shape.

## Required wiring and recurrence guards

* `libs/papercusp/libs/db/src/raw-serializers.ts` owns `restoreRawJsonbSerializer`.
* `libs/papercusp/libs/db/src/connection.ts` calls it from `buildClient` before returning the canonical client.
* `packages/operator-core/test/_org-test-db.ts` applies the same restoration so production-shaped integration fixtures do not bind JSON differently from production.
* `libs/papercusp/libs/db/src/connection-jsonb-serializers.test.ts` pins raw JS serialization, string passthrough, both OIDs, and resistance to later drizzle mutation.
* The compatibility-named `npm run lint:no-sql-json` no longer scans or bans consumers. It verifies the wiring and hybrid/sticky implementation above, with detector positive controls in `packages/operator-core/lib/__tests__/check-no-sql-json.test.ts`.

## Verification

Run:

```bash
npm run lint:no-sql-json
npm exec vitest run -- packages/operator-core/lib/__tests__/check-no-sql-json.test.ts libs/papercusp/libs/db/src/connection-jsonb-serializers.test.ts
```

A green result establishes both halves: the static gate can detect missing production/test wiring, and the behavior suite proves the installed serializer accepts raw JS and pre-stringified values without double encoding.
