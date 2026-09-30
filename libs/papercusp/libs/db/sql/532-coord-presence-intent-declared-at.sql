-- Migration 532 — coord_presence.intent_declared_at (EI-8988).
--
-- Distinct from last_active_at (mig 277): last_active_at bumps on ANY genuine
-- activity — tool dispatch (touchActivity), an inbox-read heartbeat — even
-- when the declared `intent` TEXT never changes. So a busy agent working a
-- DIFFERENT task than its stale intent string reads as "active" (fresh
-- last_active_at) with no signal that the intent text itself is old — the
-- exact drift that nearly caused a leader to misread a live agent as
-- abandoned (su-6073d's presence intent read "Resuming WI-3641" for 25+ min
-- while it was actually root-causing WI-3646; messages proved it was live).
--
-- intent_declared_at advances ONLY when a write()'s intent value actually
-- CHANGES (see PgPresenceStore.write's CASE expression) — never on
-- touchHeartbeat/touchActivity/heartbeat, and never on a re-declare of the
-- same string. A reader can then compare "seconds since intent_declared_at"
-- against "seconds since last_active_at": fresh activity + old
-- intent_declared_at is itself a useful divergence/drift signal, not just an
-- idle-vs-active split.
--
-- The migration runner wraps each file in its own transaction, so this file
-- carries NO top-level BEGIN;/COMMIT; — an inner COMMIT would end the wrapper
-- txn early and break apply+ledger atomicity (migration-runner contract;
-- lint:migrations, files >=215).

ALTER TABLE harness_shared.coord_presence
  ADD COLUMN IF NOT EXISTS intent_declared_at timestamptz;

-- Backfill existing rows so a pre-existing agent's first post-migration read
-- doesn't show an intent "declared" at epoch/null-derived-0s-ago; treat their
-- CURRENT intent as declared at last_active_at (best available signal), or
-- heartbeat_at if last_active_at is also unset.
UPDATE harness_shared.coord_presence
   SET intent_declared_at = COALESCE(last_active_at, heartbeat_at)
 WHERE intent_declared_at IS NULL;
