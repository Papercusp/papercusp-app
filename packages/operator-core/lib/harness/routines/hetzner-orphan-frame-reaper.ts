/**
 * hetzner-orphan-frame-reaper.ts — WI-1442 fix (c) / WI-1628: the ORPHAN-FRAME
 * REAPER for dead-agent-owned Hetzner rig VMs.
 *
 * The rig lib (`papercusp-desktop/bin/lib/deb-hetzner-rig.sh`) spins up short-lived
 * Hetzner VMs for live federation-testing rigs (name pattern `hzdeb*` / `pcusp-fed-*`).
 * Its own EXIT-trap teardown (`rig_cleanup`) destroys every frame it created — but
 * that trap only fires on a CLEAN shell exit. A hard-killed agent (the fleet-death
 * class WI-1442 diagnosed) never runs its trap, so its frames run forever: a billing
 * leak AND, since the Hetzner project has a PERMANENT 2-server cap, a deadlock that
 * blocks every OTHER live brief from provisioning at all.
 *
 * This module is the pure DECISION core (no network/DB calls of its own — everything
 * arrives via injected `deps`, so the whole reap-or-skip matrix is unit-testable
 * without a real Hetzner account or Postgres). The wiring (real Hetzner client, real
 * coord-presence liveness) lives in `hetzner-orphan-frame-reaper-action.ts`.
 *
 * SAFETY MODEL (deliberately conservative — this destroys real billed VMs):
 *   - Only servers whose NAME matches the rig naming pattern are ever candidates —
 *     nothing else on the Hetzner account is ever touched.
 *   - A frame with NO owner label (created before this fix landed, or by a path that
 *     doesn't set the label) is left alone and reported separately — we destroy
 *     nothing whose ownership we can't verify.
 *   - A frame whose owner's `coord:presence` session is NOT `ended` is left alone —
 *     `live`/`parked`/`recorded`/`unknown` (an owner id that doesn't resolve at all,
 *     e.g. a federated/remote peer) all skip. Only a CONFIRMED-ended owner qualifies.
 *   - Even a confirmed-ended owner's frame is left alone until it clears a minimum age
 *     (`minAgeHours`, default matches the rig's own quota-lock TTL horizon) — a fresh
 *     frame from an owner whose session JUST ended (e.g. a clean-but-slow shutdown
 *     racing the presence read) gets a grace window before being destroyed.
 *   - `dryRun` never calls `destroy` — it only classifies and reports what WOULD
 *     happen, the recommended first bring-up mode (mirrors idle-session-reaper).
 */

import type { SessionState } from '../../agent-tools/coordination/presence-wakeability';

export interface HetznerFrameInfo {
  id: string;
  name: string;
  /** Hetzner labels — `OWNER_LABEL_KEY` carries the creating agent's owner id. */
  labels: Record<string, string>;
  /** ISO creation timestamp, or undefined if the provider didn't report one. */
  createdAt?: string;
}

/** The Hetzner label key `rig_create_server` stamps with the creating agent's
 *  owner id (`PAPERCUSP_SID`, e.g. `su-<uuid>`) — see deb-hetzner-rig.sh. */
export const OWNER_LABEL_KEY = 'pcusp-owner';

/** Rig naming patterns this reaper is authorized to touch — anything else on the
 *  Hetzner account (a real deployed harness frame, an unrelated server) never
 *  matches and is never a candidate. */
export const DEFAULT_RIG_NAME_PATTERNS: readonly RegExp[] = [/^hzdeb/i, /^pcusp-fed-/i];

export function matchesRigNaming(name: string, patterns: readonly RegExp[] = DEFAULT_RIG_NAME_PATTERNS): boolean {
  return patterns.some((p) => p.test(name));
}

/** Node's global `fetch` wraps a transport failure (DNS, connect, reset, timeout)
 *  as `TypeError: fetch failed` with a `cause.code`. These node error codes are the
 *  transient-transport class. HTTP-status errors (a 401 bad token, a 5xx) are NOT
 *  here on purpose — those are surfaced, not silently swallowed. */
const TRANSIENT_NET_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/**
 * True for a TRANSIENT network/transport error reaching an upstream (the `fetch
 * failed` class), which a best-effort periodic sweep should skip-this-tick-and-retry
 * rather than record as a routine failure (EI-6868: a Hetzner connectivity blip was
 * wedging the `hetzner-orphan-frame-reaper` routine every tick with "fetch failed").
 * Genuine failures — a bad token (HTTP 401), an unexpected logic error — return false
 * so they still surface.
 */
export function isTransientNetworkError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
  const name = typeof err.name === 'string' ? err.name : '';
  const message = typeof err.message === 'string' ? err.message : '';
  const code = typeof err.code === 'string' ? err.code : '';
  const causeCode =
    err.cause && typeof err.cause === 'object' && typeof (err.cause as { code?: unknown }).code === 'string'
      ? (err.cause as { code: string }).code
      : '';

  if (name === 'AbortError' || name === 'TimeoutError') return true;
  if (TRANSIENT_NET_CODES.has(code) || TRANSIENT_NET_CODES.has(causeCode)) return true;
  // Node global fetch surfaces transport failures as `TypeError: fetch failed`.
  if (/fetch failed/i.test(message)) return true;
  if (/\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up)\b/i.test(message)) return true;
  return false;
}

export interface OwnerLiveness {
  ownerId: string;
  /** `ended` = confirmed dead (the only state this reaper acts on). Anything else
   *  (including transitional `draining`/`suspect`, or `unknown`) means "don't touch".
   *  Reuse the coordinator's canonical union so new non-terminal states cannot
   *  silently drift this destructive consumer's contract out of sync. */
  sessionState: SessionState | 'unknown';
}

export interface HetznerOrphanReaperDeps {
  /** Every server on the account (already fetched — this module does no filtering
   *  by pattern itself... it does; see below. Kept simple: return everything). */
  listFrames(): Promise<HetznerFrameInfo[]>;
  /** Fresh, per-call liveness for a batch of owner ids (never a cached snapshot —
   *  see recipient-liveness.ts's own rationale for why staleness is dangerous here). */
  resolveOwnerLiveness(ownerIds: readonly string[]): Promise<OwnerLiveness[]>;
  /** Actually destroy one frame. Never called when `dryRun` is true. */
  destroy(id: string): Promise<void>;
  /** Injectable clock (tests pass a fixed instant). */
  now(): number;
  namePatterns?: readonly RegExp[];
  /** Injectable retry backoff sleep (tests pass a no-op so retries run instantly).
   *  Defaults to a real `setTimeout`-based delay. */
  delay?(ms: number): Promise<void>;
}

export interface ReapOptions {
  /** Minimum frame age (hours) before an ended-owner's frame is destroyed — a grace
   *  window against a race between a clean shutdown and the presence read. */
  minAgeHours?: number;
  /** Preview only — classify + report, destroy nothing. */
  dryRun?: boolean;
  /** WI (hetzner-orphan-frame-reaper HTTP-401 flap): the number of `listFrames()`
   *  attempts before a non-transient failure (a bad-token 401, an unexpected 5xx)
   *  is treated as GENUINE and allowed to surface as a routine failure. Previously
   *  ANY single non-network-transient error surfaced immediately — but a real
   *  incident showed Hetzner's own auth path can 401 on a one-off blip (confirmed:
   *  the SAME token succeeded seconds later, with no rotation in between), which
   *  filed/updated a bug EI over a self-healing condition (the exact "phantom
   *  routine-failure" class this reaper's watchdog signal is already known to
   *  produce for network-level errors — this closes the same gap at the
   *  HTTP-status layer). A PERSISTENTLY bad token still fails every attempt and
   *  correctly surfaces after the retries are exhausted — this only absorbs a
   *  one-off flake, it never hides a real credential problem. Default 3.
   */
  maxListAttempts?: number;
}

export const DEFAULT_MIN_AGE_HOURS = 2;
export const DEFAULT_MAX_LIST_ATTEMPTS = 3;
/** Backoff between listFrames() retry attempts (ms) — short, since this only exists
 *  to absorb a one-off upstream blip, not to wait out a real outage (the transient-
 *  network path already skips-and-retries-next-cadence for that). */
const LIST_RETRY_BACKOFF_MS = [300, 900];

async function defaultDelay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ReapResult {
  scanned: number;
  matchedRigNames: number;
  destroyed: string[];
  skippedNoOwnerLabel: string[];
  skippedOwnerAlive: string[];
  skippedTooYoung: string[];
  errors: Array<{ id: string; error: string }>;
  /** Set when `listFrames()` failed with a TRANSIENT network error — the sweep was
   *  skipped cleanly this tick (nothing enumerated, nothing destroyed) instead of
   *  throwing and wedging the routine. Absent on a normal run. */
  listError?: string;
  dryRun: boolean;
}

/**
 * Reap every rig-named Hetzner frame whose owner is confirmed `ended` and old
 * enough. Best-effort per-frame — one destroy failing never aborts the sweep.
 */
export async function reapOrphanedHetznerFrames(
  deps: HetznerOrphanReaperDeps,
  opts: ReapOptions = {},
): Promise<ReapResult> {
  const dryRun = opts.dryRun ?? false;
  const minAgeMs = (opts.minAgeHours ?? DEFAULT_MIN_AGE_HOURS) * 3_600_000;
  const patterns = deps.namePatterns ?? DEFAULT_RIG_NAME_PATTERNS;
  const now = deps.now();

  const out: ReapResult = {
    scanned: 0,
    matchedRigNames: 0,
    destroyed: [],
    skippedNoOwnerLabel: [],
    skippedOwnerAlive: [],
    skippedTooYoung: [],
    errors: [],
    dryRun,
  };

  const maxAttempts = Math.max(1, opts.maxListAttempts ?? DEFAULT_MAX_LIST_ATTEMPTS);
  const delay = deps.delay ?? defaultDelay;
  let all: HetznerFrameInfo[] | undefined;
  let lastNonTransientError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      all = await deps.listFrames();
      lastNonTransientError = undefined;
      break;
    } catch (e) {
      // A transient network blip reaching the upstream (the `fetch failed` class) must
      // NOT wedge this best-effort periodic sweep — skip the tick cleanly and let the
      // next cadence retry (no point burning retries here — the transient-network path
      // already has its own next-cadence retry).
      if (isTransientNetworkError(e)) {
        out.listError = e instanceof Error ? e.message : String(e);
        return out;
      }
      // A non-transient (HTTP-status) failure — e.g. a bad-token 401, an unexpected
      // 5xx — used to surface on the FIRST occurrence. But a real incident showed
      // Hetzner's own auth path can 401 on a one-off blip that clears on the very
      // next call with the SAME (unrotated, still-valid) token — indistinguishable
      // from a genuinely bad token without retrying. Absorb up to `maxAttempts`
      // one-off flakes with a short backoff; only surface once it's PERSISTENT.
      lastNonTransientError = e;
      if (attempt < maxAttempts) await delay(LIST_RETRY_BACKOFF_MS[Math.min(attempt - 1, LIST_RETRY_BACKOFF_MS.length - 1)]);
    }
  }
  if (lastNonTransientError !== undefined) throw lastNonTransientError;
  if (!all) throw new Error('hetzner-orphan-frame-reaper: unreachable — listFrames neither succeeded nor threw');
  out.scanned = all.length;
  const candidates = all.filter((f) => matchesRigNaming(f.name, patterns));
  out.matchedRigNames = candidates.length;
  if (candidates.length === 0) return out;

  const ownerIds = [
    ...new Set(candidates.map((f) => f.labels[OWNER_LABEL_KEY]).filter((v): v is string => Boolean(v))),
  ];
  const liveness = ownerIds.length > 0 ? await deps.resolveOwnerLiveness(ownerIds) : [];
  const livenessByOwner = new Map(liveness.map((l) => [l.ownerId, l.sessionState]));

  for (const f of candidates) {
    const owner = f.labels[OWNER_LABEL_KEY];
    if (!owner) {
      out.skippedNoOwnerLabel.push(f.id);
      continue;
    }
    const state = livenessByOwner.get(owner) ?? 'unknown';
    if (state !== 'ended') {
      out.skippedOwnerAlive.push(f.id);
      continue;
    }
    const ageMs = f.createdAt ? now - Date.parse(f.createdAt) : Number.POSITIVE_INFINITY;
    if (!(ageMs >= minAgeMs)) {
      out.skippedTooYoung.push(f.id);
      continue;
    }
    if (dryRun) {
      out.destroyed.push(f.id); // "would destroy" — dryRun never actually calls destroy()
      continue;
    }
    try {
      await deps.destroy(f.id);
      out.destroyed.push(f.id);
    } catch (e) {
      out.errors.push({ id: f.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return out;
}
