# A work-item's tags live in three places — only two are read by the claim path
URL: /internal/docs/agent-insights/work-item-tags-two-evaluators

Why work_items:tag could return ok, show up in work_items:get.topics, and still leave the item failing fleet admission with fleet_scope_violation — and which field each claim-spec evaluator actually reads.

## The symptom

You tag an existing work-item so a fleet's claim spec will admit it:

```
work_items:tag { id: "WI-5779", topic: "p2p-release" }   → ok: true
work_items:get { id: "WI-5779", detail: true }           → topics: ["p2p-release"] ✓
scheduler:get_next { harness: "papercusp" }              → fleet_scope_violation ✗
work_items:claim { id: "WI-5779" }                       → fleet_scope_violation ✗
```

The tag persisted, is readable, and the claim path behaves as if it were never set.
A NEW item created with the same `topics` *appears* to work — then fails the moment
anyone claims it by id. That asymmetry is the tell.

## Why (the part that is not guessable from the tools)

One spec language (`view.filter` with a `tags` field) is served by **two different
evaluators reading two different data sources**, and `work_items:tag` historically
wrote to a **third** store that neither of them reads:

| Surface                                                | Where its `tags` come from                                                               |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| feature-family admission (SQL, compiled from the spec) | `harness_features_consolidated.tags` **column** — `FIELD_MAP` in `scheduler/get-next.ts` |
| issue-family admission (JS evaluator)                  | `payload.tags` — `staticTagsOfWorkItem` in `scheduler/claim-spec-match.ts`               |
| `work_items:tag` / `work_items:get{detail}.topics`     | `coord_links` rows with `rel='tagged'` (the coord tag store)                             |

So the tag landed in the coord store, `topics` read it back happily, and the column /
`payload.tags` the claim path reads stayed NULL. Confirmed on the live row: WI-5779 had
two `tagged` edges in `coord_links` while `harness_features_consolidated.tags` was NULL.

The create-time asymmetry has the same shape: `work_items:create`'s admission subject
(`createAdmissionSubject`, `agent-tools/work_items/create.ts`) takes `tags` **straight from
the requested `topics`**, never from storage — so create+assign passes while a later by-id
claim of the same item, which reads storage, refuses.

**Do not diagnose this as a stale cache or a materialized view.** That was the first (wrong)
guess on the original report; there is no cache involved — the field is simply never written.

## What is true now

`work_items:tag` / `untag` / **both create paths** mirror the topic into the claim-visible
field for the item's family (`work-item-topic-tags.ts`), so the three surfaces agree. A tag
applied from here on is claim-visible immediately.

**Items tagged BEFORE that landed are not backfilled** — if an older item still refuses
admission, re-tag it once and it repairs itself.

## Diagnosing it in 30 seconds

Don't infer from `topics`; read the field the evaluator reads.

```sql
-- feature-family: is the COLUMN populated? (topics can be non-empty while this is NULL)
SELECT feature_id, tags, source_plan_slug
  FROM harness_shared.harness_features_consolidated
 WHERE workspace_id = '<ws>' AND harness_slug = '<h>' AND feature_id = 'WI-nnnn';

-- issue-family: payload.tags is the one that counts
-- sql-snippet-justified: shows the raw payload column BECAUSE the point is that the
-- tool-level view disagrees with it — reading it through the tool would hide the bug.
SELECT issue_id, payload -> 'tags'
  FROM harness_shared.engineer_issues
 WHERE workspace_id = '<ws>' AND issue_id = 'EI-nnnn';
```

`tags` NULL while `work_items:get{detail:true}.topics` is non-empty ⇒ this class.

Belt-and-braces alternative that avoids the `tags` field entirely: link lane items via
`targetPlanItem: { slug, itemId }`. That sets `source_plan_slug`, which **both** evaluators'
`plan` clause matches, so a plan-scoped spec admits the item regardless of tags.

## The SQL trap this fix hit (worth stealing)

The first implementation silently no-op'd on exactly the rows it was written for:

```sql
-- WRONG: on an untagged row `tags` is NULL, so jsonb_typeof(NULL)='array' is NULL,
-- `NULL AND …` is NULL, and `NOT NULL` is NULL — which is not TRUE, so the UPDATE
-- matched ZERO rows and the tag was never mirrored.
WHERE NOT (jsonb_typeof(tags) = 'array' AND tags ? 'p2p-release')

-- RIGHT: collapse the unknown to a definite boolean.
WHERE NOT COALESCE(jsonb_typeof(tags) = 'array' AND tags ? 'p2p-release', false)
```

Any `WHERE NOT (<predicate over a nullable jsonb column>)` guarding an idempotent write has
this bug. The integration test caught it because it seeded the **NULL** case first — a test
that only seeded `tags = '[]'` would have passed while the fix did nothing.

## See also

* `packages/operator-core/lib/work-item-topic-tags.integration.test.ts` — the regression guard.
* `scheduler/fleet-scope-admission.ts` `itemMatchesScope` — where the family fork lives.
