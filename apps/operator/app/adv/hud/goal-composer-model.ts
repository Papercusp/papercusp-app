/**
 * The "+ Start a goal" composer's non-visual half (goals-tab-improvement-2026-08-09 P-015).
 *
 * Validation and the POST live here, apart from the JSX, because both are
 * behaviour worth pinning and neither needs a DOM: the shape of what counts as
 * a submittable draft is worth stating once, and the response parse is a
 * two-layer envelope that has already been hand-rolled once per caller.
 *
 * ONLY `title` IS REQUIRED. [owner 2026-08-09, interactive, verbatim]
 * "when creating a new goal the 'kill this if' and 'ceiling' should not be
 * required properties". This reverses the original P-015 rule, which made both
 * mandatory here on the reasoning that the form was the last place GOAL mode's
 * "kill criterion and ceiling at creation" contract could be enforced. The
 * owner has overruled that trade: a goal you cannot start until you have
 * invented a kill condition is a goal you do not start. `goals:start` accepts
 * both as optional (its zod args are `.optional()`, and `buildGoalKickoffBrief`
 * renders "none declared" lines rather than a fabricated $0.00), so the client
 * and server now agree.
 */
// The only import this otherwise dependency-free module takes, and a cheap one:
// launch-agent.ts's runtime surface is one boolean const plus a function (its
// own imports are `import type`), so pinning the headless rule to the SAME
// constant NewSessionLauncher uses costs nothing and keeps the two owner-facing
// launch surfaces from drifting apart.
import { OWNER_LAUNCH_HEADLESS } from '@papercusp/operator-core/lib/launch-agent';

/** What the form collects, before it becomes tool args. */
export interface GoalComposerDraft {
  /** The outcome, stated so its achievement is checkable. REQUIRED. */
  title: string;
  /** The written condition under which the goal is abandoned. Optional; "" = not declared. */
  killCriterion: string;
  /**
   * The spend ceiling AS TYPED, in dollars — "500", "500.00", "$500".
   * Optional; "" = no ceiling declared. A NON-empty value must still parse:
   * see `validateGoalDraft`.
   */
  ceiling: string;
  /** Optional longer statement: what winning looks like, scope, constraints. */
  body?: string;
}

export interface GoalStartArgs {
  title: string;
  /** Omitted entirely when not declared — never sent as "" or null. */
  killCriterion?: string;
  /** Omitted entirely when not declared — never sent as 0, which would read as a $0 ceiling. */
  budgetCents?: number;
  body?: string;
}

export interface GoalStartRequestIdentity {
  requestKey: string;
  fingerprint: string;
}

/**
 * Reuse a request key only while the validated payload and its filing scope are
 * unchanged. The fingerprint stays client-local; the server independently
 * fingerprints the accepted arguments before persisting the idempotency claim.
 */
export function getGoalStartRequestIdentity(
  args: GoalStartArgs,
  scope: { workspaceId: string; harnessSlug: string },
  previous: GoalStartRequestIdentity | null,
  createKey: () => string = () => globalThis.crypto.randomUUID(),
): GoalStartRequestIdentity {
  const fingerprint = JSON.stringify({
    workspaceId: scope.workspaceId,
    harnessSlug: scope.harnessSlug,
    args: {
      title: args.title,
      killCriterion: args.killCriterion ?? null,
      budgetCents: args.budgetCents ?? null,
      body: args.body ?? null,
    },
  });
  if (previous?.fingerprint === fingerprint) return previous;
  return { requestKey: createKey(), fingerprint };
}

export type GoalDraftValidation =
  | { ok: true; args: GoalStartArgs }
  | { ok: false; errors: Partial<Record<keyof GoalComposerDraft, string>> };

/**
 * Dollars-as-typed → integer cents.
 *
 * Returns null for anything that is not a non-negative amount. Rounds rather
 * than truncates so "0.005" cannot silently become 0 — a ceiling that reads
 * back lower than what was typed is the one rounding direction the owner would
 * be entitled to be annoyed about.
 */
export function ceilingToCents(raw: string): number | null {
  const cleaned = raw.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/**
 * The submittability rule, stated once: TITLE ONLY.
 *
 * Kill criterion and ceiling are optional per the owner directive in this
 * file's header. Two distinctions this function is careful about, because
 * "optional" is easy to over-apply:
 *
 * 1. EMPTY is accepted; MALFORMED is still refused. An empty ceiling means "no
 *    ceiling declared" and is fine. A ceiling of "abc" or "-5" is a typo, and
 *    accepting it by silently dropping it would discard a constraint the owner
 *    DID give — the exact mirror of fabricating one they did not. So a
 *    non-empty ceiling must parse.
 * 2. An undeclared field is OMITTED from the args, never sent as "" or 0.
 *    `budgetCents: 0` would read downstream as a deliberate $0 ceiling — an
 *    instant-kill budget — rather than as "the owner did not set one". This is
 *    why `GoalStartArgs` uses optional keys rather than nullable values.
 */
export function validateGoalDraft(draft: GoalComposerDraft): GoalDraftValidation {
  const errors: Partial<Record<keyof GoalComposerDraft, string>> = {};
  const title = draft.title.trim();
  const killCriterion = draft.killCriterion.trim();
  const ceilingRaw = draft.ceiling.trim();
  // Only parse when something was typed: `null` from an EMPTY string means "not
  // declared", but from a NON-empty one it means "unparseable" — same value,
  // opposite dispositions, so the emptiness test has to come first.
  const cents = ceilingRaw ? ceilingToCents(ceilingRaw) : null;

  if (!title) errors.title = 'State the outcome — what does winning look like?';
  if (ceilingRaw && cents === null) {
    errors.ceiling = 'Enter an amount in dollars, e.g. 500 or 500.00 — or leave it blank for no ceiling.';
  }

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    args: {
      title,
      ...(killCriterion ? { killCriterion } : {}),
      ...(cents === null ? {} : { budgetCents: cents }),
      ...(draft.body?.trim() ? { body: draft.body.trim() } : {}),
    },
  };
}

export type GoalStartResult =
  | { ok: true; goalId: string; agentOwnerId: string | null }
  | { ok: false; error: string };

/**
 * POST the composer to `goals:start`.
 *
 * The projected-tool transport wraps a tool's `data` in an MCP content
 * envelope, so the payload sits one JSON parse deeper than it looks — the same
 * double-parse `postGoalCreate` does in GoalProposalCard.tsx. An `isError`
 * result carries its message as PROSE in that same content slot rather than as
 * `error`, which is why the failure path reads `content[0].text` too: treating
 * a rolled-back launch as an unparseable response would tell the owner nothing
 * about what went wrong.
 *
 * WI-37871 — the goal's agent is spawned HEADLESS, always. The flag rides here
 * rather than in `GoalStartArgs` on purpose: it is a fixed property of THIS
 * transport (the owner-facing composer), not a field of the draft the form
 * collects, so it cannot be surfaced as an option by accident and every caller
 * of this function gets it. See OWNER_LAUNCH_HEADLESS for the directive.
 */
export async function postGoalStart(
  args: GoalStartArgs,
  opts: {
    workspaceId: string;
    harnessSlug: string;
    requestKey: string;
    fetchImpl?: typeof fetch;
  },
): Promise<GoalStartResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const qs = new URLSearchParams({ ws: opts.workspaceId, harness: opts.harnessSlug });
  let text: string;
  let httpOk: boolean;
  let status: number;
  try {
    const r = await doFetch(`/api/agent-tools/goals/start?${qs.toString()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-papercusp-workspace': opts.workspaceId },
      body: JSON.stringify({
        ...args,
        harness: opts.harnessSlug,
        headless: OWNER_LAUNCH_HEADLESS,
        requestKey: opts.requestKey,
      }),
    });
    httpOk = r.ok;
    status = r.status;
    text = await r.text();
  } catch (e) {
    return { ok: false, error: `goals:start — could not reach the operator: ${(e as Error)?.message ?? e}` };
  }
  if (!httpOk) return { ok: false, error: `goals:start → ${status}: ${text.slice(0, 200)}` };

  try {
    const outer = JSON.parse(text) as {
      content?: Array<{ text?: string }>;
      isError?: boolean;
      error?: string | { message?: string };
    };
    const inner = outer.content?.[0]?.text;
    if (outer.error) {
      const msg = typeof outer.error === 'string' ? outer.error : (outer.error.message ?? 'start failed');
      return { ok: false, error: msg };
    }
    // A refusal (bad input, or a spawn that failed and rolled back) comes back
    // as isError + prose. Surface the prose: it names the rollback.
    if (outer.isError) return { ok: false, error: inner?.slice(0, 400) ?? 'goals:start refused the call' };
    if (!inner) return { ok: false, error: 'goals:start returned no content' };

    const data = JSON.parse(inner) as {
      id?: string;
      agent_owner_id?: string;
      degradedReasons?: string[];
    };
    if (!data.id) {
      return { ok: false, error: data.degradedReasons?.join('; ') ?? 'goals:start returned no goal id' };
    }
    return { ok: true, goalId: data.id, agentOwnerId: data.agent_owner_id ?? null };
  } catch {
    return { ok: false, error: `goals:start — unparseable response: ${text.slice(0, 200)}` };
  }
}
