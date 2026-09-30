/**
 * The network a connected app's call came from (P-011, D-028) — pure, dependency-free, so the key
 * store can use it without loading the alert delivery rail.
 *
 * The client address is caller-reported (forwarding headers). It is DISPLAY and ALERT data only and
 * must never feed an authorization decision.
 */

import { isIP } from 'node:net';

/** What one recorded use of a key found (see store.ts `recordAppKeyUse`). */
export interface AppKeyUseOutcome {
  /** This call was the key's first use ever. */
  firstUse: boolean;
  /** The network of this call when the key had never been used from it before; else null. */
  newNetwork: string | null;
}

/**
 * The network a client address belongs to: an IPv4 /24 or an IPv6 /48. A home connection's
 * address changes inside its network all the time; a new network is the signal worth a ping.
 * A value that is not an IP address is kept as-is (lowercased, bounded). Null for no address.
 */
export function networkOf(address: string | null | undefined): string | null {
  const raw = address?.trim();
  if (!raw) return null;
  const v4mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(raw)?.[1];
  const addr = v4mapped ?? raw;
  const family = isIP(addr);
  if (family === 4) {
    const [a, b, c] = addr.split('.');
    return `${a}.${b}.${c}.0/24`;
  }
  if (family === 6) {
    const groups = expandIpv6(addr);
    return groups ? `${groups.slice(0, 3).join(':')}::/48` : addr.toLowerCase().slice(0, 64);
  }
  return addr.toLowerCase().slice(0, 64);
}

function expandIpv6(addr: string): string[] | null {
  const bare = addr.split('%')[0].toLowerCase();
  const [head, tail] = bare.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail !== undefined && tail !== '' ? tail.split(':') : [];
  if (tail === undefined && headParts.length !== 8) return null;
  const missing = 8 - headParts.length - tailParts.length;
  if (missing < 0) return null;
  const groups = [...headParts, ...Array(missing).fill('0'), ...tailParts];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.replace(/^0+(?=.)/, ''));
}
