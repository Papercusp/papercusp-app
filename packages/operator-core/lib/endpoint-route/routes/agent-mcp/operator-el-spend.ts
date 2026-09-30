/**
 * GET /api/agent-mcp/operator-el-spend — current-month ElevenLabs Conv-AI usage.
 * Ported from app/api/agent-mcp/operator-el-spend/route.ts. `auth: 'public'`.
 */
import { withWorkspace } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../../workspace-registry';
import { loadVoicePrefs } from '../../../voice-prefs';
import { readElevenLabsKey } from '../../../voice-credentials';
import { TtlMap } from '../../../ttl-map';
import { defineTool } from '@papercusp/agent-mcp';

interface SpendCacheEntry {
  secsUsed: number;
  source: 'elevenlabs' | 'pg-fallback';
}
const SPEND_CACHE_TTL_MS = 60_000;
// Keyed by EL agent id — cardinality is tiny, but stale ids must not pin
// entries forever (audit P-004 / EI-127 class).
const spendCache = new TtlMap<SpendCacheEntry>({ ttlMs: SPEND_CACHE_TTL_MS, maxEntries: 64 });

interface ElConversation {
  call_duration_seconds?: number;
  callDurationSeconds?: number;
  start_time_unix_secs?: number;
}
interface ElConversationsPage {
  conversations: ElConversation[];
  has_more?: boolean;
  hasMore?: boolean;
  next_cursor?: string | null;
  nextCursor?: string | null;
}

function localYm(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function localMonthStartUnixSecs(): number {
  const d = new Date();
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
  return Math.floor(monthStart.getTime() / 1000);
}

async function fetchElSpendSecs(
  agentId: string,
  apiKey: string,
  monthStartUnix: number,
): Promise<number> {
  let cursor: string | undefined;
  let totalSecs = 0;
  let pageCount = 0;
  while (true) {
    const u = new URL('https://api.elevenlabs.io/v1/convai/conversations');
    u.searchParams.set('agent_id', agentId);
    u.searchParams.set('call_start_after_unix', String(monthStartUnix));
    u.searchParams.set('page_size', '100');
    u.searchParams.set('summary_mode', 'exclude');
    if (cursor) u.searchParams.set('cursor', cursor);
    const res = await fetch(u.toString(), {
      headers: { 'xi-api-key': apiKey, 'accept': 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      throw new Error(`el-list ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    }
    const data = (await res.json()) as ElConversationsPage;
    const convs = Array.isArray(data.conversations) ? data.conversations : [];
    for (const c of convs) {
      const d = c.call_duration_seconds ?? c.callDurationSeconds ?? 0;
      if (typeof d === 'number' && Number.isFinite(d) && d > 0) totalSecs += d;
    }
    const hasMore = (data.has_more ?? data.hasMore) === true;
    const next = data.next_cursor ?? data.nextCursor ?? null;
    pageCount += 1;
    if (!hasMore || !next || pageCount >= 20) break;
    cursor = next;
  }
  return totalSecs;
}

async function fetchPgFallbackSecs(workspace: string, ym: string): Promise<number> {
  try {
    return await withWorkspace(workspace, async (tx) => {
      const rows = await tx`
        SELECT COALESCE(SUM(duration_secs), 0)::int AS total
        FROM harness_shared.el_conv_calls
        WHERE ym = ${ym}
      `;
      return Number(rows[0]?.total ?? 0);
    });
  } catch (e: unknown) {
    const msg = (e as Error)?.message ?? String(e);
    if (/relation .*el_conv_calls.* does not exist/i.test(msg)) return 0;
    throw e;
  }
}

export default defineTool({
  method: 'GET',
  path: '/agent-mcp/operator-el-spend',
  auth: 'public',
  async handler() {
    const ym = localYm();
    const workspace = activeWorkspaceId();
    const prefs = await loadVoicePrefs();
    const agentId = prefs.elevenLabsAgentId;
    const minutesCap = prefs.fullAgentMonthlyMinuteCap > 0 ? prefs.fullAgentMonthlyMinuteCap : null;

    if (!agentId) {
      return Response.json({
        minutes_used: 0,
        minutes_cap: minutesCap,
        ym,
        over_cap: false,
        pct_used: minutesCap != null ? 0 : null,
        source: 'no-agent',
      });
    }

    const now = Date.now();
    const cached = spendCache.get(agentId, now);
    let secsUsed: number;
    let source: 'elevenlabs' | 'pg-fallback';

    if (cached) {
      secsUsed = cached.secsUsed;
      source = cached.source;
    } else {
      const apiKey = await readElevenLabsKey();
      if (!apiKey) {
        secsUsed = await fetchPgFallbackSecs(workspace, ym);
        source = 'pg-fallback';
        console.warn('[el-spend] no EL API key configured; using PG fallback');
      } else {
        try {
          secsUsed = await fetchElSpendSecs(agentId, apiKey, localMonthStartUnixSecs());
          source = 'elevenlabs';
        } catch (e: unknown) {
          const msg = (e as Error)?.message ?? String(e);
          console.warn('[el-spend] EL API failed, falling back to PG:', msg.slice(0, 200));
          secsUsed = await fetchPgFallbackSecs(workspace, ym);
          source = 'pg-fallback';
        }
      }
      spendCache.set(agentId, { secsUsed, source }, now);
    }

    const minutesUsed = Math.round(secsUsed / 60);
    const overCap = minutesCap !== null && minutesUsed >= minutesCap;
    const pctUsed = minutesCap !== null ? Math.min(1, minutesUsed / minutesCap) : null;

    return Response.json({
      minutes_used: minutesUsed,
      minutes_cap: minutesCap,
      ym,
      over_cap: overCap,
      pct_used: pctUsed,
      source,
    });
  },
});
