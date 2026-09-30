# Temporal memory — validity windows, point-in-time recall, and supersession
URL: /internal/docs/agent-insights/temporal-memory-validity-and-supersession

How memory:search/list read current and historical facts, how remember/update/forget choose between correction, supersession, soft invalidation, and hard deletion, and why validity changes never re-embed content.

Papercusp memory facts are temporal records, not an append-only pile of equally
current assertions. The canonical store keeps a validity window on each memory,
default recall returns only the facts valid now, and superseded facts remain
available only when a caller explicitly asks for history.

This page describes the operator-facing contract. It deliberately does not add a
graph engine: the implementation is columns and SQL on
`harness_shared.memory_canonical`.

## The validity model

A memory is valid on the half-open interval:

```text
COALESCE(valid_at, created_at) <= instant < invalid_at
```

A null `invalid_at` means the window is still open. Pre-temporal rows have a
null `valid_at`; their `created_at` is the effective start, so no backfill or
re-embedding is required.

The lifecycle fields are real columns:

* `valid_at` — explicit start, with `created_at` as the fallback.
* `invalid_at` — when the fact stopped being current.
* `superseded_by` — the id of the replacing memory, or null for a soft forget.

Validity is metadata, not embedded content. Closing a window is a column-only
update and does not touch vector rows.

## Read the current truth by default

`memory:search` and `memory:list` exclude closed rows unless a temporal
control is present. This is the safety invariant: a corrected or retired fact
must not silently return as current guidance.

```text
memory:search { query: "memory embed default" }
memory:list { kind: "project", harness_slug: "papercusp" }
```

Use `as_of` to answer “what did we believe then?”:

```text
memory:search {
  query: "memory embed default",
  as_of: "2026-06-15T00:00:00Z"
}
```

The store applies the window at that instant. A row that is superseded today can
therefore carry `metadata.validity.status: "current"` in an `as_of` result:
the status is relative to the requested instant.

Use `include_superseded:true` for a lifecycle audit:

```text
memory:search {
  query: "memory embed default",
  include_superseded: true
}
```

Closed results carry `metadata.validity` with `valid_at`, `invalid_at`,
`superseded_by`, and `status:"superseded"`. Compact recall/orient renderers
also prefix closed facts with `[SUPERSEDED YYYY-MM-DD]` so metadata trimming
cannot make stale guidance look current.

If both controls are present, `as_of` wins: the result is the set valid at that
instant, not every historical row. Use `include_superseded` without `as_of`
when the goal is the full lifecycle.

## Choose update, supersession, or removal deliberately

### Correct the same fact in place

Use `memory:update { id, content }` when the stored assertion itself was
mistyped or needs an in-place correction and its identity should remain stable.
This preserves the id. It does not create a before/after historical pair.

### Record a new fact replacing an old fact

Use `memory:remember { ..., supersede:<old-id> }` when a new assertion replaces
an older assertion and the history matters. The new row is written first, then
the old row closes with `superseded_by` pointing to the new id.

If both rows already exist, express the same relationship from the new row:

```text
memory:update { id: "<new-id>", supersedes: "<old-id>" }
```

Do not hard-delete the old row first; that destroys the history and makes a
point-in-time answer impossible.

### Remove without a replacement

Use `memory:forget { id, soft:true }` when a fact stopped being true but has no
replacement worth recording. It closes the validity window and preserves the
row for `as_of` / `include_superseded`.

Use the default hard `memory:forget { id }` when the user wants the data gone,
especially for privacy. Hard delete is deliberately the default and removes the
canonical row plus its vector rows.

## Concurrency and failure behavior

Closing a window is first-wins: the SQL updates only rows whose
`invalid_at IS NULL`. A repeated or racing closer returns false and cannot
overwrite the first `invalid_at` or `superseded_by`. Treat that result as a
signal to re-read the lifecycle rather than retrying blindly.

Supersession never degrades into a half-done approximation on a backend without
validity-window support. The tool refuses before applying a content patch.
Likewise, `soft:true` never falls back to hard deletion.

## Discipline checklist

* Recall normally without flags; the result is current-only.
* Use `as_of` for one historical instant.
* Use `include_superseded` for the full lifecycle and inspect
  `metadata.validity`.
* Use in-place update for the same fact, supersession for a new replacement,
  soft forget for historical removal, and hard forget for privacy.
* Never treat a `[SUPERSEDED ...]` body as current instructions.
* Re-read after a first-wins conflict; do not overwrite the winner.
