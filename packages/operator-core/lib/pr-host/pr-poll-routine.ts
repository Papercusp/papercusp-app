/**
 * Per-harness PR-poll routine config (Phase 7 P-042 — the un-vaporware of the
 * falsely-"shipped" poll daemon, EI-479). A harness's PR-poll schedule is a
 * `harness_shared.routines` row with target_role='system:pr-poll' — these wrap
 * db-org's routine primitives so the schedule is ordinary harness config, exactly
 * the way `git-sync-routine.ts` wraps the git-sync schedule (the pattern the
 * PR-1 brief says to mirror).
 *
 * The action half lives in `./poll-daemon.ts` (registered as the `pr-poll` system
 * action); this module is the CRUD + seed half (the routines engine reads the row,
 * the settings route flips it active/inactive when the reviewer role is toggled).
 *
 * Pass the owning `workspaceId` explicitly — `harness_shared.routines.workspace_id`
 * is NOT NULL with no column default and no fill trigger (same constraint
 * git-sync-routine.ts documents).
 */
import type { Sql } from 'postgres';
import { getOrgPg, upsertRoutine, setRoutineActive, deleteRoutine, type RoutineRow } from '@papercusp/db-org';
import { computeNextFireAt } from '../harness/routines/cron';
import { parseGithubUrl } from '../harness/clone-github';

export const PR_POLL_ROUTINE_NAME = 'pr-poll';
export const PR_POLL_TARGET = 'system:pr-poll';

/**
 * 60s cadence (the spec P-042 claimed) with per-harness jitter. A 6-field crontab
 * `<sec> * * * * *` fires once per minute at a deterministic second offset derived
 * from the harness slug — so N harnesses don't all hammer GitHub on the same second
 * after a synchronized restart (the same anti-thundering-herd reasoning as
 * git-sync's `gitSyncCronForKey`, applied to the seconds field for a sub-minute
 * cadence). The routines engine ticks every 30s, so the effective poll latency is
 * ≤30s past each minute boundary — well inside the "60s poll" envelope.
 */
export function prPollCronForKey(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) >>> 0;
  }
  return `${h % 60} * * * * *`;
}

/**
 * Normalize any GitHub remote form (HTTPS clone URL, SSH `git@…`, or the bare
 * `github.com/owner/repo` that `completion_ref.remote` uses) into the canonical
 * `github.com/<owner>/<repo>` string the PrHost (`parseRemote` in github.ts)
 * expects. Returns null when the string isn't a recognizable GitHub remote.
 */
export function normalizeRemote(remote: string | null | undefined): string | null {
  if (!remote) return null;
  const parsed = parseGithubUrl(remote);
  if (parsed) return `github.com/${parsed.owner}/${parsed.repo}`;
  // Bare `github.com/owner/repo` (the completion_ref form — no protocol, so
  // parseGithubUrl's HTTPS/SSH regexes miss it).
  const m = /^(?:https?:\/\/)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote.trim());
  if (m && !/^\.+$/.test(m[1]) && !/^\.+$/.test(m[2])) return `github.com/${m[1]}/${m[2]}`;
  return null;
}

export interface PrPollRoutineInput {
  /** Owning workspace_id (routines.workspace_id is NOT NULL, no default). */
  workspaceId: string;
  installSlug: string;
  /** Canonical `github.com/<owner>/<repo>` upstream remote to poll. */
  remote: string;
  cron?: string;
  /** Defaults INACTIVE when omitted — the routine goes live when the reviewer
   *  role is enabled for the harness (settings route seeds it active). */
  active?: boolean;
}

/** Create or update a harness's `system:pr-poll` routine. */
export async function upsertPrPollRoutine(sql: Sql, input: PrPollRoutineInput): Promise<RoutineRow> {
  return upsertRoutine(
    sql,
    {
      workspaceId: input.workspaceId,
      installSlug: input.installSlug,
      name: PR_POLL_ROUTINE_NAME,
      triggerKind: 'cron',
      triggerConfig: {
        cron: input.cron ?? prPollCronForKey(input.installSlug),
        // The action reads `remote` from here (mirrors git-sync storing `branch` in
        // trigger_config) so the per-tick poll needs no registry round-trip.
        remote: input.remote,
      },
      targetRole: PR_POLL_TARGET,
      active: input.active ?? false,
    },
    computeNextFireAt,
  );
}

/** Read a harness's pr-poll routine, or null if none seeded. */
export async function getPrPollRoutine(sql: Sql, installSlug: string): Promise<RoutineRow | null> {
  const rows = await sql<Array<Record<string, unknown>>>`
    SELECT * FROM harness_shared.routines
     WHERE install_slug = ${installSlug} AND target_role = ${PR_POLL_TARGET}
     LIMIT 1
  `;
  if (!rows.length) return null;
  const r = rows[0];
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id ?? ''),
    installSlug: String(r.install_slug),
    name: String(r.name),
    triggerKind: r.trigger_kind as RoutineRow['triggerKind'],
    triggerConfig: (r.trigger_config ?? {}) as RoutineRow['triggerConfig'],
    targetRole: String(r.target_role),
    payloadTemplate: (r.payload_template ?? null) as RoutineRow['payloadTemplate'],
    concurrency: r.concurrency as RoutineRow['concurrency'],
    catchup: r.catchup as RoutineRow['catchup'],
    tier: (r.tier as RoutineRow['tier']) ?? 'durable',
    active: Boolean(r.active),
    lastFiredAt: (r.last_fired_at ?? null) as Date | null,
    nextFireAt: (r.next_fire_at ?? null) as Date | null,
    // pr-poll is a cron routine, never a loop — the loop fields are always null here.
    rescheduleIntervalSec: r.reschedule_interval_sec == null ? null : Number(r.reschedule_interval_sec),
    targetOwnerId: (r.target_owner_id ?? null) as string | null,
  };
}

/** Enable/disable a harness's pr-poll routine (go-live = setPrPollRoutineActive(sql, slug, true)). */
export async function setPrPollRoutineActive(sql: Sql, installSlug: string, active: boolean): Promise<boolean> {
  return setRoutineActive(sql, installSlug, PR_POLL_ROUTINE_NAME, active);
}

/** Delete a harness's pr-poll routine row entirely (durable inverse of the seed). */
export async function removePrPollRoutine(sql: Sql, installSlug: string): Promise<boolean> {
  return deleteRoutine(sql, installSlug, PR_POLL_ROUTINE_NAME);
}

export type SeedPrPollRoutineOutcome =
  | { seeded: true; active: boolean; remote: string; cron: string }
  /** No resolvable upstream remote (registered from a local path, no github_remote). */
  | { seeded: false; reason: 'no_remote' }
  /** Anything threw (PG down, registry unreadable, …) — reported, never rethrown. */
  | { seeded: false; reason: 'error'; message: string };

export interface SeedPrPollRoutineOpts {
  workspaceId: string;
  installSlug: string;
  /** Explicit remote (any GitHub form). Omit ⇒ resolve from the harness registry. */
  remote?: string;
  /** Seed active (the reviewer role just turned on). Default true. */
  active?: boolean;
}

export interface SeedPrPollRoutineDeps {
  sql?: Sql;
  /** Resolve a harness's github_remote (default: the harness registry). */
  resolveRemote?: (installSlug: string, workspaceId: string) => Promise<string | null>;
  upsert?: typeof upsertPrPollRoutine;
}

async function defaultResolveRemote(installSlug: string, workspaceId: string): Promise<string | null> {
  const { loadHarnessRegistry } = await import('../harness-registry');
  const reg = await loadHarnessRegistry(workspaceId);
  return reg.projects.find((p) => p.slug === installSlug)?.github_remote ?? null;
}

/**
 * Best-effort seed of one harness's `system:pr-poll` routine — the composition the
 * pr-reviewer-settings route calls when the reviewer role is enabled. NEVER throws:
 * every failure folds into the returned outcome (same discipline as
 * `seedGitSyncRoutineForMember`). Idempotent — `upsertRoutine` ON CONFLICT updates
 * the existing row, so a re-enable just refreshes the remote/cadence + flips active.
 */
export async function seedPrPollRoutineForHarness(
  opts: SeedPrPollRoutineOpts,
  deps: SeedPrPollRoutineDeps = {},
): Promise<SeedPrPollRoutineOutcome> {
  try {
    const resolveRemote = deps.resolveRemote ?? defaultResolveRemote;
    const rawRemote = opts.remote ?? (await resolveRemote(opts.installSlug, opts.workspaceId));
    const remote = normalizeRemote(rawRemote);
    if (!remote) return { seeded: false, reason: 'no_remote' };

    const sql = deps.sql ?? getOrgPg().sql;
    const upsert = deps.upsert ?? upsertPrPollRoutine;
    const active = opts.active ?? true;
    const cron = prPollCronForKey(opts.installSlug);
    await upsert(sql, { workspaceId: opts.workspaceId, installSlug: opts.installSlug, remote, cron, active });
    return { seeded: true, active, remote, cron };
  } catch (e) {
    return { seeded: false, reason: 'error', message: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
  }
}
