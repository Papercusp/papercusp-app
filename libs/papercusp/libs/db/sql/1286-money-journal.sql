-- 1286-money-journal.sql — agent-economy-flywheel-2026-08-30 P-042 (WI-10004635, R-30)
--
-- Double-entry money journal. Every money movement is ONE entry whose lines
-- balance (debits = credits), every amount is a whole number of cents (bigint),
-- and every entry carries the external reference of its movement (a Stripe
-- balance-transaction id, a bank transaction id, or a chain tx hash) so P-043
-- can reconcile it. The rules live in packages/operator-core/lib/cupboard/
-- money-journal.ts; this schema repeats the ones that must hold even for a
-- writer that bypasses that module:
--   * entries and lines are append-only (UPDATE/DELETE refused by trigger);
--   * a DEFERRED constraint trigger checks at commit that every touched entry
--     has at least one debit and one credit and that they balance;
--   * amounts are bigint > 0, so a sub-cent amount cannot be stored.
--
-- Per-use micros (D-062) never enter the journal. They accrue in
-- money_journal_micro_accruals (one row per meter nonce, idempotent) and roll
-- up in money_journal_rollups, whose CHECK makes the R-30 identity a schema
-- fact: total_micros = settled_cents * 10000 + rounding_micros. A settlement
-- moves whole cents into the journal as one usage-settlement entry and leaves
-- the sub-cent residue in rounding_micros, in the same transaction.
--
-- Additive only; nothing deployed reads these tables yet.

CREATE TABLE IF NOT EXISTS harness_shared.money_journal_entries (
  workspace_id       text        NOT NULL,
  entry_id           text        NOT NULL CHECK (length(entry_id) BETWEEN 1 AND 256),
  posting_seq        bigint      GENERATED ALWAYS AS IDENTITY,
  occurred_at        timestamptz NOT NULL,
  currency           text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  movement           text        NOT NULL CHECK (movement IN (
                       'customer-payment', 'credit-purchase', 'refund', 'chargeback',
                       'provider-payment', 'dao-transfer', 'tax-remittance', 'usage-settlement')),
  external_ref_kind  text        NOT NULL CHECK (external_ref_kind IN (
                       'stripe-balance-transaction', 'bank-transaction', 'chain-tx')),
  external_ref       text        NOT NULL CHECK (length(external_ref) BETWEEN 1 AND 512),
  rollup_id          text        NULL CHECK (rollup_id IS NULL OR length(rollup_id) BETWEEN 1 AND 256),
  memo               text        NOT NULL DEFAULT '' CHECK (length(memo) <= 1000),
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, entry_id),
  UNIQUE (posting_seq),
  CHECK ((rollup_id IS NOT NULL) = (movement = 'usage-settlement'))
);

CREATE INDEX IF NOT EXISTS money_journal_entries_ref_idx
  ON harness_shared.money_journal_entries (workspace_id, external_ref_kind, external_ref);
CREATE INDEX IF NOT EXISTS money_journal_entries_rollup_idx
  ON harness_shared.money_journal_entries (workspace_id, rollup_id) WHERE rollup_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS harness_shared.money_journal_lines (
  workspace_id  text     NOT NULL,
  entry_id      text     NOT NULL,
  line_no       smallint NOT NULL CHECK (line_no >= 0),
  account       text     NOT NULL CHECK (account IN (
                  'operating', 'customer-credit-reserve', 'refund-chargeback-reserve',
                  'tax-reserve', 'dao-payable', 'revenue', 'provider-cost')),
  side          text     NOT NULL CHECK (side IN ('debit', 'credit')),
  cents         bigint   NOT NULL CHECK (cents > 0),
  PRIMARY KEY (workspace_id, entry_id, line_no),
  FOREIGN KEY (workspace_id, entry_id)
    REFERENCES harness_shared.money_journal_entries (workspace_id, entry_id)
);

CREATE TABLE IF NOT EXISTS harness_shared.money_journal_rollups (
  workspace_id     text        NOT NULL,
  rollup_id        text        NOT NULL CHECK (length(rollup_id) BETWEEN 1 AND 256),
  currency         text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  total_micros     bigint      NOT NULL DEFAULT 0 CHECK (total_micros >= 0),
  settled_cents    bigint      NOT NULL DEFAULT 0 CHECK (settled_cents >= 0),
  rounding_micros  bigint      NOT NULL DEFAULT 0 CHECK (rounding_micros >= 0),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, rollup_id),
  CONSTRAINT money_journal_rollups_identity
    CHECK (total_micros = settled_cents * 10000 + rounding_micros)
);

CREATE TABLE IF NOT EXISTS harness_shared.money_journal_micro_accruals (
  workspace_id  text        NOT NULL,
  rollup_id     text        NOT NULL,
  accrual_id    text        NOT NULL CHECK (length(accrual_id) BETWEEN 1 AND 256),
  micros        bigint      NOT NULL CHECK (micros > 0),
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, rollup_id, accrual_id),
  FOREIGN KEY (workspace_id, rollup_id)
    REFERENCES harness_shared.money_journal_rollups (workspace_id, rollup_id)
);

-- Append-only: entries, lines and accruals are history.
CREATE OR REPLACE FUNCTION harness_shared.reject_money_journal_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  RAISE EXCEPTION '% is append-only; % is forbidden', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END
$guard$;

DROP TRIGGER IF EXISTS money_journal_entries_append_only_trg ON harness_shared.money_journal_entries;
CREATE TRIGGER money_journal_entries_append_only_trg
  BEFORE UPDATE OR DELETE ON harness_shared.money_journal_entries
  FOR EACH ROW EXECUTE FUNCTION harness_shared.reject_money_journal_mutation();

DROP TRIGGER IF EXISTS money_journal_lines_append_only_trg ON harness_shared.money_journal_lines;
CREATE TRIGGER money_journal_lines_append_only_trg
  BEFORE UPDATE OR DELETE ON harness_shared.money_journal_lines
  FOR EACH ROW EXECUTE FUNCTION harness_shared.reject_money_journal_mutation();

DROP TRIGGER IF EXISTS money_journal_micro_accruals_append_only_trg ON harness_shared.money_journal_micro_accruals;
CREATE TRIGGER money_journal_micro_accruals_append_only_trg
  BEFORE UPDATE OR DELETE ON harness_shared.money_journal_micro_accruals
  FOR EACH ROW EXECUTE FUNCTION harness_shared.reject_money_journal_mutation();

-- Balance at commit: every entry an INSERT touched must have >= 1 debit,
-- >= 1 credit, and debits = credits. Deferred so an entry and its lines are
-- written in any order inside one transaction.
CREATE OR REPLACE FUNCTION harness_shared.check_money_journal_entry_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $balance$
DECLARE
  debit_total  numeric;
  credit_total numeric;
  debit_lines  integer;
  credit_lines integer;
BEGIN
  SELECT coalesce(sum(cents) FILTER (WHERE side = 'debit'), 0),
         coalesce(sum(cents) FILTER (WHERE side = 'credit'), 0),
         count(*) FILTER (WHERE side = 'debit'),
         count(*) FILTER (WHERE side = 'credit')
    INTO debit_total, credit_total, debit_lines, credit_lines
    FROM harness_shared.money_journal_lines
   WHERE workspace_id = NEW.workspace_id AND entry_id = NEW.entry_id;
  IF debit_lines = 0 OR credit_lines = 0 THEN
    RAISE EXCEPTION 'money journal entry % has no % line', NEW.entry_id,
      CASE WHEN debit_lines = 0 THEN 'debit' ELSE 'credit' END
      USING ERRCODE = '23514';
  END IF;
  IF debit_total <> credit_total THEN
    RAISE EXCEPTION 'money journal entry % is unbalanced: debits % <> credits %',
      NEW.entry_id, debit_total, credit_total
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$balance$;

DROP TRIGGER IF EXISTS money_journal_entries_balance_trg ON harness_shared.money_journal_entries;
CREATE CONSTRAINT TRIGGER money_journal_entries_balance_trg
  AFTER INSERT ON harness_shared.money_journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION harness_shared.check_money_journal_entry_balance();

DROP TRIGGER IF EXISTS money_journal_lines_balance_trg ON harness_shared.money_journal_lines;
CREATE CONSTRAINT TRIGGER money_journal_lines_balance_trg
  AFTER INSERT ON harness_shared.money_journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION harness_shared.check_money_journal_entry_balance();

DO $rls$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['money_journal_entries', 'money_journal_lines', 'money_journal_rollups', 'money_journal_micro_accruals']
  LOOP
    EXECUTE format('ALTER TABLE harness_shared.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON harness_shared.%I', tbl || '_workspace_isolation', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON harness_shared.%I FOR ALL TO public '
      'USING (workspace_id = current_setting(''app.workspace_id'', true)) '
      'WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))',
      tbl || '_workspace_isolation', tbl);
  END LOOP;
END
$rls$;

GRANT SELECT, INSERT ON harness_shared.money_journal_entries TO harness_app, harness_admin;
GRANT SELECT, INSERT ON harness_shared.money_journal_lines TO harness_app, harness_admin;
GRANT SELECT, INSERT ON harness_shared.money_journal_micro_accruals TO harness_app, harness_admin;
GRANT SELECT, INSERT, UPDATE ON harness_shared.money_journal_rollups TO harness_app, harness_admin;

COMMENT ON TABLE harness_shared.money_journal_entries IS
  'Append-only double-entry money journal (P-042, R-30): one balanced entry per money movement, each carrying its external reference. Rules: packages/operator-core/lib/cupboard/money-journal.ts.';
COMMENT ON TABLE harness_shared.money_journal_rollups IS
  'Per-use micros roll-ups, outside the journal (D-062). total_micros = settled_cents * 10000 + rounding_micros is a CHECK.';
