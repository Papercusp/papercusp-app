/**
 * MODEL + EFFORT — which brain this chat's session is running on, as a
 * ChatModeAction axis (hud-chat-owner-controls-2026-08-11 P-002, WI-6510).
 *
 * [owner 2026-07-27, verbatim] "Add a buttons to the bottom of the chat to
 * change the model and effort level"
 *
 * A PILL in the `config` band, beside ACCT and CTX (D-005/D-009 §A): the model a
 * session runs on is a value that is currently something plus the control that
 * changes it — exactly what a mode-action is.
 *
 * ── ONE AXIS, NOT TWO (D-007) ──
 * The owner said "model and effort level", but they are NOT independent axes.
 * Effort rides the model spec as `<model>[:<effort>]`, and effort-WITHOUT-model
 * is an explicit error in `composeLaunchModelSpec`. psu has no `--effort` flag at
 * all, so emitting one separately is WARNED AND DROPPED by its parseArgs — a
 * silent no-op that would pass every test while changing nothing. So this is one
 * compound control whose options are whole specs, and the spec is never
 * assembled here: the tier menu already carries composed specs, and psu's own
 * resume path splits the tail per backend (psu-launcher.mjs:1197 →
 * `modelArgsFor`: claude → `--model X --effort Y`, codex → `-c
 * model_reasoning_effort`, omp verbatim). Composing at that seam is the one form
 * every backend honours.
 *
 * ── WHY THIS FORKS RATHER THAN RESUMING IN PLACE ──
 * D-007 branch 1: `psu --resume … --model` CARRIES conversation context across a
 * changed spec, so changing model does not throw the conversation away. But the
 * session this popup is attached to is, by construction, the one the owner is
 * talking to — usually still LIVE — and two processes resuming the same session
 * id collide. That collision is precisely what WI-3882's `--fork-session` exists
 * to avoid, and psu threads the fork flag and the model spec through the SAME
 * argv, so they compose.
 *
 * So a pick BRANCHES: a new session, carrying this conversation, on the chosen
 * model; the current one keeps running, untouched. That is both halves of the
 * ruling at once — context carries (branch 1), and what the owner gets is a new
 * session on a different model.
 *
 * ── WHAT THE PILL IS ALLOWED TO CLAIM ──
 * Never that the CURRENT session changed model — it did not, and cannot: a
 * running CLI cannot be re-pointed at another model in place. The label says a
 * new session is opened (D-002: a control that appears to re-point the session
 * when it does not is the silent no-op this plan exists to prevent). And per
 * D-009 §B the value rendered is always the EFFECTIVE one read back off the
 * session's own launch argv, never the value that was picked.
 */
import { fetchSyncQuery } from '@papercusp/sync';
import {
  DEFAULT_MODEL_TIERS,
  modelSpecFromArgv,
  splitModelSpec,
  type ModelTier,
} from '@papercusp/operator-core/lib/agent-config-constants';
import { registerChatModeAction } from './registry';
import { resumableSessionId, type SessionActionCtx } from './SessionActions';
import type { ChatModeOption } from './types';

/** What `current()` reports when the launch argv names no model — the session
 *  runs whatever the backend defaults to. `__`-prefixed so it can never collide
 *  with a real model spec. */
const MODEL_DEFAULT = '__backend-default';

/**
 * Read the model spec off the context, distinguishing the two absences.
 *
 * `undefined` — the roster row carries no `launchArgv` at all (an older
 * operator, or a mid-deploy SSE push). The value is UNKNOWN, and D-005 §5 is
 * explicit that unknown means NO PILL rather than a plausible guess.
 * `null` — the argv was read and names no model: the backend default.
 *
 * Exported for test.
 */
export function readModelSpec(ctx: SessionActionCtx): string | null | undefined {
  const argv = (ctx as { launchArgv?: unknown }).launchArgv;
  if (argv === undefined) return undefined;
  /*
   * An EMPTY argv is UNKNOWN, not "no --model".
   *
   * It looks like the third case — argv read, no model named — but it is not,
   * and the difference is visible in the writer: adv-roster's active tier is
   * `launchArgv: adv?.launchArgv ?? []`, so a session with NO adv_sessions row
   * at all (launch-su's terminal path records none) arrives here as `[]`. Every
   * session that DOES have a launch record has a non-empty argv — the binary is
   * always argv[0]. So an empty array carries no evidence about the model, and
   * rendering it as "default" would state a fact about a launch we never saw
   * (D-005 §5). No pill instead.
   */
  if (Array.isArray(argv) && argv.length === 0) return undefined;
  return modelSpecFromArgv(argv);
}

/** The menu, given the workspace tier list. Pure — exported so the row set is
 *  testable without a fetch. */
export function modelOptions(tiers: readonly ModelTier[]): ChatModeOption[] {
  /* An empty/absent workspace menu is not an empty control: DEFAULT_MODEL_TIERS
     is the menu the rest of the system falls back to, so falling back here keeps
     the pill offering the same specs a spawn would actually get. */
  const menu = tiers.length > 0 ? tiers : DEFAULT_MODEL_TIERS;
  return menu.map((t) => {
    const { model, effort } = splitModelSpec(t.spec);
    return {
      id: t.spec,
      /* Tier NAME leads because that is the vocabulary the owner's own menu is
         written in; the spec follows because the tier name alone does not say
         which brain you get. */
      label: `${t.name} · ${model ?? t.spec}${effort ? ` (${effort} effort)` : ''}`,
      /* The tier's own `when` line is USER-AUTHORED guidance about when to pick
         it — the best hint available, and better than anything invented here. */
      hint: t.when,
    };
  });
}

/** POST the fork-onto-a-new-model launch. Exported for tests.
 *
 *  Deliberately the SAME endpoint the shipped resume/fork buttons already use
 *  (`SessionActions.launchInNewTerminal`) rather than a second poster: this is
 *  that same launch with one more field, and the leader's admin-proxy auth trap
 *  (cross-owner identity refusal) does not reach it — this route is not an admin
 *  proxy. */
export async function forkOntoModel(ctx: SessionActionCtx, spec: string): Promise<void> {
  const sessionId = resumableSessionId(ctx);
  if (!sessionId) throw new Error('no resumable session id');
  const label = ctx.ownerLabel ?? ctx.sessionOwnerId;
  const res = await fetch('/api/agent-mcp/console/launch', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({
      resumeSessionId: sessionId,
      /* See the module header: the source session is live, so this BRANCHES
         instead of resuming in place. */
      fork: true,
      resumeModel: spec,
      label: `${spec} · ${label}`,
    }),
  });
  const data = (await res.json().catch(() => null)) as { status?: string; error?: string } | null;
  if (!res.ok || data?.status !== 'ok') {
    /* The route turns the envelope's non-claude refusal into a 400 carrying its
       reason, so a refused model change SAYS SO rather than opening a session
       that quietly kept the old model. */
    throw new Error(`model change failed: ${data?.error ?? `HTTP ${res.status}`}`);
  }
}

registerChatModeAction({
  id: 'mode-model',
  cap: 'MODEL',
  /* Same cluster as ACCT and CTX: posture says what the agent IS, these say what
     it RUNS ON. */
  group: 'config',
  available: (ctx) => {
    const c = ctx as SessionActionCtx;
    if (!c.sessionOwnerId) return false;
    /* A missing roster row is not yet evidence that this axis is inapplicable:
       while the shared read is in flight, show a disabled loading pill. Once
       it resolves, the backend/session checks below remain authoritative. */
    if (c.rosterReadState === 'loading') return true;
    /* claude-only, and for a mechanism reason rather than caution: codex and omp
       resumes exec the bare CLI, so the envelope refuses a model there instead
       of dropping the flag silently. Offering a pill that can only throw would
       be the same lie one layer up. */
    if (c.agent !== 'claude') return false;
    if (!resumableSessionId(c)) return false;
    /* UNKNOWN ⇒ no pill (D-005 §5). */
    return readModelSpec(c) !== undefined;
  },
  /* PURE + sync (D-005 §6): the spec is parsed straight off the roster row the
     surface already rendered from. Sourcing `launchArgv` ONTO that row
     (adv-roster.ts) is what makes this possible without a per-agent lookup. */
  current: (ctx) => {
    if (ctx.rosterReadState === 'loading') {
      return {
        value: 'loading…',
        on: false,
        loading: true,
        title: 'Loading this session\'s model and effort…',
      };
    }
    const spec = readModelSpec(ctx as SessionActionCtx);
    if (!spec) {
      return {
        value: 'default',
        optionId: MODEL_DEFAULT,
        on: false,
        title:
          'This session was launched with no explicit --model, so it runs the backend default. Picking a model opens a NEW session carrying this conversation.',
      };
    }
    const { model, effort } = splitModelSpec(spec);
    return {
      /* The whole spec, not a prettified subset: the `[1m]` window marker and the
         effort tail both change what you are talking to, and a display that drops
         either would misreport the session. */
      value: spec,
      optionId: spec,
      on: true,
      title: `Running ${model ?? spec}${effort ? ` at ${effort} effort` : ' at the model default effort'}. Read from this session's own launch arguments. Picking a model opens a NEW session carrying this conversation; this one keeps running.`,
    };
  },
  /* The workspace's tier menu is user-authored and grows, so the list scrolls and
     filters rather than being a fixed short set (D-005 §4). */
  searchable: true,
  searchPlaceholder: 'Search models…',
  /* Async + LAZY: resolved by the bar on menu open, so a popup where nobody
     changes model pays no `agentConfig.modelTiersBaseline` query. */
  options: async () =>
    modelOptions(
      await fetchSyncQuery<ModelTier>({ queryName: 'agentConfig.modelTiersBaseline', args: {} }),
    ),
  set: async (ctx, optionId) => {
    /* Belt and braces with `current()`: the default row is a REPORTED state, not
       a settable one — there is no "launch with no model" to switch back to
       without naming a model. */
    if (optionId === MODEL_DEFAULT) {
      throw new Error(
        'The backend default is what this session already runs — pick a specific model to branch onto.',
      );
    }
    await forkOntoModel(ctx as SessionActionCtx, optionId);
    /* No optimistic echo (D-009 §B). The new session's own launch argv is the
       truth and flows back through the roster on the next push; writing a
       predicted value here is how a control starts lying. */
  },
});
