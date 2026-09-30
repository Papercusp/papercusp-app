/**
 * curation:feed — the READ projection of the curator-operator's salience policy,
 * for a dashboard consumer (pui-fleet-status-view-2026-06-04 D-006, "curated"
 * mode).
 *
 * The curation LOOP (curator-operator-2026-06-04) surfaces salient signals into
 * the operator conversation on a cadence (flag-gated, writes the curation-log).
 * This tool is the complementary PULL surface: it runs the SAME gather
 * (`gatherFleetSignals` over the production `buildFleetReaders`) and the SAME
 * per-signal `baseDisposition`, and returns the classified signals so a dashboard
 * can render "what matters across the fleet right now". It does NOT run the loop,
 * write the curation-log, surface into the chat, or need the
 * PAPERCUSP_DBOS_CURATION flag — it's a pure read of the current salient state.
 *
 * It deliberately OMITS the loop's idempotency overlay (already-surfaced →
 * suppress): a dashboard shows the current salient state, not one-time surfaces.
 *
 * Read-only, additive, reuses curator-operator's modules unchanged. Loads on the
 * next :3070 restart like any new tool.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { gatherFleetSignals } from '../../curation/fleet-signals';
import { buildFleetReaders } from '../../curation/deps';
import {
  baseDisposition,
  dropTriagedHandledSignals,
  SALIENCE_POLICY_VERSION,
  type Disposition,
  type FleetSignal,
  type FleetSignalKind,
} from '../../curation/salience-policy';
import { readTriagedHandledItemIds } from '../../attention/triage-store';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 300;

/** One classified signal as the dashboard renders it. */
export interface FeedRow {
  id: string;
  kind: FleetSignalKind;
  title: string;
  detail: string | null;
  harness: string | null;
  severity: 'blocker' | 'question' | 'advisory' | null;
  ref: string | null;
  ts: string;
  disposition: Disposition;
  urgent: boolean;
}

export interface FeedOpts {
  harness?: string;
  surfaceOnly?: boolean;
  limit?: number;
}

/**
 * Classify + filter + rank gathered signals for the dashboard. Pure (no I/O), so
 * it's unit-testable without a database. Each signal gets its `baseDisposition`
 * (NO idempotency overlay — this is a current-state read), is optionally filtered
 * by harness / to surface-disposition only, then ranked: urgent first, then
 * surface-before-batch, then newest (the gather already sorted newest-first, so a
 * stable sort preserves recency within a tier).
 */
export function rankFleetFeed(signals: readonly FleetSignal[], opts: FeedOpts = {}): FeedRow[] {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  let rows: FeedRow[] = signals.map((s) => {
    const base = baseDisposition(s.kind, s.userRequested);
    return {
      id: s.id,
      kind: s.kind,
      title: s.title,
      detail: s.detail ?? null,
      harness: s.harness ?? null,
      severity: s.severity ?? null,
      ref: s.ref ?? null,
      ts: s.ts,
      disposition: base.disposition,
      urgent: base.urgent,
    };
  });
  if (opts.harness) rows = rows.filter((r) => r.harness === opts.harness);
  if (opts.surfaceOnly) rows = rows.filter((r) => r.disposition === 'surface');

  const dispRank: Record<Disposition, number> = { surface: 0, batch: 1, suppress: 2 };
  return rows
    .map((r, i) => ({ r, i })) // index keeps the sort stable (recency within a tier)
    .sort((a, b) => {
      if (a.r.urgent !== b.r.urgent) return a.r.urgent ? -1 : 1;
      if (a.r.disposition !== b.r.disposition) return dispRank[a.r.disposition] - dispRank[b.r.disposition];
      return a.i - b.i;
    })
    .map(({ r }) => r)
    .slice(0, limit);
}

export default defineTool({
  name: 'curation:feed',
  description:
    "Pull the curator-operator's salience-ranked fleet signals (escalations / blockers / decisions-needed / completions / progress) — the READ projection of the salience policy for a dashboard. A pure read of the CURRENT salient state (no loop, no chat-surface, no flag); the pui Fleet 'curated' view consumes this.",
  capability: 'curation:read',
  guidance: {
    when: "You want the curator's view of what matters across the fleet right now — the salience-ranked signals (escalations, blockers, decisions owed, recent completions) for a dashboard or status read. Pass surfaceOnly to get just the always-surface signals; harness to scope to one project.",
    notWhen:
      "For the raw tool-call firehose use activity:recent / the activity stream. To make the operator SURFACE a message into the chat, that's the curation loop (flag-gated), not this read.",
    seeAlso: [
      'curation:change-feed (the rolled-up steering view)',
      'activity:recent (the raw tool-call firehose)',
    ],
  },
  requirePrincipal: false,
  args: z.object({
    /** Filter to one harness (omit for fleet-wide). */
    harness: z.string().max(256).optional(),
    /** Only the surface-disposition signals (escalations/blockers/decisions/user-completions). */
    surfaceOnly: z.boolean().optional(),
    /** Max signals returned (default 100, max 300). */
    limit: z.number().int().positive().max(MAX_LIMIT).optional(),
  }),
  async handler(args) {
    const signals = await gatherFleetSignals(buildFleetReaders());
    // EI-1687: exclude items the operator triaged to "handled" (downgrade/resolve)
    // so a handled escalation does not re-surface as "open" every read/wake.
    const handled = await readTriagedHandledItemIds();
    const rows = rankFleetFeed(dropTriagedHandledSignals(signals, handled), {
      harness: args.harness,
      surfaceOnly: args.surfaceOnly,
      limit: args.limit,
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ signals: rows, count: rows.length, policyVersion: SALIENCE_POLICY_VERSION }),
        },
      ],
    };
  },
});
