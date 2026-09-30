-- 664-widen-fact-body-cap.sql — EI-18681984560352579
-- Widen the standing-facts body CHECK cap from 500 -> 1200 chars.
--
-- WHY: facts:assert has always TRUNCATED (never rejected) an over-cap body —
-- code-run-self-state-adoption-2026-07-03 P-007 made that call deliberately,
-- because a hard reject had cost a caller 7 whole lost facts in 14 days. But
-- with the cap at 500, real-world conclusions ("a discriminator rule +
-- verdict", "a decision + its rationale") regularly ran over, and the
-- silent tail-clip repeatedly amputated exactly the OPERATIVE clause a fact
-- exists to deliver (facts fold VERBATIM as BINDING context — a clipped
-- conclusion reads as a complete instruction that just stops). Observed 3x
-- in one session against the same key (2026-07-26), once removing the
-- verdict sentence of a discriminator rule entirely.
--
-- FIX: raise the stored cap to 1200 — generous enough that a tight,
-- front-loaded conclusion essentially never truncates in practice, while
-- keeping the clamp-not-reject fallback (clampFactBody, store.ts) for the
-- rare genuine overflow, so the "never lose the whole write" guarantee from
-- P-007 is preserved. The tool schema's already-documented 4000-char
-- transport ceiling is unchanged; 1200 remains well inside it.
--
-- FACTS_FOLD_LIMIT (12 facts/scope-selector, unchanged) is the actual
-- fold-budget control — worst case 12 * 1200 = 14400 chars per scope
-- selector in a fold, up from 12 * 500 = 6000. Deliberately accepted: a
-- fact that isn't silently mangled is worth the larger worst-case bound,
-- and per-scope cap (50 facts, LRU-evicted, unchanged) already bounds total
-- storage regardless of body length.
--
-- Idempotent (DROP/ADD CONSTRAINT IF EXISTS guard). Applied via the runner
-- (db:migrate / A1 boot-apply).

ALTER TABLE harness_shared.agent_facts
  DROP CONSTRAINT IF EXISTS agent_facts_body_check;

ALTER TABLE harness_shared.agent_facts
  ADD CONSTRAINT agent_facts_body_check CHECK (char_length(body) <= 1200);
