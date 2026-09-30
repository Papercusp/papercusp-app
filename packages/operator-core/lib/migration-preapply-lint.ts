import {
  ENFORCED_FROM as MIGRATION_LINT_ENFORCED_FROM,
  EXCLUSIVE_LOCK_ENFORCED_FROM,
  INDEX_SWAP_ENFORCED_FROM,
  VIEW_DROP_ENFORCED_FROM,
  VIEW_LOCK_ORDER_ENFORCED_FROM,
  findLiteralTenantDefault,
  findRawTxControl,
  findUnacknowledgedExclusiveLock,
  findUnguardedConstraintRename,
  findUnguardedViewDrop,
  findUnguardedReslug,
  findViewLockOrderInversion,
  findUniqueIndexShapeSwap,
} from '../../../scripts/lint-migrations.mjs';
import {
  ACK_MARKER,
  isEnforcedMigrationFile,
  makeAncestorResolver,
  readForwardCompatSidecar,
  violationsFor,
} from '../../../scripts/check-migration-forward-compat.mjs';

function migrationNumber(filename: string): number {
  return Number.parseInt(/^(\d+)-/.exec(filename)?.[1] ?? '0', 10);
}

/**
 * Fail-closed, DB-free subset of the two migration gate lints.
 *
 * Boot apply is the last point at which a new migration is still editable. The
 * green checkpoint runs later, after the file may already be ledgered and thus
 * immutable, so every per-file safety rule must also run here before SQL reaches
 * Postgres. Cross-file/ledger checks remain in lint:migrations.
 */
export function assertMigrationPassesPreApplyLints(args: {
  filename: string;
  sqlText: string;
  sqlDir: string;
  isAncestorOfHead?: (sha: string) => boolean | null;
}): void {
  const { filename, sqlText, sqlDir } = args;
  const num = migrationNumber(filename);
  const failures: string[] = [];

  if (num >= MIGRATION_LINT_ENFORCED_FROM) {
    const tx = findRawTxControl(sqlText);
    if (tx.length > 0) failures.push(`top-level transaction control (${tx.join(', ')})`);

    const renames = findUnguardedConstraintRename(sqlText);
    if (renames.length > 0) failures.push(`bare RENAME CONSTRAINT (${renames.join(', ')})`);

    const defaults = findLiteralTenantDefault(sqlText);
    if (defaults.length > 0) {
      failures.push(
        `literal tenant-scoping DEFAULT (${defaults.map((hit: { column: string; value: string }) => `${hit.column}=${hit.value}`).join(', ')})`,
      );
    }

    const reslugs = findUnguardedReslug(sqlText);
    if (reslugs.length > 0) failures.push(`unguarded work_items harness re-slug (${reslugs.join(', ')})`);
  }

  if (num >= INDEX_SWAP_ENFORCED_FROM) {
    const swaps = findUniqueIndexShapeSwap(sqlText);
    if (swaps.length > 0) {
      failures.push(`same-migration unique-index shape swap (${swaps.map((hit: { index: string }) => hit.index).join(', ')})`);
    }
  }

  // This one matters MOST here rather than at the gate: the hazard is an ACCESS
  // EXCLUSIVE lock taken at APPLY time, and boot apply is exactly when the box is
  // busiest. Refusing here turns a fleet-wide read stall into a startup error
  // naming the offending statement (EI-21698566084995732).
  if (num >= EXCLUSIVE_LOCK_ENFORCED_FROM) {
    const locks = findUnacknowledgedExclusiveLock(sqlText);
    if (locks.length > 0) {
      failures.push(
        `ACCESS EXCLUSIVE lock with no -- EXCLUSIVE-LOCK: acknowledgement (${locks
          .map((hit: { table: string; action: string; target: string }) => `${hit.action} TRIGGER ${hit.target} on ${hit.table}`)
          .join(', ')})`,
      );
    }
  }

  if (num >= VIEW_DROP_ENFORCED_FROM) {
    const drops = findUnguardedViewDrop(sqlText);
    if (drops.length > 0) {
      failures.push(
        `unguarded view drop (${drops
          .map((hit: { view: string; dynamic: boolean; cascade: boolean }) =>
            `${hit.dynamic ? 'dynamic ' : ''}${hit.view}${hit.cascade ? ' CASCADE' : ''}`,
          )
          .join(', ')})`,
      );
    }
  }

  if (num >= VIEW_LOCK_ORDER_ENFORCED_FROM) {
    const inversions = findViewLockOrderInversion(sqlText);
    if (inversions.length > 0) {
      failures.push(
        `view lock-order inversion (${inversions
          .map((hit: { view: string; table: string; dynamic?: boolean }) =>
            hit.dynamic ? 'dynamic ALTER TABLE then CREATE OR REPLACE VIEW' : `${hit.view} over ${hit.table}`,
          )
          .join(', ')})`,
      );
    }
  }

  if (isEnforcedMigrationFile(filename)) {
    const forwardCompat = violationsFor(sqlText);
    if (forwardCompat.length > 0 && !ACK_MARKER.test(sqlText)) {
      const sidecar = readForwardCompatSidecar(sqlDir, filename, {
        migrationText: sqlText,
        isAncestorOfHead: args.isAncestorOfHead ?? makeAncestorResolver(),
      });
      if (!sidecar.honored) {
        failures.push(
          `destructive DDL without an accepted FORWARD-COMPAT acknowledgement (${forwardCompat
            .map((hit: { id: string }) => hit.id)
            .join(', ')}${sidecar.present ? `; sidecar rejected: ${sidecar.refusals.join('; ')}` : ''})`,
        );
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `[migration-preapply-lint] ${filename} fails migration gate safety checks; refusing to apply while the file is still editable: ${failures.join('; ')}`,
    );
  }
}
