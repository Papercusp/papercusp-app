/**
 * Shared readiness-trigger fixture helpers for dependency integration rigs.
 *
 * The trigger DDL is extracted from the shipped migrations at module load rather
 * than copied into each test. A migration rename or trigger rewrite therefore
 * fails the rig loudly instead of leaving it green against stale hand-written SQL.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');

export function migrationText(file: string): string {
  return readFileSync(resolve(SQL_DIR, file), 'utf8');
}

/** Pull a named trigger's DROP/CREATE pair from the real migration bytes. */
export function extractTriggerDdl(sqlText: string, triggerName: string): string {
  const drop = new RegExp(`DROP\\s+TRIGGER[^;]*\\b${triggerName}\\b[^;]*;`, 'i').exec(sqlText);
  const create = new RegExp(`CREATE\\s+TRIGGER\\s+${triggerName}\\b[\\s\\S]*?;`, 'i').exec(sqlText);
  if (!create) {
    throw new Error(
      `dependency-trigger-fixture: could not find 'CREATE TRIGGER ${triggerName}' in the migration text. ` +
        'The rig extracts this statement from the SHIPPED migration on purpose — if the trigger ' +
        'was renamed or restructured, update this extractor rather than pasting DDL into a test.',
    );
  }
  return `${drop ? drop[0] : ''}\n${create[0]}`;
}

export const TRIGGER = 'wir_status_sync_dependents_trg';

/** The production widened trigger from migration 640. */
export const WIDE_TRIGGER_DDL = extractTriggerDdl(migrationText('640-unify-workitem-readiness-triggers.sql'), TRIGGER);

/** The pre-640 narrow trigger, used only by the soak's negative control. */
export const NARROW_TRIGGER_DDL = extractTriggerDdl(migrationText('379-maintained-ready-column.sql'), TRIGGER);
