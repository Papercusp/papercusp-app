/**
 * revise.ts — the TARGETED Scout revision path of the Queen↔Scout feedback loop
 * (queen-scout-feedback-loop-2026-06-20, P-001 / D-001 step 3).
 *
 * When the scheduler's cycle-start coord:inbox read (P-001) finds plan-keyed Queen
 * feedback for `scout:<hive>`, the cycle fires OUT-OF-CADENCE (P-002) and the runner
 * (register-scout-action.ts) runs THIS instead of a fresh ideation cycle: for each
 * routed DRAFT the Queen gave feedback on, load it, ask the LLM to REVISE it to
 * address the feedback, and write the revision back (a new plan version — the
 * `harness_plans` upsert bumps version + records the revision). The runner then
 * pings the Queen back so she re-reviews (D-001 step 3 / D-003 #1).
 *
 * Why a SEPARATE path (not the normal ideation cycle): a revision-request tick must
 * NOT ideate fresh drafts — that would route NEW plans instead of revising the one
 * the Queen is iterating on (and would starve the loop). The revision is a
 * deterministic plan edit + one focused LLM rewrite, so it lives here, pure over an
 * injected {@link ScoutLlmCall} + the plan-lock seam (fake-testable, $0).
 *
 * BOUNDARY: this owns the revision MECHANISM. The convergence JUDGMENT (when to keep
 * iterating vs. finalize-ready vs. deprecate; the "still making progress?" heuristics)
 * is the Queen+Scout role-prompt guidance (P-005, sibling brief) — it composes on top
 * of this. The revision PROMPT below is the minimal functional seam; P-005 may refine
 * it without re-deriving the mechanism.
 */

import { withPlanLock as realWithPlanLock } from '../agent-tools/plans/with-plan-lock';
import { SCOUT_FEEDBACK_LOOP_GUIDANCE } from './feedback-loop-prompt';
import type { ScoutLlmCall } from './types';
import type { ScoutCycleLike } from './scheduler';
import type { ScoutRevisionRequest } from './scheduler';
import { DEFAULT_SCOUT_REVISION_MODEL } from './models';

/** Default model for the revision rewrite — the synthesis-tier model the recombine
 *  step uses (cheaper than the opus ideators; revision is synthesis, not divergence). */
export const DEFAULT_REVISION_MODEL = DEFAULT_SCOUT_REVISION_MODEL;

/**
 * What happened to one draft this revision tick.
 *   - revised   — success (the draft was rewritten).
 *   - missing   — the draft no longer exists (terminal; ack + ping).
 *   - unchanged — the LLM returned no change (terminal; ack + ping).
 *   - rejected  — the LLM produced an UNUSABLE output (declined / non-plan); terminal,
 *                 ack + ping (retrying a deterministic non-plan would loop forever).
 *   - error     — a TRANSIENT failure (llmCall threw / plan busy); retryable. When
 *                 EVERY item is `error`, the cycle THROWS so the tick retries (no ack).
 */
export type RevisionStatus = 'revised' | 'missing' | 'unchanged' | 'rejected' | 'error';

/** Per-feedback-item revision outcome (the runner pings the Queen back from these). */
export interface RevisionOutcome {
  planSlug: string;
  /** The Queen owner that sent the feedback — the ping-back recipient. */
  fromOwnerId: string;
  /** The feedback msg_id (for the ping-back thread + the scheduler's ack). */
  msgId: string;
  status: RevisionStatus;
  costUsd: number;
  /** One line for the ping-back / tick observability. */
  note: string;
}

/**
 * A revision tick's result. Structurally a {@link ScoutCycleLike} (so the runner
 * returns it where the scheduler expects a cycle — `provenance: []` because a
 * revision routes nothing NEW, it edits an existing draft) PLUS the per-item
 * `revisions` the runner uses to ping the Queen back.
 */
export interface ScoutRevisionResult extends ScoutCycleLike {
  revisions: RevisionOutcome[];
}

export interface ScoutReviseDeps {
  /** The injected LLM call (the gym:judge pattern; faked in tests). */
  llmCall: ScoutLlmCall;
  /** Plan lock+read+write seam (default = the real one). Faked in tests. */
  withPlanLock?: typeof realWithPlanLock;
  /** Workspace the DRAFT plans live under — scout drafts are pinned to the DEFAULT
   *  workspace (register-scout-action.ts), so the revision must read/write there too. */
  planWorkspaceId: string;
  /** The hive slug (plan scope + intent labeling). */
  harnessSlug: string;
  /** Model for the rewrite (default {@link DEFAULT_REVISION_MODEL}). */
  model?: string;
  /** Max output tokens for the rewrite (default 8000 — a plan is small). */
  maxTokens?: number;
}

// The Scout-side protocol/discipline is the CANONICAL guidance authored by the
// P-005 sibling brief (feedback-loop-prompt.ts) — B3 "carries the TEXT" into the
// revision per that module's contract. We prepend it as the discipline, then add
// the mechanical-output constraints for THIS deterministic single-rewrite step
// (the Scout cycle is a deterministic pipeline, run.ts D-009 — no tool access in a
// step; the wiring records the revision + pings the Queen, so the rewrite must
// emit ONLY the revised plan, never a tool call / deprecation note).
const REVISION_SYSTEM = `${SCOUT_FEEDBACK_LOOP_GUIDANCE}

---

## This step — the mechanical revision (output contract)

You are running ONE targeted revision pass as a deterministic pipeline step. You have NO tools here: the wiring records your revision and pings the reviewing steward back for you. So:
- Output ONLY the full revised plan as Markdown. No preamble, no commentary, no code fences, no tool calls.
- PRESERVE the YAML frontmatter block (the leading --- ... --- ), including slug, status: draft, and origin. You MAY refine the title and bump the updated date.
- INTEGRATE the feedback — sharpen the Now/Background and add/fix Phase items + Decisions as it directs. Do not blindly append; weave it in. Keep the plan HONEST (don't overclaim or invent results).
- Keep it a valid plan: the same section structure (## Now / ## Background / ## Phase … / ## Decisions).
- If you conclude the PREMISE itself is flawed (not just execution), you cannot deprecate from this step — instead state plainly IN THE ## Now BLOCK that the premise looks unsound and why, so the reviewing steward can deprecate. Never emit a deprecation note in place of the plan.`;

/** Build the revision user prompt from the current plan body + the Queen's feedback. */
export function revisionUserPrompt(currentPlan: string, feedback: string): string {
  return [
    '# The current DRAFT plan',
    '',
    currentPlan,
    '',
    "# The Queen's feedback to address",
    '',
    feedback.trim() || '(no body — treat the act of feedback as "this needs another pass"; tighten the weakest part.)',
    '',
    '# Task',
    'Revise the plan above to address the feedback. Return the full revised Markdown only.',
  ].join('\n');
}

/**
 * Cheap guard: a revision must still LOOK like the plan it replaces — a leading YAML
 * frontmatter block AND the plan's own slug somewhere in it. Defends against an LLM
 * that returns prose / an apology / a truncated body instead of the plan (we refuse
 * to overwrite a real draft with garbage).
 */
export function looksLikePlanMarkdown(md: string, slug: string): boolean {
  const t = md.trim();
  if (!t.startsWith('---')) return false; // frontmatter block
  if (t.length < 40) return false; // not a plausible plan
  return t.includes(slug); // the slug survived the rewrite
}

/**
 * Run a targeted revision over the Queen's feedback items (P-001). One focused LLM
 * rewrite per draft, defensive per item (one failure never aborts the batch — the
 * ideators.ts discipline). Returns the per-item outcomes + the cycle-shaped totals.
 *
 * THROWS only when EVERY item errored (and there was ≥1) — a total failure should
 * trip the tick's error/backpressure path (no ack, retry next tick); partial
 * progress returns normally so the scheduler acks the consumed feedback.
 */
export async function runScoutRevisionCycle(
  feedback: readonly ScoutRevisionRequest[],
  deps: ScoutReviseDeps,
): Promise<ScoutRevisionResult> {
  const withPlanLock = deps.withPlanLock ?? realWithPlanLock;
  const model = deps.model ?? DEFAULT_REVISION_MODEL;
  // 16384: server-side thinking counts against this budget (EI-13119 class — see ideators.ts).
  const maxTokens = deps.maxTokens ?? 16384;
  const lockOpts = (slug: string, what: string) => ({
    slug,
    intent: `scout:revise ${what} ${slug} (queen feedback)`,
    workspaceId: deps.planWorkspaceId,
    harnessSlug: deps.harnessSlug,
  });

  const outcomes: RevisionOutcome[] = [];
  let totalCost = 0;

  for (const item of feedback) {
    const base = { planSlug: item.planSlug, fromOwnerId: item.fromOwnerId, msgId: item.msgId };
    try {
      // 1. Read the current draft (newBody:null ⇒ read-only).
      const read = await withPlanLock<string | null>(null, lockOpts(item.planSlug, 'read'), async (current) => ({
        newBody: null,
        value: current,
      }));
      if (read.kind === 'busy') {
        outcomes.push({ ...base, status: 'error', costUsd: 0, note: 'plan busy (concurrent writer) on read' });
        continue;
      }
      const current = read.value;
      if (current === null) {
        outcomes.push({ ...base, status: 'missing', costUsd: 0, note: 'draft no longer exists' });
        continue;
      }

      // 2. One focused LLM rewrite addressing the feedback.
      const res = await deps.llmCall({
        model,
        system: REVISION_SYSTEM,
        messages: [{ role: 'user', content: revisionUserPrompt(current, item.body) }],
        responseFormat: 'text',
        maxTokens,
      });
      const cost = res.costUsd ?? 0;
      totalCost += cost;
      const revised = (res.text ?? '').trim();

      if (!revised || revised === current.trim()) {
        outcomes.push({ ...base, status: 'unchanged', costUsd: cost, note: 'LLM returned no change' });
        continue;
      }
      if (!looksLikePlanMarkdown(revised, item.planSlug)) {
        // Refuse to overwrite a real draft with a non-plan response. This is a
        // TERMINAL 'rejected' (not a transient 'error'): the output is deterministic
        // for this prompt, so retrying would loop — ack it + ping the Queen instead.
        outcomes.push({ ...base, status: 'rejected', costUsd: cost, note: 'revision did not preserve plan shape — not written' });
        continue;
      }

      // 3. Write the revision back (bumps version + records the revision). The body
      //    is the trimmed rewrite + a single trailing newline (the plan-file convention).
      const newBody = `${revised}\n`;
      const write = await withPlanLock<RevisionStatus>(null, lockOpts(item.planSlug, 'write'), async (cur) => {
        if (cur === null) return { newBody: null, value: 'missing' as RevisionStatus };
        return { newBody, value: 'revised' as RevisionStatus };
      });
      if (write.kind === 'busy') {
        outcomes.push({ ...base, status: 'error', costUsd: cost, note: 'plan busy (concurrent writer) on write' });
        continue;
      }
      outcomes.push({
        ...base,
        status: write.value,
        costUsd: cost,
        note: write.value === 'revised' ? 'revised to address feedback' : 'draft vanished before write',
      });
    } catch (e) {
      outcomes.push({ ...base, status: 'error', costUsd: 0, note: e instanceof Error ? e.message : String(e) });
    }
  }

  const allErrored = feedback.length > 0 && outcomes.every((o) => o.status === 'error');
  if (allErrored) {
    throw new Error(
      `scout revision failed for all ${feedback.length} draft(s): ` +
        outcomes.map((o) => `${o.planSlug}: ${o.note}`).join('; '),
    );
  }

  return {
    provenance: [],
    costUsd: totalCost,
    ideas: [],
    scored: [],
    survivors: [],
    stop: 'completed',
    revisions: outcomes,
  };
}
