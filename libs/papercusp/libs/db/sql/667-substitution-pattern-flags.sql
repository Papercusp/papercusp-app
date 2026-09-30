-- 667-substitution-pattern-flags.sql — plan bash-to-tool-substitution-2026-07-26 (P-015 / WI-5998)
-- Carry the regex FLAGS alongside the pattern source in the substitution registry.
--
-- WHY: migration 665 stores only `bash_pattern`, and the seeder writes
-- `pair.bashPattern.source` into it — dropping the flags. Every consumer
-- (both PreToolUse hooks, the P-019 CLAUDE.md generator) then recompiles
-- `new RegExp(row.bash_pattern)` and gets a CASE-SENSITIVE regex, while the
-- equivalence verdict on that same row was computed WITH the flags intact
-- (equivalence.ts preserves `pair.bashPattern.flags`). Verified divergence on a
-- real sampled atom:
--
--   psql postgresql://localhost/papercusp -c "SELECT count(*) FROM harness_shared.work_items"
--     audited pattern (i flag) -> matches
--     registry recompile       -> DOES NOT MATCH
--
-- So `operator-db-select` — the best-adopted pair in the whole audit (85%) and
-- the row Phase 5 measures before/after — would have been a silent no-op
-- against the overwhelmingly common uppercase-SELECT form. That breaks the
-- D-001 chain at its root: a row may only leave `observe` because its pattern
-- was PROVEN equivalent, which requires the stored pattern to BE the pattern
-- that was audited. A dropped flag makes the stored pattern a different one.
--
-- WHY A CHECK ON THE FLAG SET (the recurrence guard): `g` and `y` make
-- `RegExp.prototype.test()` STATEFUL — it advances `lastIndex` between calls,
-- so the same registry row would match and then miss on successive commands,
-- producing an advisory that fires every other time with no pattern anyone
-- could reproduce. The audit harness already strips `g` defensively; this makes
-- it impossible to store one in the first place, for every future consumer,
-- rather than relying on each of them to remember. Only the stateless,
-- semantics-only flags are admissible.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS + guarded constraint add). Applied via
-- the runner (db:migrate / A1 boot-apply) — never a raw psql -f.

ALTER TABLE harness_shared.bash_tool_substitutions
  ADD COLUMN IF NOT EXISTS bash_pattern_flags text NOT NULL DEFAULT '';

DO $$
BEGIN
  -- Stateless flags only. Empty string = no flags (the common case).
  --   i = case-insensitive, m = multiline, s = dotAll, u = unicode.
  -- Deliberately EXCLUDED: g / y (stateful `.test()` via lastIndex — see above),
  -- and d / v (irrelevant here; `v` would also change character-class semantics
  -- out from under a pattern audited under `u`).
  --
  -- The single alternation-free pattern `^i?m?s?u?$` enforces all three
  -- properties at once:
  --   * alphabet   — only i/m/s/u can appear at all;
  --   * no repeats — each letter appears at most once ('ii' is rejected, and it
  --                  would be a TypeError at RegExp construction in the
  --                  consumer rather than a mere mismatch);
  --   * canonical order — 'mi' is rejected in favour of 'im', so two rows with
  --                  the same flags are always byte-identical and diffable.
  -- That last property is free rather than a burden: `RegExp.prototype.flags`
  -- is spec'd to emit flags in a fixed order (d g i m s u v y), so ANY value
  -- produced by reading `.flags` off a real regex is already canonical —
  -- verified: new RegExp('x','usmi').flags === 'imsu'. Only a hand-typed value
  -- can fail this, which is precisely the case worth failing.
  --
  -- (Written this way deliberately: the obvious dedupe idiom
  -- `regexp_replace(flags, '(.)(?=.*\1)', '', 'g')` is a JS-ism — Postgres ARE
  -- rejects a backreference inside a lookahead with "invalid backreference
  -- number" (SQLSTATE 2201B), which would have failed this migration at APPLY
  -- time and wedged the boot-apply path for the whole fleet.)
  ALTER TABLE harness_shared.bash_tool_substitutions
    DROP CONSTRAINT IF EXISTS bash_tool_substitutions_pattern_flags_chk;
  ALTER TABLE harness_shared.bash_tool_substitutions
    ADD CONSTRAINT bash_tool_substitutions_pattern_flags_chk
    CHECK (bash_pattern_flags ~ '^i?m?s?u?$');
END $$;

-- Existing rows were seeded before this column existed, so their flags are ''
-- — which is CORRECT for the four file-read pairs (no flags) and WRONG for the
-- two postgres pairs (`i`). Rather than hand-patch values here (a hand-authored
-- row is exactly what seed.ts's derive-don't-type discipline forbids), the
-- seeder re-derives every row from the frozen fixtures and now writes the flags
-- with them; re-running it repairs these in place.

COMMENT ON COLUMN harness_shared.bash_tool_substitutions.bash_pattern_flags IS
  'Regex flags the pattern was AUDITED with, so a consumer recompiles the identical RegExp: new RegExp(bash_pattern, bash_pattern_flags). Restricted to [imsu] by CHECK — g/y are rejected because they make .test() stateful via lastIndex, which would make a row match and miss alternately across successive commands (WI-5998).';
