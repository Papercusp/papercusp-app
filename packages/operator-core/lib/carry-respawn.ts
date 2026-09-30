/**
 * carry-respawn — the deterministic producer→consumer BRIDGE for the P-018
 * Claude-Code swap-in (deterministic-context-carry-2026-07-14, Phase 6).
 *
 * P-018's terminal shape is: disable Claude Code's native auto-compact, and have
 * psu watch context %, END the session at a threshold, and RESPAWN a successor
 * "with the built handoff as launch context". The live actuation half (the
 * ctx%-watch, the kill, the actual respawn, the gateway window-guard backstop)
 * runs in the psu-host loop and is verified by the Phase-7 cold-boot drills
 * (P-020). THIS module is the deterministic half that both the eventual live
 * respawn AND session:request-compaction share: given the already-built
 * {@link CarryDoc} (P-009/P-010/P-011 producers) it assembles the two things a
 * respawn actually delivers —
 *
 *   1. the SYSTEM-PROMPT ADDENDUM: the carry document rendered to the constant
 *      budget B ({@link renderCarryDoc} with {@link carryDocBudgetChars}), the
 *      successor's launch context (composeLaunchContext / --append-system-prompt-file);
 *   2. the successor's POSITIONAL FIRST PROMPT: the owner's FINAL message when it
 *      is still OPEN (P-010 "the final owner message becomes the successor's actual
 *      first prompt, never quoted material"), routed through the ONE shared kickoff
 *      source {@link deriveLaunchPromptText} so the respawn path and the plans:launch
 *      path can never drift.
 *
 * plus the P-010 OPEN-OWNER-QUESTION gate ({@link gateOpenOwnerQuestion}) the
 * DELIBERATE-boundary consumer must bounce on once before it cuts.
 *
 * PURE — every input is already assembled + bounded by buildCarryDoc; no DB, no
 * fs, no spawn. That is deliberate: the live respawn actuation (which is not
 * unit-testable without a host) stays in the psu-host; the ASSEMBLY it depends on
 * is testable in isolation here, exactly as the producers are.
 */
import {
  type BuildCarryDocOpts,
  type CarryDoc,
  type OpenOwnerQuestionGate,
  buildCarryDoc,
  carryDocBudgetChars,
  gateOpenOwnerQuestion,
  renderCarryDoc,
  unresolvedOwnerRequests,
} from './carry-doc';
import { deriveLaunchPromptText, type LaunchPlanRef } from './agent-tools/plans/launch-prompt';
import { getLoopCarryNoteWithMeta, shortCarryHash, type LoopCarryNoteWithMeta } from './carry-note';

/** The two artifacts a successor respawn delivers, plus the boundary gate. */
export interface RespawnLaunchSpec {
  /**
   * The carry document rendered to the constant budget B — delivered to the
   * successor as its launch-context system-prompt addendum (the seam
   * composeLaunchContext / `--append-system-prompt-file` already own). Always
   * present: even a minimal session yields the head + continuation + self-recall.
   */
  systemPromptAddendum: string;
  /**
   * The successor's positional first prompt (kickoff), or null.
   *
   * Set to the owner's FINAL message (routed through {@link deriveLaunchPromptText})
   * precisely when that message is still OPEN — `lastOwnerMessage` present AND
   * `answered === false`. That is the P-010 contract: an unanswered owner turn is
   * the one thing a successor must CONTINUE, so it arrives as a live first prompt,
   * never as quoted tail history (a quoted copy reads as already-handled). An
   * ANSWERED owner message (a model turn already followed it) or no owner message
   * at all ⇒ null: the successor opens on the carry doc alone and its loop/AUTO
   * wake picks the work back up — re-delivering a handled message would re-trigger
   * finished work.
   */
  firstPrompt: string | null;
  /** The char budget B the addendum was held to (carryDocBudgetChars(window)). */
  budgetChars: number;
  /**
   * The P-010 open-owner-question gate. When `crossesOpenOwnerMessage` is true a
   * DELIBERATE boundary must refuse ONCE before respawning (do not abandon an open
   * owner question across the cut); a FORCED boundary never trips it (its safety
   * net is exactly `firstPrompt` above — the message is carried, not lost).
   */
  openOwnerQuestion: OpenOwnerQuestionGate;
  /** Work-item ids withdrawn from a preceding machine continuation in the tail. */
  retractedContinuationRefs?: string[];
  /**
   * Number of still-open questions asked by this session. This is deliberately
   * separate from `openOwnerQuestion.crossesOpenOwnerMessage`: the P-010 gate
   * is about an unanswered human turn in the transcript, while an open
   * `coord:ask-owner` conversation lives in the conversation ledger and is
   * otherwise invisible to the transcript-tail predicate. The compaction tool
   * reports both kinds of open owner work to its caller.
   */
  openOwnerAskCount?: number;
  /** Final carry-note freshness verdict when the live adapter performed its
   * delivery-boundary re-read. */
  carryNoteFreshness?: CarryNoteFreshness;
}

export interface CarryNoteSnapshotIdentity {
  /** The short hash of the full note body, or null for a confirmed empty note. */
  bodyHash: string | null;
  /** The note's committed write instant, when available. */
  updatedAtMs: number | null;
  /** True only when the note reader failed rather than finding an empty note. */
  readFailed: boolean;
}

export type CarryNoteFreshnessStatus = 'equal' | 'superseded' | 'unable-to-verify';

export interface CarryNoteFreshness {
  status: CarryNoteFreshnessStatus;
  snapshot: CarryNoteSnapshotIdentity;
  live: CarryNoteSnapshotIdentity;
  /** Identity fields that differed between the two reads. */
  changedFields: string[];
}

/**
 * Normalize a carry-note read to the identity used at the delivery boundary.
 * Hashing keeps the comparison independent of the clipped text that may be
 * rendered into the prompt, while readFailed remains distinct from a confirmed
 * empty note.
 */
export function carryNoteSnapshotIdentity(
  meta: LoopCarryNoteWithMeta | null | undefined,
): CarryNoteSnapshotIdentity {
  const readFailed = meta?.readFailed === true;
  const body = !readFailed && typeof meta?.note === 'string' && meta.note.length > 0 ? meta.note : null;
  const updatedAtMs =
    typeof meta?.updatedAtMs === 'number' && Number.isFinite(meta.updatedAtMs) ? meta.updatedAtMs : null;
  return {
    bodyHash: body === null ? null : shortCarryHash(body),
    updatedAtMs,
    readFailed,
  };
}

/** Compare the carry-note captured while building a document with its final
 * delivery-boundary read. Any confirmed identity change is conservative
 * SUPERSEDED guidance; either read failure is unable-to-verify guidance. */
export function compareCarryNoteFreshness(
  snapshot: CarryNoteSnapshotIdentity,
  live: CarryNoteSnapshotIdentity,
): CarryNoteFreshness {
  const changedFields: string[] = [];
  if (snapshot.bodyHash !== live.bodyHash) changedFields.push('bodyHash');
  if (snapshot.updatedAtMs !== live.updatedAtMs) changedFields.push('updatedAtMs');
  if (snapshot.readFailed !== live.readFailed) changedFields.push('readFailed');
  const equal = changedFields.length === 0;
  const status: CarryNoteFreshnessStatus =
    live.readFailed || snapshot.readFailed ? 'unable-to-verify' : equal ? 'equal' : 'superseded';
  return { status, snapshot, live, changedFields };
}

function formatCarryNoteSnapshotIdentity(identity: CarryNoteSnapshotIdentity): string {
  return `bodyHash=${identity.bodyHash ?? 'null'}, updatedAtMs=${identity.updatedAtMs ?? 'null'}, ` +
    `readStatus=${identity.readFailed ? 'failed' : 'ok'}`;
}

/** Render the minimum high-priority guidance needed when a carry-note snapshot
 * is no longer safe to present as authoritative. */
export function renderCarryNoteFreshnessWarning(freshness?: CarryNoteFreshness): string {
  if (!freshness || freshness.status === 'equal') return '';
  if (freshness.status === 'unable-to-verify') {
    const cause = freshness.live.readFailed
      ? 'the final live loop:checkpoint read failed'
      : 'the carry-note snapshot was unreadable';
    return (
      `⚠ CARRIED LOOP CHECKS UNABLE-TO-VERIFY — ${cause}; this is NOT confirmation that the ` +
      `embedded checks are absent or current. Do not act on any carried check until you read ` +
      `loop:checkpoint directly and reconcile the live state.`
    );
  }
  return (
    `⚠ CARRIED LOOP CHECKS SUPERSEDED — the live loop:checkpoint differs from the snapshot used ` +
    `to build this carry document (changed: ${freshness.changedFields.join(', ') || 'unknown'}; ` +
    `snapshot: ${formatCarryNoteSnapshotIdentity(freshness.snapshot)}; live: ` +
    `${formatCarryNoteSnapshotIdentity(freshness.live)}). Read the live loop:checkpoint before ` +
    `acting on any embedded check; the carried checks may be stale or contradicted.`
  );
}

export interface BuildRespawnLaunchSpecInput {
  /** The already-assembled carry document (buildCarryDoc). */
  doc: CarryDoc;
  /** The session's EFFECTIVE window in TOKENS (min(backend n_ctx, configured
   *  limit) — P-005). The caller resolves it from the per-session model registry;
   *  the budget B derives from it (carryDocBudgetChars), keeping this pure. */
  effectiveWindowTokens: number;
  /** Render clock (testability); defaults to now. */
  now?: number;
  /** AUTO mode of the RESPAWNED session — threaded to deriveLaunchPromptText.
   *  Inert when an owner message is delivered verbatim (the note-present branch),
   *  but kept explicit for the plan-pointer wording + future callers. Default true
   *  (a respawn is unattended by construction). */
  autoMode?: boolean;
  /** The plan the successor is bound to, if any — appends the exact `plans:get`
   *  pointer to the first prompt (deriveLaunchPromptText), so a plan-bound
   *  successor never has to recover the slug from context. */
  plan?: LaunchPlanRef | null;
  /** Optional delivery-boundary comparison produced by the live adapter. */
  carryNoteFreshness?: CarryNoteFreshness;
}

/** Live adapter inputs. The deterministic assembly remains in
 * {@link buildRespawnLaunchSpec}; this wrapper only resolves an owner through
 * the already-defined carry-document producer and fails soft for the watcher. */
export interface BuildOwnerRespawnLaunchSpecOpts
  extends Omit<BuildRespawnLaunchSpecInput, 'doc'> {
  /** Effective tool-session role, threaded into the carry document so role-
   * aware recovery text can be selected at the render boundary. */
  role?: string | null;
  /** Session/transcript/workspace inputs owned by the live watcher. A threshold
   * boundary is deliberate by default; callers can explicitly mark a forced cut. */
  buildOpts?: BuildCarryDocOpts;
  /** Test seam. */
  buildFn?: (ownerId: string, opts?: BuildCarryDocOpts) => Promise<CarryDoc>;
  /** Delivery-boundary live re-read. Defaults to the canonical reader when the
   * canonical document builder is used; custom builders should inject this seam
   * when they exercise loop-note freshness. */
  refreshLoopCarryNoteWithMetaFn?: (
    ref: Parameters<typeof getLoopCarryNoteWithMeta>[0],
  ) => Promise<LoopCarryNoteWithMeta>;
}

/**
 * Assemble the {@link RespawnLaunchSpec} from a built carry document. Pure and
 * deterministic — the single place the P-009/P-010/P-011 producers become the
 * concrete inputs a P-018 respawn (or a session:request-compaction bounce) needs.
 */
export function buildRespawnLaunchSpec(input: BuildRespawnLaunchSpecInput): RespawnLaunchSpec {
  const { doc, effectiveWindowTokens, plan } = input;
  const now = input.now ?? Date.now();
  const autoMode = input.autoMode ?? true;

  const budgetChars = carryDocBudgetChars(effectiveWindowTokens);
  const freshnessWarning = renderCarryNoteFreshnessWarning(input.carryNoteFreshness);
  // Keep the warning inside the same constant budget as the carry document. The
  // aging ladder sheds lower-priority slots to make room for this safety signal.
  const renderBudget = freshnessWarning
    ? Math.max(1, budgetChars - freshnessWarning.length - 2)
    : budgetChars;
  const renderedCarryDoc = renderCarryDoc(doc, now, { budgetChars: renderBudget });
  const systemPromptAddendum = freshnessWarning
    ? `${freshnessWarning}\n\n${renderedCarryDoc}`
    : renderedCarryDoc;
  const openOwnerQuestion = gateOpenOwnerQuestion(doc.continuation);
  const openOwnerAskCount = doc.asks.length;

  const firstPrompt = deriveRespawnFirstPrompt(doc, autoMode, plan);

  return {
    systemPromptAddendum,
    firstPrompt,
    budgetChars,
    openOwnerQuestion,
    openOwnerAskCount,
    retractedContinuationRefs: doc.retractedContinuationRefs ?? [],
    ...(input.carryNoteFreshness ? { carryNoteFreshness: input.carryNoteFreshness } : {}),
  };
}

/**
 * Build the live successor launch spec for one coordination owner. Returns null
 * on every assembly failure so the caller can leave the current session intact
 * and retain its native/gateway safety backstops.
 */
export async function buildOwnerRespawnLaunchSpec(
  ownerId: string,
  opts: BuildOwnerRespawnLaunchSpecOpts,
): Promise<RespawnLaunchSpec | null> {
  if (!ownerId?.trim()) return null;
  try {
    const build = opts.buildFn ?? buildCarryDoc;
    const buildOpts: BuildCarryDocOpts = {
      boundaryDeliberate: true,
      ...opts.buildOpts,
    };
    if (opts.role !== undefined) buildOpts.role = opts.role;
    const doc = await build(ownerId.trim(), buildOpts);
    let carryNoteFreshness: CarryNoteFreshness | undefined;
    const loop = doc.brief.loop;
    const refreshLoopCarryNoteWithMeta =
      opts.refreshLoopCarryNoteWithMetaFn ??
      opts.buildOpts?.getLoopCarryNoteWithMetaFn ??
      (opts.buildFn ? null : getLoopCarryNoteWithMeta);
    if (loop && refreshLoopCarryNoteWithMeta) {
      const snapshot = carryNoteSnapshotIdentity({
        note: loop.carryNoteReadFailed ? null : loop.carryNote,
        updatedAtMs: loop.carryNoteReadFailed ? null : loop.carryNoteUpdatedAtMs,
        readFailed: loop.carryNoteReadFailed === true,
      });
      const liveMeta = await refreshLoopCarryNoteWithMeta({
        harness: loop.harness,
        ownerId: ownerId.trim(),
        workspaceId: doc.brief.workspaceId ?? opts.buildOpts?.workspaceId,
      }).catch(
        (): LoopCarryNoteWithMeta => ({ note: null, updatedAtMs: null, readFailed: true }),
      );
      carryNoteFreshness = compareCarryNoteFreshness(snapshot, carryNoteSnapshotIdentity(liveMeta));
    }
    return buildRespawnLaunchSpec({
      doc,
      effectiveWindowTokens: opts.effectiveWindowTokens,
      now: opts.now,
      autoMode: opts.autoMode,
      plan: opts.plan,
      carryNoteFreshness,
    });
  } catch {
    return null;
  }
}

/**
 * The P-010 first-prompt rule, isolated + exported for direct testing: the owner's
 * final message becomes the successor's first prompt ONLY when it is OPEN
 * (present + unanswered). A blank owner message (never expected from a real turn,
 * but guarded so it can't fall through to deriveLaunchPromptText's empty-note
 * plan-kickoff branch), an answered message, or no owner message ⇒ null. Pure.
 */
export function deriveRespawnFirstPrompt(
  doc: CarryDoc,
  autoMode = true,
  plan?: LaunchPlanRef | null,
): string | null {
  const { continuation } = doc;
  const pending = unresolvedOwnerRequests(continuation)
    .map((request) => ({ ...request, text: request.text.trim() }))
    .filter((request) => request.text.length > 0);
  if (pending.length === 0) return null;
  const ownerText =
    pending.length === 1
      ? pending[0].text
      : [
          'The following owner requests remain unresolved across this context boundary. ' +
            'Address every request; do not treat one reply as resolving the others.',
          ...pending.map((request, index) =>
            `[Unresolved owner request ${index + 1}${request.requestId ? ` · ${request.requestId}` : ''}]\n${request.text}`
          ),
        ].join('\n\n');
  return deriveLaunchPromptText(ownerText, autoMode, plan ?? null);
}
