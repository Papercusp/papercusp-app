-- 1307 — Sealed content written by a session that holds a restricted
-- Personal Vault disclosure.
--
-- Plan personal-data-reader-set-labels-2026-10-01 P-006 (WI-10004933), D-006.
-- A shared store is not a directed channel: coord:feed returns every agent's
-- messages and coord:read fetches any message by id. So while the writer holds
-- an active disclosure, the shared row keeps only a stub and the content moves
-- here, together with a SNAPSHOT of the writer's active labels. Opening a row
-- records those labels on the opener (personal_disclosures) in the same
-- transaction that returns the content, so the reader inherits the same
-- recipient bound as the writer.
--
--   store            — which shared store the stub lives in ('coord' first;
--                      work-item comments, facts and memory follow in P-012).
--   ref              — the stub's key inside that store (a coord msg_id).
--   writer_owner_id  — the agent identity that wrote it.
--   content          — the authored fields the stub omits.
--   labels           — [{ userId, documentId, source, level, readerSet }] as
--                      they stood at write time. A later release of the
--                      writer's own label does not unseal what it wrote.
--
-- Expand-only and idempotent: a new table that the deployed release neither
-- reads nor writes. Workspace RLS and grants mirror 1303.

CREATE TABLE IF NOT EXISTS harness_shared.personal_sealed_contents (
  id              uuid        NOT NULL DEFAULT gen_random_uuid(),
  workspace_id    text        NOT NULL,
  store           text        NOT NULL CHECK (length(btrim(store)) > 0),
  ref             text        NOT NULL CHECK (length(btrim(ref)) > 0),
  writer_owner_id text        NOT NULL CHECK (length(btrim(writer_owner_id)) > 0),
  content         jsonb       NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  labels          jsonb       NOT NULL CHECK (jsonb_typeof(labels) = 'array' AND jsonb_array_length(labels) > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, store, ref)
);

ALTER TABLE harness_shared.personal_sealed_contents ENABLE ROW LEVEL SECURITY;

DO $personal_sealed_policy$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'harness_shared'
       AND tablename = 'personal_sealed_contents'
       AND policyname = 'personal_sealed_contents_workspace_isolation'
  ) THEN
    CREATE POLICY personal_sealed_contents_workspace_isolation
      ON harness_shared.personal_sealed_contents FOR ALL TO public
      USING (workspace_id = current_setting('app.workspace_id', true))
      WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
  END IF;
END
$personal_sealed_policy$;

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.personal_sealed_contents TO harness_app, harness_admin;

COMMENT ON TABLE harness_shared.personal_sealed_contents IS
  'Content a session wrote to a shared store (coord messages first) while it held a restricted Personal Vault disclosure. The shared row keeps a stub; opening this row records its label snapshot on the opener (D-006).';
