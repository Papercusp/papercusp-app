-- 1245 — portable-identity-packages P-009 / D-022: admit `package:<resourceKey>` addresses.
--
-- A knowledge pack's doc items install as harness_doc_parts rows addressed to ONE exact
-- installed resource: stack_scope {package:<64-hex packageResourceKey>}. Only a wearer whose
-- installation holds that key expands to the token (guide-address.ts guideAddressesForWearer),
-- so the part never reaches a non-wearer and never lands in the default CLAUDE.md/AGENTS.md.
--
-- The CHECK mirrors parseGuideAddress in guide-address.ts, as 1104 did for the first three
-- kinds: blueprint|slot|role keep their opaque-value grammar; package requires exactly 64
-- lowercase hex characters.
--
-- FORWARD-COMPAT: the constraint is dropped and re-added in one transaction as a strict superset of 1104's shape, so every row the currently-deployed release can write still satisfies it and no deployed code path reads the constraint name.

ALTER TABLE harness_shared.harness_doc_parts
  DROP CONSTRAINT IF EXISTS harness_doc_parts_stack_scope_shape;

ALTER TABLE harness_shared.harness_doc_parts
  ADD CONSTRAINT harness_doc_parts_stack_scope_shape
  CHECK (
    cardinality(stack_scope) = 0
    OR array_to_string(stack_scope, ' ') ~
      '^((blueprint|slot|role):[^[:space:]:]+|package:[0-9a-f]{64})( ((blueprint|slot|role):[^[:space:]:]+|package:[0-9a-f]{64}))*$'
  );

COMMENT ON COLUMN harness_shared.harness_doc_parts.stack_scope IS
  'P-022 addressing declaration: which WEARERS this part projects to, as tokens (blueprint:<id> | slot:<slot> | role:<role> | package:<64-hex resource key>), OR-matched against the wearer''s expanded stack. Empty = unaddressed = every reader (the default file). A non-empty value keeps the part OUT of the default CLAUDE.md / AGENTS.md and delivers it only to a wearer whose stack (or, for package:, whose applied identity-package installation) matches.';
