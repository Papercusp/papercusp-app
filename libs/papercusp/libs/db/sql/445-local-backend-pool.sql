-- 445-local-backend-pool.sql — the LOCAL inference-backend registry
-- (local-concurrent-inference-2026-07-02 P-004, D-002): a registry of local
-- LLM-serving backends (llama-server | vllm | ollama) the papercusp inference
-- gateway proxies to, mirroring the durable account-pool storage model so a
-- registered backend hot-reloads into the running gateway the same way a
-- registered Claude/Codex account does (gateway:reload).
--
-- One row per backend. `models` is the list of model ids this backend serves
-- (an OpenAI-compatible `/v1/chat/completions` request whose `model` matches
-- an entry routes to this backend). Health/in-flight are NOT persisted here —
-- they are live gateway-process state (local-backend-pool.ts); this table is
-- only the durable "what backends exist" registry.
--
-- Idempotent. Applied via the runner (db:migrate) so schema_migrations records it.

CREATE TABLE IF NOT EXISTS harness_shared.local_backends (
  id             text        PRIMARY KEY,
  workspace_id   text        NOT NULL,
  kind           text        NOT NULL CHECK (kind IN ('llama-server', 'vllm', 'ollama')),
  base_url       text        NOT NULL,
  models         jsonb       NOT NULL DEFAULT '[]'::jsonb,
  max_concurrent integer     NOT NULL DEFAULT 4 CHECK (max_concurrent > 0),
  enabled        boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS local_backends_workspace
  ON harness_shared.local_backends (workspace_id)
  WHERE enabled;
