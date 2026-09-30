-- 1027 — desktop_sessions: admit the 'kasmvnc' kind (plan agent-virtual-desktops-2026-08-23, P-012 / D-020 / D-022).
--
-- D-020 makes KasmVNC BOTH the viewer transport and the sandbox's display server: an
-- `Xkasmvnc` process replaces the `Xvfb` process at the root of the desktop. Everything
-- above it is unchanged (openbox, the D-010 a11y bus, the D-015/D-016 bwrap plan) because
-- D-021 keeps the whole driver layer X-bound.
--
-- WHY A NEW KIND RATHER THAN REUSING 'xvfb-local' (D-007: the registry row is the
-- AUTHORIZATION, so it has to be true). Three things differ in ways a reader ACTS on:
--   1. There is a listener. An 'xvfb-local' row promises `-nolisten tcp` and no socket at
--      all; a KasmVNC row has a loopback-bound websocket that P-013's ticket proxy dials.
--      Labelling it 'xvfb-local' would tell the viewer lane there is nothing to connect to.
--   2. Teardown and freeze reach a different process tree, and the per-kind lifecycle
--      thresholds below are chosen for a server that a human may be WATCHING (D-008 rule 3).
--   3. Capability provenance: a `-hw3d`/DRI3 rung exists only here, so a GL record read off
--      a 'kasmvnc' row is answering a different question than one read off a bare Xvfb.
--
-- FORWARD-COMPAT: this only WIDENS the allowed set — the old CHECK's five values all remain
-- legal and no row changes. The currently-deployed release cannot write 'kasmvnc' because
-- its DesktopKind union does not contain it (the value ships in the same change as this
-- migration), so the live :3070 checkout keeps inserting exactly the values it always did
-- and is unaffected by the wider constraint. The DROP+ADD pair is the only way Postgres
-- expresses a CHECK amendment; it is expand-only, and the contract step (should 'kasmvnc'
-- ever be retired) would be a separate later migration.

ALTER TABLE harness_shared.desktop_sessions
  DROP CONSTRAINT IF EXISTS desktop_sessions_kind_ck;

ALTER TABLE harness_shared.desktop_sessions
  ADD CONSTRAINT desktop_sessions_kind_ck
    CHECK (kind IN ('xvfb-local', 'frame-slot', 'vm-guest', 'bwrap', 'microvm', 'kasmvnc'));

COMMENT ON CONSTRAINT desktop_sessions_kind_ck ON harness_shared.desktop_sessions IS
  'Closed set of desktop kinds. Widened by 1027 to admit ''kasmvnc'' (P-012/D-020): a sandbox '
  'desktop whose X server IS the KasmVNC server, reached over a loopback-bound websocket by '
  'P-013''s ticket-gated proxy. Kept closed on purpose — a kind the lifecycle governor has no '
  'policy for is a desktop nothing reaps, so DESKTOP_LIFECYCLE_POLICY and this constraint are '
  'amended together (the TypeScript Record over DesktopKind fails to compile otherwise).';
