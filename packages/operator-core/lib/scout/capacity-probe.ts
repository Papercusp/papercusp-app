/**
 * capacity-probe.ts — read-only gateway pool probes for the Scout layer (WI-5391 Part B).
 *
 * One raw snapshot reader, two consumers with DIFFERENT failure semantics:
 *
 *   - ROUTING (register-scout-action.ts `readScoutProviderCapacity`) derives booleans and
 *     fails OPEN to the historical Claude route when the probe is unavailable — never send
 *     Scout into an unknown provider on missing evidence.
 *   - AUDIT (scheduler.ts record-time discrimination) needs a TRISTATE: a failed probe is
 *     `undefined` (no contradiction possible — trust the denial's attestation), never a
 *     fabricated "available". Collapsing probe-failure into either boolean is exactly the
 *     evidence-free classification WI-5391 exists to remove.
 *
 * The snapshot is persisted verbatim into the scout tick detail on capacity-shaped
 * failures, so every exclusion from the error metric is retro-auditable: a 'no-capacity'
 * gate recorded while `healthyAccounts > 0` is the WI-4541 admission-defect signature.
 */

export interface ScoutPoolSnapshot {
  /** Epoch ms the gateway was probed — pairs with the failure instant for audit. */
  probedAtMs: number;
  /** Gateway `/stats.healthyAccounts` (Claude pool serviceable denominator); absent when the field was missing. */
  healthyAccounts?: number;
  /** Gateway `/stats.codexHealthyAccounts`; absent when the field was missing. */
  codexHealthyAccounts?: number;
  /** Gateway `/admin/config.providers.codex.configured === true`. */
  codexConfigured: boolean;
  /** Gateway `/admin/config.providers.codex.cliAccountCount`; absent when the field was missing. */
  codexCliAccountCount?: number;
}

/** Which provider routes Scout could actually reach, derived from one snapshot. */
export interface ScoutRoutableProviders {
  claudeAvailable: boolean;
  codexAvailable: boolean;
}

/**
 * The PURE derivation of "which routes are reachable" from an already-read snapshot.
 *
 * Extracted so the ROUTING path (`readScoutProviderCapacity`) and the P-016 cycle-top
 * PRECHECK share ONE definition of available. They previously could not disagree only
 * because just one of them existed; with two callers, a second inline copy of these
 * booleans is exactly the drift that makes a precheck refuse a cycle the router would
 * happily have run (or vice versa).
 *
 * Takes a snapshot rather than probing: the precheck must judge the SAME reading it
 * stamps on the tick, not a second probe taken a moment later.
 */
export function scoutRoutableProviders(snapshot: ScoutPoolSnapshot): ScoutRoutableProviders {
  return {
    claudeAvailable: typeof snapshot.healthyAccounts === 'number' && snapshot.healthyAccounts > 0,
    codexAvailable:
      snapshot.codexConfigured && ((snapshot.codexCliAccountCount ?? 0) > 0 || (snapshot.codexHealthyAccounts ?? 0) > 0),
  };
}

/**
 * Is this snapshot AFFIRMATIVE evidence that Scout has no route at all? (P-016 gate.)
 *
 * Deliberately a STRICTER bar than `scoutRoutableProviders`, and the difference is the
 * whole point — it is the same split capacity-probe already draws between its two
 * consumers, one level down:
 *
 *   - ROUTING asks "should I send this call to claude?" and a missing `healthyAccounts`
 *     is reason enough to prefer another route. Being wrong costs a re-route.
 *   - THE GATE asks "should I refuse to run at all?" and being wrong SILENCES THE
 *     PRODUCER. So it requires the gateway to have actually SAID zero
 *     (`healthyAccounts === 0`), never merely to have omitted the field.
 *
 * Codex reuses the routing derivation unchanged: `codexConfigured:false` IS an affirmative
 * statement from `/admin/config`, not an absence.
 */
export function scoutPoolAffirmativelyExhausted(snapshot: ScoutPoolSnapshot): boolean {
  const claudeSaidZero = typeof snapshot.healthyAccounts === 'number' && snapshot.healthyAccounts === 0;
  return claudeSaidZero && !scoutRoutableProviders(snapshot).codexAvailable;
}

/** One provider entry from the gateway's `/admin/config`, in either reported shape. */
interface GatewayProviderConfig {
  configured?: unknown;
  cliAccountCount?: unknown;
}

/**
 * Find one provider's config in `/admin/config.providers`, which the gateway reports as an
 * ARRAY of `{ id, configured, cliAccountCount, … }` entries.
 *
 * WHY THIS EXISTS (WI-38225 — measured live 2026-08-12, not theorised): this module used to
 * do `config.providers?.codex`, typed as a keyed object. `providers` is a LIST, so that
 * expression is `undefined` on EVERY probe — which set `codexConfigured: false`
 * unconditionally, regardless of the gateway's actual answer. The consequence was not a
 * cosmetic flag: `codexAvailable` is `codexConfigured && …`, so it could never be true,
 * `resolveScoutModel` could never select the codex fallback, and Scout was left with exactly
 * ONE usable route — dying whenever the claude pool emptied while a healthy, configured codex
 * account sat unused. Every failing tick recorded the tell:
 * `{ healthyAccounts: 0, codexHealthyAccounts: 1, codexConfigured: false }` — the count read
 * from `/stats` was right, and only the flag that gates the fallback was wrong.
 *
 * BOTH SHAPES are accepted deliberately. The array is what this gateway returns today; the
 * keyed object is what the old type asserted, and a probe that silently disables a provider
 * when the shape moves is precisely the failure being fixed. An unknown shape yields
 * `undefined`, which keeps the caller's existing "not configured" reading rather than
 * inventing availability.
 */
function findProviderConfig(providers: unknown, id: string): GatewayProviderConfig | undefined {
  if (Array.isArray(providers)) {
    return providers.find(
      (entry): entry is GatewayProviderConfig & { id: string } =>
        typeof entry === 'object' && entry !== null && (entry as { id?: unknown }).id === id,
    );
  }
  if (typeof providers === 'object' && providers !== null) {
    const entry = (providers as Record<string, unknown>)[id];
    return typeof entry === 'object' && entry !== null ? (entry as GatewayProviderConfig) : undefined;
  }
  return undefined;
}

/**
 * Probe the localhost pacing gateway's pool state without changing any routing state.
 * Returns `undefined` when either probe fails or times out (~1s) — the TRISTATE unknown,
 * deliberately distinct from "no healthy accounts".
 */
export async function readScoutPoolSnapshot(fetchImpl: typeof fetch = fetch): Promise<ScoutPoolSnapshot | undefined> {
  const base = `http://127.0.0.1:${Number(process.env.PAPERCUSP_GATEWAY_PORT) || 8788}`;
  try {
    const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(1_000) : undefined;
    const [statsRes, configRes] = await Promise.all([
      fetchImpl(`${base}/stats`, signal ? { signal } : undefined),
      fetchImpl(`${base}/admin/config`, signal ? { signal } : undefined),
    ]);
    if (!statsRes.ok || !configRes.ok) return undefined;
    const stats = (await statsRes.json()) as { healthyAccounts?: unknown; codexHealthyAccounts?: unknown };
    const config = (await configRes.json()) as { providers?: unknown };
    const codex = findProviderConfig(config.providers, 'codex');
    return {
      probedAtMs: Date.now(),
      ...(typeof stats.healthyAccounts === 'number' ? { healthyAccounts: stats.healthyAccounts } : {}),
      ...(typeof stats.codexHealthyAccounts === 'number' ? { codexHealthyAccounts: stats.codexHealthyAccounts } : {}),
      codexConfigured: codex?.configured === true,
      ...(typeof codex?.cliAccountCount === 'number' ? { codexCliAccountCount: codex.cliAccountCount } : {}),
    };
  } catch {
    return undefined;
  }
}
