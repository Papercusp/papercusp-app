/**
 * dns-truth-divergence.ts — EI-12952: detect a box-local DNS hijack of a
 * workspace-owned domain BEFORE an agent misdiagnoses it as a production
 * outage.
 *
 * Live incident (2026-07-18): an su session's own `Bash` tool `dig`/`curl`/
 * python all agreed papercusp.com was completely down — including querying
 * the zone's own authoritative nameserver directly — and came within one
 * owner approval of requesting Cloudflare dashboard access to "fix" DNS
 * records that were never broken. Root cause (verified live, NOT a designed
 * sandbox feature — see the agent-insights doc
 * `su-box-dns-hijack-not-sandbox-synthesis`): this dev box's LAN silently
 * hijacks plain UDP:53 answers for papercusp.com specifically to a stale
 * wrong IP, while TCP:53 and any externally-routed lookup (WebFetch, which
 * does not share this box's network stack) return the true answer.
 *
 * This module is the PURE comparator, unit-testable with no network / DNS
 * dependency: given an in-sandbox resolution result and an externally-sourced
 * "truth" result for the same host, decide whether they diverge in a way
 * that indicates a local hijack rather than routine DNS churn (different
 * CDN edge selection, TTL-driven rotation among a stable answer SET is NOT a
 * divergence — only a genuinely DISJOINT answer set is).
 *
 * Deliberately NOT wired into a scheduled watchdog here — the root cause is
 * box-local network infrastructure outside papercusp's own reach to fix, so
 * the actionable win is a fast, reusable, TESTED check any agent or health
 * tool can call ad hoc (or a future scheduled sweep can adopt) instead of
 * every session re-deriving the UDP-vs-TCP tell from scratch.
 */

export interface DnsAnswerSet {
  /** Resolved IPv4/IPv6 addresses (order-independent — compared as a set). */
  addresses: string[];
}

export type DnsTruthVerdict =
  | { diverges: false; reason: string }
  | { diverges: true; reason: string; localOnly: string[]; truthOnly: string[] };

/**
 * PURE: does the in-sandbox (`local`) answer set diverge from the
 * externally-sourced (`truth`) answer set for the same host, in a way that
 * indicates a hijack rather than benign DNS churn?
 *
 * A CDN/load-balancer commonly rotates which subset of a larger, STABLE
 * anycast/edge pool it returns per query — so "local returned fewer/more of
 * the same addresses" or "local and truth overlap partially due to
 * rotation" is NOT by itself proof of a hijack. What IS conclusive: the two
 * sets share ZERO addresses (a fully disjoint answer — exactly the observed
 * incident: local synthesized 18.204.152.241, truth was
 * 172.67.145.145/104.21.73.140, no overlap at all).
 *
 * Either set being empty (a lookup failure on one side) is reported as
 * non-divergent — "no answer" is a different failure mode (a real outage, or
 * a network blip) from "wrong answer", and this comparator's whole point is
 * distinguishing "the box is lying" from "the box got no answer".
 */
export function evaluateDnsTruthDivergence(local: DnsAnswerSet, truth: DnsAnswerSet): DnsTruthVerdict {
  const localSet = new Set(local.addresses.filter(Boolean));
  const truthSet = new Set(truth.addresses.filter(Boolean));

  if (localSet.size === 0 || truthSet.size === 0) {
    return {
      diverges: false,
      reason:
        localSet.size === 0 && truthSet.size === 0
          ? 'both sides returned no answer — not evaluable here, not a hijack signature'
          : 'one side returned no answer — a lookup failure, not necessarily a hijack; investigate separately',
    };
  }

  const overlap = [...localSet].filter((a) => truthSet.has(a));
  if (overlap.length > 0) {
    return { diverges: false, reason: `answer sets overlap on ${overlap.length} address(es) — benign (CDN edge rotation)` };
  }

  const localOnly = [...localSet];
  const truthOnly = [...truthSet];
  return {
    diverges: true,
    reason:
      `local and externally-sourced answers for this host share NO addresses ` +
      `(local: ${localOnly.join(', ')}; truth: ${truthOnly.join(', ')}) — this is the EI-12952 hijack ` +
      `signature, not routine DNS churn. Do not trust the in-sandbox reading; verify via ` +
      `WebFetch https://dns.google/resolve before concluding an outage or touching DNS records.`,
    localOnly,
    truthOnly,
  };
}
