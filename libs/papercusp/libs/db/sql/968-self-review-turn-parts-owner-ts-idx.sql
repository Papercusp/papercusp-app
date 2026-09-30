-- 968: index harness_shared.session_turn_parts for the arm-B self-review corroboration read.
--
-- EI-21481919801123128. `work_items:complete`'s arm-B gate corroborates a claimed self-review
-- against the invocation ledger. That ledger (harness_shared.tool_invocations) records MCP
-- tools ONLY, so a review performed with native client tools (Read/Grep/Glob) left no trace
-- and an HONEST close was refused. The fix reads session_turn_parts alongside it — but that
-- table has 2.37M rows and only two indexes, (ingested_at) and the
-- (workspace_id, source_kind, session_id, part_idx) primary key. Neither serves an
-- (owner, ts) lookup.
--
-- Measured on the live operator BEFORE this index, with the gate's own predicate:
--   Parallel Seq Scan, 5 workers, 222,576 shared buffers, 444ms — to return 58 rows.
-- That runs on the work_items:complete hot path, so shipping the corroboration widening
-- without this index would trade a false-refusal defect for a latency one.
--
-- Two deliberate shape choices:
--   * PARTIAL on part_kind='tool_use'. The gate only ever counts tool CALLS; tool_use is
--     roughly 30% of the table, so the partial index is materially smaller than a full one.
--     The gate's query carries the same literal predicate, so the planner can use it.
--   * workspace_id is NOT a leading column. It is 'default' on 2,373,429 of 2,373,429 rows
--     (measured), so it carries no selectivity and would only widen the key.
--
-- Additive DDL: no FORWARD-COMPAT acknowledgement is required. The currently-deployed
-- release simply does not use this index, which costs it nothing.

CREATE INDEX IF NOT EXISTS session_turn_parts_owner_ts_tool_use_idx
    ON harness_shared.session_turn_parts (owner, ts DESC)
 WHERE part_kind = 'tool_use';
