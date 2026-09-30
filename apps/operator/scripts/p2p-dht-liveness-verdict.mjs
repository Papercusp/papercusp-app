/**
 * p2p-dht-liveness-verdict.mjs — the JUDGEMENT half of the DHT liveness probe,
 * kept pure and dependency-free so it can be unit-tested (see the sibling
 * `p2p-dht-liveness-verdict.test.ts`) without standing up a DHT.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS (P-302, EI-20584279536840151)
 *
 * The original probe built swarmA AND swarmB in ONE process on ONE host and
 * asserted they connected. That is a real check of exactly one thing — "is the
 * bootstrap node still routing" (EI-8892's silent-wedge class) — and it is
 * completely blind to everything else:
 *
 *   - it passes on ANY DHT topology, public or isolated, so a bootstrap pin that
 *     had silently stopped taking effect still read green;
 *   - it never emits a packet across a machine boundary, so it stayed green for
 *     DAYS while the Mac side of the two-machine rig could not dial ANYONE
 *     (macOS Local Network privacy was dropping every outbound datagram).
 *
 * The lesson is not "the probe was wrong" — it answered the question it was
 * asked. It is that a NARROW claim rendered as a broad one ("OK — bootstrap
 * healthy") is indistinguishable from the broad claim being true. So every
 * verdict here carries an explicit `proved` scope, and the words "healthy"
 * are never emitted for something narrower than what the caller asked for.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TWO RULES THIS MODULE ENFORCES
 *
 * 1. FAIL CLOSED. A run that could not carry out its own experiment is
 *    `unknown`, never `ok`. Inconclusive gets its own exit code so a caller can
 *    tell "the DHT is broken" from "I could not tell", but NEITHER is success.
 *
 * 2. PEER IDENTITY IS THE CROSS-HOST PROOF. "A connection happened" is not
 *    evidence a packet crossed the network — two swarms in one process satisfy
 *    it. The client must connect to the *specific* public key the remote server
 *    announced, and that server must have run on a different host. Anything
 *    else is degenerate and is reported as such.
 */

/**
 * Exit codes. INCONCLUSIVE is deliberately distinct from FAIL: both are
 * non-zero (fail closed), but a caller that files alarms must be able to say
 * "could not test" instead of libelling a healthy DHT as wedged. Mislabelled
 * alarms are what send the next responder hunting a fault that never existed
 * (see the wrapper's own WI-5804 crash-retry comment).
 */
export const EXIT = Object.freeze({
  HEALTHY: 0,
  FAIL: 1,
  USAGE: 2,
  INCONCLUSIVE: 3,
});

/**
 * What a run is allowed to claim it proved. Ordered narrow → broad.
 * `nothing` is the correct answer far more often than it feels like it is.
 */
export const PROVED = Object.freeze({
  NOTHING: 'nothing',
  /** Two separate PROCESSES on THIS host connected via the bootstrap. */
  LOCAL_ONLY: 'local-process-to-process',
  /**
   * A process on ANOTHER host connected to us, identity-verified.
   *
   * ⚠ READ THE BOUNDARY: this is proof the two HOSTS can carry DHT traffic,
   * measured with a standalone probe process. It is NOT proof that the
   * Papercusp APP on either host can — a per-process denial (macOS Local
   * Network privacy / TCC, a sandbox profile, a per-binary firewall rule) sits
   * entirely inside this result's blind spot, and that is precisely the P-302
   * fault: the Mac's standalone node reached the tower in 35ms while the app's
   * own sidecar could not send a single datagram.
   *
   * The complementary instrument is `classifyDhtReachability` /
   * `scheduleDhtReachabilityCheck` in
   * packages/operator-core/lib/sync/hyperbee/swarm.ts, which samples the LIVE
   * app process's own dht-rpc counters. Infrastructure health and app-process
   * health are two different questions; you need both answers.
   */
  CROSS_HOST: 'cross-host-packet-flow',
});

/**
 * @typedef {Object} DhtCounters
 * @property {number} routingTableSize
 * @property {number} requestsTotal
 * @property {number} responses
 * @property {number} timeouts
 */

/**
 * @typedef {Object} ProbeObservation
 * @property {'cross-host'|'local-only'} scope   What the run was CONFIGURED to prove.
 * @property {boolean} [remoteConfigured]        Was a remote peer actually specified.
 * @property {boolean} [remoteLegLaunched]       Did the remote peer process start at all.
 * @property {string|null} [remoteLegError]      Why it did not.
 * @property {boolean} [serverLegLaunched]       Did the announcing peer process start at all.
 * @property {string|null} [serverLegError]      Why it did not.
 * @property {boolean} [serverAnnounced]         Did the server's announce actually flush.
 * @property {DhtCounters|null} [serverCounters] The server's own dht-rpc counters.
 * @property {string|null} [expectedRemoteKey]   Public key the server announced (hex).
 * @property {string[]} [connectedPeerKeys]      remotePublicKey of every connection seen.
 * @property {string|null} [clientLocalKey]      The client's OWN public key.
 * @property {boolean} [serverHostIsRemote]      Did the server run on a different host.
 * @property {DhtCounters|null} [clientCounters] The client's own dht-rpc counters.
 * @property {boolean} [inboundAnswered]         Did the client answer an inbound ping.
 * @property {boolean} [bootstrapProvenReachable] Did some OTHER leg in this run
 *   demonstrably get responses from the bootstrap. This is the discriminator
 *   between "this host's transmit path is blocked" and "the bootstrap is dead" —
 *   see `diagnoseSilence`.
 */

/**
 * @typedef {Object} LivenessVerdict
 * @property {'ok'|'fail'|'unknown'} level
 * @property {string} code
 * @property {number} exitCode
 * @property {string} proved
 * @property {string} message
 */

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Does the client's own DHT show the P-302 signature — outbound queries piling
 * up with NOTHING ever coming back, and an empty routing table to match?
 *
 * This is the single most actionable diagnosis the probe can produce, because
 * it says the fault is on the CLIENT's transmit path (an OS/firewall/privacy
 * layer eating datagrams) rather than at the bootstrap. Without it, that
 * failure is indistinguishable from "the bootstrap is wedged" — and the whole
 * of P-302 was spent chasing the wrong one of those two.
 */
export function looksTransmitBlocked(counters) {
  if (!counters || typeof counters !== 'object') return false;
  const { routingTableSize, requestsTotal, responses } = counters;
  if (!isFiniteNumber(routingTableSize) || !isFiniteNumber(requestsTotal) || !isFiniteNumber(responses)) {
    return false;
  }
  // Requests must actually have been ATTEMPTED — a probe that never queried
  // anything is "never queried", a different (and much less alarming) state.
  return requestsTotal > 0 && responses === 0 && routingTableSize === 0;
}

/**
 * Turn "we sent queries and heard NOTHING back" into a diagnosis — but only as
 * far as the evidence actually reaches.
 *
 * ⚠ THE WHOLE POINT: those counters are IDENTICAL for two completely different
 * faults —
 *   (a) this host's outbound datagrams are being dropped (macOS Local Network
 *       privacy / a firewall) — the P-302 fault; and
 *   (b) nothing is listening at that bootstrap address at all — a dead port, a
 *       stale pin, a wedged unit.
 *
 * Nothing observable from ONE host separates them, so asserting either one from
 * the counters alone is a guess dressed as a finding. (Pointing this probe at a
 * dead port made it confidently blame a perfectly healthy host's transmit path.)
 * The only honest discriminator is a SECOND vantage point: if another leg in
 * this same run got responses from that same bootstrap, the bootstrap is alive
 * and THIS host is the problem. Absent that, name both causes and hand over the
 * probe that settles it.
 */
export function diagnoseSilence({ counters, inboundAnswered, bootstrapProvenReachable, side }) {
  const seen = counters
    ? `${counters.requestsTotal} requests sent, ${counters.responses} responses, routing table empty`
    : 'queries sent, nothing received';

  if (bootstrapProvenReachable === true) {
    return {
      code: 'tx-blocked',
      message:
        `FAIL — the ${side} host's outbound path is BLOCKED: ${seen}` +
        `${inboundAnswered ? ', while still ANSWERING inbound traffic' : ''}. ` +
        'Another peer in this same run reached that bootstrap, so the bootstrap is alive and this host is the fault. ' +
        'TX dropped with RX intact is the macOS Local Network privacy signature (P-302) — check the OS privacy/firewall grant for the process.',
    };
  }

  return {
    code: 'bootstrap-silent',
    message:
      `FAIL — no response from the bootstrap: ${seen}. TWO causes produce exactly this and nothing here separates them: ` +
      `(a) this ${side} host's outbound datagrams are being dropped (OS privacy/firewall — the P-302 fault), or ` +
      '(b) nothing is listening at that address (dead port / stale pin / wedged unit). ' +
      'DISCRIMINATOR: capture on the far side (tcpdump on the bootstrap host) WITH a positive control in the same window — ' +
      'if the packets arrive, the bootstrap is at fault; if they never arrive while the control does, this host is.',
  };
}

function verdict(level, code, exitCode, proved, message) {
  return { level, code, exitCode, proved, message };
}

/**
 * Judge a completed probe run.
 *
 * Every path that is not a fully-demonstrated connection returns non-zero. The
 * ONLY route to EXIT.HEALTHY is a connection to the expected peer key, and — if
 * the caller asked for cross-host — that peer having genuinely been on another
 * host.
 *
 * @param {ProbeObservation} obs
 * @returns {LivenessVerdict}
 */
export function judgeLivenessProbe(obs) {
  // FAIL CLOSED at the very first gate: a malformed/absent observation means the
  // probe did not report on itself, which is not evidence of health.
  if (!obs || typeof obs !== 'object') {
    return verdict(
      'unknown',
      'no-observation',
      EXIT.INCONCLUSIVE,
      PROVED.NOTHING,
      'INCONCLUSIVE — the probe produced no observation to judge. This is NOT a pass: nothing was demonstrated.',
    );
  }

  const scope = obs.scope === 'cross-host' ? 'cross-host' : 'local-only';
  const wantCrossHost = scope === 'cross-host';
  const connectedPeerKeys = Array.isArray(obs.connectedPeerKeys) ? obs.connectedPeerKeys.filter(Boolean) : [];
  const counters = obs.clientCounters ?? null;

  // ── Could the experiment even be carried out? ──────────────────────────────
  if (wantCrossHost && obs.remoteConfigured === false) {
    return verdict(
      'unknown',
      'no-remote-configured',
      EXIT.INCONCLUSIVE,
      PROVED.NOTHING,
      'INCONCLUSIVE — a cross-host probe was requested but no remote peer was configured. Refusing to report a local-only result as cross-host health.',
    );
  }

  // A harness fault (the announcing process never started) is genuinely
  // unknowable. It is NOT the same as that process running and finding the
  // bootstrap dead — see the next gate.
  if (obs.serverLegLaunched === false) {
    return verdict(
      'unknown',
      'server-leg-unavailable',
      EXIT.INCONCLUSIVE,
      PROVED.NOTHING,
      `INCONCLUSIVE — the announcing peer process never started, so no experiment ran${
        obs.serverLegError ? `: ${obs.serverLegError}` : '.'
      } This is a probe-harness fault, not a DHT verdict.`,
    );
  }

  // THE ORIGINAL CLASS THIS PROBE EXISTS FOR (EI-8892): the announcing peer ran
  // and its announce never flushed. That is a POSITIVE FINDING about the path —
  // the bootstrap is not acking join/lookup — and it must be reported as FAIL.
  // Filing it as "inconclusive" would be the same misdiagnosis that made P-302
  // expensive: a real, actionable fault rendered as "I could not tell".
  if (obs.serverAnnounced === false) {
    if (looksTransmitBlocked(obs.serverCounters)) {
      const d = diagnoseSilence({
        counters: obs.serverCounters,
        inboundAnswered: false,
        bootstrapProvenReachable: obs.bootstrapProvenReachable,
        side: 'announcing',
      });
      return verdict('fail', d.code, EXIT.FAIL, PROVED.NOTHING, d.message);
    }
    return verdict(
      'fail',
      'announce-timeout',
      EXIT.FAIL,
      PROVED.NOTHING,
      'FAIL — the announcing peer could not complete its announce: the bootstrap is not acking join/lookup. ' +
        'This is the silent-wedge class (EI-8892) — the unit can still report ActiveState=active while routing nothing.',
    );
  }

  if (wantCrossHost && obs.remoteLegLaunched === false) {
    return verdict(
      'unknown',
      'remote-leg-unavailable',
      EXIT.INCONCLUSIVE,
      PROVED.NOTHING,
      `INCONCLUSIVE — the remote peer process never started, so no cross-host packet could be demonstrated${
        obs.remoteLegError ? `: ${obs.remoteLegError}` : '.'
      } This is NOT evidence the DHT is healthy, and NOT evidence it is wedged.`,
    );
  }

  if (!obs.expectedRemoteKey) {
    return verdict(
      'unknown',
      'server-never-announced',
      EXIT.INCONCLUSIVE,
      PROVED.NOTHING,
      'INCONCLUSIVE — the server peer never announced a public key, so the client had no identity to verify against. Without an expected key a "connection" proves nothing about WHO answered.',
    );
  }

  // ── Did anything connect at all? ───────────────────────────────────────────
  if (connectedPeerKeys.length === 0) {
    if (looksTransmitBlocked(counters)) {
      const d = diagnoseSilence({
        counters,
        inboundAnswered: obs.inboundAnswered,
        // The announcing peer having flushed IS proof the bootstrap answers —
        // that is what makes a client-side silence attributable to the client.
        bootstrapProvenReachable: obs.bootstrapProvenReachable ?? obs.serverAnnounced === true,
        side: 'dialling',
      });
      return verdict('fail', d.code, EXIT.FAIL, PROVED.NOTHING, d.message);
    }
    return verdict(
      'fail',
      'no-connection',
      EXIT.FAIL,
      PROVED.NOTHING,
      'FAIL — no peer connection was established within the timeout (bootstrap wedged, unreachable, or the peers never found each other).',
    );
  }

  // ── A connection happened. To WHOM? ────────────────────────────────────────
  // "A connection fired" was the old probe's entire test, and it is exactly the
  // assertion that two swarms in one process satisfy trivially.
  if (obs.clientLocalKey && connectedPeerKeys.includes(obs.clientLocalKey)) {
    return verdict(
      'fail',
      'self-connection',
      EXIT.FAIL,
      PROVED.NOTHING,
      'FAIL — the client connected to ITS OWN public key. That is a degenerate loop that demonstrates nothing about the network; it is the exact shape the old single-process probe could not distinguish from success.',
    );
  }

  if (!connectedPeerKeys.includes(obs.expectedRemoteKey)) {
    return verdict(
      'fail',
      'wrong-peer',
      EXIT.FAIL,
      PROVED.NOTHING,
      `FAIL — connected to ${connectedPeerKeys.length} peer(s), but NONE was the expected server key ${obs.expectedRemoteKey.slice(0, 16)}…. An unverified connection is not proof the intended path works.`,
    );
  }

  // ── Identity verified. Was it actually across the machine boundary? ────────
  if (wantCrossHost && obs.serverHostIsRemote !== true) {
    return verdict(
      'fail',
      'same-host-degenerate',
      EXIT.FAIL,
      PROVED.LOCAL_ONLY,
      'FAIL — a cross-host probe was requested, but both peers ran on THIS host. The connection is real yet proves only local process-to-process routing; reporting it as cross-host health is the precise error that let a total two-machine transport outage read green for days.',
    );
  }

  if (wantCrossHost) {
    return verdict(
      'ok',
      'cross-host-verified',
      EXIT.HEALTHY,
      PROVED.CROSS_HOST,
      `OK — a process on another host connected to the expected peer key ${obs.expectedRemoteKey.slice(0, 16)}…. Packets demonstrably crossed the machine boundary. ` +
        'SCOPE: this proves the two HOSTS can carry DHT traffic, as measured by a STANDALONE probe process. It does NOT prove the Papercusp app process on either host can — ' +
        'a per-process denial (macOS Local Network privacy, sandbox, per-binary firewall) is invisible here and is exactly the P-302 fault. For that, read the app\'s own reachability sample (swarm.ts).',
    );
  }

  return verdict(
    'ok',
    'local-only-verified',
    EXIT.HEALTHY,
    PROVED.LOCAL_ONLY,
    `OK (LOCAL-ONLY) — two separate PROCESSES on this host connected via the bootstrap, identity-verified against ${obs.expectedRemoteKey.slice(0, 16)}…. ` +
      'SCOPE: this proves the bootstrap is routing. It does NOT prove any other machine can reach the DHT — pass --remote-host to test that.',
  );
}
