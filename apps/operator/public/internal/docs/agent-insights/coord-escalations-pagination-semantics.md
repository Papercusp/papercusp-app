# coord:escalations — total vs trueOpenTotal, and how offset actually pages
URL: /internal/docs/agent-insights/coord-escalations-pagination-semantics

Why total/count is not the backlog size, and how to correctly page the full open-escalation backlog with offset.

`coord:escalations` lists escalations addressed to the human, newest-first,
bounded at the storage layer (EI-1548 — it never loads the whole backlog into
memory). Two related traps have bitten agents reading its result:

## `total` / `count` is just the size of THIS page — not the backlog size

`total` and `count` both equal `escalations.length` for the page you just
fetched. They are **not** a measure of how many escalations exist overall.

**EI-16170**: an agent ran a `status=open` scan with `maxRecords: 10` and read
back `total: 2`. It concluded "only 2 escalations open" — but 279+ were
actually open at the time. A small `maxRecords` silently produces a small
`total` that *looks* like ground truth but isn't.

For `status=open`, use **`trueOpenTotal`** instead — an unbounded exact count
of the real open backlog — as the ground truth for "how many are open". Never
use `total`/`count` for that purpose.

## Paging the whole backlog: `offset` vs raising `maxRecords`

`truncated: true` means older escalations exist beyond the current window.
The two ways to try to see more are **not equivalent**:

* **Raising `maxRecords`** (up to the 500 max) only widens a fixed *recency*
  window. It can never reach an old escalation buried under a lot of newer,
  fast-resolving traffic — you will hit the 500 cap before you hit the old
  row.
* **Paging with `offset`** (for `status=open` only) slices the *exact
  materialized open set* — real backward pagination. Start at `offset: 0`,
  then re-call with `offset: offset + maxRecords` each time, until
  `truncated: false`. The sum of all pages' `escalations.length` equals
  `trueOpenTotal`.

**EI-18712273081050373**: this distinction is easy to miss because both knobs
look like "give me more" — but only `offset` actually walks the full open set.
`offset` is a no-op for `status=resolved` or an unfiltered read; those can
only be widened via `maxRecords`.

## Other things to know

* A record whose `body` exceeds 500 chars is truncated in list mode
  (`bodyTruncated: true` + the original `bodyLength`), so a page of fat
  bodies can't reproduce the original multi-MB dump.
* There is no escalation read-by-id tool yet — filter `coord:escalations` by
  status/offset instead.

See also: [overwatch-anomaly-conditionkey-for-escalate-actions](/internal/docs/agent-insights/overwatch-anomaly-conditionkey-for-escalate-actions),
[unresolved-escalation-phantom-orphaned-slug](/internal/docs/agent-insights/unresolved-escalation-phantom-orphaned-slug).
