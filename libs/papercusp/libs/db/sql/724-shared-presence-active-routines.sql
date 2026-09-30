-- 724-shared-presence-active-routines.sql
--
-- EI-19330771435294981 / plan published-routine-set-capability-2026-08-02 (P-002).
--
-- Migration 682 added `runs_routines`, a BOOLEAN meaning "this node fires the pot's
-- cadence loops" — where "cadence loops" is the fixed set CADENCE_RUNNER_ROUTINES
-- (gym-cycle, scout-cycle) in packages/operator-core/lib/cadence-runner-capability.ts.
--
-- WI-6996 then pointed a DIFFERENT election at that bit: the git-sync INTEGRATOR
-- election (git-sync-action.ts, LockAuthorityDeps.routineHostsOnly). That election
-- asks "does this node integrate THIS repo", not "does this node fire gym-cycle",
-- and the mismatch is measurable rather than theoretical. On papercusp 2026-08-02:
-- gym-cycle was inactive and scout-cycle did not exist, so `runs_routines` was NULL
-- on EVERY live presence row; the narrowing resolved to the empty set and excluded
-- ALL peers, which turned integrator peer arbitration OFF rather than tightening it.
-- It is also latent in the other direction — arm gym-cycle on a peer that holds a
-- device namespace in the bare store and that peer wins the integrator lease on the
-- strength of a bit about an unrelated loop, reproducing the ~5.5h origin/staging
-- freeze WI-6996 was opened for.
--
-- The fix is NOT to widen the boolean. cadence-runner-capability.ts:22-32 already
-- measured and REJECTED that: "has any active routine" would have been satisfied by
-- the wrongly-elected peer's own git-sync routine, shipping a no-op. That argument
-- is against widening a SHARED predicate — it is not an argument against publishing
-- the underlying facts and letting each caller ask its OWN question.
--
-- So: publish the SET. `active_routines` carries the ACTIVE routine NAMES for this
-- node at (workspace_id, install_slug) — the same grain
-- `defaultHasActiveCadenceRoutine` already queries, and node-LOCAL knowledge
-- (harness_shared.routines has no fed_ts/fed_hlc), which is precisely why it has to
-- be published to be usable by a peer. Both predicates then derive from one column:
--
--     routineHostsOnly  =>  active_routines && CADENCE_RUNNER_ROUTINES  (unchanged semantics)
--     git-sync election =>  'git-sync' = ANY(active_routines)
--
-- NULLABLE with no default, exactly like `runs_routines` (mig 682) and `pot_slug`
-- (mig 187): a pre-upgrade peer's federated presence record simply lacks the field
-- and the projection decodes it as absent. Absent ⇒ that PEER is not a candidate —
-- safe for the same reason 682 documents, and worth restating because it is the
-- property the whole design rests on: selectAuthorityFromRows (and its rendezvous
-- twin) re-add SELF unconditionally AFTER the exclusion filter, so an empty capable
-- set means every peer is excluded, self wins, and this node does its own work. An
-- election can never go dark from this column being unpublished.
--
-- `runs_routines` is deliberately left in place and still written. It is derived
-- from this set once P-004 lands, and it stays readable meanwhile so a peer running
-- older code that publishes only the boolean is still understood.
--
-- No new index: like `runs_routines`, this column is filtered in TS over rows the
-- election has already fetched via the existing (workspace_id, harness_slug,
-- last_seen_at DESC) / (workspace_id, pot_slug, last_seen_at DESC) index paths. It
-- is never a query predicate.

ALTER TABLE harness_shared.shared_presence
  ADD COLUMN IF NOT EXISTS active_routines text[];

COMMENT ON COLUMN harness_shared.shared_presence.active_routines IS
  'EI-19330771435294981: the ACTIVE routine NAMES this node runs for this harness, at the (workspace_id, install_slug) grain of harness_shared.routines. Published so each election can ask its OWN capability question instead of sharing one coarse bit: the cadence-runner election intersects it with CADENCE_RUNNER_ROUTINES (gym-cycle / scout-cycle), the git-sync integrator election tests for ''git-sync''. NULL = unknown/pre-upgrade peer, treated as NOT a candidate — safe because both selectors add SELF unconditionally after the exclusion filter, so an empty capable set elects self rather than nobody.';
