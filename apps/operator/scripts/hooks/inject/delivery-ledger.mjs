/**
 * DELIVERY LEDGER — the hook half of ACK-ON-PROOF for turn-start orientation.
 *
 * Plan: owner-directive-delivery-redesign-2026-09-22, P-005 (D-005). The server
 * half lives in packages/operator-core/lib/agent-tools/coordination/read-cursors.ts.
 *
 * WHY THE HOOK MUST PROVE EMISSION. The operator stages what it delivered and,
 * without proof, treats the NEXT request's arrival as the ack. Arrival only proves
 * the hook ran again. A hook killed after the server staged — this port's own
 * 2.5s wall, the client's hook timeout, a crash between receiving and printing —
 * still arrives next turn, so the block it never printed was acked and never
 * re-sent. With the ledger, the server hands back a `deliveryToken`; this module
 * records it ONLY after the payload has been written to stdout, and the next
 * request echoes it as `confirmedDelivery`. No record ⇒ no promotion ⇒ the
 * operator re-diffs from the last proven floor and re-delivers.
 *
 * One file per session under `<PAPERCUSP_HOME or ~/.papercusp>/state/turn-start-delivery/`.
 * The hook is a fresh process every turn, so the token has to outlive it.
 *
 * FAIL-SILENT, like everything in this directory: every IO failure is swallowed.
 * If the directory cannot be made writable the ledger is not opened at all and the
 * request goes out WITHOUT `confirmedDelivery`, keeping the server on
 * ack-on-arrival. That is deliberate: a ledger that can read but never record
 * would prove nothing on every turn, and the operator would re-deliver the whole
 * block forever.
 */

import { accessSync, constants, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * @typedef {object} DeliveryLedger
 * @property {() => string | null} confirmed  the token this session last proved it emitted
 * @property {(token: unknown) => void} offer  remember the token the operator just returned
 * @property {() => boolean} commit           record the offered token; call ONLY after emitting
 */

/**
 * Where the ledger lives. PAPERCUSP_HOME is an isolation pin (see
 * hooks/omp/inject-hook.ts `papercuspHomeDir`), so it is exclusive, not a fallback.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function ledgerDir(env = process.env) {
  return join(env.PAPERCUSP_HOME || join(homedir(), '.papercusp'), 'state', 'turn-start-delivery');
}

/**
 * Open the ledger for one session, or null when it cannot be written.
 * @param {string | null | undefined} owner  PAPERCUSP_SID
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {DeliveryLedger | null}
 */
export function openDeliveryLedger(owner, env = process.env) {
  if (typeof owner !== 'string' || !owner) return null;
  const dir = ledgerDir(env);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    accessSync(dir, constants.W_OK);
  } catch {
    return null;
  }
  // Session ids are `su-<uuid>`; anything else is flattened so it cannot name a
  // path outside the ledger directory.
  const file = join(dir, `${owner.replace(/[^A-Za-z0-9._-]/g, '_')}.token`);
  /** @type {string | null} */
  let offered = null;
  return {
    confirmed() {
      try {
        const token = readFileSync(file, 'utf8').trim();
        return token || null;
      } catch {
        return null;
      }
    },
    offer(token) {
      offered = typeof token === 'string' && token ? token : null;
    },
    commit() {
      if (!offered) return false;
      // Write-then-rename so a hook killed mid-write leaves the previous token
      // intact rather than a truncated one that matches nothing.
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        writeFileSync(tmp, offered, { mode: 0o600 });
        renameSync(tmp, file);
        return true;
      } catch {
        return false;
      }
    },
  };
}
