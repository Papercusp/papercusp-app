/**
 * eviction-wiring — boot binding for the P-016 φ+SWIM authority eviction
 * (shared-hive-hardening-2026-06-13).
 *
 * Behind the `papercusp-authority-eviction-probe` flag (DEFAULT OFF / dark —
 * real-hardware-gated, D-003), this:
 *   1. registers the relay-side `peer.probe` op (so this machine answers liveness
 *      probes from suspecting peers), and
 *   2. installs the {@link AuthorityEvictionMonitor} singleton so `lockAuthorityFor`
 *      excludes a relay-confirmed-dead peer before the 90s staleness window.
 *
 * The flag read is async and boot is sync, so the install runs fire-and-forget:
 * until it resolves (or if it's OFF / unreadable) NO monitor is installed and
 * authority selection is byte-identical to pre-P-016 (staleness-only). Idempotent.
 */

import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import {
  AuthorityEvictionMonitor,
  setAuthorityEvictionMonitor,
  PEER_PROBE_OP_KIND,
} from './peer-eviction';
import { registerPeerProbeOp } from './peer-probe-op';
import { registeredAuthorityOpKinds } from './authority-op-registry';

let _wired = false;

/**
 * Wire eviction at boot (flag-gated). Idempotent. Fire-and-forget on the async
 * flag read — stays dark (no monitor, no probe op) until the flag resolves ON.
 */
export function wirePeerEviction(): void {
  if (_wired) return;
  _wired = true;
  void (async () => {
    try {
      const on = await getFlag(FLAGS.AUTHORITY_EVICTION_PROBE, 'system');
      if (!on) return;
      // Register the relay-side probe op (guard against a double-register throw).
      if (!registeredAuthorityOpKinds().includes(PEER_PROBE_OP_KIND)) {
        registerPeerProbeOp();
      }
      // Install the monitor so selection consults it.
      setAuthorityEvictionMonitor(new AuthorityEvictionMonitor());
    } catch {
      /* best-effort: flag unreadable → stay dark (staleness-only selection) */
    }
  })();
}

/** Test seam: reset the wiring guard (does NOT uninstall the monitor — use
 *  `__resetAuthorityEvictionMonitorForTests`). */
export const _testing = {
  reset(): void {
    _wired = false;
  },
};
