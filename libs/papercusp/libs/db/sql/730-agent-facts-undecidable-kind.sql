-- 730-agent-facts-undecidable-kind.sql
--
-- plan agent-epistemics-2026-08-02 P-002 — A FIRST-CLASS UNKNOWN.
--
-- ── WHY (the incident this exists to stop) ───────────────────────────────────
-- On 2026-08-02 four careful agents spent ~90 minutes producing four
-- CONTRADICTORY answers to one question ("which sha is the green gate judging?")
-- that was not answerable from the fields they were reading. The dispute was
-- also action-IRRELEVANT: the run slot was externally held, so under every
-- branch of the argument the next action was identical — wait.
--
-- The reviewing agent's own account of the gap:
--
--     "I needed to record 'this is not decidable from available evidence, stop
--      re-deriving it' so peers would stop burning wakes on it. I had to do it
--      in prose, in CLAUDE.md, in a carry-note, and in a broadcast — four
--      places, none authoritative."
--
-- Four non-authoritative copies is the same failure `plans:add-decision` fixed
-- for RULINGS: a coord message is not addressable after delivery, so a peer who
-- received a wrong paraphrase has no way back to the source. Facts ARE
-- addressable — they upsert by key, carry a TTL, and fold VERBATIM into every
-- coord:orient until retracted. So the durable home for "undecidable" already
-- exists; it simply had no modality to say it.
--
-- ── WHY A MODALITY AND NOT A NEW PLANE (reuse-first) ─────────────────────────
-- 690 added `kind` as the claim MODALITY discriminator, and its own comment
-- draws the line this change follows: "scope says who the fact is ABOUT, kind
-- says what kind of claim it is." conclusion / assumption / convention are all
-- claims that something IS so. An UNDECIDABLE is a claim about the ABSENCE of a
-- determination — same subject, same scope, same TTL semantics, different
-- modality. That is a fourth `kind`, not a second table.
--
-- Deliberately NOT reused: `claim jsonb` (690). It is dead surface — the
-- contradiction detector it was built for was retired (WI-6545 / D-103) after
-- 3 of 2,217 facts ever carried one, and assert.ts tells callers "NOTHING READS
-- THIS TODAY … omit it". Repurposing a dead column would be reuse in name only
-- and would silently overload a field whose meaning nobody can look up.
--
-- ── settled_by: AN UNKNOWN MUST NAME ITS OWN EXIT ────────────────────────────
-- Inherited from P-001's `refuseAnswer()`, which REQUIRES `insteadRead`: a
-- refusal that strands the caller is not an answer. The same asymmetry applies
-- here and matters more, because an undecidable OUTLIVES the turn that wrote it.
-- An UNKNOWN with no stated exit does not stop re-derivation — it INVITES it,
-- since the next agent cannot tell "nobody could determine this" from "nobody
-- has tried lately", and the cheapest way to tell them apart is to try again.
-- That retry is precisely the cost this whole change exists to eliminate.
--
-- NULLABLE at the DB layer, REQUIRED at the tool layer for kind='undecidable'.
-- The constraint is deliberately NOT expressed as a CHECK: pre-existing rows
-- have no settled_by, a table-wide CHECK would have to tolerate NULL for every
-- kind anyway (buying nothing), and refusing at the tool gives the caller an
-- actionable message instead of a constraint-violation stack trace.
--
-- IDEMPOTENT: re-runnable. The constraint is dropped and re-added rather than
-- conditionally created, because unlike 690 this migration must CHANGE an
-- existing constraint's definition — an IF NOT EXISTS guard would find the old
-- constraint present and silently leave the narrower check in place, which is
-- the failure mode that makes a migration look applied while doing nothing.

-- FORWARD-COMPAT: the DROP+ADD below WIDENS agent_facts_kind_check from migration 690's
-- ('conclusion','assumption','convention') to add 'undecidable' as a fourth allowed
-- value — confirmed directly against 690's own constraint definition. Every kind value
-- the deployed release (checked against sha 1e0ddc5864) can write today remains valid
-- under the new, superset CHECK; the deployed release has no code path that emits
-- 'undecidable' yet (that ships with this same plan's tool-layer change), so nothing
-- live depends on the old, narrower set being exclusive. (WI-6842)

ALTER TABLE harness_shared.agent_facts
  ADD COLUMN IF NOT EXISTS settled_by text;

ALTER TABLE harness_shared.agent_facts
  DROP CONSTRAINT IF EXISTS agent_facts_kind_check;

ALTER TABLE harness_shared.agent_facts
  ADD CONSTRAINT agent_facts_kind_check
  CHECK (kind IS NULL OR kind IN ('conclusion', 'assumption', 'convention', 'undecidable'));

COMMENT ON COLUMN harness_shared.agent_facts.settled_by IS
  'What evidence WOULD settle this question (kind=''undecidable'' only; required at the tool layer). '
  'An undecidable that does not name its own exit invites the re-derivation it exists to prevent — the '
  'next reader cannot distinguish "nobody could determine this" from "nobody has tried lately". '
  'Mirrors the required insteadRead on field-reliability.ts refuseAnswer(). Plan agent-epistemics-2026-08-02 P-002.';
