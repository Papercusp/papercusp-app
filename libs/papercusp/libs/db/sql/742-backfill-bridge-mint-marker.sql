-- 742 — backfill payload._bridge onto pre-marker condition-bridge incident items.
--
-- EI-19395923444306887. Migration 741 gave the bridge a `condition_key` column;
-- the bridge minted one incident work-item per open condition and, on resolve,
-- settled WHATEVER row held the key. That is destructive for a hand-filed
-- ROOT-CAUSE bug that merely holds the same key: a condition clearing is not the
-- same event as the bug being fixed, so a transient recovery could auto-close a
-- documented finding on the reconciler's 5-minute cadence.
--
-- The fix stamps bridge-MINTED items with `payload._bridge` and settles only
-- stamped rows (condition-bridge.ts, BRIDGE_MINT_MARKER). That leaves one gap:
-- items minted by the PRE-marker code are genuinely bridge-minted but carry no
-- stamp, so the new gate would refuse to settle them — re-introducing the exact
-- work-item leak D-011 fixed (one permanently-open item per condition episode,
-- worst on a flapper like main-behind-staging:papercusp, 40 alarms on 2026-08-02).
--
-- WHY THIS BACKFILL IS SOUND, AND WHY IT MUST RUN NOW RATHER THAN LATER:
-- it rests on the invariant that NOTHING except the bridge has ever written
-- `condition_key`. That is true as of this migration — the column shipped in 741
-- and only `claimConditionKey()` writes it — so every current holder is
-- bridge-minted by construction. The invariant is exactly what
-- EI-19395923444306887 warns will be broken by the first person who hand-backfills
-- a condition_key onto a root-cause bug. So this is a one-shot window: once such a
-- row exists, no query can separate the two populations retroactively. Running it
-- in the same deploy that ships the marker closes the window for good.
--
-- Idempotent: only touches rows that lack the marker; re-running is a no-op.
-- Deliberately NOT scoped to a workspace or harness — the invariant above is
-- global, and a missed row is a silent permanent leak.

UPDATE harness_shared.work_items
   SET payload = COALESCE(payload, '{}'::jsonb)
               || jsonb_build_object(
                    '_bridge',
                    jsonb_build_object(
                      'conditionKey', condition_key,
                      'mintedAt', to_char(
                        to_timestamp(created_ts / 1000.0) AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                      ),
                      'backfilledBy', '742-backfill-bridge-mint-marker'
                    )
                  )
 WHERE condition_key IS NOT NULL
   AND (payload -> '_bridge') IS NULL;
