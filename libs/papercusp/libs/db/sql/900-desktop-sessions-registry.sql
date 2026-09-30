-- Migration 900 — desktop_sessions: the cross-process DesktopSession inventory
-- (agent-virtual-desktops-2026-08-23 P-003 / WI-40829; decisions D-004/D-005/D-006).
--
-- WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT (D-004).
-- This table is a durable RECORD of desktop sessions. It is NOT a relocation of
-- live desktop state into Postgres. `desktop-lease.ts` and `display-allocator.ts`
-- each keep their in-process handles (the ChildProcess and the release() closure),
-- and each cites the storage policy's carve-out that a per-process resource lease
-- — a live child of THIS loop, which dies when the loop dies — is legitimately
-- non-PG. That reasoning is still correct and is preserved unchanged.
--
-- What the carve-out never covered is a cross-process, cross-machine INVENTORY:
-- which desktops exist, of what kind, owned by whom, at what geometry, with what
-- measured capabilities. Today `computer:list_desktops` can only enumerate one
-- process's Map, so a frame-slot display or a VM guest desktop is invisible to it.
-- That gap is what this table closes.
--
-- THE SPLIT, stated so a later reader does not re-merge it:
--   PG row      = identity, kind, scope, owner, geometry, viewer binding,
--                 lifecycle timestamps, measured host capability.
--   In-process  = the ChildProcess handles and the release() closure.
-- A row without a live handle in its owning process is DEAD. Operator start
-- reconciles (see `owner_pid` / `owner_boot_id` below). LIVENESS IS NEVER
-- INFERRED FROM THE ROW ALONE — a row is a claim about a process, not proof of it.
--
-- FORWARD-COMPAT: this migration is additive and creates a brand-new relation.
-- The currently-deployed release checkout serving :3070 contains no code path that
-- reads or writes harness_shared.desktop_sessions — the first such code ships with
-- this plan item — so the partial UNIQUE indexes below cannot conflict with live
-- writes. Nothing is dropped, renamed, or tightened on an existing relation.
--
-- Idempotent: IF NOT EXISTS everywhere; re-runnable. No top-level BEGIN/COMMIT —
-- the migration runner wraps each file in its own transaction.

CREATE TABLE IF NOT EXISTS harness_shared.desktop_sessions (
  id                 uuid PRIMARY KEY,
  workspace_id       text NOT NULL,
  harness_slug       text,

  -- The provisioning stack that owns this session. Kept OPEN (a text column with
  -- a CHECK, not a PG enum) precisely so P-010 (bwrap) and P-011 (microvm) can
  -- land their tiers without a schema migration.
  kind               text NOT NULL,

  -- D-005: scope is first-class so a pot-SHARED desktop and an agent-EXCLUSIVE
  -- one both survive the merge, and so D-002's BYOC workspace desktop has a
  -- representable identity instead of being mislabelled as an agent sandbox.
  --   'pot'       → scope_ref = the hive home-harness slug; several callers share it.
  --   'agent'     → scope_ref = the ownerId; exclusive, released when the child exits.
  --   'workspace' → the product's own desktop. NEVER handed to capability:computer
  --                 as a drivable target by default; its viewer binding is P-013's.
  scope              text NOT NULL,
  scope_ref          text NOT NULL,

  -- Which operator/frame/VM owns the live handle. NULL = the local process.
  host_ref           text,
  -- Reconciliation identity (D-004: "operator start reconciles"). owner_boot_id
  -- disambiguates a recycled pid — pids wrap ~daily on this box under fleet load,
  -- so pid alone would let a stale row alias a live unrelated process.
  owner_pid          integer,
  owner_boot_id      text,

  display            text NOT NULL,

  -- D-006: TWO geometries, never one.
  -- display_geometry — what the X server actually runs at; the human live view
  -- wants the real thing (1920x1080 on frames, 1024x768 for local sandboxes).
  display_width      integer NOT NULL,
  display_height     integer NOT NULL,
  display_depth      integer NOT NULL DEFAULT 24,
  -- capture_geometry — what the AGENT is served. Claude meters an image at about
  -- (w*h)/750 tokens, so 1920x1080 (~2,765) costs ~2.6x 1024x768 (~1,050) per
  -- observation, per step, compounding across a loop. Downscale happens AT
  -- CAPTURE; provider-side downscale costs the same tokens or loses accuracy.
  -- A lease may raise this deliberately; the default just stops paying 2.6x by
  -- accident. Only the capability:computer screenshot path reads it — the human
  -- viewer path keeps display_geometry.
  capture_width      integer NOT NULL,
  capture_height     integer NOT NULL,

  state              text NOT NULL DEFAULT 'provisioning',
  lease_holder       text,

  -- Ticketed viewer binding (P-013). The frame-vnc single-use ticket and its
  -- no-listener design are UNCHANGED by this table; this records the binding,
  -- it does not implement or replace it.
  viewer_mode        text NOT NULL DEFAULT 'none',
  viewer_actor       text,

  -- MEASURED at provision, never assumed: { gl, wayland, kvm, a11y }. This is
  -- what makes the microVM tier host-capability-GATED (D-001) rather than a
  -- universal assumption, and it is where P-002's measured GL ladder verdict
  -- lands rather than being re-probed by every consumer.
  capabilities       jsonb NOT NULL DEFAULT '{}'::jsonb,

  ttl_sec            integer,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_active_at     timestamptz NOT NULL DEFAULT now(),
  released_at        timestamptz,

  CONSTRAINT desktop_sessions_kind_ck
    CHECK (kind IN ('xvfb-local', 'frame-slot', 'vm-guest', 'bwrap', 'microvm')),
  CONSTRAINT desktop_sessions_scope_ck
    CHECK (scope IN ('pot', 'agent', 'workspace')),
  CONSTRAINT desktop_sessions_state_ck
    CHECK (state IN ('provisioning', 'ready', 'idle', 'frozen', 'released', 'dead')),
  CONSTRAINT desktop_sessions_viewer_mode_ck
    CHECK (viewer_mode IN ('none', 'watch', 'takeover')),
  -- A terminal row must carry its release time, and a live row must not: this is
  -- what stops a "released" row with a NULL released_at reading as fresh to the
  -- reaper, and a live row looking already-reclaimed.
  CONSTRAINT desktop_sessions_released_at_ck
    CHECK (
      (state IN ('released', 'dead') AND released_at IS NOT NULL)
      OR (state NOT IN ('released', 'dead') AND released_at IS NULL)
    ),
  CONSTRAINT desktop_sessions_geometry_ck
    CHECK (
      display_width > 0 AND display_height > 0
      AND capture_width > 0 AND capture_height > 0
      AND display_depth > 0
    )
);

COMMENT ON TABLE harness_shared.desktop_sessions IS
  'Cross-process inventory of agent desktop sessions (plan '
  'agent-virtual-desktops-2026-08-23, D-004). Holds the RECORD; the owning '
  'process holds the live handle. A row without a live handle in its owning '
  'process is DEAD — never infer liveness from the row alone.';

COMMENT ON COLUMN harness_shared.desktop_sessions.capabilities IS
  'Measured-at-provision host capabilities { gl, wayland, kvm, a11y }. MEASURED, '
  'never assumed — this is what gates the microVM tier per D-001.';

COMMENT ON COLUMN harness_shared.desktop_sessions.capture_width IS
  'Agent-facing capture geometry (D-006). Defaults to 1024x768 for every kind so '
  'a 1920x1080 display does not silently cost ~2.6x tokens per observation.';

-- ONE live session per (workspace, scope, scope_ref).
-- For scope='pot' this is what makes ensureHiveDesktop idempotent across
-- processes; for scope='agent' it is what stops two frame agents typing into
-- each other's session (D-005's exclusivity, enforced by the database rather
-- than by every caller remembering to check).
CREATE UNIQUE INDEX IF NOT EXISTS desktop_sessions_live_scope_uq
  ON harness_shared.desktop_sessions (workspace_id, scope, scope_ref)
  WHERE state NOT IN ('released', 'dead');

-- A display can back only one live session on a given host. NULL host_ref means
-- the local process, and Postgres treats NULLs as distinct in a unique index, so
-- COALESCE pins local rows into one comparable key rather than letting duplicate
-- local ':110' rows slip through.
CREATE UNIQUE INDEX IF NOT EXISTS desktop_sessions_live_display_uq
  ON harness_shared.desktop_sessions (COALESCE(host_ref, ''), display)
  WHERE state NOT IN ('released', 'dead');

-- The enumeration path (computer:list_desktops) and the reaper both read live
-- rows by tenant; the reconciler reads them by owning process.
CREATE INDEX IF NOT EXISTS desktop_sessions_live_idx
  ON harness_shared.desktop_sessions (workspace_id, harness_slug, state)
  WHERE state NOT IN ('released', 'dead');

CREATE INDEX IF NOT EXISTS desktop_sessions_owner_idx
  ON harness_shared.desktop_sessions (owner_boot_id, owner_pid)
  WHERE state NOT IN ('released', 'dead');

DO $mig900$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.tables
     WHERE table_schema = 'harness_shared'
       AND table_name = 'desktop_sessions'
  ) THEN
    RAISE EXCEPTION '900: post-condition failed — harness_shared.desktop_sessions was not created';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_indexes
     WHERE schemaname = 'harness_shared'
       AND indexname = 'desktop_sessions_live_scope_uq'
  ) THEN
    RAISE EXCEPTION '900: post-condition failed — the live-scope uniqueness index is missing';
  END IF;

  RAISE NOTICE '900: desktop_sessions registry installed';
END
$mig900$;
