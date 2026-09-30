/**
 * maintenance-carry — the deterministic PRODUCER for the P-017 omp swap-in
 * (deterministic-context-carry-2026-07-14, Phase 6).
 *
 * P-017's terminal shape: when a papercusp-owned omp session compacts, the
 * "summary" it folds in is papercusp's DETERMINISTIC carry document (D-002 —
 * papercusp-owned deterministic assembly replaces the native LLM summarizer),
 * NOT an LLM oneshot.
 *
 * The delivery SEAM this rides is the one omp ALREADY ships, so P-017 needs no
 * omp bundle patch (D-009 — the version-bumping `dist/cli.js` is never
 * byte-patched; same rationale as D-008's re-scope of P-003) and no extension
 * file: omp's `compaction.remoteEndpoint` client posts `{ systemPrompt?, prompt }`
 * to the gateway's /maintenance/summarize and reads back `{ summary }` (the P-002
 * maintenance lane, pinned by omp-bundle-contract.test.ts). For a session that
 * opts in, that endpoint returns THIS deterministic document in place of a model
 * call — the summarizer's LLM oneshot becomes a pure DB assembly.
 *
 * The session whose context is compacting is identified by the ownerId, because
 * omp's remote-compaction client sends ONLY `content-type: application/json`
 * (pi-agent-core `requestRemoteCompaction` — no owner header). psu-launcher, which
 * holds the ownerId when it writes the config, encodes it in the remoteEndpoint
 * URL (a loopback su-id, not PII — the same shape as the existing `?model=` param
 * on /maintenance/backend-context).
 *
 * THIS module is the deterministic half that both the eventual live gateway
 * wiring AND its tests share: ownerId → {@link buildCarryDoc} → {@link renderCarryDoc}
 * → the `{ summary }` shape omp expects, held to the constant budget B
 * ({@link carryDocBudgetChars}). The LIVE actuation half — the gateway branch that
 * reads the URL param and the psu-launcher opt-in that points sessions at it —
 * rides the Phase-7 cold-boot drills (P-020), exactly like carry-respawn.ts's
 * live legs: a deterministic-carry swap must be drilled before it replaces a live
 * fleet's compaction path, and it lands DEFAULT-OFF.
 *
 * Returning `null` is the load-bearing safety contract: it means "no deterministic
 * document — fall back to the existing LLM summarizer", so a build miss NEVER
 * strands a compaction. Every failure path funnels to `null`, never a throw.
 */
import {
  type BuildCarryDocOpts,
  type CarryDoc,
  buildCarryDoc,
  carryDocBudgetChars,
  renderCarryDoc,
} from './carry-doc';

/** The deterministic summary the gateway returns in place of an LLM oneshot. */
export interface MaintenanceCarrySummary {
  /**
   * The rendered deterministic carry document — the string omp folds in as the
   * compaction summary (its remote-compaction client reads `.summary`).
   */
  summary: string;
  /**
   * Always true — lets the gateway tag the response so telemetry can tell a
   * deterministic carry from an LLM summary (and a test assert the branch fired).
   */
  deterministic: true;
  /** The char budget B the document was held to (carryDocBudgetChars(window)). */
  budgetChars: number;
}

export interface MaintenanceCarryOpts {
  /**
   * The omp session's EFFECTIVE window in TOKENS (P-005) when psu-launcher can
   * supply it (it probes the backend window at config time via
   * /maintenance/backend-context). Absent / ≤0 ⇒ the budget floors to one
   * coherent verbatim tail ({@link carryDocBudgetChars}), a safe minimum handoff.
   */
  effectiveWindowTokens?: number;
  /** Render clock (testability); defaults to now. */
  now?: number;
  /**
   * Extra {@link buildCarryDoc} inputs psu-launcher can thread through the
   * remoteEndpoint URL (workspaceId, harness, account, ownerLabel, transcriptPath,
   * …). `boundaryDeliberate` is FORCED to false unless a caller explicitly sets it:
   * a compaction is a forced cut from the summarizer's view (omp hit its threshold
   * and is cutting now), and a forced tail is the safe under-promise (P-010 — a
   * successor trusts it less). A transcript path is not usually supplied here
   * because omp KEEPS its recent messages in-context after compaction (the summary
   * replaces only the older ones), so the verbatim tail is largely redundant with
   * omp's own retention.
   */
  buildOpts?: BuildCarryDocOpts;
  /** Test seam — the document builder. Defaults to the real {@link buildCarryDoc}. */
  buildFn?: (ownerId: string, opts?: BuildCarryDocOpts) => Promise<CarryDoc>;
  /** Test seam — the renderer. Defaults to the real {@link renderCarryDoc}. */
  renderFn?: typeof renderCarryDoc;
}

/**
 * Render an already-built carry document to the `{ summary }` shape omp expects,
 * held to the constant budget B. PURE (mirrors carry-respawn.ts): every input is
 * already assembled + bounded by {@link buildCarryDoc}. Returns `null` when the
 * render yields no usable text — the caller's signal to fall back to the LLM
 * summarizer rather than fold an empty summary.
 */
export function renderMaintenanceCarrySummary(
  doc: CarryDoc,
  opts: { effectiveWindowTokens?: number; now?: number; renderFn?: typeof renderCarryDoc } = {},
): MaintenanceCarrySummary | null {
  const budgetChars = carryDocBudgetChars(opts.effectiveWindowTokens ?? 0);
  const render = opts.renderFn ?? renderCarryDoc;
  const summary = render(doc, opts.now ?? Date.now(), { budgetChars }).trim();
  if (!summary) return null;
  return { summary, deterministic: true, budgetChars };
}

/**
 * Build the deterministic maintenance carry summary for `ownerId`: the impure
 * edge the gateway calls with just the ownerId parsed from the remoteEndpoint
 * URL. Assembles the document ({@link buildCarryDoc}) then renders it
 * ({@link renderMaintenanceCarrySummary}).
 *
 * FAIL-SOFT by contract: a blank ownerId, a throwing build/render, or an empty
 * document all return `null` — never a throw — so the caller falls back to the
 * existing LLM summarizer and a deterministic-carry miss cannot strand a live
 * compaction.
 */
export async function buildMaintenanceCarrySummary(
  ownerId: string,
  opts: MaintenanceCarryOpts = {},
): Promise<MaintenanceCarrySummary | null> {
  if (!ownerId || !ownerId.trim()) return null;
  try {
    const build = opts.buildFn ?? buildCarryDoc;
    // boundaryDeliberate defaults false (a compaction is a forced cut); a caller
    // may override via buildOpts, but the safe default wins when it is absent.
    const doc = await build(ownerId.trim(), { boundaryDeliberate: false, ...opts.buildOpts });
    return renderMaintenanceCarrySummary(doc, {
      effectiveWindowTokens: opts.effectiveWindowTokens,
      now: opts.now,
      renderFn: opts.renderFn,
    });
  } catch {
    // Fail-soft: the caller falls back to the LLM summarizer. A deterministic
    // carry miss must never break a compaction.
    return null;
  }
}
