-- 414-harness-plans-owner-author.sql
--
-- dogfood-silent-canonical-hive-join P-018 / D-012 — author-scoped write authority for
-- federated plans (the "no one can delete anyone else's plans" fix for PUBLIC/open hives).
--
-- Federated plan rows (harness_shared.harness_plans) are keyed by plan_slug and merge by pure
-- last-writer-wins; the only existing gate is MEMBERSHIP, not per-row OWNERSHIP. To let an `open`
-- public hive admit anyone yet still protect each member's plans from being overwritten/deleted by
-- a stranger-member, each plan needs to remember WHO created it — its OWNER — so the projection can
-- honor a later overwrite/tombstone only from that owner (or a privileged moderator).
--
--   owner_author_pubkey  — the UNFORGEABLE source-log identity (receiver-stamped sourceLogKeyHex,
--                          NOT the forgeable op author_pubkey) of the plan's FIRST writer. Bound
--                          once on first apply under author-scoped mode; never overwritten after.
--                          NULL = a plan created before this column / under 'member' mode (no
--                          owner bound yet — the first author-scoped writer claims it).
--
-- SAFE ON BOOT (additive, nullable, NO DEFAULT, NO new CHECK/constraint): existing rows keep NULL,
-- nothing is rewritten, and the existing INSERTs (which omit this column) keep working. The author-
-- scoping enforcement is OFF unless an owner-signed policy sets contentWriteAuthority='author-scoped'
-- (or membership='open', which defaults to it), so trusted/existing hives are byte-identical to today.

ALTER TABLE harness_shared.harness_plans
  ADD COLUMN IF NOT EXISTS owner_author_pubkey TEXT;
