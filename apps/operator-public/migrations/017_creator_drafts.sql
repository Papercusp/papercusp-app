-- Creator draft lifecycle for authenticated Cupboard artifact publishing (P-007).
-- Drafts keep the upload capability and review state separate from the public
-- listing row. The artifact itself is immutable and addressed by its SHA-256
-- key in the existing ARTIFACTS bucket.

CREATE TABLE IF NOT EXISTS creator_drafts (
  id TEXT PRIMARY KEY NOT NULL,
  owner_github_user_id INTEGER NOT NULL,
  owner_github_login TEXT NOT NULL,
  listing_kind TEXT NOT NULL,
  listing_ref TEXT,
  title TEXT NOT NULL,
  description TEXT,
  manifest_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft',
  artifact_key TEXT,
  artifact_content_hash TEXT,
  artifact_size_bytes INTEGER,
  artifact_content_type TEXT,
  upload_token_hash TEXT,
  upload_expires_at INTEGER,
  reviewed_at INTEGER,
  reviewed_by_github_user_id INTEGER,
  review_reason TEXT,
  published_listing_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (state IN ('draft', 'submitted', 'approved', 'rejected', 'published', 'yanked', 'revoked'))
);

CREATE INDEX IF NOT EXISTS creator_drafts_owner_idx
  ON creator_drafts (owner_github_user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS creator_drafts_review_idx
  ON creator_drafts (state, created_at ASC);
