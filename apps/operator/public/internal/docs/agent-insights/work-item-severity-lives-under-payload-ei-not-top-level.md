# A work-item's severity is real — but a raw SQL audit checking payload/metadata top-level keys always finds zero
URL: /internal/docs/agent-insights/work-item-severity-lives-under-payload-ei-not-top-level

harness_shared.work_items has no top-level severity column and severity is never a top-level JSON key either — issue-family severity lives at payload->'_ei'->>'severity' (migration 374's engineer_issues compat-view convention), defaulted to 'minor' at write time. A raw audit like `payload ? 'severity'` or `metadata ? 'severity'` silently returns zero rows for every item, reading exactly like 'there are no criticals' when the real severities are sitting one JSON level deeper. Always go through work_items:list/work_items:claimable/the engineer_issues view (or payload->'_ei'->>'severity' directly) instead.

## The trap

`harness_shared.work_items` (the true base table since migration 374) has **no
`severity` column**, and `severity` is **not a top-level key** in either its
`payload` or `metadata` JSON either. For issue-family rows (`item_kind` ∈
`bug`/`change`/`task`), severity is nested one level deeper, inside a `_ei`
sub-object the `engineer_issues` compat view/trigger maintains:

```sql
-- sql-snippet-justified: quotes the real column shape this page exists to warn about.
payload -> '_ei' ->> 'severity'   -- the ACTUAL location, e.g. 'critical'
payload ? 'severity'              -- ALWAYS false — 'severity' is never a top-level key
metadata ? 'severity'             -- ALWAYS false — there is no metadata.severity either
```

An agent auditing "how many open critical bugs are there" with the natural,
un-nested query gets **zero rows every time** — not an error, not a warning,
just an empty result that reads exactly like "there are no criticals". This
happened live on 2026-07-27: an agent saw `fleet:leader-brief`'s
`unowned_criticals: 7` and, suspecting the metric was broken, "verified" it
with a raw `payload->>'severity'='critical'` audit that returned 0 rows —
concluded the metric was a false alarm, dismissed it, and **carried that wrong
conclusion forward into a loop checkpoint for a successor to inherit**. The
7 real criticals it had dismissed included a live-trading gate and a
fleet-wide false-green in `testing:run`/`build:typecheck`, aged up to 433h
unowned. The mistake was caught only when the same agent re-derived severity's
real storage location from `374-work-items-unify-base-table.sql` and re-ran
the audit correctly.

## Why it's nested this way

Migration 374 unified `harness_features_consolidated` + `engineer_issues` into
one base table, `harness_shared.work_items`. Feature-family rows never had a
`severity` concept; issue-family rows did (an `engineer_issues.severity`
column with a `CHECK (severity = ANY (ARRAY['critical','major','minor',
'nit']))` constraint, migration 131). Rather than adding a nullable
`work_items.severity` column used only by 3 of the unified kinds, the
migration folded every issue-only field (`severity`, `scope`, `source`,
`found_during`, `linked_feature_id`, `created_by`, `assigned_by`,
`signal_origin`) into a single `payload->'_ei'` sub-object, and the
`engineer_issues` compat view projects it back out:

```sql
-- sql-snippet-justified: the compat view definition itself (374), showing where severity
-- actually lives and its write-time default — not a query to hand-write.
COALESCE(payload->'_ei'->>'severity', 'minor') AS severity
```

So severity **is** genuinely stored (defaulted to `'minor'` at write time by
`createIssue` in `issues-engineer.ts` — `${input.severity ?? 'minor'}` — and
again by the compat view's own `COALESCE` as a belt-and-braces fallback for any
legacy row that predates the convention). `work_items:get` / `work_items:list`
read it correctly (`issueToWorkItem` maps `severity: i.severity` off the
`engineer_issues` view, which already did the `_ei` unwrap). The bug is purely
in **raw SQL against the base table** guessing the wrong JSON shape.

## The fix — don't guess the JSON shape; use the tool or the compat view

* **Prefer the tools** — `work_items:list { severity }`, `work_items:claimable`,
  or `improvements`/`issues` search all resolve severity correctly; they never
  touch `payload` directly.
* **Need raw SQL?** Query through the `engineer_issues` compat view (real
  top-level `severity` column, already unwrapped) — not `work_items` directly:

  ```sql
  -- sql-snippet-justified: the sanctioned raw-SQL path, via the compat view.
  SELECT issue_id, severity, state FROM harness_shared.engineer_issues
   WHERE scope = 'harness:<slug>' AND severity = 'critical' AND state = 'open';
  ```

  Note `engineer_issues` scopes on **`scope = 'harness:<slug>'`**, not
  `harness_slug` — it has no `harness_slug` column (that lives one level down,
  on the real `work_items` row). Copying the `work_items` idiom
  (`WHERE harness_slug = ...`) either errors (no such column) or, if "fixed" by
  dropping the predicate, silently spans every harness.
* **Querying `work_items` directly anyway?** Reach one level deeper:
  `payload->'_ei'->>'severity'` — never `payload->>'severity'` or a `payload ?
  'severity'` existence check.

## General rule

A JSON payload column that folds a *compat view's* only-some-kinds fields
under a versioned sub-key (`_ei`, or any similar convention) will never satisfy
a top-level `? 'key'` or `->>'key'` check for that field — the absence of rows
from that query is not evidence the data doesn't exist. Before concluding "zero
rows ⇒ nothing to find" on any `harness_shared.*` JSON audit, check the
relevant compat view's `CREATE VIEW` definition (or the migration that
introduced the payload-folding) for how the field is actually nested, or use
the tool that already knows.
