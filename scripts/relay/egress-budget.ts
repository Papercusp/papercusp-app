/**
 * Monthly egress budget for the Papercusp-run blind-relay VM (WI-10004956).
 *
 * The relay is open to anyone on the public DHT and an e2-micro can push ~1 Gbps,
 * so GCP internet egress — not CPU — is the cost risk. blind-relay itself counts
 * sessions and streams but no bytes, so the budget is measured at the VM's own
 * network interfaces (/proc/net/dev transmit bytes), which is exactly what GCP
 * bills: relayed streams plus the DHT node's background traffic.
 *
 * Pure state transitions live here so they are testable without a VM; the daemon
 * owns the timer, the file and the decision to suspend or resume the relay.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

export interface EgressState {
  /** UTC calendar month the usage belongs to, `YYYY-MM`. */
  month: string;
  /** Bytes transmitted in `month` since the daemon first observed it. */
  usedBytes: number;
  /** Interface transmit counter at the last observation (resets on reboot). */
  lastTxBytes: number;
}

export interface EgressTick {
  state: EgressState;
  /** Bytes attributed to this tick. */
  deltaBytes: number;
  /** True when this tick moved into a new UTC month (usage restarted at 0). */
  monthRolled: boolean;
  /** True when usage for the month has reached the budget. */
  overBudget: boolean;
}

export const BYTES_PER_GB = 1_000_000_000;

export function monthKey(now: Date): string {
  return now.toISOString().slice(0, 7);
}

/**
 * Advance the month's usage by one interface-counter observation.
 *
 * - First observation ever: the counter's history is unknown (it may span months),
 *   so it becomes the baseline and nothing is charged.
 * - Counter went DOWN: the VM rebooted and the kernel counter restarted at 0, so
 *   everything it now shows was sent since the reboot and is charged in full.
 * - New UTC month: usage restarts at 0; the tick's delta is charged to the new month.
 */
export function advanceEgress(
  prev: EgressState | null,
  txBytes: number,
  now: Date,
  budgetBytes: number,
): EgressTick {
  if (!Number.isFinite(txBytes) || txBytes < 0) throw new Error(`tx byte counter must be >= 0, got ${txBytes}`);
  const month = monthKey(now);
  if (!prev) {
    const state = { month, usedBytes: 0, lastTxBytes: txBytes };
    return { state, deltaBytes: 0, monthRolled: false, overBudget: false };
  }
  const deltaBytes = txBytes >= prev.lastTxBytes ? txBytes - prev.lastTxBytes : txBytes;
  const monthRolled = prev.month !== month;
  const usedBytes = (monthRolled ? 0 : prev.usedBytes) + deltaBytes;
  const state = { month, usedBytes, lastTxBytes: txBytes };
  return { state, deltaBytes, monthRolled, overBudget: budgetBytes > 0 && usedBytes >= budgetBytes };
}

/**
 * Sum transmit bytes from /proc/net/dev. With `iface`, only that interface counts;
 * without it, every interface except loopback does (a GCE VM has one: ens4).
 * Throws when nothing matched, so a renamed interface cannot read as zero usage.
 */
export function parseProcNetDevTx(text: string, iface?: string): number {
  let total = 0;
  let matched = 0;
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    if (!name || name === 'lo' || (iface && name !== iface)) continue;
    const fields = line.slice(colon + 1).trim().split(/\s+/);
    // receive: bytes packets errs drop fifo frame compressed multicast (8), then transmit bytes.
    const tx = Number(fields[8]);
    if (fields.length < 16 || !Number.isFinite(tx)) continue;
    total += tx;
    matched++;
  }
  if (matched === 0) throw new Error(`no ${iface ? `interface ${iface}` : 'non-loopback interface'} in /proc/net/dev`);
  return total;
}

export function readEgressState(path: string): EgressState | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  const s = JSON.parse(raw) as Partial<EgressState>;
  if (
    typeof s.month !== 'string' ||
    !/^\d{4}-\d{2}$/.test(s.month) ||
    typeof s.usedBytes !== 'number' ||
    typeof s.lastTxBytes !== 'number'
  ) {
    throw new Error(`malformed egress state in ${path}`);
  }
  return { month: s.month, usedBytes: s.usedBytes, lastTxBytes: s.lastTxBytes };
}

/** Atomic replace, so a crash mid-write never leaves a half file that resets the month. */
export function writeEgressState(path: string, state: EgressState): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}
