# path.join normalizes `..` away — string-based traversal checks run too late
URL: /internal/docs/agent-insights/path-join-defeats-traversal-checks

A `..`/traversal guard that inspects a string fails silently if path.join ran first; validate the raw input segment, not the joined result.

## The trap

A path-traversal guard that scans a string for `..` is **only sound if it
runs before any `path.join` / `path.posix.join`**. Both normalize `..`
segments away as part of joining — so by the time the guard sees the
string, the `..` it's looking for is gone, and a malicious input sails
through.

Real bug (found in the 2026-05-21 plans-tooling audit, `withPlanLock` in
`packages/operator-core/lib/agent-tools/plans/with-plan-lock.ts`):

```ts
const lockKey = path.posix.join(PLANS_DIR_REL, slug + '.md');
//   slug = '../../../CLAUDE'
//   PLANS_DIR_REL = 'apps/operator/docs/plans'
//   → lockKey = 'apps/CLAUDE.md'      ← the ../ are GONE, collapsed by join
validatePath(lockKey);  // checks for '..' in the string → finds none → PASSES
const filePath = path.join(absPlansDir, slug + '.md');
//   → <repo>/apps/CLAUDE.md           ← escaped docs/plans/, write lands here
```

`validatePath` did its job correctly — it just got handed a string that no
longer contained the evidence. The write verb could overwrite any `.md`
file in the repo.

## Why it's easy to miss

* The guard *looks* present and correct. `validatePath` genuinely rejects
  `../foo`, `a/../b`, etc. — when given a raw, un-joined path.
* The two surfaces diverge: the **read** path (`readPlanBySlug`) was safe
  because it validated the raw `slug` with a charset whitelist that
  rejects `/`. The **write** path validated the *joined* `lockKey`. Same
  intent, opposite soundness.
* `path.join` "helpfully" normalizing is the whole point of the function;
  nobody reads it as "destroys traversal evidence."

## The rule

**Validate the raw, caller-supplied segment — before it touches `join`.**
For a slug / filename / id that becomes one path component, the simplest
sound check is a charset whitelist that rejects `/` (and backslash):

```ts
const VALID_SLUG = /^[A-Za-z0-9._-]+$/;   // no '/', so no traversal
if (!VALID_SLUG.test(slug)) throw new Error(`invalid slug: ${slug}`);
```

A `..` segment cannot traverse without a `/` — so rejecting `/` on the raw
segment is enough, and it's robust against the `path.join` normalization
that defeats a `..`-substring check. (`..` alone, with no slash, just
yields a weird filename like `...md` inside the intended dir — not an
escape.)

If you must validate a *path* rather than a single segment, validate the
**raw** string for `..` segments first, and only then canonicalize — which
is exactly what `path-normalize.ts` does correctly (`validatePath` runs on
the raw path, `canonicalizePath` after). The canonical implementation is the
`@papercusp/locks` package source at
`libs/papercusp/packages/locks/src/path-normalize.ts`; the operator-layer
`packages/operator-core/lib/agent-tools/locks/path-normalize.ts` file is a
pure re-export shim so path-validation consumers do not pull in embedded-PG
discovery. The `withPlanLock` bug was feeding it a path that an earlier
`path.join` had already canonicalized.

> **Update (2026-06-08):** the specific `withPlanLock` instance has since
> been fixed. It is now PG-canonical (`plans-pg-canonical-migration-2026-06-03`):
> the lock key is a PG advisory lock on `workspace:harness:slug`, no longer a
> joined `.md` path, and the slug is validated up front against
> `VALID_PLAN_SLUG = /^[A-Za-z0-9._-]+$/` (`packages/operator-core/lib/agent-tools/plans/source.ts`)
> — exactly the `/`-rejecting charset whitelist this page recommends. The
> general rule below still stands; the code block above is preserved as the
> case study that motivated it.
>
> **Update (2026-06-25):** `resolvePlanScope` now also collapses concrete
> non-operator harness slugs to their Pot home before reading
> `harness_shared.harness_plans`. That changes the plan storage key, not the
> traversal defense: `getPlanRow` still rejects invalid slugs with
> `VALID_PLAN_SLUG` before the slug is used as a PG key or synthetic locator.

## Checklist when you see a traversal guard

1. Does the guard run on the **raw caller input**, or on something a
   `join`/`resolve`/`normalize` already touched?
2. If the input is a single component (slug/id/name): is there a
   `/`-rejecting whitelist? That's the cheap, sound check.
3. Read and write paths for the same resource: do they validate at the
   **same** layer with the **same** rule? Divergence is where this hides.
