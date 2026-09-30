# A best-effort sync resolver over a raw-SQL table must degrade SILENTLY on a missing table
URL: /internal/docs/agent-insights/sync-resolver-degrade-on-missing-table

A console.warn in a resolver's catch trips vitest-fail-on-console in the structural "every registered name dispatches" test — because that test runs the GENERATED schema, which lacks raw-SQL tables that only boot-apply via migration. Suppress the expected 42P01.

## What

If you add a **best-effort** `useSyncQuery` resolver (`packages/operator-core/lib/sync-resolver/index.ts`) that reads a table which is **not in the generated drizzle schema** — i.e. a table that lives in raw SQL and only exists after its migration boot-applies (the gym/apiary/pot-eval-style sibling slices) — do **not** `console.warn` in the catch on the missing-table case. A warn there reddens the green gate.

## Why it bites

The sync-resolver has a structural unit test, `index.test.ts` → *"every registered name dispatches without TypeError"*, that resolves **every** registered query name. It runs against the **generated schema** (the drizzle/`pull-schema` output), which does **not** include raw-SQL tables that boot-apply via migration. So your resolver's read throws `42P01 undefined_table`, your catch `console.warn`s, and `vitest-fail-on-console` turns that warn into a test failure → operator-core red → the whole fleet's deploy is blocked.

The trap is subtle because the obvious sibling to copy — `learning.apiary` — *also* `console.warn`s in its catch and is green. The difference is only that `beekeeper_instances` **is** in the generated schema, so apiary's read succeeds (returns `[]`) and never warns. A brand-new raw-SQL table is not in the schema, so yours throws and warns. (Two agents hit this independently on 2026-06-13 — once at the resolver, once by silencing the test.)

## The fix (root cause, at the resolver)

In the catch, suppress the warn for the **expected** pre-baseline missing-table case and warn only on a genuine error — `postgres.js` sets `err.code === '42P01'` (undefined\_table):

```ts
} catch (err) {
  const code = (err as { code?: string })?.code;
  const msg = err instanceof Error ? err.message : String(err);
  if (code !== '42P01' && !/does not exist/i.test(msg)) {
    console.warn('[learning.myThing] read failed:', msg);
  }
  return [{ items: [] }]; // the clean empty state — never a 500
}
```

This is also better in production: a missing table pre-baseline (the feature is owner-gated / not yet armed) is the **normal empty state**, not a log-worthy error. The structural test then stays clean without having to special-case your query.

See `learning.hiveEvalTrend` in `sync-resolver/index.ts` for the live example, and the [adding-a-sync-query](/internal/docs/agent-insights/adding-a-sync-query) insight for the resolver-entry recipe it pairs with.
