/**
 * `system:unclaimed-work-digest` — the daily 9am stale-backlog digest
 * (platform-ops-batch-2026-07-09 P-001): every morning, post a summary of
 * currently-UNCLAIMED papercusp work-items (state `todo`, no assignee) to
 * the coord feed so the fleet sees what is going stale.
 *
 * Unlike the weekly human-queue digest (owner inbox + attention push), this
 * one is a FLEET-visible broadcast (`to: ['*']`) — every live agent's
 * `coord:feed` / `coord:orient` picks it up, no owner ceremony needed. It is
 * read-only (lists + posts, changes no state), so it seeds ACTIVE (alpha
 * policy: finished work never ships dark).
 *
 * Config (routine `trigger_config`, optional):
 *   - `harness` — which harness's backlog to digest (default 'papercusp').
 *   - `top_n` — how many stale items the digest leads with (default 10).
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { sendMessage } from '../../agent-tools/coordination/messages';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import { listWorkItems } from '../../work-items';
import {
  DEFAULT_STRANDED_APP_TASK_BOUND_HOURS,
  productionStrandedAppTaskGuardDeps,
  runStrandedAppTaskGuard,
} from '../../stranded-app-tasks';

/** Coord identity for the digest broadcast (mirrors the human-queue-digest pattern). */
const UNCLAIMED_DIGEST_IDENTITY: AgentIdentity = {
  ownerId: 'system:unclaimed-work-digest',
  ownerLabel: 'unclaimed-work-digest',
  source: 'static-client',
  workspaceId: null,
  userId: null,
};

const DEFAULT_TOP_N = 10;
const DEFAULT_HARNESS = 'papercusp';
const TITLE_MAX = 100;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function ageDays(createdAt: string): number {
  const ms = Date.now() - new Date(createdAt).getTime();
  return Math.max(0, ms / 86_400_000);
}

/** Compose the digest message. Pure. Returns null when nothing is unclaimed (no spam). */
export function composeUnclaimedWorkDigest(
  unclaimed: Array<{ id: string; title: string; kind: string; createdAt: string }>,
  opts: { topN?: number; harness?: string } = {},
): { summary: string; body: string } | null {
  if (unclaimed.length === 0) return null;
  const topN = Math.max(1, opts.topN ?? DEFAULT_TOP_N);
  const harness = opts.harness ?? DEFAULT_HARNESS;
  // Oldest-first — the ones going stale longest lead the digest.
  const sorted = [...unclaimed].sort((a, b) => ageDays(b.createdAt) - ageDays(a.createdAt));
  const top = sorted.slice(0, topN);

  const lines = top.map((it, i) => {
    const age = `${Math.round(ageDays(it.createdAt))}d`;
    return `${i + 1}. **${it.id}** _[${it.kind} · ${age} old]_ — ${truncate(it.title, TITLE_MAX)}`;
  });

  const rest = unclaimed.length - top.length;
  const body = [
    `Daily unclaimed-work digest for \`${harness}\` — ${unclaimed.length} work-item(s) sit at \`todo\` with no assignee.`,
    lines.join('\n'),
    rest > 0
      ? `…plus ${rest} more unclaimed item(s). Full list: \`work_items:list { harness:"${harness}", state:"todo" }\`.`
      : `That's the full unclaimed list.`,
  ].join('\n\n');

  const summary = `Daily digest: ${unclaimed.length} unclaimed ${harness} work-item(s) — oldest: ${top[0].id} (${Math.round(ageDays(top[0].createdAt))}d).`;

  return { summary, body };
}

/**
 * Stranded app-task guard (app-agent-tasks-durable-execution-2026-10-06 P-005). The digest
 * above covers ONE harness, which is exactly how 129 never-claimed email tasks in the `email`
 * harness went unseen for weeks. This pass covers the routine's whole WORKSPACE, but only
 * app-created rows (trigger binding or blueprint-operation root) past a bound, and files one
 * accountable flag per (harness, kind) instead of broadcasting. Fail-soft: a guard failure
 * must not cost the digest, and vice versa. Config: `stranded_after_hours` (default 6).
 */
async function runStrandedGuard(ctx: SystemActionCtx): Promise<Record<string, unknown>> {
  const cfg = ctx.triggerConfig ?? {};
  const raw = Number(cfg.stranded_after_hours);
  const boundHours = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STRANDED_APP_TASK_BOUND_HOURS;
  try {
    const result = await runStrandedAppTaskGuard(
      productionStrandedAppTaskGuardDeps({ workspaceId: ctx.workspaceId, flagHarness: ctx.installSlug, boundHours }),
      { boundHours },
    );
    console.log(
      `[unclaimed-work-digest] stranded-app-task guard: ${result.strandedTasks} stranded task(s) in ` +
        `${result.groups} group(s), ${result.flagged.length} flagged, ${result.settled.length} settled, ` +
        `${result.errors.length} error(s)`,
    );
    return { boundHours, ...result };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.warn('[unclaimed-work-digest] stranded-app-task guard failed:', error);
    return { boundHours, error };
  }
}

registerSystemAction('unclaimed-work-digest', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const topN = Number.isFinite(Number(cfg.top_n)) && Number(cfg.top_n) > 0 ? Number(cfg.top_n) : DEFAULT_TOP_N;
  const harness = typeof cfg.harness === 'string' && cfg.harness.length > 0 ? cfg.harness : DEFAULT_HARNESS;

  const strandedAppTasks = await runStrandedGuard(ctx);

  // work-item-status-full-unify P-007: unclaimed CLAIMABLE work is at the unified token
  // 'open' now (was 'todo'); listWorkItems matches status EXACTLY, so 'todo' → empty digest.
  const rows = await listWorkItems({ harness, state: 'open', limit: 500 });
  const unclaimed = rows
    .filter((r) => !r.assignee)
    .map((r) => ({ id: r.id, title: r.title, kind: r.kind, createdAt: r.createdAt }));

  const composed = composeUnclaimedWorkDigest(unclaimed, { topN, harness });
  if (!composed) {
    console.log(`[unclaimed-work-digest] ${harness}: no unclaimed work-items — nothing to post`);
    return { diagnostics: { strandedAppTasks } };
  }

  // Fleet-broadcast rail — every live agent's coord:feed / coord:orient sees it.
  try {
    await sendMessage(UNCLAIMED_DIGEST_IDENTITY, { to: ['*'], summary: composed.summary, body: composed.body });
  } catch (e) {
    console.warn('[unclaimed-work-digest] coord broadcast failed:', e instanceof Error ? e.message : e);
  }

  console.log(`[unclaimed-work-digest] ${composed.summary}`);
  return { diagnostics: { strandedAppTasks } };
});
