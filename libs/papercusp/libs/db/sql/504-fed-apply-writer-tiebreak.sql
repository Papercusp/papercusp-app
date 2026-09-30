-- 504-fed-apply-writer-tiebreak.sql
--
-- WI-2923: the LWW *SQL apply-guard* used a bare "fed_order_key(EXCLUDED...) >=
-- fed_order_key(local...)", which at an EQUAL order key (two writers completing
-- the same item in the same clock tick — a partition double-execution) applies
-- UNCONDITIONALLY. Two healed cells each apply the OTHER's value, the echo /
-- recapture suppression then stops further ops, and convergence reports a fixed
-- point while the replicas hold DIFFERENT values — a permanent, undetected
-- divergence (composition-chaos P-002: F-003 winner a/b swap).
--
-- fed_apply_wins(excluded_hlc, excluded_ts, excluded_writer, excluded_digest,
--                local_hlc,    local_ts,    local_writer,    local_digest)
--   → true when the incoming (EXCLUDED) op should overwrite the stored row:
--     1. its fed_order_key is strictly newer → apply; strictly older → reject;
--     2. EQUAL keys, BOTH writers known and DIFFERENT → the higher writer key
--        wins on every replica (value-independent, mirrors lwwPick's clock-tie
--        sourceLogKeyHex rule);
--     3. otherwise (a writer unknown, or same writer) → the higher CONTENT
--        DIGEST wins. Local rows carry author_pubkey NULL by design (mig 214
--        stamps fed_ts only), so a writer-only rule cannot converge: each cell
--        would see "attributed remote beats unattributed local", BOTH sides
--        apply, and the values swap. The digest compare is SYMMETRIC — cell A
--        compares digest(B-content) vs digest(A-content) while cell B compares
--        digest(A-content) vs digest(B-content) — so both settle on the SAME
--        content in one exchange. Equal digests = identical content: applying
--        is an idempotent no-op (>= keeps a writer's own echo harmless).
--
-- Callers pass a digest computed over the row's CONTENT columns only (never
-- fed_ts / fed_hlc / origin / author_pubkey / bookkeeping, which legitimately
-- differ between an op and its applied row).
--
-- Explicit two-level comparison (NOT string concatenation onto the order key):
-- fed_order_key outputs mix real-HLC and derived lpad(ts) encodings, so a
-- concatenated composite would only sort correctly if the encodings were
-- provably fixed-width; the CASE avoids that assumption entirely.
--
-- Pure + IMMUTABLE (same contract as 458's fed_order_key). Idempotent
-- (CREATE OR REPLACE); no table rewrite. The migration runner wraps this file
-- in its own transaction — no top-level BEGIN/COMMIT.

CREATE OR REPLACE FUNCTION harness_shared.fed_apply_wins(
  excluded_hlc text, excluded_ts bigint, excluded_writer text, excluded_digest text,
  local_hlc    text, local_ts    bigint, local_writer    text, local_digest    text
) RETURNS boolean LANGUAGE sql IMMUTABLE AS $fed_apply_wins$
  SELECT CASE
    WHEN harness_shared.fed_order_key(excluded_hlc, excluded_ts)
       > harness_shared.fed_order_key(local_hlc, local_ts) THEN true
    WHEN harness_shared.fed_order_key(excluded_hlc, excluded_ts)
       < harness_shared.fed_order_key(local_hlc, local_ts) THEN false
    WHEN excluded_writer IS NOT NULL AND local_writer IS NOT NULL
         AND excluded_writer <> local_writer THEN excluded_writer > local_writer
    ELSE COALESCE(excluded_digest, '') >= COALESCE(local_digest, '')
  END;
$fed_apply_wins$;
