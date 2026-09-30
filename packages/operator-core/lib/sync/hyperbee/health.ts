/**
 * assessHarnessSubstrateHealth — pure-logic combined health verdict.
 *
 * Plan: papercusp-dogfood-v5-2026-05-23 + papercusp-dogfood-phase5a-
 *       hyperbee-plumbing-2026-05-24.
 *
 * Aggregates the diagnostic surfaces into one verdict for monitoring,
 * alerts, and the admin / chrome surfaces:
 *
 *   {
 *     verdict: 'disabled' | 'booting' | 'healthy' | 'degraded' | 'unhealthy',
 *     reasons: string[],
 *   }
 *
 * Verdict ladder (worst wins):
 *   - 'disabled'  — substrate flag off, nothing to assess. Not an error.
 *   - 'booting'   — flag on but handle missing from boot map.
 *   - 'healthy'   — flag on, handle present, claim error rate < 5%.
 *   - 'degraded'  — flag on, handle present, claim error rate 5-25%.
 *   - 'unhealthy' — flag on, handle present, claim error rate > 25%
 *                   OR handle present but bootstrap-progress idle for
 *                   > staleThresholdMs with mergedOps still < highestSeen.
 *
 * Pure logic — every input is passed in. No fetch, no PG.
 */

export type SubstrateHealthVerdict =
  | 'disabled'
  | 'booting'
  | 'healthy'
  | 'degraded'
  | 'unhealthy';

export interface SubstrateHealthInputs {
  flagEnabled: boolean;
  /** Is the handle in the boot map for this (workspace, harness)? */
  handlePresent: boolean;
  claimStats?: {
    total: number;
    won: number;
    lost: number;
    error: number;
  };
  bootstrapProgress?: {
    mergedOps: number;
    highestSeen: number;
    lastChangeMs: number;
    caughtUp: boolean;
  } | null;
  /**
   * Substrate-outbox DRAIN health (EI-1618). `undrainedCount` = rows with
   * `drained_at IS NULL` for this scope; `oldestUndrainedAgeMs` = age of the
   * oldest such row. A long-undrained outbox means content was CAPTURED but is
   * NOT federating — the silent-stall class (EI-681: harness booted but its
   * outbox never drains / it never joins the topic). Boot-health alone reports
   * such a harness as "healthy"; this input is what makes the stall visible.
   * Absent / null age = not measured (pure in-process callers without PG).
   */
  drainStats?: {
    undrainedCount: number;
    oldestUndrainedAgeMs: number | null;
  };
  /** oldest-undrained age ≥ this → at least `degraded`. Default 60s. */
  drainStalledThresholdMs?: number;
  /** oldest-undrained age ≥ this → `unhealthy`. Default 5m. */
  drainUnhealthyThresholdMs?: number;
  /**
   * WI-899 (A): SUBSTRATE_SIDECAR process liveness (from `probeSubstrateSidecar` in
   * service-health.ts), process-wide (NOT per-harness — one sidecar owns every
   * booted harness's engine). `true` = healthz answered; `false` = the sidecar is
   * DOWN — every harness's `handlePresent: true` (still the cached boot-time proxy)
   * is a LIE, so this forces `unhealthy` regardless of any other signal (worst-wins,
   * and the strongest possible override — a dead sidecar means NOTHING downstream of
   * it can be trusted). `undefined`/`null` = not measured / sidecar mode off — no
   * effect (never fabricates a verdict for a harness that boots in-process).
   */
  sidecarLive?: boolean | null;
  /**
   * P-004 (WI-1840, WI-183 class): per-harness replication-liveness rollup
   * (from `getReplicationLiveness()` counts). A `noReplicator` or `frozen`
   * admitted remote log means writes on that peer are SILENTLY diverging while
   * everything else here can read "healthy" — the exact connected-but-dead
   * failure class this input closes. Omitted/undefined = not measured (never
   * fabricates a verdict).
   */
  replicationLiveness?: {
    /** Logs that WERE replicating and have held 0 replicator peers past grace. */
    noReplicator: number;
    /** Logs with a replicator attached but ingest frozen past grace. */
    frozen: number;
    /** Logs the merge loop hasn't sampled recently (detector dead-man). */
    samplingStale?: number;
    /**
     * WI-3604: this harness's process resolved a DIFFERENT DHT universe than
     * the operator's declared expectation (split-DHT-universe outage class —
     * e.g. the 2026-07-09 Mac VM incident: a Server.app relaunch silently
     * dropped `PAPERCUSP_DHT_BOOTSTRAP` and joined the PUBLIC DHT). Reported
     * as a COUNT (of admitted logs reading the `dht_universe_mismatch`
     * verdict) for symmetry with `noReplicator`/`frozen`, but is really a
     * per-harness boolean condition — every admitted log reads it together.
     * Deliberately kept as its OWN distinct 'unhealthy' reason (never folded
     * into the noReplicator/frozen "WI-183 class" wording below): a
     * mismatched-universe harness's logs read `dht_universe_mismatch`
     * instead of `no_replicator`/`frozen` (see replication-liveness.ts's
     * `deriveVerdict`), so the two blocks don't double-fire.
     */
    dhtUniverseMismatch?: number;
  };
  /**
   * P-003 (own-log-fork-guard, WI-3535): this harness's OWN writable log hit
   * the Hypercore equivocation loop ("[hypercore] conflict detected") and
   * every session to it is SESSION_CLOSED — local writes are frozen and,
   * unlike replicationLiveness, this does NOT self-heal (only an explicit
   * store-reset recovery clears it — see own-log-fork-guard.ts). `forked:true`
   * is at least as severe as a stalled/frozen remote log (local writes are
   * BLOCKED, not just diverging), so it forces `unhealthy`. Omitted/undefined
   * = not measured (never fabricates a verdict).
   */
  ownLogFork?: { forked: boolean; detail?: string };
  /**
   * EI-20575137548097507: whether the REPORTING PROCESS was able to observe this
   * harness's process-local health inputs at all (`replicationLiveness`,
   * `ownLogFork`, log stats). Default/undefined = observable (preserves every
   * pre-existing caller's behaviour).
   *
   * Pass `false` when the process is reporting a harness it learned about from
   * SOMEWHERE ELSE — a node:cluster IPC snapshot or the cross-service PG
   * fallback — because those legs carry only the BOOTED-HANDLE list. The
   * liveness/fork detectors are module-scope state living in the substrate
   * OWNER process, so a non-owner reader's local maps are empty *by
   * construction*, and the per-harness join in in-process-status.ts can never
   * match. Every one of those inputs then arrives here as `undefined`, which
   * this module correctly treats as "not measured" and skips — and the verdict
   * falls through to `healthy` / "no issues detected".
   *
   * That fall-through is the bug this input closes, and it is the FIFTH
   * instance of one root defect (EI-18735338283879820, EI-19328421457282435,
   * EI-19327550671915579, WI-5307, EI-20575137548097507): this diagnostic
   * renders absence-of-information as reassurance. Each prior fix widened the
   * BOOTED-HANDLE leg (local map → cluster IPC → PG snapshot) and left the
   * health-input legs process-local, so the surface kept reporting *more*
   * harnesses it was *no better* able to assess.
   *
   * `false` therefore degrades the verdict (never better than 'degraded') and
   * names itself in `reasons`. It deliberately does NOT force 'unhealthy':
   * unobservable is not proof of a fault. This mirrors the existing
   * `samplingStale` treatment — "the detector itself is blind, which is a real
   * signal but not proof of divergence".
   */
  healthInputsObservable?: boolean;
  /**
   * WI-5777 (substrate observability gap found while re-verifying WI-5719):
   * age (ms) since the EI-8892 isolated-DHT-bootstrap liveness probe
   * (`papercup-dht-liveness-check.sh`, 5-min cadence) last SUCCEEDED, for a
   * process whose federation actually depends on that isolated bootstrap
   * (`PAPERCUSP_DHT_BOOTSTRAP` set). This closes a real silent-degrade path:
   * a wedged bootstrap makes a currently-joining/reconnecting peer read
   * `never_connected` at the replication-liveness layer, and per WI-183
   * gating `never_connected` NEVER alarms on its own — it is deliberately
   * indistinguishable from an ordinary offline peer. The EI-8892 probe is
   * the only independent signal that CAN tell the two apart; this input
   * threads that signal into the harness verdict so a wedged substrate
   * shows up here too, instead of only in a separately-filed, uncorrelated
   * EI (see WI-5719 for one such instance — resolved transient, but the
   * correlation to THIS harness's verdict was previously invisible).
   * `null`/`undefined` = not measured (this process isn't on the isolated
   * DHT, or the probe has never run / its state dir is unreadable) — never
   * fabricates a verdict, same convention as every other optional input here.
   */
  dhtBootstrapProbeStaleMs?: number | null;
  /**
   * `dhtBootstrapProbeStaleMs` ≥ this → `degraded` (never worse — this is
   * CORRELATIONAL, not a certain diagnosis: the probe itself could just be
   * down while federation is fine). Default 20 minutes — 4x the probe's
   * 5-min cadence, comfortably past ordinary timer jitter, well under the
   * wrapper's own 6h `DHT_STALE_H` "the checker itself has gone dark"
   * threshold (a different, louder concern this input does not duplicate).
   */
  dhtBootstrapProbeStaleThresholdMs?: number;
  /** Override for tests; defaults to Date.now(). */
  nowMs?: number;
  /** mergedOps lagging highestSeen for this long → unhealthy. Default 5m. */
  staleThresholdMs?: number;
  /** Error rate ≥ this → unhealthy. Default 0.25. */
  unhealthyErrorRate?: number;
  /** Error rate ≥ this (and < unhealthyErrorRate) → degraded. Default 0.05. */
  degradedErrorRate?: number;
}

export interface SubstrateHealthVerdictResult {
  verdict: SubstrateHealthVerdict;
  reasons: string[];
}

export function assessHarnessSubstrateHealth(
  inputs: SubstrateHealthInputs,
): SubstrateHealthVerdictResult {
  const reasons: string[] = [];
  if (!inputs.flagEnabled) {
    return { verdict: 'disabled', reasons: ['flag off'] };
  }
  if (!inputs.handlePresent) {
    return {
      verdict: 'booting',
      reasons: ['substrate handle missing from boot map'],
    };
  }

  const stale = inputs.staleThresholdMs ?? 5 * 60 * 1_000;
  const unhealthy = inputs.unhealthyErrorRate ?? 0.25;
  const degraded = inputs.degradedErrorRate ?? 0.05;
  const now = inputs.nowMs ?? Date.now();

  let verdict: SubstrateHealthVerdict = 'healthy';

  if (inputs.claimStats && inputs.claimStats.total > 0) {
    const rate = inputs.claimStats.error / inputs.claimStats.total;
    if (rate >= unhealthy) {
      verdict = 'unhealthy';
      reasons.push(
        `claim error rate ${(rate * 100).toFixed(1)}% ≥ ${(unhealthy * 100).toFixed(0)}%`,
      );
    } else if (rate >= degraded) {
      verdict = 'degraded';
      reasons.push(
        `claim error rate ${(rate * 100).toFixed(1)}% ≥ ${(degraded * 100).toFixed(0)}%`,
      );
    }
  }

  if (inputs.bootstrapProgress) {
    const { mergedOps, highestSeen, lastChangeMs, caughtUp } =
      inputs.bootstrapProgress;
    if (
      !caughtUp &&
      mergedOps < highestSeen &&
      now - lastChangeMs > stale
    ) {
      verdict = 'unhealthy';
      reasons.push(
        `bootstrap-progress stalled (${mergedOps}/${highestSeen}, idle ${Math.round(
          (now - lastChangeMs) / 1000,
        )}s)`,
      );
    }
  }

  // EI-1618: a stuck outbox (captured-but-not-draining) means content silently
  // isn't federating. Boot-health alone reports such a harness "healthy"; surface
  // the stall here. Worst-wins (never upgrades an already-worse verdict).
  if (
    inputs.drainStats &&
    inputs.drainStats.undrainedCount > 0 &&
    inputs.drainStats.oldestUndrainedAgeMs != null
  ) {
    const drainStalled = inputs.drainStalledThresholdMs ?? 60 * 1_000;
    const drainUnhealthy = inputs.drainUnhealthyThresholdMs ?? 5 * 60 * 1_000;
    const ageMs = inputs.drainStats.oldestUndrainedAgeMs;
    const ageS = Math.round(ageMs / 1000);
    const n = inputs.drainStats.undrainedCount;
    if (ageMs >= drainUnhealthy) {
      verdict = 'unhealthy';
      reasons.push(
        `outbox STALLED: ${n} row(s) undrained for ${ageS}s — captured but not federating (EI-681 class)`,
      );
    } else if (ageMs >= drainStalled) {
      if (verdict === 'healthy') verdict = 'degraded';
      reasons.push(`outbox lagging: ${n} row(s) undrained for ${ageS}s`);
    }
  }

  // P-004 (WI-1840): connected-but-dead replication. A stalled/frozen admitted
  // remote log means that peer's writes are silently diverging RIGHT NOW —
  // at least as severe as a stalled bootstrap, so worst-wins to 'unhealthy'.
  // A merely-stale sampler (merge loop not feeding the registry) degrades:
  // the detector itself is blind, which is a real signal but not proof of
  // divergence.
  if (inputs.replicationLiveness) {
    const { noReplicator, frozen, samplingStale, dhtUniverseMismatch } = inputs.replicationLiveness;
    // WI-3604: distinct from the connected-but-dead WI-183 class below — a
    // split-DHT-universe misconfiguration is a completely different root
    // cause (this process joined the wrong DHT entirely) and must read as
    // its own diagnosis, not get lumped in with "peer writes silently
    // diverging".
    if ((dhtUniverseMismatch ?? 0) > 0) {
      verdict = 'unhealthy';
      reasons.push(
        `DHT-universe mismatch on ${dhtUniverseMismatch} admitted remote log(s) — this process ` +
          `joined a DIFFERENT DHT than expected (split-DHT-universe outage class, WI-3604)`,
      );
    }
    if (noReplicator > 0 || frozen > 0) {
      verdict = 'unhealthy';
      const parts: string[] = [];
      if (noReplicator > 0) parts.push(`${noReplicator} with no live replicator`);
      if (frozen > 0) parts.push(`${frozen} attached-but-frozen`);
      reasons.push(
        `replication stalled on ${parts.join(' + ')} admitted remote log(s) — ` +
          `peer writes silently diverging (WI-183 class)`,
      );
    } else if ((samplingStale ?? 0) > 0) {
      if (verdict === 'healthy') verdict = 'degraded';
      reasons.push(
        `replication-liveness sampler stale for ${samplingStale} log(s) — merge loop may be wedged`,
      );
    }
  }

  // WI-5777: a stale/failing EI-8892 DHT-bootstrap probe means this harness's
  // `never_connected` verdicts (which never alarm on their own, by WI-183
  // design — see replicationLiveness above) may actually be masking a
  // silently-wedged substrate rather than genuinely-offline peers. Degraded
  // only, never worse — correlational, not proof; worst-wins (never
  // downgrades an already-worse verdict from the checks above).
  if (
    inputs.dhtBootstrapProbeStaleMs != null &&
    inputs.dhtBootstrapProbeStaleMs >=
      (inputs.dhtBootstrapProbeStaleThresholdMs ?? 20 * 60 * 1_000)
  ) {
    if (verdict === 'healthy') verdict = 'degraded';
    reasons.push(
      `isolated-DHT bootstrap liveness probe stale for ${Math.round(
        inputs.dhtBootstrapProbeStaleMs / 60_000,
      )}m — federation may be silently wedged at the substrate level (EI-8892 class); ` +
        `'never_connected' peers here are unverified, not confirmed-offline`,
    );
  }

  // P-003 (WI-3535): an own-log fork blocks LOCAL writes outright — at least
  // as severe as a stalled remote log, so worst-wins to 'unhealthy'. Unlike
  // replicationLiveness's samplingStale degrade, there is no lesser "degraded"
  // case here — the condition is binary and does not self-heal.
  if (inputs.ownLogFork?.forked) {
    verdict = 'unhealthy';
    reasons.push(
      `own-log forked: ${inputs.ownLogFork.detail ?? 'writable core hit the Hypercore equivocation loop'} — local writes are frozen until a store-reset recovery`,
    );
  }

  // WI-899 (A): a confirmed-dead sidecar overrides every other signal — nothing
  // computed above (claim stats, bootstrap progress, drain) is trustworthy once the
  // process that actually owns replication is gone; the boot map still holding a
  // proxy handle for it is exactly the "reads healthy while dead" bug this closes.
  if (inputs.sidecarLive === false) {
    verdict = 'unhealthy';
    reasons.push('substrate sidecar is DOWN (healthz unreachable) — boot-time handle is stale');
  }

  // EI-20575137548097507: the reporting process could not observe this
  // harness's process-local health inputs at all, so every such input above
  // arrived as `undefined` and was skipped as "not measured". Without this
  // block the verdict falls through to a confident `healthy` / "no issues
  // detected" for a harness nothing actually assessed — the fifth instance of
  // this diagnostic rendering absence-of-information as reassurance.
  //
  // Degrade, never worse: unobservable is not proof of a fault. Worst-wins, so
  // a genuine 'unhealthy' established above is never downgraded to 'degraded'
  // by a reporting-process limitation.
  if (inputs.healthInputsObservable === false) {
    if (verdict === 'healthy') verdict = 'degraded';
    reasons.push(
      'health inputs UNOBSERVABLE from this process — replication-liveness, own-log-fork ' +
        'and log stats live in the substrate OWNER process, and this harness was reported ' +
        'from a booted-handle snapshot (cluster IPC or PG fallback) that carries none of them. ' +
        'This is ABSENCE of measurement, not evidence of health: a stalled or forked log here ' +
        'would look identical. Read the owner process directly for an authoritative verdict.',
    );
  }

  if (verdict === 'healthy' && reasons.length === 0) {
    reasons.push('no issues detected');
  }
  return { verdict, reasons };
}
