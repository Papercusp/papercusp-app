# @papercusp/rules

A generic, **pure** ECA (Event-Condition-Action) rules engine.

Register rules `{ id, on, when, fire, args }`; given an event, `match()` returns
the actions that should fire. That's it — the lib decides **what** should fire;
the consumer **fires** it. There is no dispatch, no durability, no
loop-protection, no I/O inside the lib (that boundary is what keeps it
reusable — see [rules-engine-shared-lib-2026-06-04] D-002).

## Shape

```ts
import { RulesEngine } from '@papercusp/rules';

// Generic over the Event type and the Fire-descriptor type (default: string).
const engine = new RulesEngine<MyEvent>({ keyOf: (e) => e.tool });

engine.add({
  id: 'defer-renders-on-pane',
  on: 'coord:handoff',                       // trigger key(s); indexed for O(matching)
  when: { 'args.summary': { exists: true } },// declarative data-matcher …
  fire: 'activity:report',                   // … or a (e) => boolean predicate
  args: (e) => ({ owner: e.ctx.uiClientId }),// static object or event-derived fn
});

const actions = engine.match(event); // → [{ ruleId, fire, args, rule }]
```

## The `when` data-matcher

The common form is a **match-map** of dot-path → leaf test (implicit AND):

```ts
when: { 'args.item': { exists: true }, 'result.ok': true }
```

A bare value means `equals` (`{ 'args.kind': 'bug' }`). Operators (ergonomic,
curated, `$`-free): `equals`, `notEquals`, `exists`, `truthy`, `in`, `notIn`,
`contains`, `notContains`, `gt`, `gte`, `lt`, `lte`, `matches`, `startsWith`,
`endsWith`. Combinators `{ all: [...] }`, `{ any: [...] }`, `{ not: ... }`
(recognised only as the sole key) nest arbitrarily. For anything the data-matcher
can't express, `when` may be a plain `(event) => boolean` predicate.

### Evaluation is mingo-backed

The authoring surface above is ours and unchanged, but each leaf test is
evaluated by **[mingo](https://github.com/kofrasa/mingo)** ("MongoDB query
language for in-memory objects") rather than a hand-rolled operator switch — so
we don't own the operator edge-cases (regex / null / coercion / array semantics).
`compileToMingo(when)` translates the curated vocabulary → a mingo query
(`equals→$eq`, `in→$in`, `gt→$gt`, `matches→$regex`, `all/any/not→$and/$or/$nor`,
…); `exists` is our not-null semantics (`$ne null` / `$eq null`, not mongo's
key-presence `$exists`); and the few non-mongo ops (`truthy`, `contains`,
`notContains`) are registered as mingo custom operators. Path resolution and the
combinator tree stay ours (so the authored MatchMap remains the inspectable
surface). `compileToMingo` is exported for any consumer that wants the raw query.

For **scalar** values the behaviour is byte-identical to the previous hand-rolled
evaluator (the existing tests are the conformance suite). For the **edge cases**
it follows mingo's documented MongoDB semantics — adopted on purpose and pinned
in `compile.test.ts`:

- **Arrays** — a resolved array value matches element-wise (`{ tags: 'urgent' }`
  matches a `tags` array containing `'urgent'`). `contains`/`exists`/`truthy`
  stay atomic.
- **Null** — `null` and a missing/`undefined` value are equal under `$eq`/`$ne`
  (so `equals: null` also matches a missing field — the Mongo idiom).
- **Comparisons** are BSON-typed (no coercion): a `bigint` is not coerced to
  `number`, a non-number never satisfies `gt`/`lt`/… (JSON events carry neither
  `bigint` nor `NaN`).
- **`matches`** applies to strings only (no `String()` coercion of numbers).
- A bad `matches` regex source — or a `NaN` expected-value, which mingo cannot
  clone — throws; the engine catches it via `onError` and skips just that rule.

## Serializable rules

A rule whose `when` is a data-condition and whose `args` is a static object is
fully serializable (JSON / an Events file). Validate that form with Zod:

```ts
import { parseSerializableRule } from '@papercusp/rules';
const rule = parseSerializableRule(JSON.parse(raw));
```

Code-defined rules with predicate `when`s / function `args` use
`validateRuleShape` (structural) instead, run automatically on `engine.add`.

## Inspectability

`engine.rules()`, `engine.rulesFor(key)`, `engine.triggerKeys()`, and
`engine.describe()` (the "what fires what" edge list) expose the rule set so a
reactive-graph view can be built on top of it.

## Extending the vocabulary

The curated operator set is the default surface — inspectable, documented,
YAML-friendly, describe-able. mingo's richer operators (`$elemMatch`, `$size`,
`$type`, `$mod`, `$all`, nested-array) are reachable by extending the vocabulary
map in `compile.ts` when a real need appears; we deliberately do **not** expose
the full raw Mongo `$`-surface by default (it keeps rules inspectable and the
describe graph tractable). The `match()` interface is the contract; the evaluator
behind it is swappable — consumers don't change.

Pure, dependency-light: `zod` (the serializable-rule schema) + `mingo` (the
condition evaluator, version-pinned).
