/**
 * liveness-decoration.ts — WI-1442 fix (a): READ-TIME LIVENESS DECORATION.
 *
 * Plan `## Now` prose (and the launch-context echo of it) frequently names an
 * agent as actively holding something — "WI-1378 actively worked by su-2c799
 * per live presence", "queued behind su-7b1092's Hetzner-quota hold" — but that
 * prose is a point-in-time snapshot the plan author typed. Nothing marks it
 * stale when the named agent's session ends, so a dead agent's claim silently
 * outlives it and misleads every later reader (including a freshly-launched
 * agent whose whole context IS that stale snapshot).
 *
 * The liveness source of truth already exists (coord_presence + the P-001
 * wakeability signals — see presence-wakeability.ts). This module is the thin
 * decoration layer: scan free-text prose for `su-<hex>` agent-id mentions,
 * resolve each UNAMBIGUOUS one against coord_presence at read time, and
 * annotate it inline — e.g. "su-2c799 [ENDED 16:46]" — so the staleness
 * self-discloses to whoever reads the prose next, without mutating the
 * underlying plan file (this only decorates the TOOL OUTPUT, same spirit as
 * plans:get's other read-time overlays like linkedFeatures/planItemTests).
 *
 * Best-effort throughout: a PG hiccup or zero-candidate text returns the
 * input unchanged — this must never break a plan read.
 */

import { getOrgPg } from '@papercusp/db-org';
// Constant-only import from the pure package — see presence-wakeability.ts (WI-39450):
// '../coordination/presence' has module-load side effects and is blanket-mocked by unit
// tests, which strands this constant and crashes collection.
import { PRESENCE_STALE_MS } from '@papercusp/coordination/presence';
import { fetchWakeability } from '../coordination/presence-wakeability';
import { deriveVerdict } from '../coordination/liveness-oracle';
import { recordedLiveOwnerIds } from '../../adv-sessions';

/** Prose commonly carries an abbreviated id (the 4-8 hex-char `ownerLabel`
 *  prefix, e.g. "su-2c799") rather than the full UUID-suffixed ownerId — match
 *  both. Bee/scout ids (`s-...`) are a distinct, shorter prefix; only `su-`
 *  (superuser/session) ids are decorated for now — the class WI-1442 observed. */
const AGENT_ID_RE = /\bsu-[0-9a-f]{4,64}\b/gi;

export interface LivenessDecorationResult {
  text: string;
  /** Count of mentions actually annotated (0 when nothing matched/resolved). */
  decorated: number;
}

/** Pure formatter — exported for unit coverage without a DB round-trip. */
export function formatLivenessTag(state: string, atMs: number | null): string {
  const at = atMs != null && Number.isFinite(atMs) ? new Date(atMs).toISOString().slice(11, 16) : '??:??';
  return `${state.toUpperCase()} ${at}`;
}

/**
 * Scan `text` for `su-*` agent-id mentions and annotate each UNAMBIGUOUSLY
 * resolved one with its coord:presence-derived session state
 * (live/parked/ended/recorded) as of right now — "su-2c799 [ENDED 16:46]".
 *
 * Conservative like the WI-1612 backfill precedent: a token matching MORE
 * THAN ONE coord_presence row (an abbreviated prefix collision) is left
 * undecorated rather than guessed. A token matching NO row (an agent that
 * never registered presence, or a fully-reaped one) is also left undecorated
 * — silence there is not evidence of staleness, just absence of a signal.
 */
export async function decorateAgentLiveness(text: string | null | undefined): Promise<LivenessDecorationResult> {
  if (!text) return { text: text ?? '', decorated: 0 };
  const candidates = new Set<string>();
  for (const m of text.matchAll(AGENT_ID_RE)) candidates.add(m[0].toLowerCase());
  if (candidates.size === 0) return { text, decorated: 0 };

  const tagByToken = new Map<string, string>();
  try {
    const { sql } = getOrgPg();
    const prefixes = [...candidates].map((c) => `${c}%`);
    const rows = await sql<
      { owner_id: string; heartbeat_at: string; last_active_at: string | null }[]
    >`
      SELECT owner_id, heartbeat_at, last_active_at
        FROM harness_shared.coord_presence
       WHERE owner_id ILIKE ANY(${prefixes}::text[])
    `;
    const matchesByToken = new Map<string, typeof rows>();
    for (const token of candidates) {
      const matches = rows.filter((r) => r.owner_id.toLowerCase().startsWith(token));
      if (matches.length === 1) matchesByToken.set(token, matches);
    }
    if (matchesByToken.size > 0) {
      const ownerIds = [...matchesByToken.values()].map((m) => m[0]!.owner_id);
      const [wakeability, recordedLive] = await Promise.all([
        fetchWakeability(ownerIds),
        recordedLiveOwnerIds(ownerIds).catch(() => new Set<string>()),
      ]);
      const now = Date.now();
      for (const [token, matches] of matchesByToken) {
        const row = matches[0]!;
        const w = wakeability.get(row.owner_id) ?? { wakeable: false, liveTurn: false };
        const heartbeatMs = Date.parse(row.heartbeat_at);
        const stale = !Number.isFinite(heartbeatMs) || now - heartbeatMs > PRESENCE_STALE_MS;
        // Unification P-003: ONE derivation via the shared oracle (hardStale
        // zombie ceiling + recorded rescue included).
        const state = deriveVerdict(
          { ownerId: row.owner_id, heartbeatAt: row.heartbeat_at, stale },
          w,
          recordedLive,
          now,
        ).sessionState;
        const lastActiveMs = row.last_active_at ? Date.parse(row.last_active_at) : heartbeatMs;
        tagByToken.set(token, formatLivenessTag(state, Number.isFinite(lastActiveMs) ? lastActiveMs : null));
      }
    }
  } catch {
    return { text, decorated: 0 }; // best-effort — a lookup failure never breaks the read
  }

  if (tagByToken.size === 0) return { text, decorated: 0 };
  let decorated = 0;
  const out = text.replace(AGENT_ID_RE, (m) => {
    const tag = tagByToken.get(m.toLowerCase());
    if (!tag) return m;
    decorated += 1;
    return `${m} [${tag}]`;
  });
  return { text: out, decorated };
}

/** Convenience wrapper for a plan's `{ state, next }` Now block — decorates
 *  both prose fields, best-effort, in one call. Returns a NEW object (never
 *  mutates the input) so callers can pass the parsed plan's block directly. */
export async function decoratePlanNowBlock<T extends { state: string; next: string }>(
  now: T | null,
): Promise<T | null> {
  if (!now) return now;
  try {
    const [state, next] = await Promise.all([
      decorateAgentLiveness(now.state),
      decorateAgentLiveness(now.next),
    ]);
    if (state.decorated === 0 && next.decorated === 0) return now;
    return { ...now, state: state.text, next: next.text };
  } catch {
    return now; // best-effort — never break the caller on a decoration failure
  }
}
