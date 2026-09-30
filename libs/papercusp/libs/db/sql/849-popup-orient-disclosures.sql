-- 849 — record the six orient DISCLOSURE markers per session, so the HUD
-- sessions popup can show what the viewed agent was actually told.
--
-- plan popup-agent-state-coverage-2026-08-18, P-005.
--
-- WHY A STORED COLUMN AND NOT A RE-DERIVATION AT VIEW TIME (D-008).
--
-- The six markers — factsWithheld, factsNarrowed, factEvictionDisclosures,
-- claimableTruncated, announcedGatesTruncated, recipesTruncated — exist because
-- this codebase refuses to let a BOUNDED read masquerade as a total one. Their
-- absence is a positive statement that nothing was cut, which is the whole
-- property that makes them readable.
--
-- Four of the six are artifacts of the ARGUMENTS of the orient call the agent
-- itself made: factsNarrowed depends on that call's mode, claimableTruncated on
-- its claimableLimit, recipesTruncated on its recipesLimit and intent,
-- factsWithheld on the caller's own responsive-loop classification. Recomputing
-- them when a HUMAN opens a popup would measure the VIEWER's bounds and render
-- the answer as the agent's — i.e. it would manufacture on screen exactly the
-- false-clean reading each marker was built to prevent. So the markers are
-- recorded by the producer at orient time and read back verbatim, with the
-- instant they were recorded, and a popup on a session that has not oriented
-- since this migration shows NOTHING rather than a reassuring empty set.
--
-- Not folded into control_state: that column is a bounded CTRL projection with
-- its own token budget and generation semantics, where a change means "the
-- agent's control state moved". A disclosure change is a different subject and
-- must not advance that generation.

ALTER TABLE harness_shared.session_briefs
  ADD COLUMN IF NOT EXISTS last_orient_disclosures jsonb,
  ADD COLUMN IF NOT EXISTS last_orient_disclosures_at timestamptz;

COMMENT ON COLUMN harness_shared.session_briefs.last_orient_disclosures IS
  'The disclosure markers carried by this session''s most recent coord:orient payload (factsWithheld, factsNarrowed, factEvictionDisclosures, claimableTruncated, announcedGatesTruncated, recipesTruncated), recorded verbatim by the producer. NULL means this session has not oriented since the column existed — which is NOT the same as "nothing was withheld", and every reader must render the two differently. An EMPTY object is the positive statement that the last orient cut nothing.';

COMMENT ON COLUMN harness_shared.session_briefs.last_orient_disclosures_at IS
  'When last_orient_disclosures was last WRITTEN (semantically — an orient whose markers are unchanged does not move it). Read it as the age of the disclosure reading: markers from an orient six hours ago describe that call, not the session now.';
