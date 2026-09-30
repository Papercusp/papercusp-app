-- 902-hosted-session-webhook-receipts.sql — WI-40854 / P-078.
--
-- Hosted browser sessions and verified identity-provider events need durable,
-- revocable state before their application stores and HTTP workers are wired.
-- This migration is deliberately standalone: the parallel identity,
-- organization, and workspace-directory migrations own their tables, so this
-- leaf records stable text references without introducing cross-lane DDL
-- ordering. The integration/RLS migrations add the tenant graph boundaries.

CREATE SCHEMA IF NOT EXISTS papercusp_auth;

CREATE TABLE IF NOT EXISTS papercusp_auth.hosted_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  workspace_id TEXT,
  permission_version BIGINT NOT NULL DEFAULT 0
    CHECK (permission_version >= 0),
  upstream_provider TEXT NOT NULL,
  upstream_session_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revocation_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT hosted_sessions_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT hosted_sessions_user_nonempty CHECK (btrim(user_id) <> ''),
  CONSTRAINT hosted_sessions_organization_nonempty CHECK (btrim(organization_id) <> ''),
  CONSTRAINT hosted_sessions_workspace_nonempty
    CHECK (workspace_id IS NULL OR btrim(workspace_id) <> ''),
  CONSTRAINT hosted_sessions_provider_nonempty CHECK (btrim(upstream_provider) <> ''),
  CONSTRAINT hosted_sessions_upstream_id_nonempty CHECK (btrim(upstream_session_id) <> ''),
  CONSTRAINT hosted_sessions_expiry_after_create CHECK (expires_at > created_at),
  CONSTRAINT hosted_sessions_rotation_after_create
    CHECK (rotated_at IS NULL OR rotated_at >= created_at),
  CONSTRAINT hosted_sessions_last_seen_after_create
    CHECK (last_seen_at IS NULL OR last_seen_at >= created_at),
  CONSTRAINT hosted_sessions_revocation_after_create
    CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CONSTRAINT hosted_sessions_revocation_reason_nonempty
    CHECK (revocation_reason IS NULL OR btrim(revocation_reason) <> ''),
  CONSTRAINT hosted_sessions_upstream_session_key
    UNIQUE (upstream_provider, upstream_session_id)
);

CREATE INDEX IF NOT EXISTS hosted_sessions_user_active_idx
  ON papercusp_auth.hosted_sessions (user_id, expires_at, id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS hosted_sessions_organization_active_idx
  ON papercusp_auth.hosted_sessions (organization_id, expires_at, id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS hosted_sessions_workspace_active_idx
  ON papercusp_auth.hosted_sessions (workspace_id, expires_at, id)
  WHERE revoked_at IS NULL AND workspace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS hosted_sessions_expiry_idx
  ON papercusp_auth.hosted_sessions (expires_at, id)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE papercusp_auth.hosted_sessions IS
  'Revocable Papercusp hosted-session metadata. The provider/session reference is non-secret; no password, MFA secret, access token, or wildcard capability is stored here.';

COMMENT ON COLUMN papercusp_auth.hosted_sessions.permission_version IS
  'Authorization snapshot version checked against current membership/grant state before a hosted request is admitted.';

CREATE TABLE IF NOT EXISTS papercusp_auth.webhook_event_receipts (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  provider_account_id TEXT,
  subject_ref TEXT,
  event_version TEXT,
  event_created_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_sha256 TEXT NOT NULL,
  signature_key_ref TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processing_started_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'applied', 'ignored', 'dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_attempt_at TIMESTAMPTZ,
  last_error_code TEXT,
  retention_until TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (provider, event_id),
  CONSTRAINT webhook_event_receipts_provider_nonempty CHECK (btrim(provider) <> ''),
  CONSTRAINT webhook_event_receipts_event_id_nonempty CHECK (btrim(event_id) <> ''),
  CONSTRAINT webhook_event_receipts_event_type_nonempty CHECK (btrim(event_type) <> ''),
  CONSTRAINT webhook_event_receipts_subject_nonempty
    CHECK (subject_ref IS NULL OR btrim(subject_ref) <> ''),
  CONSTRAINT webhook_event_receipts_version_nonempty
    CHECK (event_version IS NULL OR btrim(event_version) <> ''),
  CONSTRAINT webhook_event_receipts_payload_digest
    CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT webhook_event_receipts_verified_after_receive
    CHECK (verified_at >= received_at),
  CONSTRAINT webhook_event_receipts_enqueued_after_verify
    CHECK (enqueued_at >= verified_at),
  CONSTRAINT webhook_event_receipts_processing_after_enqueue
    CHECK (processing_started_at IS NULL OR processing_started_at >= enqueued_at),
  CONSTRAINT webhook_event_receipts_processed_after_enqueue
    CHECK (processed_at IS NULL OR processed_at >= enqueued_at),
  CONSTRAINT webhook_event_receipts_attempt_after_enqueue
    CHECK (last_attempt_at IS NULL OR last_attempt_at >= enqueued_at),
  CONSTRAINT webhook_event_receipts_retention_after_receive
    CHECK (retention_until > received_at),
  CONSTRAINT webhook_event_receipts_terminal_timestamp
    CHECK (
      (status IN ('applied', 'ignored', 'dead_letter') AND processed_at IS NOT NULL)
      OR (status IN ('queued', 'processing') AND processed_at IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS webhook_event_receipts_queue_idx
  ON papercusp_auth.webhook_event_receipts (enqueued_at, provider, event_id)
  WHERE status IN ('queued', 'processing');

CREATE INDEX IF NOT EXISTS webhook_event_receipts_subject_version_idx
  ON papercusp_auth.webhook_event_receipts
    (provider, subject_ref, event_created_at DESC, event_id)
  WHERE subject_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS webhook_event_receipts_retention_idx
  ON papercusp_auth.webhook_event_receipts (retention_until, provider, event_id)
  WHERE status IN ('applied', 'ignored', 'dead_letter');

COMMENT ON TABLE papercusp_auth.webhook_event_receipts IS
  'Verified signed-event receipt and durable intake queue. Provider/event id is the dedupe key; event_created_at plus event_version support stale/out-of-order rejection; retention_until permits bounded payload retention without scanning live queue rows.';

COMMENT ON COLUMN papercusp_auth.webhook_event_receipts.signature_key_ref IS
  'Non-secret identifier of the signing-key version used for verification; never the webhook secret or signature header.';
