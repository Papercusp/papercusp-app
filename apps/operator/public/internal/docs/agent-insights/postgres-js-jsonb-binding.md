# Writing JSONB columns with postgres-js — use JSON.stringify::jsonb, not sql.json
URL: /internal/docs/agent-insights/postgres-js-jsonb-binding

In operator runtime code (getOrgPg) sql.json(obj) THROWS and a bare object param THROWS — bind JSONB as ${JSON.stringify(value)}::jsonb. The testcontainer client (_pg-helpers) binds JSONB differently, so integration tests can't faithfully test it; verify against the live host.

import { Aside } from '@astrojs/starlight/components';

## TL;DR — use `::text::jsonb` (it works EVERYWHERE)

To write a JS object/array into a **JSONB** column, bind it as
`${JSON.stringify(value)}::text::jsonb` (keep a `== null` guard for nullable
columns):

```ts
// CANONICAL — stores a real jsonb object under EVERY client (2026-06-04):
await sql`INSERT INTO t (payload) VALUES (${value == null ? null : JSON.stringify(value)}::text::jsonb)`;
```

The explicit **`::text`** cast forces postgres-js to bind the JSON as a plain
text param, so it parses **once** server-side (`text → jsonb`) and stores a real
jsonb **object** under *both* the operator runtime client (`getOrgPg().sql`) AND
a fresh / testcontainer `postgres()` pool. This sidesteps the whole
runtime-vs-test divergence below — **prefer it for all new code** and when
touching an existing jsonb write. Empirically verified against the live native
`:5432` host + a fresh pool 2026-06-04 (both → `jsonb_typeof='object'`); it is
the fix that un-broke `insertFanoutNotify` (which had landed **0** rows in prod
because `getOrgPg().sql.json()` threw on every call).

## The divergence (why bare `::jsonb` and `sql.json` are client-dependent)

Bare `${JSON.stringify(value)}::jsonb` (no `::text`) is **correct under
`getOrgPg`** but **double-encodes** (stores a jsonb *string*) under a fresh /
testcontainer pool — and `sql.json(value)` / a bare object `${value}` is the
exact inverse. So the *old* per-client rules still hold for existing code, but
`::text::jsonb` makes them moot.

Under `getOrgPg` specifically, `sql.json(value)` and a bare object `${value}`
**THROW**:

```
TypeError [ERR_INVALID_ARG_TYPE]: The "string" argument must be of type string
or an instance of Buffer or ArrayBuffer. Received an instance of Object
    at Buffer.byteLength (node:buffer)
    at .../postgres/cjs/src/bytes.js  (the Bind step)
```

Verified live (P-070 `contributor_usage_events.payload`): `JSON.stringify(v)::jsonb`
stores a real jsonb object — `jsonb_typeof(payload)='object'`, `payload->>'k'` works.

## The trap: the testcontainer client behaves OPPOSITELY

The integration-test client (`_pg-helpers.ts` — `packages/operator-core/test/_pg-helpers.ts`,
also present at `apps/operator/test/_pg-helpers.ts`; used by every
`*.integration.test.ts`) binds JSONB params **differently** from the operator
runtime client — despite *identical* postgres-js config (`prepare:false`, same
`types:{bigint}`, same postgres 3.4.9):

| form                                  | `getOrgPg` (runtime / production) | `_pg-helpers` (testcontainer)     |
| ------------------------------------- | --------------------------------- | --------------------------------- |
| `${JSON.stringify(obj)}::text::jsonb` | **jsonb object** ✓                | **jsonb object** ✓ ← **USE THIS** |
| `sql.json(obj)`                       | **throws**                        | works (jsonb object)              |
| `${obj}` (bare)                       | **throws**                        | works (jsonb object)              |
| `${JSON.stringify(obj)}::jsonb`       | jsonb object ✓                    | double-encodes → jsonb **string** |

The root cause of the divergence is unexplained (configs match); it is likely a
postgres-js protocol/connection nuance. The practical consequences:

A `*.integration.test.ts` using `_pg-helpers` will give the WRONG answer for
JSONB param binding — `sql.json` passes there but breaks in production, and the
correct `JSON.stringify::jsonb` form looks "double-encoded" there. **Verify JSONB
write behavior against the live host** (`jsonb_typeof(payload)` over the running
operator's DB), not the testcontainer. Assert only client-agnostic things
(no-throw, row lands, rollup counts) in the integration test.

## Status of affected files

**Swept 2026-06-04 (handoff-coordination-dx-followups §A2)** — every bare
`${...}::jsonb` in production code under `packages/operator-core/lib`,
`packages/coordination/src`, and `libs/papercusp/libs/db/src` (38 files) was
converted to the universal **`${...}::text::jsonb`** form, and an ESLint rule
**`papercusp/no-bare-jsonb-cast`** (`tools/eslint-rules/`, wired `error` in
`eslint.config.mjs` for `packages/operator-core/lib`, `packages/coordination/src`,
and `libs/papercusp/libs/db/src`, RuleTester-tested) flags + autofixes a bare
`${x}::jsonb` → `${x}::text::jsonb` (it skips the `sql.json()`/`pgJson()` helper
forms + `::jsonb[]`). The federation round-trip test stays green because
`::text::jsonb` stores a real object under both clients, so the per-client
sections below are now historical context — **new code should use
`::text::jsonb`**.

The 38-file sweep was a point-in-time cleanup, not a standing guarantee — as of
2026-07-02 the tree had drifted back up to 50+ live `no-bare-jsonb-cast`
violations. That regression has since been cleaned up: a full-tree
`eslint packages/operator-core/lib packages/coordination/src
libs/papercusp/libs/db/src` on 2026-07-10 reports only **3 remaining
violations** — `lib/harness/git-sync/git-sync-action.ts`,
`lib/harness/join-hive-live-rekey-federation.integration.test.ts`, and
`lib/session-archive.ts`. The count still **moves with ordinary fleet
activity** (a bare cast can be re-introduced by any new commit until the gate
lints the whole tree, not just changed files — tracked as **EI-6682**), so
don't trust "the lint rule enforces it" as proof a given file is fixed — grep
it (below) or run eslint on that file directly.

**Fixed 2026-06-03 (superseded by the sweep above)** — every getOrgPg-client
jsonb write bound via `${JSON.stringify(x)}::jsonb`:

* `packages/operator-core/lib/sync/hyperbee/projections/issues.ts` (`notes`)
* `packages/operator-core/lib/sync/hyperbee/projections/contributors.ts` (`device_attestations`)
* `packages/operator-core/lib/sync/hyperbee/projections/harness-features.ts` (`metadata`, `tags`)
* `packages/operator-core/lib/sync/hyperbee/projections/usage.ts` (`payload`)
* `packages/operator-core/lib/agent-governor-pg-store.ts` (`limits`)

The projections also gained `normalizeJsonbInput()` (a `_jsonb-input.ts` helper):
a federated row whose jsonb arrived already-stringified (from a peer on a
double-encoding client) is re-parsed before the write, so the CDC outbox
round-trip stays `IS DISTINCT FROM`-stable. No-op under getOrgPg.

Fixed earlier in P-070: `packages/operator-core/lib/harness/usage-events.ts`.

**NOT affected — do NOT "fix" these to `${JSON.stringify}::jsonb`:**

* `packages/operator-core/lib/dock-layouts.ts` and `packages/operator-core/lib/llm-testing/*` use a
  *fresh* `postgres()` pool (`db()` = `postgres(getHarnessAdminUrl(), {prepare:false})`),
  NOT getOrgPg. On that client `sql.json()` is CORRECT and `${JSON.stringify}::jsonb`
  double-encodes — the inverse of the getOrgPg rule. Leave their `sql.json()` as-is.
* `packages/operator-core/lib/operator-rate-limit.ts` binds jsonb (live-verified
  `jsonb_typeof=object`, with accumulated rate-limit state) and — as of the
  2026-06-04 sweep — via the universal `${JSON.stringify}::text::jsonb` form like
  everything else, not the older bare `::jsonb` this note originally described. A
  2026-06-03 report that flagged the (then bare-cast) form as a double-encode bug
  was a false positive from testing against the testcontainer client (which
  behaves oppositely from getOrgPg).
