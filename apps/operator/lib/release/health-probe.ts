/**
 * Post-deploy health probe — plan release-gate-ready-branch-2026-06-04, D-011(d).
 *
 * After the restart, the release-manager reads health before declaring the
 * deploy good (or triggering rollback). This is the scripted smoke: poll the
 * operator's /api/health until it reports healthy or a timeout elapses.
 *
 * Dependency-light (just fetch) so it runs standalone.
 */

export interface HealthResult {
  healthy: boolean;
  status?: number;
  body?: string;
  attempts: number;
  elapsedMs: number;
  error?: string;
  /** Set when `probeMemoryCanary` ran (EI-10361) — the verdict is attached
   *  for the caller to log/broadcast regardless of `memoryCanaryPolicy`. */
  memoryCanary?: MemoryCanaryProbeResult;
  /** Set when `probeDomainRead` ran (EI-856) — the verdict is attached for
   *  the caller to log/broadcast regardless of `domainReadPolicy`. */
  domainRead?: DomainReadProbeResult;
}

export interface MemoryCanaryProbeResult {
  /** false only on a transport/parse failure talking to the probe route
   *  itself — the route's own PASS-WITH-NOTE contract means a degraded/
   *  seeded/flag-off canary outcome still reports `reachable: true`. */
  reachable: boolean;
  ran?: boolean;
  status?: 'ok' | 'degraded' | 'decayed' | 'seeded';
  rAt10?: number | null;
  delta?: number | null;
  zeroHitRate?: number | null;
  skipReason?: string;
  error?: string;
}

/** EI-856: the deploy-triggered consumer/domain-read canary result
 *  (domain-read-canary.ts) — proves the freshly-restarted operator can
 *  genuinely resolve + read a papercusp plan through the REAL production
 *  resolver path, catching a lockstep data-move/code-flip half-state that
 *  `/api/health` + the MCP round-trip cannot see. */
export interface DomainReadProbeResult {
  /** false only on a transport/parse failure talking to the probe route
   *  itself (mirrors MemoryCanaryProbeResult.reachable). */
  reachable: boolean;
  harnessSlug?: string;
  planCount?: number;
  /** true when the read succeeded but returned ZERO plans — the exact
   *  WI-148 half-state signature (health green, every papercusp read empty). */
  empty?: boolean;
  error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ServingShaProbe {
  /** false only on a transport failure or a non-2xx response — never thrown. */
  reachable: boolean;
  /** The LIVE process's own build sha (getBuildInfo().sha, WI-265) — null when
   *  unreachable, non-2xx, or the field was absent/empty. This is a SHORT sha
   *  (`git rev-parse --short HEAD` unless PAPERCUSP_BUILD_SHA is set) — compare
   *  with `targetSha.startsWith(sha)`, never `===`, against a full-length sha. */
  sha: string | null;
  error?: string;
}

/**
 * WI-5864 / EI-18674647773291145: a SINGLE, non-retrying read of "what sha is
 * the LIVE process actually serving" — distinct from `probeHealth` above,
 * which polls until healthy (the post-restart use case). This is the
 * pre-deploy "is the checkout already at target the SAME as what's already
 * running" read `gatherPlan` needs: `currentReleaseSha === targetSha` only
 * tells you the ON-DISK checkout matches — it says nothing about whether the
 * PROCESS actually serving traffic ever picked it up. A deploy that swapped
 * the checkout and then crashed before `restart` leaves exactly that gap:
 * checkout == target, serving sha == whatever was running before, and (pre-
 * fix) `noop` computed from the checkout alone treated that as "nothing to
 * deploy" — permanently, since nothing ever advances the checkout further.
 * Never throws: a transport/parse failure yields `reachable:false, sha:null`,
 * which callers must treat as "can't confirm the serving sha" (i.e. NOT a
 * license to assume it matches).
 */
export async function fetchServingSha(
  url: string,
  opts: { requestTimeoutMs?: number } = {},
): Promise<ServingShaProbe> {
  const requestTimeoutMs = opts.requestTimeoutMs ?? 5_000;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
    if (!res.ok) return { reachable: false, sha: null, error: `status ${res.status}` };
    const body = (await res.json()) as { sha?: string | null };
    return { reachable: true, sha: typeof body.sha === 'string' && body.sha ? body.sha : null };
  } catch (e) {
    return { reachable: false, sha: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface ProbeOpts {
  timeoutMs?: number;
  intervalMs?: number;
  /** Per-request timeout. */
  requestTimeoutMs?: number;
  log?: (s: string) => void;
  /** Also probe POST /api/mcp initialize → 200 event-stream (MCP hardening). */
  probeMcp?: boolean;
  /** Base URL for MCP probe (defaults to url with /api/mcp appended). */
  mcpUrl?: string;
  /**
   * After health (+MCP, if enabled) go green, POST the live memory recall
   * canary (EI-10361) on the freshly-restarted operator — catches a
   * deploy-induced silent recall outage while the automated rollback window
   * is still open, instead of waiting for the next scheduled 05:45 tick.
   * Read-only, ~25 live searches; never retried (a single probe per deploy).
   */
  probeMemoryCanary?: boolean;
  /** Base URL for the canary probe (defaults to url with /api/health
   *  replaced by /api/internal/memory-canary). */
  memoryCanaryUrl?: string;
  /**
   * 'report' (default): a `degraded` canary verdict is attached to the
   * result and logged, but NEVER fails the probe — this is the safe,
   * near-zero-risk default (report-only monitoring, immediate alert via the
   * canary's own notify path, no deploy-pipeline behavior change).
   * 'block': a `degraded` verdict fails the probe (→ deploy rollback, while
   * the DB snapshot is still clean). This changes release-pipeline
   * declare-good semantics — a deliberate owner/release-owner policy flip
   * (PAPERCUSP_MEMORY_CANARY_POLICY=block), never the shipped default.
   */
  memoryCanaryPolicy?: 'report' | 'block';
  /**
   * After health (+MCP, if enabled; after the memory canary, if enabled) go
   * green, POST the deploy-triggered consumer/domain-read canary (EI-856) —
   * catches a lockstep data-move/code-flip half-state (WI-148 class) where
   * `/api/health` stays green but every papercusp domain read 404s/empties.
   * Read-only (one plans:list-equivalent read); never retried.
   */
  probeDomainRead?: boolean;
  /** Base URL for the domain-read canary (defaults to url with /api/health
   *  replaced by /api/internal/domain-read-canary). */
  domainReadUrl?: string;
  /**
   * 'block' (default): an UNREACHABLE probe route OR a REACHABLE-but-EMPTY
   * domain read (the exact WI-148 half-state signature — health green, zero
   * papercusp plans resolvable) fails the probe (→ deploy rollback, while the
   * DB snapshot is still clean). This is the one canary that defaults to
   * blocking (unlike memoryCanaryPolicy) because an empty/unreachable domain
   * read on the operator's OWN home harness is never a legitimate steady
   * state — a fresh install ships seeded plans, and a running deploy target
   * always has plan history.
   * 'report': the verdict is attached + logged but never fails the probe —
   * an explicit downgrade for an environment that genuinely has zero plans
   * (e.g. a from-scratch smoke rig with no seed).
   */
  domainReadPolicy?: 'report' | 'block';
}

/**
 * POST the deploy-triggered memory-canary probe route (memory-canary-probe.ts)
 * and normalize its response. Never throws — a transport failure or
 * malformed response is reported as `reachable: false`, which the 'report'
 * policy treats as a note, never a probe failure (PASS-WITH-NOTE, mirrored
 * from the route's own contract: an unarmed/broken canary must never look
 * like the deploy itself is unhealthy).
 */
export async function probeMemoryCanaryCheck(
  url: string,
  opts: { requestTimeoutMs?: number; log?: (s: string) => void } = {},
): Promise<MemoryCanaryProbeResult> {
  const requestTimeoutMs = opts.requestTimeoutMs ?? 30_000; // ~25 live searches — generous vs the 5s health/MCP probes
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const body = (await res.json()) as {
      ok?: boolean;
      ran?: boolean;
      status?: 'ok' | 'degraded' | 'decayed' | 'seeded';
      rAt10?: number | null;
      delta?: number | null;
      zeroHitRate?: number | null;
      skipReason?: string;
      error?: string;
    };
    if (!res.ok) {
      return { reachable: false, error: `status ${res.status}` };
    }
    return {
      reachable: true,
      ran: body.ran,
      status: body.status,
      rAt10: body.rAt10,
      delta: body.delta,
      zeroHitRate: body.zeroHitRate,
      skipReason: body.skipReason,
      error: body.error,
    };
  } catch (e) {
    return { reachable: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * POST the deploy-triggered domain-read canary probe route
 * (domain-read-canary.ts, EI-856) and normalize its response. Never throws —
 * a transport failure or malformed response is reported as `reachable: false`,
 * which the 'report' policy treats as a note, never a probe failure
 * (PASS-WITH-NOTE, mirrored from probeMemoryCanaryCheck / the route's own
 * contract: a broken probe apparatus must never itself look like the
 * deploy is unhealthy).
 */
export async function probeDomainReadCheck(
  url: string,
  opts: { requestTimeoutMs?: number; log?: (s: string) => void } = {},
): Promise<DomainReadProbeResult> {
  const requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const body = (await res.json()) as {
      ok?: boolean;
      reachable?: boolean;
      harnessSlug?: string;
      planCount?: number;
      empty?: boolean;
      error?: string;
    };
    if (!res.ok) {
      return { reachable: false, error: `status ${res.status}` };
    }
    return {
      reachable: Boolean(body.reachable),
      harnessSlug: body.harnessSlug,
      planCount: body.planCount,
      empty: body.empty,
      error: body.error,
    };
  } catch (e) {
    return { reachable: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function probeHealth(url: string, opts: ProbeOpts = {}): Promise<HealthResult> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 5_000;
  const started = Date.now();
  let attempts = 0;
  let lastErr: string | undefined;

  while (Date.now() - started < timeoutMs) {
    attempts++;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
      const body = await res.text();
      let ok = false;
      if (res.ok) {
        // Prefer the explicit {ok:true} contract; fall back to any 2xx.
        ok = true;
        try {
          const j = JSON.parse(body) as { ok?: boolean };
          if (j && typeof j.ok === 'boolean') ok = j.ok;
        } catch {
          /* non-JSON 2xx still counts as up */
        }
      } else {
        lastErr = `status ${res.status}`;
      }

      if (!ok) {
        if (!lastErr) lastErr = `2xx but body not ok: ${body.slice(0, 200)}`;
        opts.log?.(`health attempt ${attempts}: ${lastErr ?? 'not ready'}`);
        await sleep(intervalMs);
        continue;
      }

      // If /api/health passed and MCP probing is enabled, test the MCP endpoint.
      if (opts.probeMcp) {
        const mcpProbeResult = await probeMcpInitialize(
          opts.mcpUrl || url.replace('/api/health', '/api/mcp'),
          { requestTimeoutMs, log: opts.log },
        );
        if (!mcpProbeResult.ok) {
          lastErr = `MCP initialization failed: ${mcpProbeResult.error}`;
          opts.log?.(`health attempt ${attempts}: ${lastErr}`);
          await sleep(intervalMs);
          continue;
        }
      }

      // One-shot checks after health(+MCP) go green — never part of the retry
      // loop above (a canary/domain-read failure is not a "not ready yet"
      // condition to poll through). The memory canary (EI-10361) and the
      // domain-read canary (EI-856) are independent + additive: either,
      // neither, or both may run, and each may (under its own explicit
      // policy) fail the probe — accumulated into one `blockReason` so both
      // verdicts are always attached to the result regardless of which one
      // (if any) actually blocks.
      let memoryCanary: MemoryCanaryProbeResult | undefined;
      let domainRead: DomainReadProbeResult | undefined;
      let blockReason: string | undefined;

      if (opts.probeMemoryCanary) {
        const canaryUrl = opts.memoryCanaryUrl || url.replace('/api/health', '/api/internal/memory-canary');
        memoryCanary = await probeMemoryCanaryCheck(canaryUrl, { log: opts.log });
        opts.log?.(
          `memory canary: reachable=${memoryCanary.reachable} ran=${memoryCanary.ran} status=${memoryCanary.status ?? '—'} ` +
            `r@10=${memoryCanary.rAt10 ?? '—'} zeroHit=${memoryCanary.zeroHitRate ?? '—'}`,
        );
        // PASS-WITH-NOTE (mirrors the probe route's own contract): only a
        // REACHED, RAN, DEGRADED verdict — under the explicit 'block' policy
        // — fails the deploy. seeded/decayed/flag-off/unreachable/erroring
        // never block, however the policy is set.
        if (
          opts.memoryCanaryPolicy === 'block' &&
          memoryCanary.reachable &&
          memoryCanary.ran &&
          memoryCanary.status === 'degraded'
        ) {
          blockReason = `memory recall canary degraded (r@10=${memoryCanary.rAt10 ?? '—'}, zeroHitRate=${memoryCanary.zeroHitRate ?? '—'}) — memoryCanaryPolicy=block`;
        }
      }

      if (opts.probeDomainRead) {
        const domainUrl = opts.domainReadUrl || url.replace('/api/health', '/api/internal/domain-read-canary');
        domainRead = await probeDomainReadCheck(domainUrl, { log: opts.log });
        opts.log?.(
          `domain read: reachable=${domainRead.reachable} harness=${domainRead.harnessSlug ?? '—'} ` +
            `planCount=${domainRead.planCount ?? '—'} empty=${domainRead.empty ?? '—'}`,
        );
        // Defaults to 'block' (unlike memoryCanaryPolicy): an UNREACHABLE
        // probe route or a REACHABLE-but-EMPTY domain read on the operator's
        // own home harness is never a legitimate steady state (a fresh
        // install ships seeded plans; a running deploy target has history) —
        // this is the exact WI-148 half-state signature (health green, every
        // papercusp read silently empty). An explicit 'report' downgrade
        // exists for a from-scratch smoke rig that genuinely has zero plans.
        if (!blockReason) {
          const policy = opts.domainReadPolicy ?? 'block';
          if (policy === 'block' && (!domainRead.reachable || domainRead.empty)) {
            blockReason = domainRead.reachable
              ? `domain-read canary found ZERO plans for harness '${domainRead.harnessSlug}' — WI-148 half-state signature (health green, papercusp reads empty) — domainReadPolicy=block`
              : `domain-read canary route unreachable: ${domainRead.error ?? 'unknown'} — domainReadPolicy=block`;
          }
        }
      }

      if (blockReason) {
        return {
          healthy: false,
          status: res.status,
          body,
          attempts,
          elapsedMs: Date.now() - started,
          error: blockReason,
          ...(memoryCanary ? { memoryCanary } : {}),
          ...(domainRead ? { domainRead } : {}),
        };
      }
      return {
        healthy: true,
        status: res.status,
        body,
        attempts,
        elapsedMs: Date.now() - started,
        ...(memoryCanary ? { memoryCanary } : {}),
        ...(domainRead ? { domainRead } : {}),
      };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    opts.log?.(`health attempt ${attempts}: ${lastErr ?? 'not ready'}`);
    await sleep(intervalMs);
  }
  return { healthy: false, attempts, elapsedMs: Date.now() - started, error: lastErr };
}

/**
 * Probe the MCP endpoint with a POST /api/mcp initialize request.
 * Returns ok:true only if the response is 200 with Content-Type: text/event-stream.
 */
async function probeMcpInitialize(
  url: string,
  opts: { requestTimeoutMs?: number; log?: (s: string) => void } = {},
): Promise<{ ok: boolean; error?: string }> {
  const requestTimeoutMs = opts.requestTimeoutMs ?? 5_000;
  try {
    // Minimal MCP initialize request (JSON-RPC).
    const initMessage = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'health-probe', version: '1.0.0' },
      },
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // MCP streamable-HTTP REQUIRES both media types in Accept; a spec-compliant
        // endpoint returns 406 without it (endpoint-route/.../agent-tools/catchall.ts
        // gates on `accept.includes('text/event-stream')`). Omitting this header made
        // the post-deploy probe 406 on every deploy of the strict-MCP code → health
        // check failed → auto-rollback → main froze undeployed. (Verified live: no-Accept
        // → 406; with-Accept → 200 text/event-stream.)
        'accept': 'application/json, text/event-stream',
        'authorization': 'Bearer health-probe',
      },
      body: JSON.stringify(initMessage),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });

    const contentType = res.headers.get('content-type') ?? '';
    if (!res.ok) {
      return { ok: false, error: `status ${res.status}` };
    }
    if (!contentType.includes('text/event-stream')) {
      const body = await res.text();
      return { ok: false, error: `expected text/event-stream, got ${contentType}: ${body.slice(0, 100)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// CLI: `tsx health-probe.ts <url> [timeoutMs]`
if (require.main === module) {
  const url = process.argv[2] ?? 'http://127.0.0.1:3070/api/health';
  const timeoutMs = process.argv[3] ? Number(process.argv[3]) : undefined;
  probeHealth(url, { timeoutMs, log: (s) => console.error(`[health] ${s}`) }).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    // NOT process.exit(): stdout is async on a pipe and exit() does not drain it, so
    // `health-probe | jq` would silently lose the tail of this JSON. Setting exitCode
    // lets the process end naturally with the stream flushed. See
    // scripts/check-undrained-stdout-exit.mjs.
    process.exitCode = r.healthy ? 0 : 1;
  });
}
