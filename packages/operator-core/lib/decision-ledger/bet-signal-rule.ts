/**
 * `oddsmith:bet-signal` — emit ONE decision-ledger disposition per completed
 * bet-analysis work-item, the PAPERCUSP-NATIVE way (a reaction rule), in-process.
 *
 * WHY HERE (not in the oddsmith engine). An oddsmith-ops analyst BEE prices a market
 * and completes its `bet-analysis` work-item with a `Signal` as the completion's
 * `outputPayload`. That completion is observable on the papercusp side, so the
 * judgment-plane audit (the owner's recent-auto-decisions / signals feed) is recorded
 * RIGHT HERE — a reaction on `work_items:complete` that fires `autonomy:record_disposition`.
 * The reaction runs under the `system:event-reaction` principal with operator authority
 * (dispatch-reaction.ts), so this satisfies D-005 BY CONSTRUCTION: the confined bee's
 * envelope is never widened, and the engine/projector never needs a cross-repo MCP hop.
 * (The prior design emitted from the oddsmith projector — an oddsmith-side cross-repo
 * call. This replaces it.)
 *
 * CONTRACT BOUNDARY. papercusp cannot import `@oddsmith/contracts`, so this hand-maps
 * the handful of scalar `Signal` fields the disposition needs off the (untrusted)
 * `outputPayload` — the SAME mapping `@oddsmith/ops-guard`'s `betSignalToDisposition`
 * owns canonically (keep the two in sync; both are tiny + stable). It does NOT
 * SignalSchema-validate (that stays on the oddsmith projector before the ENGINE
 * insert); the emit is best-effort and degrades gracefully on an off-shape payload.
 *
 * NOTE (placement). This is oddsmith-domain wiring living in shared operator-core,
 * like the `oddsmith:prospect` op. The cleaner long-term home is an oddsmith PLUGIN
 * contribution (`PluginReactionRule`, plugin-sdk) once oddsmith is registered as a
 * papercusp plugin — see the on-papercusp plan (P3).
 */
import { registerReactionRule } from '../events/registry';
import type { ToolInvocationEvent } from '../events/types';

/** The synthetic action verb keying bet-signal rows in the ledger / signals feed. */
export const BET_SIGNAL_ACTION = 'oddsmith:bet-signal';
const BET_ANALYSIS_DOMAIN = 'bet-analysis';

/** The scalar subset of an analyst `Signal` the disposition needs (all defensively read). */
interface BetSignalView {
  itemRef: string;
  side?: string;
  edge?: number;
  confidence?: number;
  modelProb?: number;
  marketProb?: number;
  rationale?: string;
}

function asNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Read the completed bet-analysis Signal off a `work_items:complete` event, or `null`
 * if this completion is not a bet-analysis item carrying an output payload. Uses the
 * single-item completion shape (`result.data = { id, workItem, outputPayload, … }`),
 * matching the reflect-rules precedent — a bee completes one bet-analysis at a time.
 */
export function betSignalView(e: ToolInvocationEvent): BetSignalView | null {
  const data = e.result?.data as
    | { id?: unknown; workItem?: { payload?: unknown } | null; outputPayload?: unknown }
    | undefined;
  if (!data) return null;
  const itemRef = asStr(data.id);
  if (!itemRef) return null;

  // Gate on the create-time input payload's domainKind (set by the prospector).
  const inPayload = (data.workItem?.payload ?? null) as { domainKind?: unknown } | null;
  if (!inPayload || inPayload.domainKind !== BET_ANALYSIS_DOMAIN) return null;

  const out = data.outputPayload;
  if (!out || typeof out !== 'object' || Array.isArray(out)) return null;
  const s = out as Record<string, unknown>;
  return {
    itemRef,
    side: asStr(s.side),
    edge: asNum(s.edge),
    confidence: asNum(s.confidence),
    modelProb: asNum(s.modelProb),
    marketProb: asNum(s.marketProb),
    rationale: asStr(s.rationale),
  };
}

/** Compose the disposition `why` (numeric strength + rationale), clamped to 1000 chars.
 *  Mirrors `@oddsmith/ops-guard`'s `betSignalWhy`. */
export function betSignalWhy(v: BetSignalView): string {
  const parts: string[] = [];
  if (v.edge != null) parts.push(`edge=${v.edge >= 0 ? '+' : ''}${v.edge.toFixed(3)}`);
  if (v.confidence != null) parts.push(`conf=${v.confidence.toFixed(2)}`);
  if (v.modelProb != null) parts.push(`model=${v.modelProb.toFixed(2)}`);
  if (v.marketProb != null) parts.push(`mkt=${v.marketProb.toFixed(2)}`);
  if (v.side) parts.push(v.side);
  const head = parts.join(' ');
  const why = v.rationale ? (head ? `${head} · ${v.rationale}` : v.rationale) : head || 'bet-analysis signal';
  return why.length <= 1000 ? why : `${why.slice(0, 999)}…`;
}

/** The `autonomy:record_disposition` args for a projected bet signal (the tool re-resolves
 *  the AutonomyDecision from these axes). Propose-only + reversible + system authority keep
 *  the row honestly on the judgment plane — it never moves money (D-005). */
export function betSignalDispositionArgs(e: ToolInvocationEvent): Record<string, unknown> {
  const v = betSignalView(e)!; // guarded by `when`
  return {
    action: BET_SIGNAL_ACTION,
    disposition: 'act',
    riskTier: 'low',
    reversibility: 'reversible',
    authority: 'system',
    why: betSignalWhy(v),
    itemRef: v.itemRef,
  };
}

// A bet-analysis completion → one judgment-plane disposition. `mode:'sync'` ⇒ fires
// in-process right after the completion; `onlyOnSuccess` ⇒ never on a failed complete.
registerReactionRule({
  id: 'oddsmith:bet-signal-disposition',
  on: 'work_items:complete',
  when: (e) => betSignalView(e) !== null,
  fire: 'autonomy:record_disposition',
  args: betSignalDispositionArgs,
  onlyOnSuccess: true,
  mode: 'sync',
});
