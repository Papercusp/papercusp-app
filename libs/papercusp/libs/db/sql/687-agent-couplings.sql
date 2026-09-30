-- 687 — DECLARED agent coupling edges (unified-agent-state-plane-2026-07-27 P-031, D-061).
--
-- Coupling decides RELEVANCE: which peers are worth showing an agent in detail
-- (D-044, D-053). Until now it was DERIVED only — recent coord exchange,
-- overlapping lock holds, a plan blocked-by edge, awaiting an event they emit —
-- so an agent that KNEW it was working alongside a peer had no way to say so and
-- had to wait for a derivation to notice. Owner ruling [owner 2026-07-27]:
-- agents may couple/decouple each other manually, with no restrictions.
--
-- This table is the DECLARED half. Readers resolve coupling as the union
-- (derived ∪ declared) minus suppressions — one predicate, two sources, never a
-- second mechanism.
--
-- WHY THE PAIR IS NORMALIZED (D-061 R3). Coupling is SYMMETRIC: coupling A→B
-- couples B→A. Storing it directed would make "am I coupled to X" answer
-- differently depending on who asked — the same shape defect D-054 rejected when
-- it cut `same fleet` from the predicate. So the pair is normalized to
-- (least, greatest) at write time and the CHECK below makes that an invariant of
-- the store rather than a convention callers must remember: an un-normalized
-- INSERT fails loudly instead of silently creating a second row for the same pair.
--
-- WHY `state` AND NOT A DELETE (D-061 R4). An explicit decouple cannot un-make a
-- derivation — the shared lock really is held, the blocked-by edge really exists —
-- so a decouple that DELETED the row would be silently overwritten by the next
-- derivation tick, which is worse than refusing. `state='suppressed'` is a
-- durable mask over the union that outlives the derivation, and because it is a
-- row rather than an absence it stays VISIBLE on the pair: a reader can tell
-- "never coupled" from "deliberately decoupled by someone", and knows who.
--
-- NO ownership/consent columns, deliberately. Any agent may couple any two
-- agents, including pairs it is not part of (D-061 R1) — coupling is not a
-- permission grant, so there is nothing here to authorize against; `declared_by`
-- is an AUDIT field, never a gate.
--
-- NOT federated. NO RLS (coord-family, like plan_item_claims / coord_presence);
-- scoping is the workspace_id filter.

CREATE TABLE IF NOT EXISTS harness_shared.agent_couplings (
  workspace_id  TEXT        NOT NULL,
  -- The normalized unordered pair: agent_a < agent_b, always (see CHECK below).
  agent_a       TEXT        NOT NULL,
  agent_b       TEXT        NOT NULL,
  -- 'coupled'    — a declared edge, unioned into the coupling relation.
  -- 'suppressed' — a declared DEcoupling that masks the pair even when a
  --                derivation would otherwise couple it.
  state         TEXT        NOT NULL DEFAULT 'coupled',
  -- AUDIT ONLY (never a gate): the ownerId that declared the current state. May
  -- be neither member of the pair — third-party coupling is explicitly allowed.
  declared_by   TEXT        NOT NULL,
  -- Free-text why, for the reader who finds the edge later. Bounded so an edge
  -- can never become a payload problem on a surface that renders many of them.
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULL ⇒ no TTL: a declared edge persists until someone changes it. A TTL is
  -- for the "couple us for the next hour while we share this file" case.
  expires_at    TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, agent_a, agent_b),
  CONSTRAINT agent_couplings_pair_normalized CHECK (agent_a < agent_b),
  CONSTRAINT agent_couplings_state_check CHECK (state IN ('coupled', 'suppressed')),
  CONSTRAINT agent_couplings_reason_len CHECK (reason IS NULL OR char_length(reason) <= 500)
);

-- The hot read: "who is coupled to ME right now" — one agent's live edges from
-- either side of the pair. Two partial indexes rather than one composite, since
-- the lookup is `agent_a = $1 OR agent_b = $1` and neither leg can use the other's
-- prefix. `expires_at` trails so an unexpired-only scan stays index-covered.
CREATE INDEX IF NOT EXISTS agent_couplings_by_a
  ON harness_shared.agent_couplings (workspace_id, agent_a, expires_at);
CREATE INDEX IF NOT EXISTS agent_couplings_by_b
  ON harness_shared.agent_couplings (workspace_id, agent_b, expires_at);

COMMENT ON TABLE harness_shared.agent_couplings IS
  'P-031/D-061 DECLARED coupling edges. Coupling = derived ∪ declared − suppressed. Pair normalized to (agent_a < agent_b) because coupling is symmetric; state=suppressed is a durable decouple that survives the next derivation tick. declared_by is AUDIT, never a gate — any agent may couple any two agents.';
COMMENT ON COLUMN harness_shared.agent_couplings.state IS
  '''coupled'' = declared edge; ''suppressed'' = declared decoupling that masks the pair even when a derivation would couple it.';
COMMENT ON COLUMN harness_shared.agent_couplings.declared_by IS
  'ownerId that declared the current state. AUDIT ONLY — may be neither member of the pair (third-party coupling is allowed by D-061 R1).';
