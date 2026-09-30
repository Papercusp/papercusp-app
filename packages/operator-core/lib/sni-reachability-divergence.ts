/**
 * sni-reachability-divergence.ts — EI-16742: detect a box-local SNI-based TLS
 * filter of a workspace-owned domain BEFORE an agent misdiagnoses it as a
 * production outage.
 *
 * Live incident (2026-07-19): an su session's own TLS probes against
 * papercusp-family hostnames (papercusp.com, flags.papercuspai.com, …) all
 * hung until timeout — even when connecting DIRECTLY to a known-good IP with
 * `-servername <host>` (bypassing DNS entirely). The same IP, probed with a
 * control SNI it has no relationship to (e.g. `github.com` against GitHub's
 * own IP), succeeded instantly. Because the failure follows the **hostname**
 * (the TLS SNI) rather than the destination IP, the true origin server can
 * never explain it — a middlebox on this box's network path is reading the
 * ClientHello SNI and silently dropping the connection for papercusp-family
 * names specifically. Reading the resulting timeout as "the site is down"
 * produced two false outage escalations in one session (EI-16722, EI-16702)
 * before the pattern was identified.
 *
 * This module is the PURE comparator, unit-testable with no network / TLS
 * dependency: given the outcome of a TLS handshake against a KNOWN-GOOD
 * control SNI and the outcome of a TLS handshake against the TARGET SNI —
 * both against the SAME destination IP — decide whether the divergence
 * indicates a local SNI filter rather than a genuine outage of the target
 * host.
 *
 * Deliberately NOT wired into a scheduled watchdog here — like its sibling
 * `dns-truth-divergence.ts` (EI-12952), the root cause is box-local network
 * infrastructure outside papercusp's own reach to fix. The actionable win is
 * a fast, reusable, TESTED check any agent or health tool can call ad hoc
 * before it escalates "unreachable from here" into "the site is down" —
 * e.g. by running:
 *
 *   openssl s_client -connect <ip>:443 -servername <controlHost>  # e.g. github.com
 *   openssl s_client -connect <ip>:443 -servername <targetHost>   # the papercusp host
 *
 * against the SAME `<ip>` and feeding whether each handshake completed into
 * `evaluateSniReachability`.
 */

export interface SniProbeResult {
  /**
   * Did the TLS handshake complete (a cert was presented / rejected, i.e.
   * the peer actually responded) — as opposed to hanging until timeout with
   * no response at all. A handshake that completes and then fails
   * certificate validation is still "completed" for this purpose; only a
   * silent hang/timeout counts as not completed.
   */
  handshakeCompleted: boolean;
}

export interface SniReachabilityInputs {
  /** A known-good hostname unrelated to the target (e.g. "github.com"). */
  controlSni: string;
  /** Probe outcome for `controlSni` against the destination IP. */
  control: SniProbeResult;
  /** The workspace-owned hostname under question (e.g. "papercusp.com"). */
  targetSni: string;
  /** Probe outcome for `targetSni` against the SAME destination IP. */
  target: SniProbeResult;
}

export type SniReachabilityVerdict =
  | { classification: 'sni-filtered-locally'; reason: string }
  | { classification: 'reachable'; reason: string }
  | { classification: 'inconclusive'; reason: string };

/**
 * PURE: does this pair of same-IP, different-SNI probe outcomes match the
 * EI-16742 local-SNI-filter signature?
 *
 * The signature is specific: the control SNI (unrelated to the target,
 * proving the destination IP itself is reachable and terminating TLS fine)
 * completes while the target SNI — against that SAME IP — hangs. Since the
 * destination cannot distinguish "which hostname a client asked for" until
 * *after* it would need to respond, a same-IP success/hang split can only be
 * explained by something on the LOCAL path filtering on the SNI field.
 *
 * If the control probe itself fails, the comparison is inconclusive — that
 * could be a genuine broader outage, a bad control host, or an unrelated
 * network blip, and must not be reported as an SNI-filter finding.
 */
export function evaluateSniReachability(input: SniReachabilityInputs): SniReachabilityVerdict {
  const { controlSni, control, targetSni, target } = input;

  if (control.handshakeCompleted && !target.handshakeCompleted) {
    return {
      classification: 'sni-filtered-locally',
      reason:
        `TLS handshake against the SAME destination IP completed for control SNI "${controlSni}" ` +
        `but hung for target SNI "${targetSni}" — the destination server cannot explain a per-hostname ` +
        `difference at the same IP; this is the EI-16742 SNI-filtering signature. Do NOT conclude ` +
        `"${targetSni}" is down. Verify via an external vantage (WebFetch, a DoH-resolved external ` +
        `fetch, or a reachable alias such as its pages.dev / CDN host) before reporting an outage.`,
    };
  }

  if (!control.handshakeCompleted) {
    return {
      classification: 'inconclusive',
      reason:
        `the control SNI "${controlSni}" itself did not complete a handshake against this IP — this ` +
        `comparison cannot attribute the target's failure to local SNI filtering (could be a genuine ` +
        `broader outage, a bad control host/IP, or an unrelated network blip). Retry with a different, ` +
        `verified-reachable control host before concluding either way.`,
    };
  }

  return {
    classification: 'reachable',
    reason: `TLS handshake to target SNI "${targetSni}" completed — no evidence of local SNI filtering for this host.`,
  };
}
