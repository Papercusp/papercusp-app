# A carry-respawn/recycle rotates the native session id — every owner→native consumer must re-anchor (the WI-5075 kill loop)
URL: /internal/docs/agent-insights/carry-respawn-must-reanchor-native-session-id

>

## The signature (recognize it fast)

* Agents "suddenly have their session end and not continue" — repeatedly,
  every \~6–8 minutes for the same owners.
* `journalctl --user -u papercup-bg-host` shows `[compaction-watchdog]
  CARRY-RESPAWN queued for <owner>` firing for the SAME owner every
  `FORCE_RETRY_GRACE_MS` (\~6 min).
* The owner's transcript dir (`~/.papercusp/session-claude/<owner>/projects/...`)
  accumulates a new `<uuid>.jsonl` per firing.
* The running child's argv (`/proc/<ptyPid>/cmdline`) carries a `--session-id`
  that does NOT match `harness_shared.adv_sessions.session_id` for that
  `coord_owner_id`.
* Fresh successors "self-compact" minutes after boot: the stale estimate also
  feeds the per-turn context gauge, so a near-empty session is told it is at
  100%+ and dutifully burns a pointless `session:request-compaction`.

## Root cause (WI-5075, 2026-07-16)

P-018 (deterministic-context-carry-2026-07-14) cut over 2026-07-15 (D-014,
`GATEWAY_MAINTENANCE_CARRY` default ON): at a session's soft context threshold
the compaction-compliance watchdog asks the psu-pty host to **kill the settled
Claude child and respawn a successor** carrying the deterministic carry doc
(`recycleChild` → `mintCarryRespawnArgs`, fresh `--session-id`,
`DISABLE_AUTO_COMPACT=1`). Cold-loop RECYCLE takes the same path.

The host's `onRespawn(freshId)` only called `recordSessionOwner` — the
**file-based native→owner index** (`~/.papercusp/session-owners/<nativeId>`),
which answers "whose session is this?" but not "which session is this owner's?".
The **authoritative owner→native mapping** — `harness_shared.adv_sessions.session_id`,
what `resolveSessionRef` and therefore `estimateContextTokensForOwner` read —
was never updated. The estimate kept reading the dead predecessor's over-limit
transcript, so the watchdog saw a permanently-over owner and fired again after
every grace expiry. Each cut killed a healthy successor mid-work.

Note the two mappings are DIFFERENT indexes with different consumers; fixing
one does not fix the other. That asymmetry — plus the fact that
`recycleChild` only ledgered outcomes when a `drillId` was present, so watchdog
respawns left ZERO durable trace — is why the loop ran for two days invisibly.

## The fix (all five seams)

1. `packages/operator-core/lib/adv-sessions.ts` — `reanchorAdvSessionNativeId(id, sessionId)`:
   update `session_id` in place (same logical session), clear ended stamps,
   bump `started_at`.
2. `bootstrap-su.ts` — `POST /api/agent-mcp/console/bootstrap-su/session-respawned { advSessionId, sessionId }` (UUID-validated), sibling of session-ended/-resumed.
3. `apps/operator/scripts/psu-launcher.mjs` — `reportSessionRespawned` wired into
   `onRespawn` alongside `recordSessionOwner` (fires for BOTH carry-respawn and
   recycle).
4. `apps/operator/scripts/psu-pty-host.mjs` — non-drill respawns now ledger
   `respawned` / `respawn-failed` / `respawn-carry-delivered|dropped` rows
   (mode-tagged) in the per-owner events.jsonl.
5. Watchdog kill-loop breaker (`compaction-compliance-watchdog.ts`): ≥3
   carry-respawns for one owner with the estimate never recovering ⇒ STOP
   cutting (force rung too), raise ONE blocker escalation naming this class.
   Recovery below the limit re-arms everything.

## Deployment shape (matters for recurrence)

* The watchdog runs in **papercup-bg-host**, which executes `tsx` from the
  STAGING tree — a service restart picks up watchdog fixes immediately.
* The `psu` shim execs the STAGING tree's `psu-launcher.mjs` — NEW sessions get
  the launcher fix at next launch. **Already-running psu hosts keep the OLD
  launcher/host code in memory** and still strand their rows on respawn until
  they naturally end — the breaker exists precisely to contain them.
* The `session-respawned` ENDPOINT is served by the release operator (`:3070`),
  so it goes live via the normal commit→green→deploy pipeline; until then a
  new launcher's POST 404s harmlessly (best-effort contract).

## If you see the signature again

1. Confirm the mismatch: child argv `--session-id` vs
   `SELECT session_id FROM harness_shared.adv_sessions WHERE coord_owner_id = ...`.
2. Heal the live row(s): `UPDATE harness_shared.adv_sessions SET session_id =
   '<live native id>', ended_at = NULL, exit_code = NULL WHERE id = <adv id>`.
3. Check whether the respawn report path broke again (launcher `onRespawn` →
   `session-respawned` endpoint → `reanchorAdvSessionNativeId`), and whether
   the owner's host predates the fix.
4. The breaker escalation ("carry-respawn LOOP on ...") is the intended alarm —
   if it fired, the tracking half is broken; do NOT just clear it and let the
   loop resume.

Related: `deterministic-context-carry-2026-07-14` (P-017/P-018/P-020),
WI-3532 (why deterministic carry replaced the LLM summarizer),
EI-12655/EI-12754 (drill-side silent-vanish fixes this generalized).
