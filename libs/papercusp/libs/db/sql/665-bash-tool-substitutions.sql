-- 665-bash-tool-substitutions.sql — plan bash-to-tool-substitution-2026-07-26 (P-003)
-- The registry mapping a raw-Bash command pattern to the tool that should have
-- served it, with an equivalence verdict and an enforcement tier.
--
-- WHY: the 2026-07-26 raw-bash audit found Bash is 41% of ALL agent tool use
-- (24,641 of 60,396 tool_use blocks over 7 days, 86 su sessions, median 189
-- calls/session). Meanwhile the tools that answer the same questions sit near
-- zero: dev:processes 1 invocation against 1,232 `ps`/`pgrep` calls;
-- capability:read 3 against 3,920 file reads; dev:service_health 12 against 598
-- service probes. The ONE tool with real adoption (dev:pg_query, 85%) is also
-- the ONLY one with a row in CLAUDE.md's "you want X -> use Y, not Z" routing
-- table. Routing is the lever; this table is the routing.
--
-- WHY A TABLE AND NOT HOOK CODE (plan D-002): the enforcement point already
-- exists — PreToolUse `Bash` -> apps/operator/scripts/hooks/cc/
-- pretooluse-bash-resource-gate.sh -> locks:check_command — and it is mirrored
-- by a second hook (scripts/hooks/omp/coord-hook.ts) that Codex/OMP sessions
-- hit instead. That file's own comment already names the drift hazard we must
-- not reproduce at 30x the row count: "the pre-filter tokens mirror the seeded
-- resources' match_patterns; a new resource with a novel pattern needs a token
-- added here". So the patterns live in ONE place that BOTH hooks and the
-- CLAUDE.md routing generator read. Adding a tool becomes adding a row — which
-- is what makes "a new tool ships with the same enforcement" (plan D-004)
-- mechanical rather than a promise.
--
-- THE CENTRAL CONSTRAINT (plan D-001): `tier_requires_equivalence` below makes
-- the equivalence gate a DATABASE INVARIANT rather than a discipline. A pattern
-- cannot be promoted past `observe` unless its replacement tool has been proven
-- `equivalent` against real sampled commands. This is not ceremony — the audit
-- already found four cases where naive enforcement would have blocked work with
-- no alternative:
--   * dev:pg_query is SELECT-only, so `\d table`, `psql -f`, and any DDL have
--     no tool form at all.
--   * dev:processes answers 1% of what ps/pgrep is used for (1,134 of 1,145
--     identifiable targets fall outside its declared scope).
--   * dev:service_health returns no listening ports, so ss/lsof has none.
--   * Grep/Glob are REMOVED by the Claude Code runtime (v2.1.220), which
--     explicitly instructs agents to "search file contents with `grep` via the
--     Bash tool instead". ~5,100 calls there were agents correctly following
--     the harness's own instruction. Verdict `not-a-substitute`; never gated.
--     (plan D-007.)
--
-- Idempotent (CREATE ... IF NOT EXISTS + guarded constraint adds). Applied via
-- the runner (db:migrate / A1 boot-apply) — never a raw psql -f.

CREATE TABLE IF NOT EXISTS harness_shared.bash_tool_substitutions (
  id                  bigserial PRIMARY KEY,
  workspace_id        text        NOT NULL,

  -- Identity + matching
  intent_label        text        NOT NULL,   -- 'file-range-read', 'service-logs', ...
  bash_pattern        text        NOT NULL,   -- POSIX regex, matched per command ATOM
  tool_name           text        NOT NULL,   -- 'capability:read', 'logs:read', ...

  -- The equivalence verdict (plan P-004 harness writes this)
  equivalence_verdict text        NOT NULL DEFAULT 'unaudited',
  sample_size         integer,                -- how many real commands were tested
  failing_cases       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  evidence_ref        text,                   -- plan item / audit / WI ref

  -- Enforcement
  tier                text        NOT NULL DEFAULT 'observe',
  advisory_text       text,                   -- shown to the agent at tier advise/deny
  enabled             boolean     NOT NULL DEFAULT true,

  -- Phase 5 before/after measurement (frozen at audit time)
  baseline_calls      integer,
  baseline_sessions   integer,
  baseline_tool_calls integer,

  -- Promotion bookkeeping
  observed_since      timestamptz,
  promoted_at         timestamptz,
  false_positive_count integer    NOT NULL DEFAULT 0,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- One row per (workspace, intent). The intent is the unit an advisory speaks
-- about, so two patterns for the same intent belong in one alternation, not two
-- rows that could drift to different tiers and contradict each other.
CREATE UNIQUE INDEX IF NOT EXISTS bash_tool_substitutions_ws_intent_idx
  ON harness_shared.bash_tool_substitutions (workspace_id, intent_label);

-- The hot read: the gate fetches every enabled, actionable row for a workspace
-- on each candidate command.
CREATE INDEX IF NOT EXISTS bash_tool_substitutions_active_idx
  ON harness_shared.bash_tool_substitutions (workspace_id, enabled, tier)
  WHERE enabled;

DO $$
BEGIN
  -- Verdict domain.
  ALTER TABLE harness_shared.bash_tool_substitutions
    DROP CONSTRAINT IF EXISTS bash_tool_substitutions_verdict_chk;
  ALTER TABLE harness_shared.bash_tool_substitutions
    ADD CONSTRAINT bash_tool_substitutions_verdict_chk
    CHECK (equivalence_verdict IN
      ('unaudited', 'equivalent', 'needs-widening', 'not-a-substitute'));

  -- Tier domain.
  ALTER TABLE harness_shared.bash_tool_substitutions
    DROP CONSTRAINT IF EXISTS bash_tool_substitutions_tier_chk;
  ALTER TABLE harness_shared.bash_tool_substitutions
    ADD CONSTRAINT bash_tool_substitutions_tier_chk
    CHECK (tier IN ('observe', 'advise', 'deny'));

  -- ── plan D-001, as an invariant ──────────────────────────────────────────
  -- A row may only leave `observe` once its tool is PROVEN equivalent. There is
  -- one deliberate exemption: `policy-violation` rows, where the prohibition
  -- already exists in prose independently of any replacement tool (shared-tree
  -- git writes, raw systemctl restart of a papercup unit, curling /api/mcp,
  -- bare npm install). Those are not substitutions being proposed — they are
  -- existing rules finally being enforced — so they may go straight to `deny`.
  ALTER TABLE harness_shared.bash_tool_substitutions
    DROP CONSTRAINT IF EXISTS bash_tool_substitutions_tier_requires_equivalence;
  ALTER TABLE harness_shared.bash_tool_substitutions
    ADD CONSTRAINT bash_tool_substitutions_tier_requires_equivalence
    CHECK (
      tier = 'observe'
      OR equivalence_verdict = 'equivalent'
      OR intent_label LIKE 'policy-violation:%'
    );

  -- An advisory is what the agent actually reads. A row that advises or denies
  -- without one teaches nothing and is the `dev:processes` outcome in waiting.
  ALTER TABLE harness_shared.bash_tool_substitutions
    DROP CONSTRAINT IF EXISTS bash_tool_substitutions_advisory_required;
  ALTER TABLE harness_shared.bash_tool_substitutions
    ADD CONSTRAINT bash_tool_substitutions_advisory_required
    CHECK (
      tier = 'observe'
      OR (advisory_text IS NOT NULL AND length(btrim(advisory_text)) >= 20)
    );

  -- A non-'equivalent' verdict must say WHY, so a needs-widening row carries
  -- its own Phase-2 brief and a not-a-substitute row cannot be silently
  -- re-litigated later.
  ALTER TABLE harness_shared.bash_tool_substitutions
    DROP CONSTRAINT IF EXISTS bash_tool_substitutions_verdict_evidence;
  ALTER TABLE harness_shared.bash_tool_substitutions
    ADD CONSTRAINT bash_tool_substitutions_verdict_evidence
    CHECK (
      equivalence_verdict IN ('unaudited', 'equivalent')
      OR jsonb_array_length(failing_cases) > 0
    );
END $$;

COMMENT ON TABLE harness_shared.bash_tool_substitutions IS
  'Raw-Bash pattern -> replacement tool registry (plan bash-to-tool-substitution-2026-07-26). Single source of truth read by BOTH PreToolUse hooks (cc shell + omp ts) and the CLAUDE.md routing-table generator. Promotion past tier=observe is gated on equivalence_verdict=''equivalent'' by CHECK constraint (plan D-001).';

COMMENT ON COLUMN harness_shared.bash_tool_substitutions.bash_pattern IS
  'POSIX regex matched against a single command ATOM (the command split on ||, &&, |, ;, newline), not the whole command string — so a piped `| grep` never matches a code-search rule.';

COMMENT ON COLUMN harness_shared.bash_tool_substitutions.tier IS
  'observe = log the match, change nothing. advise = ride out as additionalContext on the gate''s existing permissionDecision:''allow'' (the command still runs). deny = block. Default advise for substitutions; deny reserved for policy-violation rows.';

COMMENT ON COLUMN harness_shared.bash_tool_substitutions.baseline_calls IS
  'Frozen count of matching Bash atoms measured when this registry row began observing; re-seeding must not overwrite this before-measurement denominator.';

COMMENT ON COLUMN harness_shared.bash_tool_substitutions.baseline_sessions IS
  'Frozen count of distinct sessions contributing to the matching Bash atoms when this registry row began observing; re-seeding must not overwrite this before-measurement denominator.';
