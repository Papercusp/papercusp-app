#!/usr/bin/env bash
#
# apply-058-transport.sh — apply migration 058 (transport column on
# tool_invocations) to a live papercusp database with safety checks.
#
# WHY THIS SCRIPT EXISTS:
#   - The 058 migration is additive + nullable + idempotent
#     (IF NOT EXISTS) so it's safe to apply against a running system.
#   - But tool_invocations is the busiest write target in the
#     operator. Even a 100ms ACCESS EXCLUSIVE lock for ALTER TABLE
#     could block live inserts. This script wraps the migration in
#     a transaction with `lock_timeout` + `statement_timeout` so a
#     wedge fails fast instead of blocking forever.
#   - Verifies the column shape after apply so silent failures show
#     up immediately.
#
# USAGE:
#   ./scripts/apply-058-transport.sh                  # uses HARNESS_ADMIN_DATABASE_URL
#   HARNESS_ADMIN_DATABASE_URL=postgres://... ./scripts/apply-058-transport.sh
#   DRY_RUN=1 ./scripts/apply-058-transport.sh        # prints SQL without running
#
# EXIT CODES:
#   0 — migration applied + verified, or already present (idempotent)
#   1 — DB connection failed
#   2 — migration ran but verification didn't see the column
#   3 — DRY_RUN: SQL printed, nothing executed
#
# ROLLBACK:
#   The migration is additive. To revert, run:
#     ALTER TABLE harness_shared.tool_invocations DROP COLUMN transport;
#   (Loses any per-row transport data already written. Pre-fold-in rows
#    are NULL anyway, so rollback is cheap if done before code merges
#    that start populating the column.)

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SQL_FILE="$ROOT/sql/058-tool-invocations-transport.sql"

if [[ ! -f "$SQL_FILE" ]]; then
  echo "ERROR: $SQL_FILE not found"
  exit 1
fi

URL="${HARNESS_ADMIN_DATABASE_URL:-${DATABASE_URL:-postgres://harness_admin:harness_admin_pwd@localhost:5432/papercusp}}"

echo "==> target database: $URL"

# 1. Check the column doesn't already exist (early exit if it does).
PRE_CHECK_SQL="$(cat <<'SQL'
SELECT count(*)::int FROM information_schema.columns
 WHERE table_schema = 'harness_shared'
   AND table_name   = 'tool_invocations'
   AND column_name  = 'transport';
SQL
)"

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo "==> [DRY_RUN] would run pre-check:"
  echo "$PRE_CHECK_SQL"
  echo ""
  echo "==> [DRY_RUN] would run migration:"
  cat "$SQL_FILE"
  echo ""
  echo "==> [DRY_RUN] would run post-check (column type + nullability)"
  exit 3
fi

EXISTING_COUNT="$(psql "$URL" -Atc "$PRE_CHECK_SQL" 2>&1)"
if [[ $? -ne 0 ]]; then
  echo "ERROR: pre-check failed (cannot reach DB?): $EXISTING_COUNT"
  exit 1
fi

if [[ "$EXISTING_COUNT" == "1" ]]; then
  echo "==> column already present — migration is idempotent, nothing to do."
  exit 0
fi

# 2. Apply with bounded lock + statement timeouts. ALTER TABLE on a hot
#    table needs ACCESS EXCLUSIVE briefly; if another long txn holds a
#    conflicting lock, fail fast instead of queueing.
echo "==> applying migration (lock_timeout=2s, statement_timeout=10s)..."

WRAPPED_SQL="$(cat <<SQL
SET lock_timeout = '2s';
SET statement_timeout = '10s';

BEGIN;
$(cat "$SQL_FILE")
COMMIT;
SQL
)"

if ! psql "$URL" -v ON_ERROR_STOP=1 <<< "$WRAPPED_SQL"; then
  echo "ERROR: migration failed. Common causes:"
  echo "   - Another transaction holds a conflicting lock; retry in a few seconds."
  echo "   - Operator isn't reachable as harness_admin; check URL credentials."
  exit 1
fi

# 3. Verify the column landed with the expected shape.
echo "==> verifying column..."
SHAPE="$(psql "$URL" -Atc "
  SELECT data_type || '|' || is_nullable
    FROM information_schema.columns
   WHERE table_schema = 'harness_shared'
     AND table_name   = 'tool_invocations'
     AND column_name  = 'transport';
" 2>&1)"

if [[ "$SHAPE" != "text|YES" ]]; then
  echo "ERROR: post-apply verification failed. Expected 'text|YES', got: $SHAPE"
  exit 2
fi

echo "==> done. Column 'transport' exists, type=text, nullable. Operator code"
echo "    on the sse-typed-events branch will populate it once merged."
