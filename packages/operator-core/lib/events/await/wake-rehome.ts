/**
 * Wake re-home — P-013 part A (review-system-rework-reduction-2026-09-23, spec
 * RSR-P-013-A): a wake addressed to a DEAD session revives it, and when the
 * session's account is walled it RE-HOMES it — onto another account, or onto
 * another backend — instead of resuming into the known wall.
 *
 * THE GAP. `executeWake`'s process-gone channel rebuilds the session's persisted
 * `--account` route (`wakeAccountRouteFromArgv`) and resumes it. For a hard pin
 * that route has NO failover (the gateway honours the pin), so a pinned account
 * sitting at its usage wall produced a resume that died seconds later with
 * `usage_limit`. The loop turn-outcome handler then re-armed it for the reset
 * (hours) — the dead session was never revived while other accounts had
 * headroom. Owner directives #191/#192 [owner 2026-09-22]: an account wall
 * should fall through to the best account that is not walled, and when Claude is
 * walled but Codex is available the SAME session should wake on the other backend.
 *
 * THE DECISION (pure — this module holds no I/O on the decision path):
 *   - a hard pin whose account is walled, with another Claude account that is not
 *     walled                                  → `rehome-account` (gateway `auto`);
 *   - every Claude account walled, a Codex account with headroom
 *                                             → `rehome-backend` (session port);
 *   - otherwise                               → `keep` (resume exactly as before).
 * A `default` route (the system credential, gateway skipped) cannot be attributed
 * to a pool account, so only the every-account-walled signal applies to it; an
 * `auto` route already fails over inside the gateway, so the same holds.
 *
 * Unknown is not walled: an empty or unreadable pool yields `keep`, never a
 * re-home. A stale projection can only cost the resume the existing wall path.
 */
import type { WakeAccountRoute } from '../../inference-gateway/spawn-env';
import type { AccountPool } from '../../deployment/account-pool';
import { accountFull, getAccount } from '../../deployment/account-pool';

export type WakeRehomeDecision =
  | { action: 'keep'; reason: string }
  | { action: 'rehome-account'; fromAccountId: string; reason: string }
  | { action: 'rehome-backend'; backend: 'codex'; reason: string };

export interface WakeRehomeInput {
  /** The persisted route the resume would otherwise use (null = none persisted). */
  route: WakeAccountRoute | null;
  /** The Claude account pool (provider-filtered). */
  claudePool: AccountPool;
  /** The Codex account pool (provider-filtered). */
  codexPool: AccountPool;
  now: number;
}

function codexHasHeadroom(codexPool: AccountPool, now: number): boolean {
  // An EMPTY codex pool is not evidence that Codex can serve: unlike the Claude
  // frame-default fallback, a backend switch is a real identity move, so it is
  // taken only on a measured account with headroom.
  return codexPool.accounts.some((a) => !accountFull(a, now));
}

export function decideWakeRehome(input: WakeRehomeInput): WakeRehomeDecision {
  const { route, claudePool, codexPool, now } = input;
  if (claudePool.accounts.length === 0) {
    return { action: 'keep', reason: 'claude pool is empty — nothing measured, no wall to route around' };
  }
  const walled = claudePool.accounts.filter((a) => accountFull(a, now));
  const allClaudeWalled = walled.length === claudePool.accounts.length;

  if (route?.mode === 'pin' && route.accountId) {
    const pinned = getAccount(claudePool, route.accountId);
    if (!pinned) {
      return { action: 'keep', reason: `pinned account ${route.accountId} is not in the claude pool — wall unknown` };
    }
    if (!accountFull(pinned, now)) {
      return { action: 'keep', reason: `pinned account ${route.accountId} has headroom` };
    }
    if (!allClaudeWalled) {
      const open = claudePool.accounts.length - walled.length;
      return {
        action: 'rehome-account',
        fromAccountId: route.accountId,
        reason:
          `pinned account ${route.accountId} is walled and ${open} other claude account(s) have headroom — ` +
          're-homed onto the gateway auto route',
      };
    }
  }

  if (!allClaudeWalled) {
    return { action: 'keep', reason: 'at least one claude account has headroom' };
  }
  if (codexHasHeadroom(codexPool, now)) {
    return {
      action: 'rehome-backend',
      backend: 'codex',
      reason: `every claude account is walled (${claudePool.accounts.length}) and a codex account has headroom`,
    };
  }
  return {
    action: 'keep',
    reason: `every claude account is walled (${claudePool.accounts.length}) and no codex account has headroom — resume keeps the existing wall handling`,
  };
}

/** Production resolver: read the account-pool projection and decide. Fail-soft —
 *  an unreadable pool is `keep`, never a re-home. */
export async function resolveWakeRehome(input: {
  workspaceId: string;
  route: WakeAccountRoute | null;
  now?: number;
}): Promise<WakeRehomeDecision> {
  try {
    const [{ loadAccountPool }, { poolForProvider }] = await Promise.all([
      import('../../deployment/account-pool-store'),
      import('../../deployment/account-pool'),
    ]);
    const pool = await loadAccountPool(input.workspaceId);
    return decideWakeRehome({
      route: input.route,
      claudePool: poolForProvider(pool, 'claude'),
      codexPool: poolForProvider(pool, 'codex'),
      now: input.now ?? Date.now(),
    });
  } catch (e) {
    return { action: 'keep', reason: `account pool unreadable (${(e as Error)?.message ?? String(e)}) — not treated as a wall` };
  }
}

/**
 * Production backend re-home: continue the dead Claude session on Codex through
 * the session-port conversion psu already implements (the same composer the
 * consult dispatcher uses — `buildAgentLaunchCommand { targetAgent }`), with the
 * wake text as the first turn. Never throws.
 *
 * The model is the first Codex entry of the owner's expert-model allowlist
 * (directive #193 [owner 2026-09-22] names the Codex models allowed to act for
 * a Claude session); with none configured there is no model to port onto, so this
 * reports not-ok and the caller resumes on Claude as before.
 *
 * Must run BEFORE the executor claims the ended row: psu's own resume claims that
 * row, and a pre-claimed row would make psu refuse the launch.
 */
export async function rehomeWakeOnBackend(input: {
  subscriberId: string;
  workspaceId: string;
  harnessSlug: string | null;
  cwd: string | null;
  wakeText: string;
  backend: 'codex';
}): Promise<{ ok: boolean; detail: string }> {
  try {
    const [core, envelopeMod, spawnMod, baseUrlMod, allowlistMod, rootMod, pathMod] = await Promise.all([
      import('../../agent-launch-core'),
      import('../../console-launcher'),
      import('../../console-spawn'),
      import('../../mcp-base-url'),
      import('../../consult/expert-model-allowlist'),
      import('../../papercusp-root'),
      import('node:path'),
    ]);
    const target = await core.resolveResumeTarget({ agentId: input.subscriberId });
    if (!target.ok) return { ok: false, detail: `resume target unresolvable: ${target.detail}` };
    if ((target.agent ?? '').toLowerCase() !== 'claude') {
      return { ok: false, detail: `session ports are claude-source-only; source is ${target.agent ?? 'unknown'}` };
    }
    const ranks = await allowlistMod.resolveExpertModelAllowlist(input.workspaceId);
    const rank = ranks.find((r) => r.agent === input.backend);
    if (!rank) return { ok: false, detail: `no ${input.backend} model is allowed in the expert-model allowlist` };
    const cmd = core.buildAgentLaunchCommand({
      mode: 'resume',
      sessionId: target.sessionId,
      resumeId: target.resumeId ?? target.sessionId,
      agent: target.agent,
      targetAgent: input.backend,
      model: rank.model,
      modelSource: 'explicit',
      headless: true,
    });
    const envelope = await envelopeMod.buildConsoleEnvelope({
      workspaceId: input.workspaceId,
      slug: input.harnessSlug,
      operatorBaseUrl: baseUrlMod.resolveSpawnHostOperatorBaseUrl(),
      skipMcpJson: false,
    });
    const spawn = await spawnMod.spawnHeadless({
      envelope: {
        ...envelope,
        env: { ...envelope.env, PAPERCUSP_KICKOFF_PROMPT: input.wakeText },
        greetingCmd: cmd,
        cwd: input.cwd ?? target.cwd ?? envelope.cwd,
      },
      label: `wake-rehome-${input.backend} · ${input.subscriberId.slice(0, 16)}`,
      logDir: pathMod.join(rootMod.papercuspPathForWorkspace(input.workspaceId), 'fleet-logs'),
      fleetSlug: null,
      coordOwnerId: input.subscriberId,
    });
    if (spawn.status !== 'ok') return { ok: false, detail: `spawn failed (code ${spawn.code}): ${spawn.error}` };
    return { ok: true, detail: `${input.subscriberId} ported claude → ${input.backend}/${rank.model}` };
  } catch (e) {
    return { ok: false, detail: `backend re-home threw: ${(e as Error)?.message ?? String(e)}` };
  }
}
