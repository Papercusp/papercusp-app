/**
 * POST /api/desktop/docs-agent-ask — the desktop tutorial's "ask an agent" ask.
 *
 * Owner redesign (2026-07-06): instead of streaming an answer from a HIDDEN
 * background agent (the /desktop/docs-qa path), the tutorial's `?` ask now
 * launches a FULL, VISIBLE agent session in a real terminal — "just like fleet
 * agents do" — so the user SEES their question and the answer being worked. The
 * opened session is TRACKED, and while its terminal stays open every follow-up
 * question is INJECTED into that SAME live agent via the coordination system
 * (coord:send + wake), so it's ONE persistent docs tutor, not a new spawn per
 * question.
 *
 * Mechanism (reuses the maintained desktop-spawn + coord machinery, NOT a fork):
 *   • LAUNCH — buildConsoleEnvelope + spawnConsole (the capability:terminal /
 *     fleet:launch-on-plan desktop-spawn path) open a visible `psu` superuser
 *     session, seeded with the question as its first user turn (`psu --kickoff`)
 *     and stamped with a stable `--label` so we can find it again.
 *   • TRACK — the launched session's coord owner id lands on its adv_sessions row
 *     (bootstrap-su records it with `coord_owner_id` + our `label`). We correlate
 *     via latestLiveAdvSessionByLabel — no separate state table needed, the
 *     adv_sessions row IS the tracking store (it flips to ended_at on terminal close).
 *   • REUSE — a follow-up finds the live labelled session and delivers the
 *     question to its coord owner via sendMessage + wakeRecipients (wake:true) —
 *     the exact "inject a follow-up via the coord system with wake set to true"
 *     the owner asked for. No live session ⇒ launch a fresh one.
 *
 * Gated on FLAGS.DOCS_QA (default ON — same flag as the docs-qa path it
 * supersedes for the tutorial); OFF ⇒ 404 and the tutorial's keyword search /
 * fallback still work.
 *
 * `auth: {}` — matches the sibling /desktop/* endpoints the tutorial runner and
 * onboarding UI call over loopback.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../../workspace-registry';
import { buildConsoleEnvelope } from '../../../console-launcher';
import { spawnConsole } from '../../../console-spawn';
import { latestLiveAdvSessionByLabel } from '../../../adv-sessions';
import { sendMessage } from '../../../agent-tools/coordination/messages';
import { wakeRecipients } from '../../../agent-tools/coordination/inbox-wake';
import { claudeSignedIn, codexSignedIn, ompSignedIn } from '../../../agent-auth-detect';
import type { AgentIdentity } from '../../../agent-tools/coordination/identity';

const NOT_FOUND = () => new Response(null, { status: 404 });

/** Stable per-workspace label for the tutorial's docs tutor. There is only ever
 *  one live docs tutor per workspace, so a FIXED label is the correlation key. */
export const DOCS_AGENT_LABEL = 'docs-tutor';

async function docsQaEnabled(): Promise<boolean> {
  const { getFlag } = await import('@papercusp/flags/server');
  const { FLAGS } = await import('@papercusp/flags');
  return getFlag(FLAGS.DOCS_QA, 'system');
}

/** Any agent backend the operator can actually drive a turn on? The PAPERCUSP_FAKE_LLM
 *  test seam counts (same gate the docs-qa path uses). A launch with NO backend would
 *  open a dead terminal, so we route the tutorial to Setup instead (needs_backend).
 *  The sign-in probes are synchronous (filesystem checks); guard each so a probe throw
 *  never turns into a false "no backend". */
function anyBackendAvailable(): boolean {
  if (process.env.PAPERCUSP_FAKE_LLM) return true;
  const probe = (fn: () => boolean): boolean => {
    try {
      return fn();
    } catch {
      return false;
    }
  };
  return probe(claudeSignedIn) || probe(codexSignedIn) || probe(ompSignedIn);
}

/**
 * Shell-quote a value for the spawned greetingCmd oneliner: leave a safe token
 * bare, single-quote anything with whitespace / shell metacharacters so a
 * free-form question can never break out of the `psu …` command. Mirrors
 * fleet:launch-on-plan's `shq`. Pure — exported for tests.
 */
export function shq(v: string): string {
  return /^[A-Za-z0-9_.:=/+@-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

/**
 * The first user turn seeded into a freshly-launched docs tutor. Establishes the
 * role (a Papercusp docs assistant for a NEW user), the non-negotiable docs-tool
 * discipline (harness:"all" — the :3070 harness_required derailment fix), the
 * anti-derailment rules, AND that it's a PERSISTENT session that will receive
 * follow-up questions. Baked into the FIRST turn (not a system prompt) so it
 * needs no launch-context file; the session keeps the framing in-context for the
 * coord-delivered follow-ups. Pure — exported for tests.
 */
export function composeDocsAgentKickoff(question: string): string {
  return [
    'You are a Papercusp documentation assistant helping a brand-new user inside the desktop tutorial.',
    'Answer their questions clearly and conversationally, like a knowledgeable teammate.',
    '',
    'HOW TO ANSWER every question (this one and the follow-ups that arrive in your coordination inbox):',
    '1. Search + read our real docs FIRST — `docs:search { harness: "all", query: <the question> }`, then',
    '   `docs:get { harness: "all", slugs: [...] }` on the most relevant pages. The `harness: "all"` argument',
    '   is MANDATORY on every docs:search / docs:get / docs:outline call — omit it and the call is REJECTED',
    '   with `harness_required`. If you ever hit that error, RETRY the SAME call with `harness: "all"`.',
    '2. NEVER ask the user which harness, project, workspace, or scope they are in — always use `harness: "all"`.',
    '3. Treat everyday-sounding words (pot, bee, mug, queen, hive, cup, swarm) as Papercusp jargon FIRST.',
    '4. Answer in a few sentences; cite pages by their `/internal/docs/<slug>` path when useful.',
    '',
    'This is a PERSISTENT session: after you answer, STAY and wait — more questions will arrive as',
    'coordination messages (an inbox inject / wake). Answer each the same way, then wait for the next.',
    '',
    `The user's first question is: ${question}`,
  ].join('\n');
}

/**
 * The `psu` invocation that opens the docs tutor: a scripted (`--no-picker`)
 * superuser claude session with NO plan, stamped with the tracking label. Pure —
 * exported for tests.
 *
 * The free-form first-turn question is NOT a CLI arg here — it's delivered via
 * the PAPERCUSP_KICKOFF_PROMPT env var (see the handler). Historically this
 * dodged buildConsoleOneliner double-single-quoting any quoted greeting and
 * breaking the shell (gnome-terminal exit 2); that builder bug is fixed (the
 * greeting now travels as an eval'd literal), but env delivery stays — a
 * multi-KB prompt has no business on a visible command line. So this command
 * carries ONLY safe slug tokens (workspace ids / the fixed label are bare; shq
 * is a belt-and-braces guard that never actually quotes them).
 */
export function buildDocsAgentPsuCommand(opts: { label: string; workspace: string }): string {
  return [
    'psu',
    '--no-picker',
    '--agent=claude',
    '--no-plan',
    `--workspace=${shq(opts.workspace)}`,
    `--label=${shq(opts.label)}`,
  ].join(' ');
}

/** A synthetic operator identity for the coord send+wake (the follow-up injector
 *  is the operator, not an agent). ownerId shows as the message sender. */
function operatorIdentity(workspaceId: string): AgentIdentity {
  return {
    ownerId: 'operator:docs-tutor',
    ownerLabel: 'Tutorial',
    source: 'static-client',
    workspaceId,
    userId: null,
  };
}

interface AskBody {
  question?: unknown;
  workspace?: unknown;
}

const docsAgentAsk = defineTool({
  method: 'POST',
  path: '/desktop/docs-agent-ask',
  auth: {},
  async handler(req) {
    if (!(await docsQaEnabled())) return NOT_FOUND();
    const body = (await req.json().catch(() => ({}))) as AskBody;
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question) return Response.json({ status: 'error', error: 'question required' }, { status: 400 });
    const workspaceId =
      typeof body.workspace === 'string' && body.workspace.trim() ? body.workspace.trim() : activeWorkspaceId();

    // No signed-in backend ⇒ a launched terminal would be a dead psu shell. Tell
    // the tutorial to route to Setup (same UX as the old needs_backend path).
    if (!anyBackendAvailable()) {
      return Response.json({ status: 'needs_backend' });
    }

    // REUSE: is there a live docs tutor for this workspace? Its coord owner id is
    // on the adv_sessions row (bootstrap-su recorded it with our label). If so,
    // deliver the follow-up to that same agent + wake it — the owner's stated
    // "inject a follow-up via the coord system with wake set to true".
    try {
      const live = await latestLiveAdvSessionByLabel(DOCS_AGENT_LABEL, workspaceId);
      if (live?.coordOwnerId) {
        const identity = operatorIdentity(workspaceId);
        const summary = question.length > 80 ? `${question.slice(0, 77)}…` : question;
        await sendMessage(identity, {
          to: [live.coordOwnerId],
          summary,
          body: question,
          extra: { wake: true },
        });
        const fan = await wakeRecipients([live.coordOwnerId], {
          summary,
          source: identity.ownerId,
          workspaceId,
        }).catch(() => ({ woken: 0 }));
        console.log(
          `[docs-agent-ask] reused owner=${live.coordOwnerId} woken=${fan.woken} q=${JSON.stringify(question).slice(0, 80)}`,
        );
        return Response.json({ status: 'reused', ownerId: live.coordOwnerId, woken: fan.woken });
      }
    } catch (e: any) {
      // A reuse-path hiccup must not block a fresh launch — fall through.
      console.warn(`[docs-agent-ask] reuse lookup failed, launching fresh: ${e?.message ?? e}`);
    }

    // LAUNCH: open a visible psu docs tutor seeded with the question, labelled so
    // the next ask can find + reuse it. Mirrors fleet:launch-on-plan's spawn —
    // base envelope (skip the superuser .mcp.json; psu bootstraps its own user-
    // level MCP), then spawnConsole with our psu greetingCmd.
    let base;
    try {
      base = await buildConsoleEnvelope({
        workspaceId,
        slug: null,
        operatorBaseUrl: new URL(req.url).origin,
        skipMcpJson: true,
      });
    } catch (e: any) {
      return Response.json({ status: 'error', error: `envelope build failed: ${e?.message ?? e}` }, { status: 500 });
    }

    const command = buildDocsAgentPsuCommand({ label: DOCS_AGENT_LABEL, workspace: workspaceId });
    // Deliver the free-form first-turn question via env (spawn-safe — see
    // buildDocsAgentPsuCommand). buildConsoleOneliner exports it with correct
    // shell escaping in the prelude, and psu reads PAPERCUSP_KICKOFF_PROMPT as the
    // kickoff first turn.
    const env = { ...base.env, PAPERCUSP_KICKOFF_PROMPT: composeDocsAgentKickoff(question) };

    const result = await spawnConsole({
      envelope: { ...base, env, greetingCmd: command },
      label: 'Docs tutor',
      writeMcpJson: false,
    });
    if (result.status === 'error') {
      // Desktop-spawn is Linux + macOS only; on Windows the operator runs in WSL
      // and returns 501 — surface it so the renderer can fall back.
      console.warn(`[docs-agent-ask] spawn failed (${result.code}): ${result.error}`);
      return Response.json({ status: 'error', error: result.error }, { status: result.code });
    }
    console.log(`[docs-agent-ask] launched ${result.terminal} pid=${result.pid} ws=${workspaceId}`);
    return Response.json({ status: 'launched', terminal: result.terminal, pid: result.pid });
  },
});

export default docsAgentAsk;
