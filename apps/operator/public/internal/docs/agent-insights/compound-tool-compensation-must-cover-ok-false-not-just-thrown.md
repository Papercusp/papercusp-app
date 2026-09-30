# A compound tool's compensating rollback must cover the {ok:false} return, not just a thrown sub-call
URL: /internal/docs/agent-insights/compound-tool-compensation-must-cover-ok-false-not-just-thrown

inProcessCall (_compound-dispatch.ts) resolves NORMALLY when a sub-tool returns a business-level {ok:false, error} — it only throws on a dispatch/gate failure. A compound that compensates a durable side effect (rollback-after-partial-create) but only wires that rollback into the try/catch around the sub-call misses the {ok:false} path entirely, because that path never throws. EI-21107910194803524: templates:new-app rolled back on a thrown pot:create but not on pot:create's own {ok:false, error:'create_failed'} return — which is exactly what createPotHarness's OWN best-effort internal rollback() produces after a connection-level fault, since each of its undo steps is individually try/catch-swallowed.

## The trap

`inProcessCall`'s `InnerCall` (`_compound-dispatch.ts`) has TWO distinct failure shapes for a sub-tool call, and they propagate completely differently:

1. **A dispatch/gate failure, or the sub-handler THROWS** → `inner(name, args)` **throws**. Any `try { await inner(...) } catch (e) { ... }` around the call sees it.
2. **The sub-tool completes normally and returns business data `{ ok: false, error, message }`** → `inner(name, args)` **resolves normally** with that payload. The doc-comment says it outright: *"a sub-tool that returns a business-level `{ ok:false, error }` resolves normally — the composition inspects that payload itself."*

A compound tool that needs to **compensate a durable side effect** (roll back a partially-created resource on failure) is easy to wire onto shape (1) alone — wrap the sub-call in try/catch, compensate in the catch — and ship believing "any pot:create failure is compensated." It is NOT: every code path that inspects `raw.ok === false` **after** the `try/catch` and throws from there is a SEPARATE failure branch that the compensation logic never touches unless it is explicitly wired in too.

## Why the `{ok:false}` path is not a hypothetical

A well-behaved sub-tool with its OWN internal rollback (e.g. `createPotHarness` in `pot/_create.ts`, which pushes an `undo` stack and runs it in its outer `catch`) is EXACTLY the kind of tool that returns `{ ok:false }` instead of throwing — that is the whole point of catching its own error and reporting cleanly. But that internal rollback is typically **best-effort**: each undo step wrapped in its own `try {} catch { /* swallow */ }`, because one already-failing step (e.g. a dead DB connection) must not stop the rest of the undo stack from attempting theirs. When the underlying fault is a **connection-level** failure (a dropped PG connection, PgBouncer closing mid-write), that same fault can defeat MULTIPLE undo steps silently, so the sub-tool reports `{ ok:false }` having only PARTIALLY reverted its own side effects — real artifacts (a registry row, a PG schema, a checkout directory) survive, while the tool call as a whole reads as "failed, handled."

If the CALLING compound tool's compensation only fires on a throw, this exact shape — success internally attempted, partially failed, reported as clean `{ok:false}` data — sails straight past it. That is precisely what EI-21107910194803524 found: `templates:new-app` rolled back correctly when `inner('pot:create', ...)` threw (a PgBouncer `write CONNECTION_CLOSED` observed live), but the SAME failure surfacing as `pot:create`'s own `{ ok:false, error:'create_failed', message:'write CONNECTION_CLOSED...' }` return hit a second branch (`if (!r?.ok || !r.path || !r.slug) { throw new MaterializeTemplateError(...) }`) that threw a plain, uncompensated error — leaving a half-born pot (schema + registry row + stranded checkout) discoverable via `pot:list` while the tool reported failure.

## The check

For any compound tool wiring a compensating rollback around a sub-call whose failure can leave a durable artifact behind: grep for every place the composition inspects that sub-call's result and decides it failed, and confirm EACH ONE routes through the same compensation path — not just the surrounding `try/catch`. A `{ ok:false }`-shaped early return is a second failure branch, not a footnote on the thrown-error branch.

The narrow exception: a failure code that is KNOWN to mean "nothing was created / the resource belongs to someone else" (e.g. `slug_exists` in `templates:new-app` — the pot under that slug belongs to an EARLIER call) must be excluded from compensation, exactly like it already is on the thrown-error branch. Don't compensate blindly; compensate on every branch that COULD have created something, and exempt only the branches proven not to.

## Fix shape (from EI-21107910194803524)

```ts
if (!r?.ok || !r.path || !r.slug) {
  const detail = /* ...derive a message... */;
  if (isSlugExists(detail)) throw slugExistsError(args.slug, detail);
  // was: throw new MaterializeTemplateError(`pot:create failed: ${detail}`, 422);
  throw await compensateCreatedHarness(
    new MaterializeTemplateError(`pot:create failed: ${detail}`, 422),
    { slug: args.slug, path: '' },
    rollbackHarness,
  );
}
```

`compensateCreatedHarness` / `rollbackHarness` were already correct and reusable — the fix is calling them from the SECOND branch too, not inventing new logic. The rollback tool itself (`pot:obliterate` here) needs to tolerate "there was nothing to roll back" (it does — `hive_not_found` is treated as success), which is what makes it safe to reach on a pre-durable-step `{ok:false}` too.
