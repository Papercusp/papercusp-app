/**
 * origin-freshness-watchdog — WI-5607, the DB/git wiring around the pure
 * `evaluateOriginFreshness` verdict (origin-freshness.ts — see that module's header for the
 * full "why" and the two-signal design). git-sync-stall-watchdog's sibling for the ONE class
 * of silent stall it cannot see: a `bridged` hive whose member git-sync routines keep
 * advancing local HEAD every tick (so commit-staleness never fires) while the bridge
 * writer's egress to GitHub origin is actually stuck.
 *
 * Scope: `bridged` hives only (`hiveGit.mode === 'bridged'`, hive-git-mode.ts). `legacy`
 * hives push origin directly every git-sync tick and are already covered by
 * git-sync-stall-watchdog's commit-staleness. `p2p-only` hives have no GitHub remote at all
 * — there is nothing named "origin" for this check to assert freshness against; their
 * propagation liveness is the P2P dial-path's own concern (WI-5210's heal-sweep already
 * covers a dead dial path).
 *
 * DETECTION: for each bridged hive, read the bare pot-git store directly (LOCAL to this
 * host — the same host-scoped, best-effort-degrades-to-null posture git-pipeline-hives.ts
 * already uses for its `stagingMainGap` panel field; a hive ticking on a different host in
 * the federation just reads null here and never alarms, it never false-alarms):
 *   - the LOCAL canonical ref the bridge is trying to publish (`BRIDGE_CANONICAL_REF`);
 *   - the synthetic github-origin namespace ref (`github-ingress.ts`) — the bridge's own
 *     best-effort local mirror of the real GitHub tip, refreshed on every successful
 *     ingress fetch. This stands in for "origin/staging" without any extra network I/O:
 *     ingress already fetches it every tick as a side effect of the bridge's normal work.
 * `aheadCount` = commits the canonical ref has that the namespace ref lacks. The
 * namespace-ref clock (when it last CHANGED) is tracked on the routine metadata — the exact
 * head-unchanged-clock idiom `checkGitSyncStall` uses for the local HEAD, applied here to
 * the origin tip instead — under its OWN metadata keys (`of_*`, never colliding with that
 * sibling's `wd_*` keys or git-sync-action's own `github_bridge` blob).
 *
 * Process-level (NOT a DBOS routine), same rationale as every sibling: a routine-based
 * watchdog queues on the very engine that can wedge.
 *
 * On a SUSTAINED alarm (EI-9030b-style debounce — a transient blip that self-heals within
 * one sweep interval never pages): an urgent owner `notifyAttention` + a durable
 * `harness_escalations` row (own phase, never clobbers git-sync's or the bridge's own rows)
 * + a fleet broadcast so any running agent can claim the rescue. Recovery clears the flag +
 * escalation idempotently.
 *
 * WI-6643 — the alarm is NAMED AFTER THE CAUSE (`describeOriginFreshnessAlert`), and the
 * one-shot latch is keyed by that cause. Previously all three signals shared one hardcoded
 * origin-behind framing and one boolean latch, so a publish REFUSAL announced itself as
 * "GitHub origin is falling behind" and pointed the responder at the bridge — which was
 * working fine — while the refusal detail sat in the body.
 *
 * Kill-switch: PAPERCUSP_ORIGIN_FRESHNESS_WATCHDOG='0'.
 */
import { existsSync } from 'node:fs';
import type { Sql } from 'postgres';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { broadcastSevereEvent, broadcastSevereEventResolvedMany } from '../severe-event-broadcast';
import { loadHarnessRegistry, type ProjectEntry } from '../harness-registry';
import { getPotGitMode, POT_GIT_MODE_SETTING_KEY } from '../harness/git-sync/hive-git-mode';
import { canonicalRepoKey } from '../sync/pot-git/repo-identity';
import { hiveGitRepoPath, readNamespaceRef, defaultRunGit, type RunGit } from '../sync/pot-git/storage';
import { githubOriginDevicePubkey } from '../sync/pot-git/github-ingress';
import { BRIDGE_CANONICAL_REF } from '../sync/pot-git/github-bridge-tick';
import { STAGING_REF } from '../sync/pot-git/integrator';
import {
  evaluateOriginFreshness,
  isIntegratorStalledThisSweep,
  describeOriginFreshnessAlert,
  describeOriginFreshnessRecovery,
  DEFAULT_AHEAD_COUNT_MAX,
  DEFAULT_TIP_AGE_STALE_MS,
  type OriginFreshnessCause,
  type OriginFreshnessThresholds,
} from './origin-freshness';

const WATCHDOG_PHASE = 'origin-freshness-watchdog';
const WATCHDOG_KIND = 'origin-freshness-watchdog';
/** WI-5791: stable condition key for "this watchdog is watching nothing". */
const WATCHDOG_BLIND_CONDITION_KEY = 'origin-freshness:watchdog-blind';
/**
 * WI-5791: edge-trigger state for the blindness broadcast, so a persistent
 * blindness alarms ONCE rather than every sweep. Process-level by design — a
 * restart re-announcing a still-blind watchdog is correct, not noise.
 */
let lastSweepWasBlind = false;
/** EI-9030b idiom: consecutive sweeps the verdict must hold before it broadcasts. */
const DEFAULT_STALL_SUSTAIN_MIN_SWEEPS = 2;
/** git-sync ticks every 3 min; 15m matches every sibling watchdog's sweep cadence. */
const DEFAULT_WATCHDOG_INTERVAL_MS = 15 * 60 * 1000;

export interface OriginFreshnessWatchdogOptions extends OriginFreshnessThresholds {
  stallSustainMinSweeps?: number;
  intervalMs?: number;
  runGit?: RunGit;
  workspaceId?: string;
}

/** `git -C repoPath rev-parse --verify --quiet <ref>` — null on any error/missing ref. */
async function readRefSha(repoPath: string, ref: string, runGit: RunGit): Promise<string | null> {
  const r = await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repoPath);
  const sha = r.stdout.trim();
  return r.code === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/**
 * WI-6996 — every cause that can be persisted in `of_alerted_cause`, so recovery can be
 * worded for the cause that actually alarmed.
 *
 * The `satisfies` clause is the point: this is a RECURRENCE GUARD, not a lookup table.
 * Recovery used to normalise the stored string with a ternary that defaulted anything
 * unrecognised to 'origin-behind', so adding a fourth signal (this one) would have
 * silently announced "GitHub origin has caught back up" when what actually happened was
 * a publish backlog draining — reintroducing the precise mis-framing WI-6643 existed to
 * fix, and doing it invisibly. With `satisfies`, adding a member to OriginFreshnessCause
 * without adding it here is a COMPILE ERROR at this line.
 */
const PERSISTED_ALERT_CAUSES = {
  'publish-refused': true,
  'publish-backlog': true,
  // EI-19442274898324113 — added the fifth signal; this line is the guard above doing
  // exactly its job: the compile broke here until the cause was registered, which is what
  // stops a self-healed integrator stall from announcing "GitHub origin has caught back
  // up" when the truth is that the INTEGRATOR advanced. That recovery line is frequently
  // the only durable trace such a stall ever leaves.
  'integrator-backlog': true,
  'origin-behind': true,
} as const satisfies Record<OriginFreshnessCause, true>;

/** Narrow a persisted `of_alerted_cause` string back to a known cause (legacy/absent ⇒ the
 *  original framing, matching WI-6643's treatment of rows that latched pre-key). */
function normalizeAlertedCause(stored: string | null | undefined): OriginFreshnessCause {
  return stored != null && stored in PERSISTED_ALERT_CAUSES ? (stored as OriginFreshnessCause) : 'origin-behind';
}

/** `git -C repoPath rev-list --count from..to` — null on any error (incl. either sha missing). */
async function revListCount(repoPath: string, from: string, to: string, runGit: RunGit): Promise<number | null> {
  const r = await runGit(['rev-list', '--count', `${from}..${to}`], repoPath);
  if (r.code !== 0) return null;
  const n = Number.parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** Bound on device namespaces examined per sweep. Each non-caught-up namespace costs one
 *  `git` spawn, and a spawn blocks bg-host's event loop ~165ms at its ~4.2GB RSS (see the
 *  `readNamespaceRefForDevices` header). Real pots have a handful; this only stops a store
 *  with pathological namespace litter from stalling the loop. */
const MAX_NAMESPACES_PER_SWEEP = 32;

/**
 * EI-22702954391733746 — the integrator's backlog across EVERY device namespace, not just
 * THIS process's own.
 *
 * WHY THIS IS NOT `readNamespaceRef(self)`. It used to be, and that made signal 5 — the only
 * signal that can see an integrator stall at all — structurally incapable of firing on
 * papercusp. `resolveUsageActor()` resolves the LOCAL MACHINE's device key, but the device
 * that PUBLISHES staging need not be the machine running the watchdog. Measured 2026-09-08:
 * bg-host's own namespace sat 945 commits BEHIND canonical (last advanced two days earlier),
 * so `rev-list --count canonical..selfNS` was 0 — and 0 was read as "integrated / caught up".
 * The publisher device was a different namespace entirely, standing 26 commits ahead of a
 * canonical ref frozen for ~8h. The detector reported health throughout, for the same reason
 * every incident in this module's header did: it measured the wrong thing and called the
 * absence of a reading a healthy reading.
 *
 * THE 0-CONFLATION THIS FIXES. `revListCount(canonical, ns)` returns 0 both when a namespace
 * is genuinely caught up AND when it is an ANCESTOR of canonical (stale / not the publisher).
 * Those are opposite worlds — "nothing to do" vs "no information" — and collapsing them is
 * what let the blindness masquerade as health. Here a pot with no integrable namespace at all
 * returns NULL (no signal), never 0.
 *
 * WHY "DESCENDANT OF CANONICAL" IS THE FILTER, and not a bare max. A naive max-ahead over all
 * namespaces is the noise generator this module's header warns about: an abandoned/divergent
 * device (measured on papercusp: 21 ahead of canonical while 32708 BEHIND it) would hold the
 * backlog permanently above 0 and alarm on any quiet period. Work the integrator could
 * actually integrate is work built ON TOP of canonical — i.e. canonical is an ancestor of it,
 * equivalently `behind === 0` in the symmetric-difference count below. A divergent device
 * fails that test and contributes no signal; a caught-up device passes it with ahead 0.
 *
 * Controls measured against the live store before this shipped:
 *   healthy state → only the publisher qualifies, ahead 0 ⇒ 0 ⇒ no alarm (negative control)
 *   during the freeze → publisher qualifies, ahead 26 ⇒ alarms in ~4 sweeps (positive control)
 *
 * Returns the max ahead-count among integrable namespaces, or null when the store yields no
 * reading at all. Null is treated as healthy by the caller — never a false alarm.
 */
export async function integratorBacklogAcrossDevices(
  repoPath: string,
  canonicalSha: string,
  runGit: RunGit,
): Promise<number | null> {
  // ONE spawn for every device's staging ref, regardless of member count — the loop-shape
  // `readNamespaceRefForDevices` exists to prevent.
  const r = await runGit(
    ['for-each-ref', '--format=%(objectname) %(refname)', `refs/namespaces/*/${STAGING_REF}`],
    repoPath,
  );
  if (r.code !== 0) return null;

  const shas = new Set<string>();
  for (const line of r.stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const sp = t.indexOf(' ');
    if (sp < 0) continue;
    const sha = t.slice(0, sp);
    if (sha) shas.add(sha);
  }
  if (shas.size === 0) return null; // no device namespaces ⇒ no reading, not a healthy reading

  let best: number | null = null;
  let examined = 0;
  for (const sha of shas) {
    if (examined >= MAX_NAMESPACES_PER_SWEEP) break;
    examined += 1;
    if (sha === canonicalSha) {
      best = Math.max(best ?? 0, 0); // caught up: a real reading of zero backlog
      continue;
    }
    // `--left-right --count A...B` yields "<behind>\t<ahead>" in ONE spawn, so the ancestry
    // test and the count cost one invocation rather than a merge-base plus a rev-list.
    const lr = await runGit(['rev-list', '--left-right', '--count', `${canonicalSha}...${sha}`], repoPath);
    if (lr.code !== 0) continue;
    const parts = lr.stdout.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const behind = Number.parseInt(parts[0], 10);
    const ahead = Number.parseInt(parts[1], 10);
    if (!Number.isFinite(behind) || !Number.isFinite(ahead)) continue;
    if (behind !== 0) continue; // divergent or stale ⇒ not integrable ⇒ contributes no signal
    best = Math.max(best ?? 0, ahead);
  }
  return best;
}

/** Resolve the hive HOME slug for a registry entry — mirrors git-sync-action's
 *  `runGithubBridgeLeg` derivation exactly (never re-import that module: it is huge and
 *  side-effecting; this one line of shared logic is cheap to keep in sync by inspection). */
function potHomeSlugOf(entry: ProjectEntry): string | undefined {
  return entry.hive_slug ?? (entry.self_repo ? entry.slug : undefined);
}

/**
 * WI-5791 — every workspace that owns a harness registry.
 *
 * Deliberately NOT falling back to `DEFAULT_WORKSPACE_ID` when this read fails:
 * that fallback is exactly how this watchdog spent its whole life sweeping an
 * empty workspace while reporting a clean pass. An empty list makes the sweep
 * check nothing, which the zero-coverage self-report then reports LOUDLY —
 * silence must never read as health.
 */
async function listRegistryWorkspaceIds(sql: Sql): Promise<string[]> {
  try {
    const rows = await sql<{ workspace_id: string }[]>`
      SELECT DISTINCT workspace_id
        FROM harness_shared.harness_registry
       WHERE workspace_id IS NOT NULL AND workspace_id <> ''
       ORDER BY workspace_id`;
    return rows.map((r) => r.workspace_id);
  } catch (e) {
    console.warn(
      `[origin-freshness-watchdog] workspace enumeration failed — this sweep covers NOTHING: ${e instanceof Error ? e.message : e}`,
    );
    return [];
  }
}

/**
 * WI-5791 — does this watchdog have anything to watch?
 *
 * The bug this guards against is not "the verdict was wrong", it is "the verdict
 * was never computed" — a sweep that examines zero entries returns exactly the
 * same shape as a sweep where everything is healthy. So ask the question the
 * sweep itself cannot: are there bridged pots in the DB that a covering sweep
 * MUST have checked? If yes and we checked none, the watchdog is blind and says
 * so, instead of reporting a clean pass forever.
 */
async function countBridgedPots(sql: Sql): Promise<number> {
  try {
    const rows = await sql<{ n: string | number }[]>`
      SELECT count(*) AS n
        FROM harness_shared.pot_settings
       WHERE setting_key = ${POT_GIT_MODE_SETTING_KEY}
         AND value #>> '{}' = 'bridged'`;
    return Number(rows[0]?.n ?? 0);
  } catch {
    return 0; // unknown — never manufacture a false blindness alarm
  }
}

export interface OriginFreshnessWatchdogResult {
  alarmed: string[];
  recovered: string[];
  checked: number;
  /**
   * WI-5791 — the sweep covered NOTHING while bridged pots exist, i.e. this
   * watchdog is not watching anything. Distinct from `checked: 0` alone, which
   * is legitimate on an install with no bridged pots. Never set on a healthy
   * pass, so a caller can treat its presence as a defect signal.
   */
  blind?: boolean;
  /**
   * EI-20285011147862697 — how many pots the PUBLISH-HEALTH pass judged (the pots the
   * origin pass skipped because they have no origin). Reported separately from
   * `checked` on purpose: the two passes cover different populations, and collapsing
   * them into one number is what let 3-of-3 origin coverage read as whole-plane health
   * while 39 publish legs went unwatched.
   */
  publishChecked?: number;
}

/**
 * WI-5738 — which sha this watchdog treats as "where origin actually is".
 *
 * Extracted as a pure function because the PRECEDENCE is the whole bug. The
 * original watchdog measured the ingress mirror of `github_default_branch`, and
 * that is why a five-day egress outage read healthy the entire time: the RELEASE
 * pipeline fast-forwards that branch hourly, so it reported a fresh tip and a
 * small ahead-count no matter how wedged egress was — and it RESET the staleness
 * clock every hour.
 *
 * Order, strongest evidence first:
 *   1. `egressHead`   — what egress LAST ACTUALLY LANDED. The only signal that
 *                       is a fact about the mechanism being watched.
 *   2. `lastObserved` — this watchdog's own previous observation. Reusing it
 *                       when a fresh reading is missing leaves the staleness
 *                       clock RUNNING, so a genuine wedge still alarms. Silence
 *                       must never read as health.
 *   3. `ingressMirror`— last resort, for a hive that has NEVER observed an
 *                       egress head (pre-upgrade metadata). A weak signal beats
 *                       none, but it must never PREEMPT a real one.
 *
 * The trap this encodes: (2) exists so that a single quiet tick cannot demote
 * the watchdog back to (3). Skipping straight from (1) to (3) silently restores
 * the exact blindness this incident was about.
 */
export function selectOriginWatermark(input: {
  egressHead: string | null;
  lastObserved: string | null;
  ingressMirror: string | null;
}): string | null {
  return input.egressHead ?? input.lastObserved ?? input.ingressMirror ?? null;
}

/**
 * One watchdog pass: scan every registry entry whose hive is in `bridged` mode and has a
 * GitHub remote configured, read the local bare store (best-effort — a missing/foreign-host
 * repo just degrades to "unknown", never a false alarm), evaluate freshness, and alarm/clear
 * exactly like `checkGitSyncStall`. Never throws.
 */
export async function checkOriginFreshness(
  sql: Sql,
  opts: OriginFreshnessWatchdogOptions = {},
): Promise<OriginFreshnessWatchdogResult> {
  const out: OriginFreshnessWatchdogResult = { alarmed: [], recovered: [], checked: 0 };
  const runGit = opts.runGit ?? defaultRunGit;
  const stallSustainMinSweeps = opts.stallSustainMinSweeps ?? DEFAULT_STALL_SUSTAIN_MIN_SWEEPS;
  const now = Date.now();
  // WI-6643: carries the CAUSE that had alarmed, so the recovery line matches it.
  const recoveredForBroadcast: { slug: string; cause: OriginFreshnessCause }[] = [];

  try {
    // WI-5791 — sweep EVERY workspace that owns a harness registry, not one
    // hard-coded default.
    //
    // This used to be `loadHarnessRegistry(opts.workspaceId ?? DEFAULT_WORKSPACE_ID)`,
    // and no caller has ever passed `opts.workspaceId` — `startOriginFreshnessWatchdog`
    // calls `checkOriginFreshness(sql, opts)` with the boot's empty opts. So every
    // sweep since this watchdog shipped (WI-5607) loaded the registry of workspace
    // `'default'`, which holds 14 unrelated scratch pots and not one bridged hive,
    // while every real pot lives in `'papercusp-workspace'`. The pass returned
    // `checked: 0` — it never entered the per-entry body, never wrote `of_origin_sha`,
    // and therefore could never age a tip or raise `tipAgeStale`. The watchdog built
    // to catch a silently-stalled egress was itself silently stalled, for its whole
    // life, and nothing said so: `checked: 0` is indistinguishable from a clean pass
    // at every surface that reads this result.
    //
    // That is the same shape as the bug this watchdog exists to catch, and as
    // EI-10103 in the sibling main-behind watchdog (a workspace it could not resolve
    // meant its escalation write threw into an outer catch). See
    // agent-insights/absorbing-state-guards-and-self-report-detectors. The
    // zero-coverage self-report below is the guard that makes the class visible.
    const workspaceIds = opts.workspaceId ? [opts.workspaceId] : await listRegistryWorkspaceIds(sql);
    const workspaceIdsSwept = workspaceIds.length;
    const targets: { workspaceId: string; entry: ProjectEntry }[] = [];
    for (const wsId of workspaceIds) {
      let projects: ProjectEntry[];
      try {
        projects = (await loadHarnessRegistry(wsId)).projects;
      } catch {
        continue; // one unreadable workspace must never abort the whole sweep
      }
      for (const entry of projects) targets.push({ workspaceId: wsId, entry });
    }

    // EI-20285011147862697: which entries the ORIGIN pass actually evaluated. Every
    // `continue` below is an ORIGIN precondition, but each one skips the whole body —
    // including the two publish signals, which need no origin. The publish-health pass
    // after this loop picks up whatever the origin pass dropped, and this is how it
    // knows which those are.
    const originCheckedSlugs = new Set<string>();

    for (const { workspaceId, entry } of targets) {
      if (!entry.github_remote) continue; // nothing to be "origin"-fresh against
      const potHomeSlug = potHomeSlugOf(entry);
      if (!potHomeSlug) continue;

      let mode: Awaited<ReturnType<typeof getPotGitMode>>;
      try {
        mode = await getPotGitMode(workspaceId, potHomeSlug, sql);
      } catch {
        continue;
      }
      if (mode !== 'bridged') continue; // legacy covered elsewhere; p2p-only has no origin

      out.checked += 1;
      originCheckedSlugs.add(entry.slug);
      const repoKey = canonicalRepoKey(entry);
      const repoPath = hiveGitRepoPath(potHomeSlug, repoKey);
      if (!existsSync(repoPath)) {
        // Not on this host — best-effort, never a false alarm.
        //
        // WI-5738 (found by su-e3b21's "check the RESET path too" prompt): this
        // `continue` skips the verdict block, and the verdict block's `else`
        // branch is the ONLY place `of_alerted` is cleared. So a pot that had
        // alarmed and then lost its bare store — a host migration, or a repoKey
        // change like WI-5168's slug→gh-<id> move, which relocates this very
        // path — stranded the latch `true` forever and could never alarm again.
        // Same absorbing-state shape as the guards this incident was about:
        // state that only advances through the success path, with an early exit
        // bypassing the clear. Clear a stranded latch on the way out.
        // Single targeted statement — no prior read needed, and a no-op unless
        // the latch is actually stranded.
        await sql`
          UPDATE harness_shared.routines
             SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"of_alerted":false}'::jsonb,
                 updated_at = now()
           WHERE install_slug = ${entry.slug}
             AND target_role = 'system:git-sync'
             AND COALESCE((metadata->>'of_alerted')::boolean, false) = true`;
        continue;
      }

      const branch = entry.github_default_branch ?? 'main';
      const devicePubkey = githubOriginDevicePubkey(entry.github_remote);

      const [canonicalSha, ingressMirrorSha] = await Promise.all([
        readRefSha(repoPath, BRIDGE_CANONICAL_REF, runGit),
        readNamespaceRef(repoPath, devicePubkey, `refs/heads/${branch}`, runGit),
      ]);

      // Read the watchdog's own tracked clock for this entry's git-sync routine row.
      const rows = await sql<
        {
          of_origin_sha: string | null;
          of_origin_since_ms: string | number | null;
          of_alerted: boolean | null;
          of_alerted_cause: string | null;
          of_stall_sweeps: number | null;
          of_publish_refused_sweeps: number | null;
          of_publish_backlog_sweeps: number | null;
          of_integrator_backlog_sweeps: number | null;
          of_integrator_canonical_sha: string | null;
          publish_refused: string | null;
          publish_backlog_remains: string | null;
          publish_published_sha: string | null;
          publish_head_sha: string | null;
          egress_head: string | null;
        }[]
      >`
        SELECT metadata->>'of_origin_sha' AS of_origin_sha,
               (metadata->>'of_origin_since_ms')::bigint AS of_origin_since_ms,
               COALESCE((metadata->>'of_alerted')::boolean, false) AS of_alerted,
               metadata->>'of_alerted_cause' AS of_alerted_cause,
               COALESCE((metadata->>'of_stall_sweeps')::int, 0) AS of_stall_sweeps,
               COALESCE((metadata->>'of_publish_refused_sweeps')::int, 0) AS of_publish_refused_sweeps,
               COALESCE((metadata->>'of_publish_backlog_sweeps')::int, 0) AS of_publish_backlog_sweeps,
               COALESCE((metadata->>'of_integrator_backlog_sweeps')::int, 0) AS of_integrator_backlog_sweeps,
               metadata->'own_head_publish'->>'refused' AS publish_refused,
               metadata->'own_head_publish'->>'backlogRemains' AS publish_backlog_remains,
               metadata->'own_head_publish'->>'publishedSha' AS publish_published_sha,
               metadata->'own_head_publish'->>'sha' AS publish_head_sha,
               metadata->'github_bridge'->>'egress_head' AS egress_head
          FROM harness_shared.routines
         WHERE install_slug = ${entry.slug} AND target_role = 'system:git-sync'
         LIMIT 1`;
      const row = rows[0];
      // WI-5738 — measure against the EGRESS target, not the ingress mirror.
      //
      // This read used to be `readNamespaceRef(..., github_default_branch)`,
      // i.e. the mirror of the branch the bridge INGESTS. On papercusp that is
      // `main`, while the bridge EGRESSES to `refs/heads/staging`. main is
      // fast-forwarded hourly by the release pipeline, so the watchdog's two
      // signals were both permanently pinned healthy — ahead-count sat at ~24
      // (< the 50 threshold) and the tracked tip never aged past ~1h — while
      // origin/staging, the ref the bridge actually writes, stayed frozen for
      // five days, 358 commits behind. The watchdog was watching a branch that
      // could not tell it anything about the thing it was built to watch.
      //
      // `github_bridge.egress_head` is what egress last actually landed. The
      // ingress mirror remains a fallback ONLY for a hive whose egress has not
      // reported yet (pre-upgrade metadata), where the old signal is still
      // better than none.
      // Defence in depth for the same trap, from the READ side. Even with the
      // sticky write, `egress_head` can be absent (pre-upgrade metadata, or a
      // hive whose egress has genuinely never reported). Falling straight back
      // to the ingress mirror is what made this watchdog blind for five days —
      // that branch is fast-forwarded hourly by the RELEASE pipeline, so it
      // reports healthy no matter how wedged egress is, and it RESETS the
      // staleness clock every hour.
      //
      // `of_origin_sha` is this watchdog's OWN last real observation. Preferring
      // it means a vanished signal leaves the clock RUNNING (so a genuine wedge
      // still alarms) instead of being reset by an unrelated branch. The
      // ingress mirror survives only as the last resort for a hive that has
      // never once observed an egress head — there, a weak signal beats none.
      const prevOriginSha = row?.of_origin_sha ?? null;
      const originSha = selectOriginWatermark({
        egressHead: row?.egress_head ?? null,
        lastObserved: prevOriginSha,
        ingressMirror: ingressMirrorSha,
      });
      const alerted = row?.of_alerted ?? false;
      // WI-6643: null on a row that latched before this key existed — treated as
      // the legacy framing, so an in-flight origin-behind alarm does not re-fire.
      const alertedCause = row?.of_alerted_cause ?? 'origin-behind';
      const prevOriginSinceMs = row?.of_origin_since_ms != null ? Number(row.of_origin_since_ms) : null;

      let originTipAgeMs: number | null = null;
      if (originSha == null) {
        originTipAgeMs = null; // never observed an origin tip yet
      } else if (originSha !== prevOriginSha || prevOriginSinceMs == null) {
        // Origin tip advanced (or first observation) — (re)start its clock.
        await sql`
          UPDATE harness_shared.routines
             SET metadata = COALESCE(metadata, '{}'::jsonb)
                   || jsonb_build_object('of_origin_sha', ${originSha}::text, 'of_origin_since_ms', ${now}::bigint),
                 updated_at = now()
           WHERE install_slug = ${entry.slug} AND target_role = 'system:git-sync'`;
        originTipAgeMs = 0;
      } else {
        originTipAgeMs = now - prevOriginSinceMs;
      }

      const aheadCount =
        canonicalSha != null && originSha != null ? await revListCount(repoPath, originSha, canonicalSha, runGit) : null;

      // WI-5738: the publish leg's OWN refusal self-report — recorded on every
      // tick at metadata.own_head_publish.refused since the guard shipped, and
      // until now raising absolutely nothing.
      const publishRefusalCode = row?.publish_refused ?? null;
      const prevRefusedSweeps = row?.of_publish_refused_sweeps ?? 0;
      const publishRefusedSweeps = publishRefusalCode ? prevRefusedSweeps + 1 : 0;
      if (publishRefusedSweeps !== prevRefusedSweeps) {
        await sql`
          UPDATE harness_shared.routines
             SET metadata = COALESCE(metadata, '{}'::jsonb)
                   || jsonb_build_object('of_publish_refused_sweeps', ${publishRefusedSweeps}::int),
                 updated_at = now()
           WHERE install_slug = ${entry.slug} AND target_role = 'system:git-sync'`;
      }

      // WI-6996: the publish leg's OWN backlog self-report — the signal that catches the
      // failure the two inferred signals are structurally blind to (canonical frozen ⇒
      // canonical === origin ⇒ aheadCount exactly 0 ⇒ early-return ok on every sweep).
      //
      // EI-19341709637436070: this field used to be persisted as `drained`, assigned
      // `!resolution.complete` — a name that reads as "has been drained" (healthy) while
      // meaning the opposite (backlog remains). Renamed to `backlogRemains` at the source
      // (own-head-publish.ts) and here, so the value now agrees with its name. A hard
      // refusal / CAS failure records `false` here, which is correct: those are the
      // refusal signal's job, not this one's, so the two never double-count.
      const publishHasBacklog = row?.publish_backlog_remains === 'true';
      const prevBacklogSweeps = row?.of_publish_backlog_sweeps ?? 0;
      const publishBacklogSweeps = publishHasBacklog ? prevBacklogSweeps + 1 : 0;
      if (publishBacklogSweeps !== prevBacklogSweeps) {
        await sql`
          UPDATE harness_shared.routines
             SET metadata = COALESCE(metadata, '{}'::jsonb)
                   || jsonb_build_object('of_publish_backlog_sweeps', ${publishBacklogSweeps}::int),
                 updated_at = now()
           WHERE install_slug = ${entry.slug} AND target_role = 'system:git-sync'`;
      }

      // How far the published head trails the worktree head, for the alarm body only.
      // Never thresholded: a large backlog that is draining is healthy, a small one that
      // never moves is not — the SWEEP COUNT is the verdict. revListCount returns null if
      // either sha is missing from the bare store (the worktree head need not be there).
      const publishBacklogCommits =
        publishHasBacklog && row?.publish_published_sha && row?.publish_head_sha
          ? await revListCount(repoPath, row.publish_published_sha, row.publish_head_sha, runGit)
          : null;

      // EI-19442274898324113: the INTEGRATOR leg's backlog — this device's namespace standing
      // ahead of canonical refs/hive/staging. Sibling of the publish signal above, one stage
      // downstream, and the one signal that can still see a fault after an integrator stall has
      // frozen canonical and origin TOGETHER (which zeroes aheadCount and silences everything
      // else). Best-effort by construction: a device whose own namespace ref is absent, or whose
      // pubkey is unresolvable, yields null ⇒ treated as healthy, never a false alarm.
      let integratorBacklogCommits: number | null = null;
      try {
        if (canonicalSha != null) {
          integratorBacklogCommits = await integratorBacklogAcrossDevices(repoPath, canonicalSha, runGit);
        }
      } catch {
        integratorBacklogCommits = null; // diagnostics must never break the sweep
      }
      // A BARE "namespace is ahead" IS NOT A STALL — thresholding on it would make this
      // detector a noise generator on every healthy busy pot. Measured on papercusp
      // 2026-08-03 minutes after the incident cleared: canonical == origin (fully recovered)
      // and the namespace was STILL 4 commits ahead, because git-sync commits every ~3 min
      // while this watchdog samples every 15 — so an instantaneous delta is nonzero almost
      // always, and a sweep counter keyed on it would climb monotonically and alarm within
      // the hour on a perfectly healthy pipeline.
      //
      // The real condition is "the namespace is ahead AND canonical DID NOT MOVE since the
      // last sweep" — i.e. the integrator had work to do and did not do it. On a healthy pot
      // canonical advances between sweeps, so the counter resets to 0 every time; during the
      // real 2026-08-03 stall canonical was pinned at 7450c49aa5 for ~5.4h, so it climbs.
      // This mirrors how `of_origin_sha` / `of_origin_since_ms` above track the ORIGIN tip:
      // a remembered sha is what turns an instantaneous reading into a progress verdict.
      const prevIntegratorCanonicalSha = row?.of_integrator_canonical_sha ?? null;
      const canonicalAdvanced = canonicalSha != null && canonicalSha !== prevIntegratorCanonicalSha;
      const integratorStalled = isIntegratorStalledThisSweep({
        backlogCommits: integratorBacklogCommits,
        canonicalSha,
        prevCanonicalSha: prevIntegratorCanonicalSha,
      });
      const prevIntegratorSweeps = row?.of_integrator_backlog_sweeps ?? 0;
      const integratorBacklogSweeps = integratorStalled ? prevIntegratorSweeps + 1 : 0;
      if (integratorBacklogSweeps !== prevIntegratorSweeps || canonicalAdvanced) {
        await sql`
          UPDATE harness_shared.routines
             SET metadata = COALESCE(metadata, '{}'::jsonb)
                   || jsonb_build_object(
                        'of_integrator_backlog_sweeps', ${integratorBacklogSweeps}::int,
                        'of_integrator_canonical_sha', ${canonicalSha}::text),
                 updated_at = now()
           WHERE install_slug = ${entry.slug} AND target_role = 'system:git-sync'`;
      }

      const verdict = evaluateOriginFreshness(
        {
          aheadCount,
          originTipAgeMs,
          publishRefusedSweeps,
          publishRefusalCode,
          publishBacklogSweeps,
          publishBacklogCommits,
          integratorBacklogSweeps,
          integratorBacklogCommits,
        },
        opts,
      );

      const prevStallSweeps = row?.of_stall_sweeps ?? 0;
      const stallSweeps = verdict.state === 'stale' ? prevStallSweeps + 1 : 0;
      if (stallSweeps !== prevStallSweeps) {
        await sql`
          UPDATE harness_shared.routines
             SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('of_stall_sweeps', ${stallSweeps}::int),
                 updated_at = now()
           WHERE install_slug = ${entry.slug} AND target_role = 'system:git-sync'`;
      }

      const framing = describeOriginFreshnessAlert(verdict, {
        slug: entry.slug,
        potHomeSlug,
        publishRefusalCode,
        publishBacklogCommits,
        integratorBacklogCommits,
        // EI-21517899493871930: hand the framing the origin numbers this sweep ALREADY
        // measured (same two values `evaluateOriginFreshness` was called with, above), so a
        // p2p-publish alarm reports origin's actual state instead of asserting one. Without
        // them the alarm claimed origin was dead while it was ~1 commit behind and advancing.
        aheadCount,
        originTipAgeMs,
      });

      if (verdict.state === 'stale') {
        // WI-6643: the one-shot latch is keyed by CAUSE, not by a bare boolean.
        // Three distinguishable signals used to share one `of_alerted` flag, so
        // whichever fired first silenced the others for as long as it stayed
        // stale — and since a publish refusal keeps `state:'stale'` pinned, an
        // origin-behind alarm that latched first could mask a later refusal
        // FOREVER while its summary kept describing the wrong subsystem. A
        // change of cause re-alarms once, then falls back to one-shot.
        if (alerted && alertedCause === framing.cause) continue; // one-shot until recovery
        if (stallSweeps < stallSustainMinSweeps) continue; // debounce a transient blip

        const flip = await sql`
          UPDATE harness_shared.routines
             SET metadata = COALESCE(metadata, '{}'::jsonb)
                   || jsonb_build_object('of_alerted', true, 'of_alerted_cause', ${framing.cause}::text),
                 updated_at = now()
           WHERE install_slug = ${entry.slug}
             AND target_role = 'system:git-sync'
             AND (COALESCE((metadata->>'of_alerted')::boolean, false) = false
                  OR COALESCE(metadata->>'of_alerted_cause', '') IS DISTINCT FROM ${framing.cause}::text)`;
        if (flip.count !== 1) continue; // another process won the flip

        try {
          const { notifyAttention } = await import('../attention-notify');
          await notifyAttention({
            kind: 'intervention',
            title: framing.title,
            body: `${entry.slug} (bridged hive ${potHomeSlug}): ${verdict.reason}.`,
            importance: 'urgent',
            workspaceId,
            data: {
              cause: framing.cause,
              aheadCountStale: verdict.aheadCountStale,
              tipAgeStale: verdict.tipAgeStale,
              publishRefused: verdict.publishRefused,
              publishRefusalCode,
            },
          });
        } catch (e) {
          console.warn(`[origin-freshness-watchdog] notify failed: ${e instanceof Error ? e.message : e}`);
        }

        await broadcastSevereEvent({
          summary: framing.summary,
          body: `${verdict.reason}\n\n${framing.whyItMatters}`,
          category: 'severe-event',
          conditionKey: `origin-freshness:${entry.slug}`,
          // WI-6228: one-shot until recovery (`if (alerted) continue` above) — our
          // silence is deliberate, never evidence origin caught up. This exact
          // condition was falsely auto-resolved 120m after its single alarm on
          // 2026-07-26 while the egress freeze was still live.
          oneShot: true,
        });

        try {
          await sql`
            INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
            VALUES (${entry.slug}, ${WATCHDOG_PHASE}, ${JSON.stringify({
              kind: WATCHDOG_KIND,
              harness_slug: entry.slug,
              pot_home_slug: potHomeSlug,
              aheadCount,
              originTipAgeHrs: originTipAgeMs != null ? Math.round(originTipAgeMs / 3_600_000) : null,
              emitted_at: now,
              detail: `origin-freshness watchdog: ${verdict.reason}`,
            })}, ${now}, ${workspaceId})
            ON CONFLICT (harness_slug, phase)
            DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`;
        } catch (e) {
          console.warn(`[origin-freshness-watchdog] escalation write failed: ${e instanceof Error ? e.message : e}`);
        }
        out.alarmed.push(entry.slug);
        console.warn(`[origin-freshness-watchdog] ALARM ${entry.slug}: ${verdict.reason}`);
      } else {
        const cleared = await sql`
          UPDATE harness_shared.harness_escalations
             SET escalation = NULL, mtime_ms = ${now}
           WHERE harness_slug = ${entry.slug}
             AND phase = ${WATCHDOG_PHASE}
             AND escalation IS NOT NULL`;
        if (alerted) {
          await sql`
            UPDATE harness_shared.routines
               SET metadata = (COALESCE(metadata, '{}'::jsonb) || '{"of_alerted":false}'::jsonb)
                     - 'of_alerted_cause',
                   updated_at = now()
             WHERE install_slug = ${entry.slug} AND target_role = 'system:git-sync'`;
          recoveredForBroadcast.push({ slug: entry.slug, cause: normalizeAlertedCause(alertedCause) });
          out.recovered.push(entry.slug);
        } else if (cleared.count > 0) {
          console.warn(
            `[origin-freshness-watchdog] cleared a STRANDED escalation for ${entry.slug} (alerted flag was already false)`,
          );
        }
      }
    }

    // ── EI-20285011147862697 — the PUBLISH-HEALTH pass ────────────────────────────
    //
    // Deliberately separate from the origin pass above. All four `continue` gates at
    // the top of that loop (github_remote, potHomeSlug, mode resolution, mode ===
    // 'bridged') are ORIGIN preconditions and are correct AS SUCH: with no GitHub
    // remote and no bridged mode there is genuinely no origin to be fresh against.
    // But each of them skips the ENTIRE body — including the publish-REFUSAL (WI-5738)
    // and publish-BACKLOG (WI-6996) signals, neither of which needs an origin at all.
    // Both read `metadata.own_head_publish.*` off the pot's own git-sync routine row,
    // which exists for every pot that publishes p2p.
    //
    // MEASURED 2026-08-12 (papercusp-workspace): 3 pots are `bridged` while 42 carry an
    // own_head_publish leg — so 39 publish legs were evaluated by NOTHING, and the one
    // pot actually wedged (papercusp/papercusp-desktop, refused:'secrets', ~41h / 189
    // consecutive refusals) sat in that unwatched majority, reporting itself honestly on
    // every tick into a void. It should have alarmed after 3 sweeps; it never got one.
    //
    // The zero-coverage self-report below could not catch it either: its denominator was
    // `countBridgedPots()` — the SAME narrow population — so 3-of-3 read as full
    // coverage. That is why this is a coverage fix and not merely a louder warning.
    //
    // This pass evaluates ONLY the two publish signals, only for pots the origin pass
    // dropped, and writes only keys that pass does not own for them — so it cannot
    // regress the bridged pots that work today.
    for (const { workspaceId, entry } of targets) {
      if (originCheckedSlugs.has(entry.slug)) continue; // the origin pass already judged it
      const potHomeSlug = potHomeSlugOf(entry);
      if (!potHomeSlug) continue; // cannot frame an alert without a pot home

      const rows = await sql<
        {
          publish_refused: string | null;
          publish_backlog_remains: string | null;
          publish_published_sha: string | null;
          publish_head_sha: string | null;
          of_publish_refused_sweeps: number | null;
          of_publish_backlog_sweeps: number | null;
          of_alerted: boolean | null;
          of_alerted_cause: string | null;
        }[]
      >`
        SELECT metadata->'own_head_publish'->>'refused' AS publish_refused,
               metadata->'own_head_publish'->>'backlogRemains' AS publish_backlog_remains,
               metadata->'own_head_publish'->>'publishedSha' AS publish_published_sha,
               metadata->'own_head_publish'->>'sha' AS publish_head_sha,
               COALESCE((metadata->>'of_publish_refused_sweeps')::int, 0) AS of_publish_refused_sweeps,
               COALESCE((metadata->>'of_publish_backlog_sweeps')::int, 0) AS of_publish_backlog_sweeps,
               COALESCE((metadata->>'of_alerted')::boolean, false) AS of_alerted,
               metadata->>'of_alerted_cause' AS of_alerted_cause
          FROM harness_shared.routines
         WHERE install_slug = ${entry.slug}
           AND target_role = 'system:git-sync'
           AND metadata->'own_head_publish' IS NOT NULL
         LIMIT 1`;
      const row = rows[0];
      if (!row) continue; // no publish leg on this pot — nothing to judge

      out.publishChecked = (out.publishChecked ?? 0) + 1;

      const publishRefusalCode = row.publish_refused ?? null;
      const publishRefusedSweeps = publishRefusalCode ? (row.of_publish_refused_sweeps ?? 0) + 1 : 0;
      const publishHasBacklog = row.publish_backlog_remains === 'true';
      const publishBacklogSweeps = publishHasBacklog ? (row.of_publish_backlog_sweeps ?? 0) + 1 : 0;
      if (
        publishRefusedSweeps !== (row.of_publish_refused_sweeps ?? 0) ||
        publishBacklogSweeps !== (row.of_publish_backlog_sweeps ?? 0)
      ) {
        await sql`
          UPDATE harness_shared.routines
             SET metadata = COALESCE(metadata, '{}'::jsonb)
                   || jsonb_build_object(
                        'of_publish_refused_sweeps', ${publishRefusedSweeps}::int,
                        'of_publish_backlog_sweeps', ${publishBacklogSweeps}::int),
                 updated_at = now()
           WHERE install_slug = ${entry.slug} AND target_role = 'system:git-sync'`;
      }

      // Origin signals are deliberately null: this pot HAS no origin, so inferring one
      // would manufacture exactly the false reading this whole file keeps re-learning.
      // evaluateOriginFreshness computes the publish signals first and independently of
      // every origin inference (see its WI-5738 / WI-6996 comments), so a refusal alarms
      // on its own here.
      const verdict = evaluateOriginFreshness(
        {
          aheadCount: null,
          originTipAgeMs: null,
          publishRefusedSweeps,
          publishRefusalCode,
          publishBacklogSweeps,
          publishBacklogCommits: null,
          integratorBacklogSweeps: 0,
          integratorBacklogCommits: null,
        },
        opts,
      );
      const framing = describeOriginFreshnessAlert(verdict, {
        slug: entry.slug,
        potHomeSlug,
        publishRefusalCode,
        publishBacklogCommits: null,
        integratorBacklogCommits: null,
        // EI-21517899493871930: explicitly UNMEASURED, for the same reason the snapshot above
        // passes nulls — this pot has no origin, so there is nothing to measure. The framing
        // then says so outright rather than inferring impact from the publish refusal.
        aheadCount: null,
        originTipAgeMs: null,
      });

      const alerted = row.of_alerted ?? false;
      const alertedCause = row.of_alerted_cause ?? null;

      if (verdict.state === 'stale') {
        if (alerted && alertedCause === framing.cause) continue; // one-shot until recovery

        const flip = await sql`
          UPDATE harness_shared.routines
             SET metadata = COALESCE(metadata, '{}'::jsonb)
                   || jsonb_build_object('of_alerted', true, 'of_alerted_cause', ${framing.cause}::text),
                 updated_at = now()
           WHERE install_slug = ${entry.slug}
             AND target_role = 'system:git-sync'
             AND (COALESCE((metadata->>'of_alerted')::boolean, false) = false
                  OR COALESCE(metadata->>'of_alerted_cause', '') IS DISTINCT FROM ${framing.cause}::text)`;
        if (flip.count !== 1) continue; // another process won the flip

        try {
          const { notifyAttention } = await import('../attention-notify');
          await notifyAttention({
            kind: 'intervention',
            title: framing.title,
            body: `${entry.slug} (p2p hive ${potHomeSlug}, no origin): ${verdict.reason}.`,
            importance: 'urgent',
            workspaceId,
            data: {
              cause: framing.cause,
              aheadCountStale: false,
              tipAgeStale: false,
              publishRefused: verdict.publishRefused,
              publishRefusalCode,
            },
          });
        } catch (e) {
          console.warn(`[origin-freshness-watchdog] notify failed: ${e instanceof Error ? e.message : e}`);
        }

        await broadcastSevereEvent({
          summary: framing.summary,
          body: `${verdict.reason}\n\n${framing.whyItMatters}`,
          category: 'severe-event',
          conditionKey: `origin-freshness:${entry.slug}`,
          oneShot: true,
        });

        try {
          await sql`
            INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
            VALUES (${entry.slug}, ${WATCHDOG_PHASE}, ${JSON.stringify({
              kind: WATCHDOG_KIND,
              harness_slug: entry.slug,
              pot_home_slug: potHomeSlug,
              aheadCount: null,
              originTipAgeHrs: null,
              emitted_at: now,
              detail: `origin-freshness watchdog (publish-health pass): ${verdict.reason}`,
            })}, ${now}, ${workspaceId})
            ON CONFLICT (harness_slug, phase)
            DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`;
        } catch (e) {
          console.warn(`[origin-freshness-watchdog] escalation write failed: ${e instanceof Error ? e.message : e}`);
        }
        out.alarmed.push(entry.slug);
        console.warn(`[origin-freshness-watchdog] ALARM ${entry.slug} (publish-health): ${verdict.reason}`);
      } else if (alerted) {
        await sql`
          UPDATE harness_shared.harness_escalations
             SET escalation = NULL, mtime_ms = ${now}
           WHERE harness_slug = ${entry.slug}
             AND phase = ${WATCHDOG_PHASE}
             AND escalation IS NOT NULL`;
        await sql`
          UPDATE harness_shared.routines
             SET metadata = (COALESCE(metadata, '{}'::jsonb) || '{"of_alerted":false}'::jsonb)
                   - 'of_alerted_cause',
                 updated_at = now()
           WHERE install_slug = ${entry.slug} AND target_role = 'system:git-sync'`;
        recoveredForBroadcast.push({ slug: entry.slug, cause: normalizeAlertedCause(alertedCause) });
        out.recovered.push(entry.slug);
      }
    }

    if (recoveredForBroadcast.length > 0) {
      const list = recoveredForBroadcast.map((r) => r.slug).join(', ');
      await broadcastSevereEventResolvedMany({
        conditionKeys: recoveredForBroadcast.map((r) => `origin-freshness:${r.slug}`),
        summary:
          // WI-6643: a refusal clearing is not "origin caught back up" — on
          // 2026-07-28 the recovery said exactly that when what had actually
          // happened was a secrets exemption landing.
          recoveredForBroadcast.length === 1
            ? describeOriginFreshnessRecovery(recoveredForBroadcast[0]!.cause, list)
            : `origin freshness RECOVERED on ${recoveredForBroadcast.length} hives (${list}) — publish/origin flow has resumed.`,
      });
    }
    // WI-5791 — the self-report. A sweep that checked nothing is not a healthy
    // sweep, and until now it was reported as one. Only meaningful when bridged
    // pots actually exist: a workspace with none legitimately checks zero.
    //
    // This deliberately does NOT stop at a console.warn. The whole lesson of this
    // incident is that a signal nobody reads is not a detector — a warn buried in
    // the bg-host journal would be the same mistake one level up. It goes to the
    // same severe-event surface a real origin-freshness stall uses, keyed on a
    // stable conditionKey so it dedupes rather than storms, and edge-triggered off
    // module state so a persistent blindness broadcasts once, not every 15 minutes.
    if (out.checked === 0) {
      const bridged = await countBridgedPots(sql);
      if (bridged > 0) {
        out.blind = true;
        console.warn(
          `[origin-freshness-watchdog] BLIND: checked 0 entries across ${workspaceIdsSwept} workspace(s) while ${bridged} bridged pot(s) exist. ` +
            `This watchdog is not watching anything — treat every 'clean' origin-freshness pass as unverified until fixed.`,
        );
        if (!lastSweepWasBlind) {
          lastSweepWasBlind = true;
          await broadcastSevereEvent({
            summary: `origin-freshness watchdog is BLIND — it checked 0 pots while ${bridged} bridged pot(s) exist. Origin freshness is NOT being monitored.`,
            body:
              `The sweep enumerated ${workspaceIdsSwept} workspace(s) and found no eligible entry, so no origin tip was measured, aged, or judged ` +
              `on this pass. A 'clean' origin-freshness result right now means NOTHING WAS CHECKED — not that origin is healthy.\n\n` +
              `This is the failure mode described in agent-insights/absorbing-state-guards-and-self-report-detectors (Shape D): a correctly ` +
              `written detector aimed at an empty set reports a clean pass forever. Claim it: check which workspaces own a harness registry ` +
              `(harness_shared.harness_registry) versus which own the bridged pots (harness_shared.pot_settings, setting_key='hiveGit.mode'), ` +
              `and confirm the sweep's scope covers the latter.`,
            category: 'severe-event',
            conditionKey: WATCHDOG_BLIND_CONDITION_KEY,
            // WI-6228: edge-triggered off `lastSweepWasBlind` — "a persistent
            // blindness broadcasts once, not every 15 minutes". A blind watchdog
            // that stays blind must NEVER be auto-resolved by its own silence:
            // that would retire the one signal saying nothing is being monitored.
            oneShot: true,
          });
        }
      }
    } else if (lastSweepWasBlind) {
      // Coverage came back — retract the blindness alarm, same as any recovery.
      lastSweepWasBlind = false;
      await broadcastSevereEventResolvedMany({
        conditionKeys: [WATCHDOG_BLIND_CONDITION_KEY],
        summary: `origin-freshness watchdog RECOVERED coverage — it is checking ${out.checked} pot(s) again.`,
      });
    }

    return out;
  } catch (e) {
    console.warn(`[origin-freshness-watchdog] pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return out;
  }
}

let watchdogTimer: ManagedHandle | null = null;

/**
 * Start the watchdog: an immediate boot check + a recurring process-level sweep. Idempotent.
 * Kill-switch: PAPERCUSP_ORIGIN_FRESHNESS_WATCHDOG='0'.
 */
export function startOriginFreshnessWatchdog(sql: Sql, opts: OriginFreshnessWatchdogOptions = {}): void {
  if (process.env.PAPERCUSP_ORIGIN_FRESHNESS_WATCHDOG === '0') return;
  const intervalMs = opts.intervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS;

  const run = (): void => {
    void checkOriginFreshness(sql, opts).then((r) => {
      if (r.alarmed.length > 0) {
        console.warn(`[origin-freshness-watchdog] alarmed on: ${r.alarmed.join(', ')}`);
      }
      // WI-5791: surface the watchdog's OWN failure at the same volume as the
      // failures it watches for. Without this the blind state is only visible to
      // a caller that inspects the result object — and nothing ever did, which is
      // how it stayed blind from the day it shipped.
      if (r.blind) {
        console.warn(
          `[origin-freshness-watchdog] BLIND — this sweep watched nothing. Origin-freshness is NOT being monitored.`,
        );
      }
    });
  };

  run(); // boot check
  if (watchdogTimer) watchdogTimer.stop();
  watchdogTimer = managedSetInterval('origin-freshness-watchdog', intervalMs, run, { category: 'watchdog' });
}

export { DEFAULT_AHEAD_COUNT_MAX, DEFAULT_TIP_AGE_STALE_MS };
