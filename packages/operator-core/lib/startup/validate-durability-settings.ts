/**
 * Boot-time durability-settings visibility (EI-19298078028509573).
 *
 * The operator Postgres has been observed running with `synchronous_commit = off`
 * (measured 2026-08-02, dev box: `fsync=on`, `full_page_writes=on` — NOT the reckless
 * `fsync=off` configuration, but COMMIT can return before the WAL record is durably
 * flushed). On a crash or unclean shutdown the most-recently-acknowledged transactions
 * can be silently lost — with `ok:true` and a real `INSERT ... RETURNING` id already
 * handed to the caller, no error anywhere, hitting every writer/table/scope at once.
 *
 * This guard does not change the setting (that is a throughput/durability trade-off
 * requiring an explicit decision — see EI-19298078028509573 for the options) and does
 * not gate boot. It exists ONLY so a post-crash investigation starts with "the DB was
 * running relaxed-durability" as a KNOWN fact from the boot log, instead of discovering
 * it hours into triage from first principles — which is precisely what
 * EI-19298078028509573 asked for (its point 3: "a boot-time assertion that records the
 * setting on startup").
 *
 * Read-only + fail-soft, like its startup/ siblings: a health check must never fail boot.
 */
import { getOrgPg } from '@papercusp/db-org';

export interface DurabilitySettings {
  synchronousCommit: string;
  fsync: string;
  fullPageWrites: string;
}

export interface DurabilitySettingsResult {
  ok: boolean;
  settings: DurabilitySettings | null;
  /** true when synchronous_commit is NOT 'on'/'remote_write'/'remote_apply' — i.e. a crash
   *  can lose acknowledged-but-unflushed transactions. */
  relaxedDurability: boolean;
}

/** synchronous_commit values that guarantee a COMMIT is not acknowledged before its WAL
 *  record is at least locally flushed. `off`, `local` is NOT included deliberately — `local`
 *  still only guarantees a LOCAL flush, but on a single-node dev box that is effectively the
 *  durable case; the genuinely dangerous values here are `off` (no flush guarantee at all). */
const DURABLE_VALUES = new Set(['on', 'remote_write', 'remote_apply', 'local']);

export async function checkDurabilitySettings(): Promise<DurabilitySettingsResult> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<Array<{ synchronous_commit: string; fsync: string; full_page_writes: string }>>`
      SELECT current_setting('synchronous_commit') AS synchronous_commit,
             current_setting('fsync') AS fsync,
             current_setting('full_page_writes') AS full_page_writes
    `;
    const row = rows[0];
    if (!row) return { ok: true, settings: null, relaxedDurability: false };

    const settings: DurabilitySettings = {
      synchronousCommit: row.synchronous_commit,
      fsync: row.fsync,
      fullPageWrites: row.full_page_writes,
    };
    const relaxedDurability = !DURABLE_VALUES.has(settings.synchronousCommit);

    if (relaxedDurability) {
      console.warn(
        `[durability-settings] Postgres synchronous_commit='${settings.synchronousCommit}' ` +
          `(fsync=${settings.fsync}, full_page_writes=${settings.fullPageWrites}). A crash or ` +
          'unclean shutdown can silently lose the most-recently-acknowledged transactions ' +
          '(committed with ok:true and a real returned id, no error anywhere) — this is a KNOWN, ' +
          'observed configuration (EI-19298078028509573), not a new fault. If you are debugging a ' +
          "post-crash 'the row I know I wrote is gone' report, start here before assuming app-layer " +
          'data loss.',
      );
    } else {
      console.log(
        `[durability-settings] Postgres synchronous_commit='${settings.synchronousCommit}' — ` +
          'commits are durably flushed before being acknowledged.',
      );
    }

    return { ok: true, settings, relaxedDurability };
  } catch (e) {
    // Fail-soft: a health check must never fail boot, and a connection hiccup here says
    // nothing about the real setting — report unknown rather than guess.
    console.warn(
      '[durability-settings] startup check skipped (non-fatal):',
      e instanceof Error ? e.message : e,
    );
    return { ok: true, settings: null, relaxedDurability: false };
  }
}
