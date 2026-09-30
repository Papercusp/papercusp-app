-- 784 — edit_attribution_ledger.acquired_via (EI-20055604348536487)
--
-- The ledger's `intent` column is documented as "the agent's declared intent" (D-002: what the
-- agent was actually doing, captured at edit time so it SURVIVES the session). In practice it
-- held the name of the HOOK that happened to take the lock: the automatic per-edit file-lock
-- hook acquires with `intent: f'PreToolUse:{tool_name}'`, and locks:acquire persists that
-- verbatim. Measured 2026-08-10 over a 24h window (n=3,257): 'PreToolUse:Edit' 3,047 rows /
-- 54 agents, 'PreToolUse:Write' 210 rows / 45 agents, versus ~50 rows carrying a real declared
-- intent — 97.5% sentinel.
--
-- The writer now records the agent's DECLARED coord intent in `intent` (already in hand on that
-- path: recordEditAttribution reads the presence row for plan_slug), and puts the lifecycle
-- label HERE. Splitting rather than overwriting keeps the fix lossless: 'which rows came from
-- the automatic edit hook vs a hand-held multi-file lock' is a real signal, and it is currently
-- the ONLY thing `intent` carries — a fix that merely replaced the value would destroy it.
--
-- EXPAND-only (additive, nullable): the deployed release does not reference this column, and
-- pre-existing rows keep NULL, which reads correctly as "not recorded" rather than "not a hook".
ALTER TABLE harness_shared.edit_attribution_ledger
  ADD COLUMN IF NOT EXISTS acquired_via text;

COMMENT ON COLUMN harness_shared.edit_attribution_ledger.acquired_via IS
  'How the lock behind this edit was taken — the lifecycle label passed by the acquiring hook '
  'or dispatch step (e.g. ''PreToolUse:Edit'', ''capability:edit''), NULL when hand-acquired or '
  'pre-784. Diagnostic only: never read this as the agent''s intent.';

COMMENT ON COLUMN harness_shared.edit_attribution_ledger.intent IS
  'What the agent said it was DOING at edit time — its declared coord intent (D-002), which is '
  'why this survives the session ending. Never a hook/dispatch lifecycle label: those go to '
  'acquired_via (784). Consumers render this as prose (git-sync uses it as the commit subject).';
