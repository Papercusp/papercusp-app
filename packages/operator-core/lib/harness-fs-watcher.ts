/**
 * Per-process singleton that mirrors one FS data source to PG so that
 * panels can read via Zero's WS push instead of polling REST:
 *
 *   .papercusp/proposals/*.md         → harness_shared.harness_proposals_shared
 *
 * (pending-reviews retired — fs-watcher-retirement step 3: pending_reviews is
 *  PG-canonical at producer time (audit P-077); promote.ts writes PG directly
 *  and resolveReview updates PG directly, so the FS→PG mirror was redundant —
 *  and its orphan-delete sweep was a latent hazard to the PG-only rows.)
 *
 * Architecture:
 *   - chokidar watches every registered project's `.papercusp/` directory,
 *     across all three phased worktrees (staging, testing, production).
 *   - Per-path debounced upserts (200ms) collapse fast-fire writes from
 *     agent processes to a single PG roundtrip.
 *   - awaitWriteFinish stabilises events on partial writes.
 *   - A 60-second reconciliation sweep compares filesystem mtimes against
 *     PG `mtime_ms` and replays any divergence — catches dropped inotify
 *     events under memory pressure. Also deletes orphan proposal rows whose
 *     file is gone from disk.
 *   - Pinned to globalThis to survive Next.js dev module re-evaluation
 *     (anti-pattern A18 from /docs/performance).
 *
 * Phase awareness (Item 2 of the polling-removal arc):
 *   - Each project may have up to three worktrees: staging (project.path),
 *     testing (`<path>--testing` or config override), production
 *     (`<path>--production` or override). The watcher mirrors all three
 *     when their .papercusp/ directories exist.
 *   - Every PG row carries a `phase` column. (harness_slug, phase, ...)
 *     is the composite PK across all three mirror tables.
 *   - phasePath() and ALL_PHASES are imported from @/lib/harness-phases
 *     so the watcher and the API routes share a single source of truth.
 *
 * Lifecycle:
 *   - Started lazily on first /api/harness/* request via ensureHarnessFsWatcher().
 *   - Re-reads the project list on each reconcile tick so newly-registered
 *     harnesses get watched without a process restart.
 *   - SIGTERM handler stops chokidar cleanly so inotify watches release.
 *
 * Workspace-aware project model (EI-107 fix, per-window-workspace-context-2026-05-31
 * P-020): the project list is loaded per-OWNING-workspace via
 * `backgroundWorkspaceIds()` (every registered workspace under the shared-operator
 * model; just the one active workspace otherwise) + `loadHarnessRegistry(workspaceId)`
 * per id — see `loadAllProjects()`. Each `TaggedProject` carries the workspaceId that
 * actually registered it, and `phaseForPath()` threads that id through to every PG
 * write (`upsertProposal`/`deleteProposal` take it as an explicit parameter — they no
 * longer call `activeWorkspaceId()`). This closes both pollution windows the previous
 * revision of this comment documented as open:
 *   1. Workspace switch: a harness that no longer belongs to the *global* active
 *      workspace is still watched until the next 60s reconcile, but its events now
 *      stamp the workspace that owns IT, not whatever `activeWorkspaceId()` resolves
 *      to at event time — so a switch no longer mis-stamps stale-window events.
 *   2. Shared-operator model (`PAPERCUSP_SHARED_OPERATOR=1`, multiple workspaces live
 *      at once): the watcher now watches + correctly stamps EVERY registered
 *      workspace's projects, not just the global one.
 * The 60s reconcile sweep (`reconcileAll`) re-derives the full tagged project list
 * the same way, so a workspace registering/deregistering a harness converges within
 * ~60s as before — only the stamping is now correct throughout.
 */
import { promises as fs, existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { getResourceProfile } from './resource-profile';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, basename, dirname } from 'node:path';

const execFileP = promisify(execFile);
import chokidar, { type FSWatcher } from 'chokidar';

import { getOrgPg, generated } from '@papercusp/db-org';
import { and, eq, sql as dsql } from 'drizzle-orm';

const hps = generated.harnessProposalsSharedInHarnessShared;
import { loadHarnessRegistry, type ProjectEntry } from './harness-registry';
import { backgroundWorkspaceIds } from './workspace-registry';
import { ALL_PHASES, phasePath, type Phase } from './harness-phases';
import { notifySyncInvalidate } from './sync-sse';

// not a DBOS candidate (dbos-scheduler-consolidation-2026-06-03 D-002 / P-011):
// the watcher is event-driven (chokidar); this 60s tick is only a reconcile
// BACKSTOP for dropped inotify events + in-process watcher state. A detached DBOS
// cron would lose the watcher's in-memory view — it stays in-process.
// F-E5 (app-wide-load-traps § E): widen the background cadence on a quiet/
// battery host so periodic work runs proportionally less often (multiplier 1 on AC).
const RECONCILE_INTERVAL_MS = 60_000 * getResourceProfile().backgroundCadenceMultiplier;
const DEBOUNCE_MS = 200;

/**
 * Paths chokidar must never walk or poll.
 *
 * The dispatch only needs *structured* files — `*.md` proposals. The
 * `.log` / `.swp` extension guards keep chokidar from `lstat`-ing
 * high-volume append-only logs forever (that pegged the operator event loop
 * at ~100% and starved `/api/*` past the 30 s watchdog — the
 * `psu: route exceeded 30s` outage, 2026-06-05). `node_modules` / `.git` /
 * `embedded-pg-data*` are defensive guards so a broad watched root can never
 * trigger a recursive walk into a huge tree.
 */
const WATCHER_IGNORED_RE =
  /(?:^|\/)(?:node_modules|\.git|embedded-pg-data[^/]*)(?:\/|$)|\.(?:swp|swo|tmp|log)$/;

/** True when chokidar should ignore `p` (never emit events for / recurse into
 *  it). Exported for unit testing. */
export function isWatcherIgnored(p: string): boolean {
  return WATCHER_IGNORED_RE.test(p);
}

interface WatcherState {
  watcher: FSWatcher;
  /**
   * Secondary chokidar instance with `depth: 0` that fires events for
   * every file at the top of each `<harness-dir>/`. Lets us pick up
   * pattern-matched files we can't enumerate ahead of time (e.g.
   * `checkpoint-*.md`, `checkpoint-*.md.granted`) without recursing
   * into the dozens of subdirs the harness writes into. Wired to the
   * same `classifyAndDispatch`; debounce keys dedupe overlap with
   * the recursive watcher's specific-file watches.
   */
  topWatcher: FSWatcher;
  /**
   * Watches `~/.papercusp/harnesses/<slug>/enabled-plugins.json`. The
   * papercusp CLI writes this file directly (bypassing the operator API),
   * so without an FS watcher PG can drift. Mirroring on every change
   * keeps `harness_shared.plugin_enables` canonical for read paths.
   */
  enabledPluginsWatcher: FSWatcher;
  projects: TaggedProject[];
  /**
   * Paths currently subscribed on `watcher` / `topWatcher`. Tracked
   * explicitly (rather than re-derived from `projects`) because the
   * derivation is existence-filtered: a dir that existed at subscribe
   * time but was deleted since would vanish from a re-derivation on
   * BOTH sides of the reconcile diff, never get unwatched, and leave
   * chokidar watching its (possibly /tmp-sized) parent.
   */
  watchedPathSet: Set<string>;
  topWatchedPathSet: Set<string>;
  reconcileTimer: ManagedHandle;
  debouncers: Map<string, ReturnType<typeof setTimeout>>;
  stopped: boolean;
}

type _G = { __harnessFsWatcher?: WatcherState };
const _g = globalThis as unknown as _G;

/** A registry ProjectEntry tagged with the workspace that actually registered it. */
interface TaggedProject {
  project: ProjectEntry;
  workspaceId: string;
}

/**
 * Load the full project list this watcher instance must cover, tagged with
 * each project's OWNING workspace (EI-107 fix; P-020's `backgroundWorkspaceIds()`
 * — under the shared-operator model that is EVERY registered workspace, else just
 * the one active workspace, matching prior single-workspace behavior exactly).
 * Two workspaces are never merged into one flat untagged list, so a downstream PG
 * write can always stamp the workspace that owns the project the event came from,
 * instead of whatever `activeWorkspaceId()` resolves to at event time.
 */
async function loadAllProjects(): Promise<TaggedProject[]> {
  const wsIds = backgroundWorkspaceIds();
  const out: TaggedProject[] = [];
  for (const workspaceId of wsIds) {
    const reg = await loadHarnessRegistry(workspaceId);
    for (const project of reg.projects ?? []) {
      out.push({ project, workspaceId });
    }
  }
  return out;
}

/** All phased .papercusp/ directories that may exist for a project. */
function harnessDirsForProject(p: ProjectEntry): Array<{ phase: Phase; harnessDir: string }> {
  return ALL_PHASES.map((phase) => {
    const root = phasePath(p, phase);
    return { phase, harnessDir: join(root, '.papercusp') };
  });
}

/**
 * Watch paths chokidar should subscribe to for a given project.
 *
 * EXISTENCE-ANCHORED: every returned path must have an existing anchor
 * dir *inside* the project. chokidar watches the nearest existing
 * ancestor of a missing path to detect its creation — for a registry
 * entry whose project dir is gone (e.g. a cleaned-up /tmp e2e project)
 * that ancestor is /tmp or $HOME, giant high-churn dirs whose every
 * event triggers a full lstat-per-entry rescan. Two operators watching
 * /tmp (11k entries) burned ~1.6 cores each and saturated their event
 * loops (2026-06-06 incident). Paths whose anchor appears later are
 * picked up by the 60s reconcile re-derivation in reconcileAll().
 */
export function watchedPaths(p: ProjectEntry): string[] {
  const out: string[] = [];
  if (!existsSync(p.path)) return out; // dead project — never watch outside it
  for (const { harnessDir } of harnessDirsForProject(p)) {
    if (!existsSync(harnessDir)) continue; // anchor missing — reconcile adds it later
    out.push(
      join(harnessDir, 'proposals'),
      // pending-reviews: chokidar dispatch retired (fs-watcher-retirement step 3).
      // pending_reviews is PG-canonical at producer time (audit P-077).
      // summary.md: chokidar dispatch retired (fs-watcher-retirement step 2).
      // The harness_summaries mirror was a dead legacy path — nothing wrote
      // the top-level .papercusp/summary.md and nothing read the table (the
      // live summary UI is served from harness_text_artifacts, migration 035).
      // pending-issues.jsonl: chokidar dispatch retired; producer-time
      // PG writes from operator endpoints replaced the mirror.
      // config.json, tests/, escalation.md, supervisor-notes.md,
      // archives, prs.json, plan-review.md, smoke-{pass,failure}.md,
      // smoke-results.json, smoke-startup.log: producer-time PG writes
      // retired the watcher dispatch on these paths.
      // skills: producer-time PG writes via _post_curator_outputs.
      // debug/, logs/hooks, screenshots, run.log: chokidar
      // dispatch retired across this arc — producer-time PG writes via
      // their respective endpoints.
      // actions/, action-runs/: chokidar dispatch retired (fs-watcher-retirement
      // step 4). harness_branch_actions was an unconsumed mirror — the
      // /branch/:branch/actions REST route recomputes on demand (1s cache) and
      // nothing read the table; it was dropped.
    );
  }
  // Git-log: chokidar dispatch retired. Refresh now happens at 60s
  // reconcile cadence + on explicit UI request. No fs.watch on .git/.
  return out;
}

/**
 * harnessDirs the depth-0 topWatcher should subscribe to. Same
 * existence anchor as watchedPaths() — a missing harnessDir would make
 * chokidar watch its ancestors (project root, /tmp, $HOME).
 */
export function topWatchPaths(p: ProjectEntry): string[] {
  return harnessDirsForProject(p)
    .map(({ harnessDir }) => harnessDir)
    .filter((d) => existsSync(d));
}

function debounce(state: WatcherState, key: string, fn: () => Promise<void>): void {
  const existing = state.debouncers.get(key);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    state.debouncers.delete(key);
    fn().catch((e) => {
      console.warn(`[harness-fs-watcher] ${key} write failed:`, e?.message ?? e);
    });
  }, DEBOUNCE_MS);
  state.debouncers.set(key, t);
}

interface PhasedMatch {
  project: ProjectEntry;
  phase: Phase;
  harnessDir: string;
  /** The workspace that registered `project` (EI-107) — thread this through to
   *  every PG write instead of re-resolving `activeWorkspaceId()` at event time. */
  workspaceId: string;
}

/** Find the (project, phase) whose .harness dir contains `p`. */
function phaseForPath(state: WatcherState, p: string): PhasedMatch | null {
  for (const { project, workspaceId } of state.projects) {
    for (const { phase, harnessDir } of harnessDirsForProject(project)) {
      if (p === harnessDir || p.startsWith(harnessDir + '/')) {
        return { project, phase, harnessDir, workspaceId };
      }
    }
  }
  return null;
}

// Proposals are markdown (.md), not JSON. The accept/reject endpoints
// append `applied: true` / `appliedAt: <iso>` (or rejected:/rejectedAt:)
// into the file body — the file is the source-of-truth invariant. Sibling
// <id>.review.md (if present) carries `VERDICT: accept|reject|defer` plus
// a summary line. Both are parsed here so the panel can read structured
// fields from PG instead of re-reading every file.
function parseFooterTimestamp(body: string, key: string): number | null {
  const re = new RegExp('^' + key + ':\\s*(.+)$', 'm');
  const m = body.match(re);
  if (!m) return null;
  const raw = m[1].trim();
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

async function upsertProposal(
  slug: string,
  phase: Phase,
  path: string,
  workspaceId: string,
): Promise<void> {
  const filename = path.split('/').pop() ?? '';
  if (!filename.endsWith('.md') || filename.endsWith('.review.md')) return;
  const proposalId = filename;
  let body = '';
  let mtimeMs = 0;
  let sizeBytes = 0;
  try {
    body = await fs.readFile(path, 'utf8');
    const st = statSync(path);
    mtimeMs = st.mtimeMs;
    sizeBytes = st.size;
  } catch {
    return;
  }

  const applied = /^applied:\s*true/m.test(body);
  const rejected = /^rejected:\s*true/m.test(body);
  const status = applied ? 'applied' : rejected ? 'rejected' : 'pending';
  const appliedAt = applied
    ? (parseFooterTimestamp(body, 'appliedAt') ?? Math.floor(mtimeMs))
    : null;
  const rejectedAt = rejected
    ? (parseFooterTimestamp(body, 'rejectedAt') ?? Math.floor(mtimeMs))
    : null;

  let reviewVerdict: string | null = null;
  let reviewSummary: string | null = null;
  let reviewedAt: number | null = null;
  const reviewPath = path.replace(/\.md$/, '.review.md');
  try {
    const reviewBody = await fs.readFile(reviewPath, 'utf8');
    const verdictMatch = reviewBody.match(/^VERDICT:\s*(accept|reject|defer)\b/im);
    if (verdictMatch) reviewVerdict = verdictMatch[1].toLowerCase();
    try { reviewedAt = Math.floor(statSync(reviewPath).mtimeMs); } catch {}
    const summaryLine = reviewBody
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !/^VERDICT:/i.test(l) && !/^#/.test(l));
    reviewSummary = summaryLine ? summaryLine.slice(0, 240) : null;
  } catch { /* no reviewer file */ }

  const { db } = getOrgPg();
  const ws = workspaceId;
  const ts = Math.floor(mtimeMs);
  await db
    .insert(hps)
    .values({
      harnessSlug: slug,
      phase,
      proposalId: proposalId,
      status,
      reviewVerdict: reviewVerdict,
      reviewSummary: reviewSummary,
      reviewedAt: reviewedAt,
      appliedAt: appliedAt,
      rejectedAt: rejectedAt,
      sizeBytes: sizeBytes,
      payload: { body } as any,
      ts,
      mtimeMs: Math.floor(mtimeMs),
      workspaceId: ws,
    })
    .onConflictDoUpdate({
      target: [hps.harnessSlug, hps.phase, hps.proposalId],
      set: {
        status: dsql`EXCLUDED.status`,
        reviewVerdict: dsql`EXCLUDED.review_verdict`,
        reviewSummary: dsql`EXCLUDED.review_summary`,
        reviewedAt: dsql`EXCLUDED.reviewed_at`,
        appliedAt: dsql`EXCLUDED.applied_at`,
        rejectedAt: dsql`EXCLUDED.rejected_at`,
        sizeBytes: dsql`EXCLUDED.size_bytes`,
        payload: dsql`EXCLUDED.payload`,
        ts: dsql`EXCLUDED.ts`,
        mtimeMs: dsql`EXCLUDED.mtime_ms`,
        workspaceId: dsql`EXCLUDED.workspace_id`,
      },
    });
}

async function deleteProposal(
  slug: string,
  phase: Phase,
  path: string,
  workspaceId: string,
): Promise<void> {
  const filename = path.split('/').pop() ?? '';
  if (!filename.endsWith('.md') || filename.endsWith('.review.md')) return;
  const proposalId = filename;
  const { db } = getOrgPg();
  // Scope by workspaceId too (EI-107): the table's PK is (harnessSlug, proposalId,
  // phase) with no workspace component, so under the shared-operator model two
  // workspaces registering a same-named harness/proposal would otherwise let one
  // workspace's delete remove the other's row.
  await db
    .delete(hps)
    .where(
      and(
        eq(hps.harnessSlug, slug),
        eq(hps.phase, phase),
        eq(hps.proposalId, proposalId),
        eq(hps.workspaceId, workspaceId),
      ),
    );
}

// ── Mirror 4 retired: harness_pending_issues is now written at producer
// time by operator endpoints (/:slug/issues/pending, /:slug/issues/triage,
// /:slug/issues/clear). Validator role POSTs each finding directly.

// ── Mirror 5 (harness_phases) RETIRED — fs-watcher-retirement step 5.
// It mirrored config.json + worktree existence, but its `alive` was hardcoded
// false (never live process state) and its only consumer (HealthBadge) was
// repointed to harness_lanes (the PID-swept live lane tracker). The
// /api/harness/:slug/phases REST route recomputes the full phase state on
// demand. Table dropped in migration 285.

// ── Mirror 6 retired: harness_tests is now written at producer time
// by bash run.sh's NEXT_TESTER block → /api/internal/test-snapshot.

// ── Mirror 7 retired: harness_escalations is now written at producer
// time by bash run.sh's plan-reviewer rejection path + bin/supervisor.sh
// → /api/internal/escalation-event.

// ── Mirror 7b retired: harness_archives is now written at producer
// time by bash run.sh's archiveOnDone hook → /api/internal/archive-event.

// ── Mirror 7b9 retired: harness_skills is now written at producer
// time by bash run.sh's _post_curator_outputs after `invoke curator`
// → /api/internal/skill-snapshot.

// ── Mirrors 7c1/7c2/7d retired: feature_prs, feature_debug_notes, and
// smoke_test are now written at producer time:
//   - PRs:        bash run.sh → POST /api/internal/pr-event
//   - debug note: bash run.sh debugger hook → POST /api/internal/feature-debug-note-event
//   - smoke test: bin/service-smoke-test.sh → POST /api/internal/smoke-test-event
// Watcher mirror handlers + reconcile sweeps deleted in this commit.

// ── Mirror 7c retired: harness_plan_review is now written at producer
// time by bash run.sh's plan-review block → /api/internal/plan-review-event.

// ── Mirror 7e retired: harness_checkpoints is now written at producer
// time by bash run.sh's checkpoint emitters → /api/internal/checkpoint-event
// (create) and the operator's grant endpoint (grant).

// ── Mirror 7f retired: harness_hook_logs is now written at producer
// time by bash run.sh's run_hook() → /api/internal/hook-log-event.
// HOOK_KEEP=50 cap is enforced by the endpoint on each insert.

// ── Mirror 7g retired: harness_screenshots is now written at producer
// time by the operator's POST/DELETE /:slug/screenshots endpoints.

// ── Mirror 7h retired: harness_decisions is now written at producer
// time by bash run.sh's log() → /api/internal/decision-event. The
// fs.watch + tail-grep parser was deleted in the same commit.

// ── Mirror 7i RETIRED: harness_git_log → on-demand REST ────────────────
// The git_log mirror was a pure cache over `git log` (git is the canonical
// producer). The UI (RealGitPanel / AdvGitPanel) now reads the on-demand
// /api/harness/<slug>/git/log route (3s-TTL cached, shells out live) — it
// always did, so the mirror was already UI-orphaned. The
// harness_shared.harness_git_log table is dropped in migration 258.
// (fs-watcher-retirement-2026-05-10 step 1.)

// Mirror 7k (harness_branch_actions) RETIRED — fs-watcher-retirement step 4.
// It was an unconsumed mirror: the /api/harness/<slug>/branch/<branch>/actions
// REST route recomputes the same payload on demand (1s cache) and nothing read
// the table (no UI sync subscriber). The table is dropped in migration 283.

function classifyAndDispatch(
  state: WatcherState,
  path: string,
  kind: 'add' | 'change' | 'unlink',
): void {
  // Git ref change: not dispatched. git is the producer and there's no
  // producer-event for "user committed" — and the harness_git_log mirror
  // is retired (fs-watcher-retirement step 1). The UI reads the on-demand
  // /api/harness/<slug>/git/log REST route (3s-TTL cached) instead.

  const match = phaseForPath(state, path);
  if (!match) return;
  const { project, phase, harnessDir: hd, workspaceId } = match;
  const slug = project.slug;

  // Proposals: top-level *.md only; .review.md siblings trigger an upsert
  // of the parent so review_verdict/review_summary refresh.
  const proposalsDir = join(hd, 'proposals');
  if (
    path.startsWith(proposalsDir + '/') &&
    path.endsWith('.md') &&
    !path.slice(proposalsDir.length + 1).includes('/')
  ) {
    if (path.endsWith('.review.md')) {
      const parent = path.replace(/\.review\.md$/, '.md');
      debounce(state, `proposal:${slug}:${phase}:${parent}`, async () => {
        await upsertProposal(slug, phase, parent, workspaceId);
      });
      return;
    }
    debounce(state, `proposal:${slug}:${phase}:${path}`, async () => {
      if (kind === 'unlink') await deleteProposal(slug, phase, path, workspaceId);
      else await upsertProposal(slug, phase, path, workspaceId);
    });
    return;
  }

  // Pending issues: written at producer time by the operator's
  // /:slug/issues/pending and /:slug/issues/triage endpoints.
  // Validator role POSTs each finding directly. Watcher mirror retired.

  // Phases: mirror fully retired (fs-watcher-retirement step 5). The
  // /api/harness/:slug/phases REST route recomputes phase state on demand;
  // HealthBadge reads liveness from harness_lanes. harness_phases dropped (mig 285).

  // Tests: written at producer time by bash run.sh's NEXT_TESTER block
  // → /api/internal/test-snapshot. Watcher mirror retired.

  // Escalations: written at producer time by bash run.sh (plan-reviewer
  // rejection) and bin/supervisor.sh → /api/internal/escalation-event.
  // Watcher mirror retired.

  // Archives: any *.tar.gz event in the archives/ dir → replace-all rescan.
  // Debounce key is per (slug, phase) so a burst of 5 file events does one
  // rescan, not five.
  // Archives: bash run.sh's archiveOnDone hook now POSTs each new
  // .tar.gz to /api/internal/archive-event at producer time.

  // Skills: written at producer time by bash run.sh's
  // _post_curator_outputs after `invoke curator` →
  // /api/internal/skill-snapshot. Watcher mirror retired.

  // PRs: bash run.sh's branch-iso onPass=pr handler now POSTs each PR
  // to /api/internal/pr-event at producer time. The .papercusp/prs.json
  // file write was retired alongside the chokidar mirror.

  // Plan-review: written at producer time by bash run.sh's plan-review
  // block after the reviewer LLM finishes → /api/internal/plan-review-event.
  // Watcher mirror retired.

  // Feature debug notes: bash run.sh's debugger hook now POSTs each
  // note to /api/internal/feature-debug-note-event at producer time.

  // Smoke test: bin/service-smoke-test.sh now POSTs the aggregated
  // outcome to /api/internal/smoke-test-event when it decides
  // pass/fail. The 4 sibling files are still written for human
  // inspection but the chokidar re-aggregation has been retired.

  // Checkpoints: chokidar dispatch retired.
  //   - checkpoint-*.md CREATE: bash run.sh's checkpoint emitters POST
  //     to /api/internal/checkpoint-event at producer time.
  //   - .granted: operator-side grant endpoint already writes the row
  //     directly (1c4a84f orchestrator-pg arc).

  // validation-contract.md presence is now refreshed by the 60s
  // reconcile sweep; chokidar dispatch retired (see SPEC.md note above).

  // Branch actions: chokidar dispatch retired (fs-watcher-retirement step 4).
  // harness_branch_actions was an unconsumed mirror — the /branch/:branch/actions
  // REST route recomputes the same fan-in on demand (1s cache); nothing read the
  // table. Table dropped in migration 283.

  // Hook logs: written at producer time by bash run.sh's run_hook
  // → /api/internal/hook-log-event. Watcher mirror retired.

  // Screenshots: written at producer time by the operator's POST/DELETE
  // /:slug/screenshots endpoints (which directly INSERT/DELETE the PG
  // row). Watcher mirror retired.

  // Decisions: bash run.sh's log() now POSTs each `ORCH decision: ...`
  // line directly to /api/internal/decision-event, which writes the
  // harness_decisions row at producer time. The fs.watch + tail-grep
  // mirror has been retired.
}

async function reconcileAll(state: WatcherState): Promise<void> {
  // Re-read the registry so newly-added harnesses get picked up — across EVERY
  // workspace this operator instance serves (EI-107 / P-020 backgroundWorkspaceIds()),
  // each tagged with its owning workspace so downstream writes stamp correctly.
  const newProjects = await loadAllProjects();

  // If the project list (or path existence) shifted, re-add watch paths.
  // Diff against the *recorded* subscription sets, not a re-derivation —
  // see the watchedPathSet doc comment.
  const newPaths = new Set(newProjects.flatMap((tp) => watchedPaths(tp.project)));
  for (const p of newPaths) if (!state.watchedPathSet.has(p)) state.watcher.add(p);
  for (const p of state.watchedPathSet) if (!newPaths.has(p)) state.watcher.unwatch(p);
  state.watchedPathSet = newPaths;
  // Same housekeeping for the top-level (checkpoint-pattern) watcher.
  const newTopPaths = new Set(newProjects.flatMap((tp) => topWatchPaths(tp.project)));
  for (const p of newTopPaths) if (!state.topWatchedPathSet.has(p)) state.topWatcher.add(p);
  for (const p of state.topWatchedPathSet) if (!newTopPaths.has(p)) state.topWatcher.unwatch(p);
  state.topWatchedPathSet = newTopPaths;
  state.projects = newProjects;

  // (Phases re-mirror removed — fs-watcher-retirement step 5; harness_phases
  //  dropped, the /phases REST route recomputes on demand.)

  // Enabled-plugins reconcile: walk ~/.papercusp/harnesses/<slug>/ and
  // re-mirror each enabled-plugins.json into PG. Catches direct CLI
  // writes that happened while the watcher was down or before cold start.
  try {
    const { papercuspPath } = await import('./papercusp-root');
    const { mirrorHarness } = await import('./plugin-enables-pg');
    const epRoot = papercuspPath('harnesses');
    if (existsSync(epRoot)) {
      const entries = await fs.readdir(epRoot, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const file = join(epRoot, e.name, 'enabled-plugins.json');
        if (!existsSync(file)) continue;
        try { await mirrorHarness(e.name); } catch {}
      }
    }
  } catch (e) {
    console.warn('[harness-fs-watcher] enabled-plugins reconcile failed:', (e as Error)?.message ?? e);
  }

  // (Per-project branch-actions reconcile removed — fs-watcher-retirement
  //  step 4; harness_branch_actions mirror retired, table dropped mig 281.)

  // Walk each (project, phase) and replay anything with diverged mtime.
  for (const { project: proj, workspaceId } of newProjects) {
    for (const { phase, harnessDir: hd } of harnessDirsForProject(proj)) {
      if (!existsSync(hd)) continue;

      // Pending issues: written at producer time by operator endpoints.
      // No reconcile sweep needed.

      // Tests: written at producer time by bash run.sh NEXT_TESTER →
      // /api/internal/test-snapshot. No reconcile sweep needed.

      // Escalations: written at producer time by bash run.sh +
      // bin/supervisor.sh → /api/internal/escalation-event. No
      // reconcile sweep needed.

      // Archives: written at producer time by bash run.sh
      // archiveOnDone → /api/internal/archive-event. No reconcile
      // sweep needed.

      // Screenshots: written at producer time by operator POST/DELETE
      // /:slug/screenshots endpoints. No reconcile sweep needed.

      // Decisions: written at producer time by bash run.sh log() →
      // /api/internal/decision-event. No reconcile sweep needed.

      // Plan-review: only stored once per harness (staging path only).
      if (phase === 'staging') {
        // Plan-review: written at producer time by bash run.sh →
        // /api/internal/plan-review-event. No reconcile sweep needed.

        // Checkpoints: written at producer time by bash run.sh →
        // /api/internal/checkpoint-event (create) and operator grant
        // endpoint (grant). No reconcile sweep needed.

        // Hook logs: written at producer time by bash run.sh run_hook
        // → /api/internal/hook-log-event. No reconcile sweep needed.

        // Smoke test: written at producer time by bin/service-smoke-test.sh
        // → /api/internal/smoke-test-event. No reconcile sweep needed.
      }

      // Proposals reconcile (pending-reviews retired — step 3: PG-canonical).
      {
        const dir = join(hd, 'proposals');
        const fsIds = new Set<string>();
        if (existsSync(dir)) {
          try {
            const files = await fs.readdir(dir, { withFileTypes: true });
            for (const ent of files) {
              if (!ent.isFile()) continue;
              const f = ent.name;
              if (!f.endsWith('.md') || f.endsWith('.review.md')) continue;
              const path = join(dir, f);
              const id = f;
              fsIds.add(id);
              const fsMtime = Math.floor(statSync(path).mtimeMs);
              const { db } = getOrgPg();
              const rows = await db
                .select({ mtime_ms: hps.mtimeMs })
                .from(hps)
                .where(and(eq(hps.harnessSlug, proj.slug), eq(hps.phase, phase), eq(hps.proposalId, id)));
              if (rows.length === 0 || Number(rows[0].mtime_ms) !== fsMtime) {
                await upsertProposal(proj.slug, phase, path, workspaceId);
              }
            }
          } catch {}
        }

        // Orphan delete: proposal rows in PG whose FS file is gone. Scoped by
        // workspaceId too (EI-107) — the table's PK is (harnessSlug, proposalId,
        // phase) with no workspace component, so an unscoped select/delete here
        // could otherwise walk (and delete) another workspace's same-slug rows.
        try {
          const { db } = getOrgPg();
          const pgIds = await db
            .select({ id: hps.proposalId })
            .from(hps)
            .where(
              and(eq(hps.harnessSlug, proj.slug), eq(hps.phase, phase), eq(hps.workspaceId, workspaceId)),
            );
          for (const { id } of pgIds) {
            if (!fsIds.has(id)) {
              await db
                .delete(hps)
                .where(
                  and(
                    eq(hps.harnessSlug, proj.slug),
                    eq(hps.phase, phase),
                    eq(hps.proposalId, id),
                    eq(hps.workspaceId, workspaceId),
                  ),
                );
            }
          }
        } catch {}
      }
    }
  }
}

/**
 * EI-255 mitigation: periodically fully RECYCLE (stop + rebuild from scratch)
 * the watcher, to bound any accumulation of closed-but-retained chokidar
 * handles across the many incremental add()/unwatch() reconcile cycles this
 * long-lived process-singleton runs over its lifetime. Heap-profiled 2026-06-10:
 * 23,448 retained FSEventWrap/FSWatcher/Stats/FSEvent objects vs only 1,845
 * LIVE inotify watch descriptors after ~2h18m uptime — a ~12x overhead that
 * never gets released by chokidar's own `.unwatch()` bookkeeping.
 *
 * This is a DEFENSE-IN-DEPTH BOUND, not a proven, independently-verified
 * root-cause fix: the suspected mechanism (chokidar 4.x's internal per-path
 * maps not fully releasing closed watcher objects across repeated add/unwatch
 * cycles) has not been confirmed via a live before/after heap-diff — that
 * verification needs CDP access to a running instance (kill -USR1 + a
 * HeapProfiler snapshot, as the original P-004 audit did), which a future
 * profiling pass should do. What IS certain: closing every handle and
 * rebuilding fresh, on a bounded cadence, cannot leave MORE than one recycle
 * period's worth of accumulation outstanding, regardless of exactly which
 * layer is retaining references. A brief (sub-reconcile-tick) gap in live fs-
 * event coverage during the swap is expected and already tolerated by the
 * existing 60s reconcile backstop (this file's own documented mitigation for
 * dropped events under load — see the module header).
 */
const WATCHER_RECYCLE_INTERVAL_MS = 4 * 60 * 60_000; // 4h
let recycleTimerStarted = false;

function ensureWatcherRecycleTimer(): void {
  if (recycleTimerStarted) return;
  recycleTimerStarted = true;
  managedSetInterval('harness-fs-watcher-recycle', WATCHER_RECYCLE_INTERVAL_MS, () => {
    if (!_g.__harnessFsWatcher) return; // nothing running — nothing to recycle
    stopHarnessFsWatcher();
    void ensureHarnessFsWatcher().catch((e) =>
      console.warn('[harness-fs-watcher] periodic recycle failed:', (e as Error)?.message ?? e),
    );
  }, { category: 'global-sweep' });
}

// SIGTERM/SIGINT cleanup — registered ONCE (module-level), never per watcher
// instantiation. Previously `ensureHarnessFsWatcher()` called `process.once(...)`
// on every (re)start, which was harmless as long as the watcher was only ever
// started once per process — but the periodic recycle above calls
// ensureHarnessFsWatcher() repeatedly over a long-lived process's life, and
// `.once()` listeners that never FIRE (no SIGTERM arrives) never self-remove,
// so that pattern would itself accumulate a NEW listener on `process` (a
// permanent, always-alive object) every recycle — trading one leak for
// another. `stopHarnessFsWatcher()` already re-reads the current global state
// fresh each call, so ONE pair of standing listeners is correct regardless of
// how many times the watcher has been recycled since.
let shutdownHandlersRegistered = false;

function ensureShutdownHandlers(): void {
  if (shutdownHandlersRegistered) return;
  shutdownHandlersRegistered = true;
  process.on('SIGTERM', stopHarnessFsWatcher);
  process.on('SIGINT', stopHarnessFsWatcher);
}

// Exported for exactly one purpose: a unit test proving the "registered once,
// ever" guards actually hold under repeated calls (the regression this fix
// targets) without needing to boot a real chokidar/PG-backed watcher.
export { ensureWatcherRecycleTimer, ensureShutdownHandlers };

/** Test-only: reset the module-level "registered once" guards so a test can
 *  exercise ensureWatcherRecycleTimer()/ensureShutdownHandlers() idempotency
 *  from a clean slate (mirrors __resetWorkspaceFallbackWarnings' pattern). */
export function __resetHarnessFsWatcherSingletonGuardsForTests(): void {
  recycleTimerStarted = false;
  shutdownHandlersRegistered = false;
}

/**
 * Idempotent. Starts the watcher on first call; subsequent calls return
 * the existing state. Safe to call from any /api/harness/* route.
 */
export async function ensureHarnessFsWatcher(): Promise<WatcherState> {
  if (_g.__harnessFsWatcher) return _g.__harnessFsWatcher;

  const projects = await loadAllProjects();
  const allPaths = projects.flatMap((tp) => watchedPaths(tp.project));
  const topPaths = projects.flatMap((tp) => topWatchPaths(tp.project));

  const watcher = chokidar.watch(allPaths, {
    persistent: true,
    // ignoreInitial: true — initial state is captured by reconcileAll()
    // on watcher startup. The 'add' events for already-existing files
    // would otherwise fire 8× per (slug, path) every time Turbopack
    // HMR re-creates the watcher, which produces a sustained
    // multi-events/sec invalidation storm on the dashboard.
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    // Ignore swap/temp files AND high-volume `*.log` appends + bulky trees —
    // see WATCHER_IGNORED_RE. (The previous /\/\.\w/ regex matched '.h' in
    // '.papercusp' and silently dropped every event under the watched dirs;
    // this one is anchored to path segments + extensions so it can't.)
    ignored: isWatcherIgnored,
  });

  // Top-level watcher (depth: 0) catches checkpoint-*.md / *.granted
  // and any other top-of-harness files we can't enumerate ahead of
  // time. Events for files the recursive watcher already sees collapse
  // via the dispatcher's debounce keys.
  const topWatcher = chokidar.watch(topPaths, {
    persistent: true,
    ignoreInitial: true,  // see above
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    ignored: isWatcherIgnored,
  });

  // Watch ~/.papercusp/harnesses/<slug>/enabled-plugins.json. depth:1
  // so we see per-harness files but don't recurse into plugin payloads.
  const { papercuspPath: _ppForWatch } = await import('./papercusp-root');
  const enabledPluginsRoot = _ppForWatch('harnesses');
  const enabledPluginsWatcher = chokidar.watch(enabledPluginsRoot, {
    persistent: true,
    ignoreInitial: true,
    depth: 1,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    ignored: isWatcherIgnored,
  });

  const state: WatcherState = {
    watcher,
    topWatcher,
    enabledPluginsWatcher,
    projects,
    watchedPathSet: new Set(allPaths),
    topWatchedPathSet: new Set(topPaths),
    reconcileTimer: managedSetInterval('harness-fs-reconcile', RECONCILE_INTERVAL_MS, () => {
      reconcileAll(state).catch((e) =>
        console.warn('[harness-fs-watcher] reconcile failed:', e?.message ?? e),
      );
    }, { category: 'global-sweep' }),
    debouncers: new Map(),
    stopped: false,
  };

  for (const w of [watcher, topWatcher]) {
    w.on('add', (p) => classifyAndDispatch(state, p, 'add'))
     .on('change', (p) => classifyAndDispatch(state, p, 'change'))
     .on('unlink', (p) => classifyAndDispatch(state, p, 'unlink'))
     .on('error', (e) => {
       console.warn('[harness-fs-watcher] chokidar error:', (e as Error)?.message ?? e);
     });
  }

  const onEnabledPluginsEvent = (p: string) => {
    if (!p.endsWith('enabled-plugins.json')) return;
    const slug = basename(dirname(p));
    if (!slug || slug === 'harnesses') return;
    debounce(state, `enabledPlugins:${slug}`, async () => {
      const { mirrorHarness } = await import('./plugin-enables-pg');
      try { await mirrorHarness(slug); } catch (e) {
        console.warn(`[harness-fs-watcher] mirrorHarness(${slug}) failed:`, (e as Error)?.message ?? e);
      }
    });
  };
  enabledPluginsWatcher
    .on('add', onEnabledPluginsEvent)
    .on('change', onEnabledPluginsEvent)
    .on('unlink', onEnabledPluginsEvent)
    .on('error', (e) => {
      console.warn('[harness-fs-watcher] enabled-plugins chokidar error:', (e as Error)?.message ?? e);
    });

  // Initial reconcile so cold-boot picks up anything that existed before
  // the watcher started.
  void reconcileAll(state).catch(() => {});

  // SIGTERM/SIGINT cleanup (registered once, ever — see ensureShutdownHandlers'
  // doc comment) + the EI-255 periodic full-recycle bound (also registered once).
  ensureShutdownHandlers();
  ensureWatcherRecycleTimer();

  _g.__harnessFsWatcher = state;
  return state;
}

export function stopHarnessFsWatcher(): void {
  const state = _g.__harnessFsWatcher;
  if (!state || state.stopped) return;
  state.stopped = true;
  for (const t of state.debouncers.values()) clearTimeout(t);
  state.debouncers.clear();
  state.reconcileTimer.stop();
  void state.watcher.close();
  void state.topWatcher.close();
  void state.enabledPluginsWatcher.close();
  _g.__harnessFsWatcher = undefined;
}
