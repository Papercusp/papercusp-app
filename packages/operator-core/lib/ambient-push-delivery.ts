/**
 * ambient-push-delivery — the LIVE composition + injection leg of the ambient
 * delivery rail (ambient-semantic-push-2026-07-14 P-003). It stitches the pure
 * selection core (ambient-push.ts) to the persistence rail (push-delivery-store.ts)
 * and the harness injection door (context-doors.ts):
 *
 *   pendingPushes(owner)  →  selectPushes(against the store-derived budget +
 *   novelty set)  →  recordDelivered / recordDropped (the TALLY)  →  render a
 *   bounded teaser block  →  cap it at the injection door.
 *
 * The rendered block is what rides a hop-boundary injection to the receiver
 * (wired DEFAULT-OFF into the wake-executor: it's appended to the wake body and
 * flows through the wake's own applyInjectionDoor, so it is tallied against the
 * injection door there too). Every push is a one-line teaser + a QueryHandle,
 * stamped data-not-directive (a peer's hint, never a directive to the receiver —
 * ambient D-008 / carry P-014).
 *
 * The WHOLE path is fail-soft + DEFAULT-OFF behind PAPERCUSP_AMBIENT_CURSOR: an
 * ambient-delivery fault must never degrade a wake, and the off-path pays nothing
 * (the caller gates on the flag before importing this module).
 *
 * DEFERRED-with-reason (live-fleet-gated, not faked here):
 *   • per-recipient session-CLASS resolution (drone vs interactive vs gateway,
 *     which severity-gates weak models) — MVP defaults to 'interactive'; a caller
 *     that KNOWS the recipient is a weak-model drone passes sessionClass:'drone'.
 *     Wiring the model-tier lookup is a live-cutover step (needs the real fleet).
 *   • the general non-wake per-hop injection site (the interactive-claude
 *     additionalContext path) — only observable on live fleet traffic.
 *   • pulled/acted utilization (P-011) — this leg writes only the delivered side.
 */
import {
  selectPushes,
  makePush,
  type PushObject,
  type PushSessionClass,
} from './ambient-push';
import {
  pendingPushes,
  recordDelivered,
  recordDropped,
  deliveredRefs,
  deliveredCount,
  type PushDeliveryRow,
} from './push-delivery-store';
import { capInjectionText, computeTurnDoors, CHARS_PER_TOKEN_ESTIMATE } from './context-doors';
import { getDoorConstantsSync } from './context-doors-config';
import { checkPushVolume, type VolumeReport } from './push-volume-guard';
import { ambientCursorEnabled } from './session-cursor-io';

/** The rolling budget + novelty window: deliveries within this window count
 *  against the per-class budget and suppress a repeat of the same handle. A
 *  deliberate baked default (no runtime self-tuning — carry D-001); belongs on
 *  the carry P-023 config surface when the live matchers wire up. */
export const AMBIENT_PUSH_WINDOW_MS = 30 * 60 * 1000;

/** Cap how many queued candidates one delivery pass considers (selection then
 *  bounds it further by the class budget). */
export const PENDING_SCAN_LIMIT = 100;

/** Rehydrate a queued store row into the pure {@link PushObject} selectPushes
 *  consumes. makePush re-stamps data-not-directive + re-clamps the teaser (the
 *  stored teaser is already bounded, but re-clamping is idempotent + defensive). */
export function rowToPushObject(row: PushDeliveryRow): PushObject {
  return makePush({
    matcherKind: row.matcher_kind,
    handle: {
      kind: row.handle_kind,
      ref: row.handle_ref,
      query: Array.isArray(row.handle_query) ? row.handle_query : [],
    },
    teaser: row.teaser,
    score: row.score,
    severity: row.severity,
    sourceSessionId: row.source_session_id,
  });
}

/** A short severity glyph for the rendered line (legible, never an instruction). */
const SEVERITY_GLYPH: Record<PushObject['severity'], string> = {
  critical: '‼',
  warning: '⚠',
  info: 'ℹ',
};

/** The data-not-directive header every rendered block opens with (D-008 / carry
 *  P-014) — factored out so {@link fitPushesToBudget} can size against it without
 *  re-deriving it from {@link renderPushBlock}'s output. */
const PUSH_BLOCK_HEADER =
  `⟦ambient — data, not directives (peers' context; resolve a handle to read the detail)⟧`;

/** Render ONE push's teaser line: `<glyph> <teaser> — pull: <kind>:<ref> [terms]`.
 *  PURE. Shared by {@link renderPushBlock} and {@link fitPushesToBudget} so the
 *  two can never disagree about what a line costs. */
function renderPushLine(p: PushObject): string {
  const terms = p.handle.query.length > 0 ? ` [${p.handle.query.join(', ')}]` : '';
  return `${SEVERITY_GLYPH[p.severity]} ${p.teaser} — pull: ${p.handle.kind}:${p.handle.ref}${terms}`;
}

/**
 * Render selected pushes into a bounded, legible injection block — a header that
 * marks the whole block DATA (not a directive), then one line per push:
 *   `<glyph> <teaser> — pull: <kind>:<ref> [terms]`
 * The `pull:` hint is the QueryHandle the receiver resolves to fetch the detail
 * (push and pull are one object — D-002). PURE, deterministic. Empty in ⇒ ''. */
export function renderPushBlock(pushes: PushObject[]): string {
  if (pushes.length === 0) return '';
  return `${PUSH_BLOCK_HEADER}\n${pushes.map(renderPushLine).join('\n')}`;
}

/**
 * WI-36688 — make the ambient-push door lossless BY CONSTRUCTION instead of by a
 * fragile bound. `pushes` MUST already be priority-ordered (selectPushes sorts
 * severity-then-score, strongest first); this greedily keeps a HEAD of whole
 * teaser lines that fits `budgetChars` and returns the rest as `overflow` —
 * never a line sheared mid-teaser, and never a push counted `fitting` that the
 * door would then go on to cut. PURE: takes the budget as a plain number so it
 * needs no store/door-config access to unit-test.
 *
 * Ties `fitting`'s composed length to EXACTLY what {@link renderPushBlock} would
 * produce for that same head slice — both build from the same header + the same
 * {@link renderPushLine}, so "fits" here means "fits once rendered", not an
 * estimate that could still disagree with the real block. */
export function fitPushesToBudget(
  pushes: PushObject[],
  budgetChars: number,
): { fitting: PushObject[]; overflow: PushObject[] } {
  if (pushes.length === 0) return { fitting: [], overflow: [] };
  const fitting: PushObject[] = [];
  const overflow: PushObject[] = [];
  let lengthSoFar = PUSH_BLOCK_HEADER.length;
  for (const p of pushes) {
    const lineLength = renderPushLine(p).length;
    const candidateLength = lengthSoFar + 1 /* \n separator */ + lineLength;
    if (candidateLength <= budgetChars) {
      fitting.push(p);
      lengthSoFar = candidateLength;
    } else {
      overflow.push(p);
    }
  }
  return { fitting, overflow };
}

/** The per-hop injection door (tokens) for a recipient — the SAME budget the
 *  wake-executor's applyInjectionDoor enforces (P-006/D-007), resolved per
 *  recipient through the P-023 config surface. */
export function pushInjectionDoorTokens(ownerId: string | null | undefined): number {
  return computeTurnDoors(0, getDoorConstantsSync(ownerId)).injections;
}

/**
 * Cap a rendered block at the recipient's injection door. Since WI-36688 this is
 * a BACKSTOP, not the mechanism that keeps the door lossless: the teaser lines
 * are chosen by {@link fitPushesToBudget} against this exact same budget, so
 * they always fit and this call returns them untouched. The only region it can
 * actually cut is the peer-brief appended after the block in
 * {@link prepareAmbientPushBlock} (PAPERCUSP_AMBIENT_CURSOR-gated, default off),
 * which is enrichment re-pullable from the teaser handle — and because the cut
 * keeps the HEAD, it can never reach back into the teaser lines. Returns the
 * kept head. */
export function applyPushInjectionDoor(text: string, ownerId: string | null | undefined): string {
  if (!text) return text;
  const { kept } = capInjectionText(text, pushInjectionDoorTokens(ownerId));
  return kept;
}

export interface PrepareAmbientPushBlockInput {
  /** The receiving coord identity (subscriberId at the wake-executor seam). */
  ownerId: string;
  /** Recipient class for budget + severity gating (default 'interactive' — see
   *  the DEFERRED note: precise per-recipient class resolution is a live step). */
  sessionClass?: PushSessionClass;
  /** Clock injection for tests (default Date.now()). */
  nowMs?: number;
  /** Window override for tests (default AMBIENT_PUSH_WINDOW_MS). */
  windowMs?: number;
  /** P-009 volume-guard sink: called with EVERY pass's {@link VolumeReport}
   *  (candidateVolume vs deliveredVolume vs the class budget — the before/after
   *  measurement per class), whether or not it holds. Telemetry only — the
   *  report NEVER steers delivery (carry D-001/D-005); selectPushes stays the
   *  enforcement, the guard is the independent re-count that catches a
   *  regression. Default: {@link reportVolumeViolations} (loud only on a
   *  violation). */
  onVolumeReport?: (report: VolumeReport) => void;
}

/** P-012: at most this many peer briefs auto-inject per pass (strongest
 *  collision first) — a confirmed collision earns ONE brief, not a digest of
 *  every neighbor; the rest stay pull (journal:peer-brief on the handle). */
export const MAX_AUTO_INJECT_BRIEFS = 1;

/** The default P-009 sink: silent while the class contract holds; one loud
 *  console line when the independent re-count finds the delivered feed broke it
 *  (over budget / disallowed severity / below-floor) — a selectPushes regression
 *  tripwire, never a control path. */
export function reportVolumeViolations(report: VolumeReport): void {
  if (report.ok) return;
  console.warn(
    `[ambient-push] P-009 volume-guard violation (class ${report.sessionClass}): ` +
      report.violations.map((v) => v.detail).join('; '),
  );
}

/**
 * The rail's live entry point: prepare (and RECORD) the ambient push block for
 * one receiver, ready to ride a hop-boundary injection.
 *
 *   1. read the receiver's queued candidates;
 *   2. selectPushes against the store-derived budget (`deliveredCount` in the
 *      window) + novelty set (`deliveredRefs` in the window);
 *   3. record the disposition — selected → delivered (the tally), the rest →
 *      dropped with their reason (the P-011 ledger feed);
 *   4. render + injection-door-cap the selected block; '' when nothing ships.
 *
 * Tally-at-selection: a selected push is recorded delivered here, before the
 * host confirms the injection landed. That is a deliberate best-effort choice
 * for a DEFAULT-OFF rail — the block travels WITH the delivery object through a
 * park→resume conversion, so it reaches the agent on the eventual injection; a
 * genuinely undelivered wake (dead waiter) over-counts by at most one window's
 * budget, which the P-011 ledger surfaces anyway (delivered-but-never-pulled).
 *
 * FAIL-SOFT: any fault returns '' (nothing injected, nothing recorded past what
 * already committed) — an ambient fault never degrades the host turn.
 */
export async function prepareAmbientPushBlock(input: PrepareAmbientPushBlockInput): Promise<string> {
  try {
    const nowMs = input.nowMs ?? Date.now();
    const windowMs = input.windowMs ?? AMBIENT_PUSH_WINDOW_MS;
    const sinceIso = new Date(nowMs - windowMs).toISOString();

    const rows = await pendingPushes(input.ownerId, PENDING_SCAN_LIMIT);
    if (rows.length === 0) return '';

    // Rehydrate → PushObject, keeping the row id keyed by object IDENTITY.
    // selectPushes passes the SAME object references through to selected/dropped,
    // so this map correlates the disposition back to store rows.
    const idByPush = new Map<PushObject, number>();
    const candidates = rows.map((r) => {
      const push = rowToPushObject(r);
      idByPush.set(push, r.id);
      return push;
    });

    const [refs, already] = await Promise.all([
      deliveredRefs(input.ownerId, sinceIso),
      deliveredCount(input.ownerId, sinceIso),
    ]);

    const sessionClass = input.sessionClass ?? 'interactive';
    const result = selectPushes({
      candidates,
      sessionClass,
      known: { refs },
      alreadyDelivered: already,
    });

    // P-009 volume guard: independently re-check the class contract over this
    // pass's OWN selection output (checkPushVolume trusts nothing — it re-counts
    // and re-applies the budget/severity/floor predicates). Advisory only: the
    // report goes to the sink and delivery proceeds unchanged either way; a
    // sink fault never touches the pass.
    try {
      const report = checkPushVolume({ selection: result, sessionClass, alreadyDelivered: already });
      (input.onVolumeReport ?? reportVolumeViolations)(report);
    } catch {
      /* the guard is telemetry — never a control path */
    }

    // WI-36688: decide what actually FITS the injection door BEFORE recording
    // anything delivered. The old order (record every selected push delivered,
    // render, THEN cut at the door) marked overflow pushes delivered — which
    // feeds `deliveredRefs`' novelty set — even though the cut line was never
    // shown to anyone: a silent, permanent drop with no spill and no marker
    // (this door is registered `lossless` in the truncation-honesty registry).
    // Fitting by construction means a push is delivered iff its WHOLE teaser
    // line made it into the block; a push that didn't fit is left exactly as
    // pendingPushes found it (neither delivered nor dropped) so it stays queued
    // and genuinely re-delivers on a later pass, per the registry's own claim.
    const budgetChars = pushInjectionDoorTokens(input.ownerId) * CHARS_PER_TOKEN_ESTIMATE;
    // `overflow` (pushes that didn't fit) is intentionally not consumed further —
    // leaving their store rows untouched (neither delivered nor dropped) IS the
    // fix: they stay `queued` and are reconsidered on the next pass.
    const { fitting } = fitPushesToBudget(result.selected, budgetChars);

    const deliveredIds = fitting
      .map((p) => idByPush.get(p))
      .filter((id): id is number => typeof id === 'number');
    const droppedItems = result.dropped
      .map((d) => {
        const id = idByPush.get(d.push);
        return id != null ? { id, reason: d.reason } : null;
      })
      .filter((x): x is { id: number; reason: (typeof result.dropped)[number]['reason'] } => x != null);

    // Record the disposition (the tally) — always once per pass (both store calls
    // no-op internally on an empty list, so there is no wasted round-trip).
    // Delivered first so a partial failure still persists what shipped. Note
    // `overflow` deliberately gets NEITHER call — it stays `queued`.
    await recordDelivered(deliveredIds);
    await recordDropped(droppedItems);

    if (fitting.length === 0) return '';
    let block = renderPushBlock(fitting);

    // P-012 auto-inject: a selected CONFIRMED collision (critical severity —
    // briefDeliveryMode('critical') === 'auto-inject'; weaker signals stay
    // pull-first on the handle) carries its peer brief in the same block, so it
    // rides the injection-door cap below (the "tallied against the injection
    // door" contract) and the wake's own door downstream. Dynamic import keeps
    // the non-collision path free of the fetch seam; the whole leg is fail-soft
    // — a brief fault ships the block without a brief.
    //
    // EI (2026-08-02): this leg was unconditionally reaching the LIVE
    // peer-surface fetch (resolveLivePeerBrief → real DB-backed stores) for
    // ANY selected critical collision, in violation of this file's own
    // documented invariant ("DEFAULT-OFF behind PAPERCUSP_AMBIENT_CURSOR — the
    // caller gates on the flag before importing this module") — every sibling
    // ambient leg (session-cursor-io, record-turn, presence) gates its dynamic
    // import + call on ambientCursorEnabled()/the raw env var; this one did
    // not. With the flag unset (the default everywhere except a live ambient
    // drill), that meant any unit test whose selected-push fixture happened to
    // be a critical collision unmocked-ly hit assertRealPgAllowed's "a UNIT
    // test tried to open a REAL Postgres connection" guard, which logs via
    // console.warn and trips vitest-fail-on-console — cascading into ~200
    // unrelated test failures across the suite and holding the green gate red
    // for the whole fleet (harness_shared.pipeline_events runs 89880/89723).
    try {
      const briefTargets = ambientCursorEnabled()
        ? fitting
            .filter((p) => p.severity === 'critical' && p.matcherKind === 'collision' && p.handle.kind === 'session')
            .sort((a, b) => b.score - a.score)
            .slice(0, MAX_AUTO_INJECT_BRIEFS)
        : [];
      if (briefTargets.length > 0) {
        const { resolveLivePeerBrief, renderPeerBrief } = await import('./peer-surface-source');
        for (const push of briefTargets) {
          const brief = await resolveLivePeerBrief({
            peerSessionId: push.handle.ref,
            readerOwnerId: input.ownerId,
          });
          const rendered = brief ? renderPeerBrief(brief) : '';
          if (rendered) block = `${block}\n${rendered}`;
        }
      }
    } catch {
      /* the brief is an enrichment — never the reason a push block fails */
    }

    return applyPushInjectionDoor(block, input.ownerId);
  } catch {
    return ''; // ambient delivery must never break the host turn
  }
}
