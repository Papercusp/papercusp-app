-- 869 — predicate_watches: allow op = 'changed'
--
-- state-plane-interest-and-hardening-2026-08-21 P-004.
--
-- WHY. A measurement of every state:subscribe call in this workspace (300 calls,
-- 50 not_ok = 16.7%) found the single largest failure class — 23 of the 50 — is
-- agents trying to say "wake me when this value MOVES": 12 omitted `on` entirely
-- and 11 invented an operator ('change' / 'changes' / 'changed'). No such
-- operator existed. The only expressible workaround was `ne` against the value's
-- CURRENT reading, which forces the caller to transcribe a volatile value into
-- the subscription — the exact anti-pattern the state plane exists to remove —
-- and carries a silent race: if the value moves between the read and the
-- subscribe, the watch is registered against a stale operand and never fires.
--
-- 'changed' is baseline-relative instead of operand-relative: it compares each
-- observation against the PREVIOUS recorded observation (last_value), with the
-- baseline established by the registration-time inline eval. There is no operand
-- to transcribe and therefore no window to race.
--
-- FORWARD-COMPAT: this only WIDENS the permitted set — every op the currently
-- deployed release can write ('eq','ne','gt','gte','lt','lte','exists',
-- 'contains') stays permitted, and that release has no code path that emits
-- 'changed', so it cannot write a row this constraint would have rejected nor
-- read one it cannot interpret. The DROP/ADD pair is how Postgres widens a CHECK;
-- it is not a contraction.

ALTER TABLE harness_shared.predicate_watches
  DROP CONSTRAINT IF EXISTS predicate_watches_op_check;

ALTER TABLE harness_shared.predicate_watches
  ADD CONSTRAINT predicate_watches_op_check
  CHECK (op = ANY (ARRAY[
    'eq'::text, 'ne'::text, 'gt'::text, 'gte'::text,
    'lt'::text, 'lte'::text, 'exists'::text, 'contains'::text,
    'changed'::text
  ]));
