import { useState, useEffect } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import { useQueryState, parseAsStringEnum, parseAsString } from 'nuqs';
import { Tooltip } from '@/app/harness/Tooltip';
import { Table } from '@/app/harness/Table';
import { StatusPill } from '../ui';
import { useLexicon } from '@/lib/useLexicon';

/**
 * /admin/git — the git-sync → green-checkpoint → release pipeline console.
 *
 * Surfaces the whole automated pipeline in one view:
 *   - the three routines (git-sync / green-checkpoint / release-trigger) + schedule
 *   - windowed stats (24h / 7d) from the pipeline_events history (mig 177):
 *     git-sync sync/conflict/error counts, MERGE CONFLICTS, merge-resolver
 *     (opus:xhigh) success rate, green-checkpoint main-is-green rate
 *   - latest git-sync + resolver state, any OPEN merge conflict
 *   - the release-gate deploy gap (`staging` churn vs the green `main` pin vs deployed :3070)
 *   - a recent event timeline
 *
 * Reads the `dev.gitPipeline` sync query (a snapshot wrapped in a 1-element array
 * → data[0]). The window toggle lives in the URL (nuqs) so it's deep-linkable +
 * agent-driveable.
 */

// ── server snapshot shape (mirrors git-pipeline-stats.ts) ──
interface RoutineInfo {
  name: string;
  active: boolean;
  cron: string | null;
  lastFiredAtMs: number | null;
  nextFireAtMs: number | null;
}
interface WindowSummary {
  sinceMs: number;
  gitSync: { total: number; synced: number; nothing: number; conflict: number; error: number };
  mergeResolver: { total: number; ok: number; failed: number; error: number };
  greenCheckpoint: {
    total: number;
    advanced: number;
    upToDate: number;
    notGreen: number;
    notFastForward: number;
    createFailed: number;
    /** EI-20702428259478130 — mirrors PipelineWindowSummary (operator-core). */
    advancedPrefix: number;
    error: number;
    skipped: number;
    other: number;
  };
  deploy: { total: number; ok: number; rolledBack: number; failed: number; refused: number };
}
interface PipelineEvent {
  id: string;
  kind: 'git_sync' | 'merge_resolver' | 'green_checkpoint' | 'deploy';
  status: string;
  detail: Record<string, unknown>;
  createdAtMs: number;
}
interface CommitRef {
  shortSha: string;
  committedAtMs: number;
  subject: string;
}
interface DeployState {
  integrationBranch: string;
  releaseRef: string;
  mainHead: CommitRef | null;
  ready: CommitRef | null;
  deployed: CommitRef | null;
  deployedAtMs: number | null;
  deployedBehindMain: number | null;
  readyBehindMain: number | null;
  deployedBehindReady: number | null;
  errors: string[];
}
interface GitPipelineSnapshot {
  slug: string;
  generatedAtMs: number;
  routines: { gitSync: RoutineInfo | null; greenCheckpoint: RoutineInfo | null; releaseTrigger: RoutineInfo | null };
  gitSync: {
    lastStatus: string | null;
    lastSyncedAtMs: number | null;
    consecutiveErrorTicks: number;
    headSha: string | null;
    lastPushed: string[];
    lastMerged: string[];
    lastConflicts: string[];
    lastErrors: string[];
  };
  resolver: {
    model: string;
    lastStatus: string | null;
    lastAtMs: number | null;
    lastExitCode: number | null;
    lastHttpStatus: number | null;
    lastTimedOut: boolean | null;
    lastScopes: string[];
  };
  openConflict: { scopes: string[]; conflicts: { scope: string; files: string[] }[]; emittedAtMs: number | null } | null;
  windows: { day: WindowSummary; week: WindowSummary };
  recent: PipelineEvent[];
  deploy: DeployState;
  // release-pipeline-resilience-2026-06-09 P-004/P-009: green-checkpoint gate health.
  gate: {
    consecutiveReds: number;
    lastGreenAtMs: number | null;
    firstRedAtMs: number | null;
    stalled: boolean;
    lastFixerStatus: string | null;
    lastFixerAtMs: number | null;
    lastFixerCandidate: string | null;
    flakyWorkspaces: string[];
    // frozen-candidate-stays-frozen-through-all-fixes-2026-09-03 P-021 (D-007 #1): the
    // frozen repair queue's manifest — one row per leg, the same rows the gate-red work-item
    // and the owner brief render. Only the fields this panel reads are typed here.
    repairQueue?: {
      phase: string;
      candidate: string;
      repairHead: string;
      manifest: RepairManifestView | null;
      manifestSummary: RepairManifestSummaryView | null;
    } | null;
    // gate-file-level-test-reuse-2026-09-27 P-013: what per-test-file pass reuse did in the
    // latest gate round. Null/absent = not measured (a runner predating the field), never "0".
    testPassReuse?: {
      judgedSha: string;
      headline: string;
      alarms: { ws: string; file: string; proof: string }[];
    } | null;
    // P-013: where the latest round's time went. Null/absent = not measured this round.
    roundPhases?: { breakdown: string } | null;
  };
}
interface RepairManifestView {
  candidate: string;
  repairHead: string;
  builtAtMs: number;
  rows: {
    legId: string;
    kind: string;
    workspace?: string;
    subjectPaths: string[];
    subjectPathsTruncated: number;
    statusLabel: string;
    admitCommand: string | null;
    claim: { actor: string; atMs: number } | null;
  }[];
  rowsTruncated: number;
}
interface RepairManifestSummaryView {
  legs: number;
  red: number;
  admitted: number;
  green: number;
  claimed: number;
  pathless: number;
}
function manifestStatusTone(label: string): Tone {
  if (label.startsWith('green')) return 'good';
  if (label.startsWith('admitted')) return 'warn';
  return 'bad';
}

// ── helpers ──
function fmtRel(ts: number | null | undefined): string {
  if (ts == null) return '—';
  const d = Date.now() - ts;
  if (d < 0) {
    const a = -d;
    if (a < 60_000) return `in ${Math.round(a / 1000)}s`;
    if (a < 3_600_000) return `in ${Math.round(a / 60_000)}m`;
    return `in ${Math.round(a / 3_600_000)}h`;
  }
  if (d < 60_000) return `${Math.round(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}
function pct(n: number, d: number): string {
  if (d <= 0) return '—';
  return `${Math.round((n / d) * 100)}%`;
}
type Tone = 'good' | 'warn' | 'bad' | 'neutral';
function statusTone(s: string | null): Tone {
  switch (s) {
    case 'synced':
    case 'ok':
    case 'advanced':
      return 'good';
    case 'conflict':
    case 'not-green':
    case 'failed':
      return 'warn';
    case 'error':
    case 'create-failed':
      return 'bad';
    default:
      return 'neutral';
  }
}
const KIND_LABEL: Record<PipelineEvent['kind'], string> = {
  git_sync: 'git-sync',
  merge_resolver: 'resolver',
  green_checkpoint: 'green-check',
  deploy: 'deploy',
};

function Dot({ on }: { on: boolean }) {
  return <span className={`pc-git__dot ${on ? 'is-on' : 'is-off'}`} aria-hidden="true" />;
}
function Stat({ label, value, tone, sub }: { label: string; value: React.ReactNode; tone?: Tone; sub?: string }) {
  return (
    <div className={`pc-git__stat ${tone ? `is-${tone}` : ''}`}>
      <div className="pc-git__stat-v">{value}</div>
      <div className="pc-git__stat-l">{label}</div>
      {sub && <div className="pc-git__stat-s">{sub}</div>}
    </div>
  );
}
function RoutineCard({ r, label }: { r: RoutineInfo | null; label: string }) {
  return (
    <div className="pc-git__routine">
      <div className="pc-git__routine-head">
        <Dot on={!!r?.active} />
        <span className="pc-git__routine-name">{label}</span>
        <StatusPill tone={r?.active ? 'good' : 'neutral'} label={r?.active ? 'active' : 'inactive'} />
      </div>
      <div className="pc-git__kv">
        <span className="pc-git__k">cron</span>
        <span className="pc-git__v">{r?.cron ?? '—'}</span>
        <span className="pc-git__k">last fired</span>
        <span className="pc-git__v">{fmtRel(r?.lastFiredAtMs)}</span>
        <span className="pc-git__k">next</span>
        <span className="pc-git__v">{fmtRel(r?.nextFireAtMs)}</span>
      </div>
    </div>
  );
}

// ── per-hive surface (per-hive-git-and-release-gate P-014) ──
// One row per OTHER repo-backed coding hive that is green-gated (the operator-home has its
// own full view above). Mirrors the server shape from git-pipeline-hives.ts.
interface GitPipelineHiveRow {
  slug: string;
  root: string;
  greenCmd: string;
  greenCmdOverridden: boolean;
  integrationBranch: string;
  releaseRef: string;
  hasDeploy: boolean;
  greenCheckpointActive: boolean;
  gateStatus: 'green' | 'held' | 'stalled' | 'unknown';
  consecutiveReds: number;
  lastGreenAtMs: number | null;
  lastGreenSha: string | null;
  stagingMainGap: number | null;
  lastDeployAtMs: number | null;
  lastDeployStatus: string | null;
  // ── github bridge (github-bridge-hive-egress-2026-07-02 P-009; mirrors git-pipeline-hives.ts) ──
  hiveGitMode: 'legacy' | 'bridged' | 'p2p-only';
  bridge: {
    atMs: number | null;
    ran: boolean;
    skipped: string | null;
    egressTarget: string | null;
    lastAdmitted: string | null;
    divergence: 'clear' | 'escalate' | null;
    needsOwner: boolean;
    errors: number;
    memberSlug: string;
  } | null;
}

function gateTone(s: GitPipelineHiveRow['gateStatus']): Tone {
  return s === 'green' ? 'good' : s === 'held' ? 'warn' : s === 'stalled' ? 'bad' : 'neutral';
}
function gateLabel(r: GitPipelineHiveRow): string {
  if (r.gateStatus === 'green') return 'green';
  if (r.gateStatus === 'held') return `held · ${r.consecutiveReds} red`;
  if (r.gateStatus === 'stalled') return 'STALLED';
  return 'no runs yet';
}

/** Bridge pill tone (P-009): escalated divergence is the loud state — owner-lever cases loudest. */
export function bridgeTone(r: Pick<GitPipelineHiveRow, 'hiveGitMode' | 'bridge'>): Tone {
  if (!r.bridge) return 'neutral'; // mode set, no tick yet
  if (r.bridge.divergence === 'escalate') return r.bridge.needsOwner ? 'bad' : 'warn';
  if (r.bridge.errors > 0) return 'warn';
  return 'good';
}

/** Bridge pill label (P-009): mode · sync state · egress target. */
export function bridgeLabel(r: Pick<GitPipelineHiveRow, 'hiveGitMode' | 'bridge'>): string {
  const mode = r.hiveGitMode === 'bridged' ? 'bridged' : 'p2p-only';
  if (!r.bridge) return `${mode} · no tick yet`;
  const state =
    r.bridge.divergence === 'escalate'
      ? r.bridge.needsOwner
        ? 'diverged · owner'
        : 'diverged'
      : r.bridge.errors > 0
        ? `${r.bridge.errors} err`
        : 'in sync';
  const target = r.bridge.egressTarget && r.bridge.egressTarget !== 'skipped' ? ` → ${r.bridge.egressTarget}` : '';
  return `${mode} · ${state}${target}`;
}

/** The per-hive pipelines section: a row per gated coding hive + an inline editor that wires
 *  the green-command edit to the per-hive override (POST /api/desktop/git/pot-green-cmd).
 *  The selected hive lives in the URL (nuqs) so it's deep-linkable + agent-driveable. */
function PerHiveSection() {
  const t = useLexicon();
  const sync = useSyncQuery<GitPipelineHiveRow>({ queryName: 'dev.gitPipelineHives', staleTime: 30_000 });
  const rows = sync.data ?? [];
  const [selected, setSelected] = useQueryState('hive', parseAsString.withDefault(''));
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const sel = rows.find((r) => r.slug === selected) ?? null;
  // Seed the edit draft from the selected row's resolved command (a mid-edit form draft is
  // useState, not nuqs — per AGENTS.md).
  useEffect(() => {
    setErr(null);
    setDraft(sel ? sel.greenCmd : '');
  }, [selected, sel?.greenCmd]);

  async function save(clear: boolean) {
    if (!sel) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch('/api/desktop/git/pot-green-cmd', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: sel.slug, greenCmd: clear ? '' : draft }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string };
      if (!res.ok || body.ok === false) {
        setErr(body.error ? `${body.error}${body.message ? `: ${body.message}` : ''}` : `HTTP ${res.status}`);
      } else {
        void sync.invalidate();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="pc-git__sec">
      <h3 className="pc-git__h">
        Per-{t('pot', { lower: true })} pipelines <span className="pc-git__muted">· other coding {t('pot', { plural: true, lower: true })}</span>
      </h3>
      {sync.error && <div className="pc-git__err">{String(sync.error.message || sync.error)}</div>}
      {rows.length === 0 ? (
        <div className="pc-git__empty">
          No per-{t('pot', { lower: true })} coding pipelines yet — a coding {t('pot', { lower: true })} backed by a repo (green gate enabled) appears here. The
          operator-home pipeline is shown above.
        </div>
      ) : (
        <div className="pc-git__hives">
          {rows.map((r) => {
            const open = r.slug === selected;
            return (
              <div key={r.slug} className={`pc-git__hive ${open ? 'is-open' : ''}`}>
                <button
                  type="button"
                  className="pc-git__hive-row"
                  onClick={() => void setSelected(open ? '' : r.slug)}
                  aria-expanded={open}
                >
                  <span className="pc-git__hive-slug">{r.slug}</span>
                  <StatusPill tone={gateTone(r.gateStatus)} label={gateLabel(r)} />
                  {(r.hiveGitMode === 'bridged' || r.hiveGitMode === 'p2p-only') && (
                    <Tooltip
                      label={
                        r.bridge
                          ? `GitHub bridge · tick ${fmtRel(r.bridge.atMs)} via ${r.bridge.memberSlug}` +
                            (r.bridge.lastAdmitted ? ` · watermark ${r.bridge.lastAdmitted.slice(0, 10)}` : '')
                          : 'GitHub bridge enabled — no tick reported yet'
                      }
                    >
                      <StatusPill tone={bridgeTone(r)} label={bridgeLabel(r)} />
                    </Tooltip>
                  )}
                  <code className="pc-git__hive-cmd">
                    {r.greenCmd}
                    {r.greenCmdOverridden && <span className="pc-git__hive-badge">override</span>}
                  </code>
                  <span className="pc-git__hive-gap">
                    {r.stagingMainGap == null
                      ? '—'
                      : `${r.stagingMainGap} ${r.integrationBranch}→${r.releaseRef}`}
                  </span>
                  <span className="pc-git__hive-green">
                    {r.lastGreenSha ? `🟩 ${r.lastGreenSha}` : 'no green'} · {fmtRel(r.lastGreenAtMs)}
                  </span>
                  <span className="pc-git__hive-deploy">
                    {r.lastDeployStatus
                      ? `${r.lastDeployStatus} ${fmtRel(r.lastDeployAtMs)}`
                      : r.hasDeploy
                        ? 'no deploy yet'
                        : 'gate-only'}
                  </span>
                  <span className="pc-git__hive-caret" aria-hidden="true">
                    {open ? '▾' : '▸'}
                  </span>
                </button>
                {open && (
                  <div className="pc-git__hive-edit">
                    <label className="pc-git__hive-k" htmlFor={`gc-${r.slug}`}>
                      green command
                    </label>
                    <input
                      id={`gc-${r.slug}`}
                      className="pc-git__hive-input mono"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      placeholder={r.greenCmd}
                      spellCheck={false}
                      autoComplete="off"
                    />
                    <div className="pc-git__hive-actions">
                      <button
                        type="button"
                        className="pc-git__hive-save"
                        disabled={saving || draft.trim().length === 0 || draft.trim() === r.greenCmd}
                        onClick={() => void save(false)}
                      >
                        {saving ? 'Saving…' : 'Save override'}
                      </button>
                      <Tooltip label="Revert to the auto-detected command">
                        <button
                          type="button"
                          className="pc-git__hive-reset"
                          disabled={saving || !r.greenCmdOverridden}
                          onClick={() => void save(true)}
                        >
                          Reset to default
                        </button>
                      </Tooltip>
                    </div>
                    <div className="pc-git__hive-meta">
                      runs <code>{r.greenCmd}</code> in <code>{r.root}</code> · checkpoint{' '}
                      {r.greenCheckpointActive ? 'active' : 'inactive'} ·{' '}
                      {r.greenCmdOverridden ? 'owner override' : 'detected default'}
                    </div>
                    {err && <div className="pc-git__err">{err}</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default function GitClient() {
  const [win, setWin] = useQueryState('window', parseAsStringEnum(['24h', '7d']).withDefault('24h'));
  const sync = useSyncQuery<GitPipelineSnapshot>({ queryName: 'dev.gitPipeline', staleTime: 30_000 });
  const st = sync.data?.[0];
  const w = st ? (win === '7d' ? st.windows.week : st.windows.day) : null;

  return (
    <div className="pc-git">
      <div className="pc-git__bar">
        <div className="pc-git__bar-l">
          <strong>Pipeline</strong>
          <span className="pc-git__muted">git-sync → green-checkpoint → release · {st?.slug ?? '…'}</span>
        </div>
        <div className="pc-git__bar-r">
          <div className="pc-git__seg" role="tablist" aria-label="Stats window">
            {(['24h', '7d'] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={win === k}
                className={`pc-git__seg-btn ${win === k ? 'is-active' : ''}`}
                onClick={() => void setWin(k)}
              >
                {k}
              </button>
            ))}
          </div>
          <button type="button" className="pc-git__refresh" onClick={() => sync.invalidate()} disabled={sync.fetching}>
            {sync.fetching ? '…' : '↻'}
          </button>
        </div>
      </div>

      {sync.loading && !st && <div className="pc-git__empty">Loading pipeline…</div>}
      {sync.error && <div className="pc-git__err">{String(sync.error.message || sync.error)}</div>}

      {st && w && (
        <div className="pc-git__body">
          {/* OPEN CONFLICT banner — the thing that needs a human's eyes */}
          {st.openConflict && (
            <div className="pc-git__banner">
              <strong>⚠ Open merge conflict</strong> in {st.openConflict.scopes.join(', ') || '—'} — merge-resolver (
              {st.resolver.model}) dispatched {fmtRel(st.openConflict.emittedAtMs)}.
              <div className="pc-git__banner-files">
                {st.openConflict.conflicts.map((c) => (
                  <div key={c.scope}>
                    <code>{c.scope}</code>: {c.files.join(', ') || '(files not enumerated)'}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ROUTINES */}
          <section className="pc-git__sec">
            <h3 className="pc-git__h">Routines</h3>
            <div className="pc-git__routines">
              <RoutineCard r={st.routines.gitSync} label="git-sync" />
              <RoutineCard r={st.routines.greenCheckpoint} label="green-checkpoint" />
              <RoutineCard r={st.routines.releaseTrigger} label="release-trigger (auto-deploy)" />
            </div>
          </section>

          {/* STATS (windowed) */}
          <section className="pc-git__sec">
            <h3 className="pc-git__h">
              Stats <span className="pc-git__muted">· last {win}</span>
            </h3>
            <div className="pc-git__stats">
              <Stat label="git-sync ticks" value={w.gitSync.total} sub={`${w.gitSync.synced} synced · ${w.gitSync.nothing} no-op`} />
              <Stat
                label="merge conflicts"
                value={w.gitSync.conflict}
                tone={w.gitSync.conflict > 0 ? 'warn' : 'good'}
                sub={`${pct(w.gitSync.conflict, w.gitSync.total)} of ticks`}
              />
              <Stat
                label="git-sync errors"
                value={w.gitSync.error}
                tone={w.gitSync.error > 0 ? 'bad' : 'good'}
                sub="push/fetch failures"
              />
              <Stat
                label="resolver runs"
                value={w.mergeResolver.total}
                tone={w.mergeResolver.failed + w.mergeResolver.error > 0 ? 'warn' : 'neutral'}
                sub={`${w.mergeResolver.ok} ok · ${pct(w.mergeResolver.ok, w.mergeResolver.total)} success`}
              />
              <Stat
                label="green-checkpoints"
                value={w.greenCheckpoint.total}
                sub={`${w.greenCheckpoint.advanced} advanced · ${w.greenCheckpoint.upToDate} up-to-date`}
              />
              {/* EI-20702428259478130: `error` (a green-checkpoint crash / the 25-min
                  timeout / unparseable JSON) used to be in NEITHER the numerator nor the
                  denominator, so a gate that died on every single tick rendered
                  "main-green rate 100%" with a `good` tone — the infra death was not just
                  indistinguishable in the ledger, it read as success. The denominator is
                  now every tick that reached a VERDICT about the code; `skipped`/`other`
                  stay out because those ticks judged nothing. `advancedPrefix` joins the
                  numerator: a partial advance did move `main`. */}
              <Stat
                label="main-green rate"
                value={pct(
                  w.greenCheckpoint.advanced + w.greenCheckpoint.upToDate + w.greenCheckpoint.advancedPrefix,
                  w.greenCheckpoint.advanced +
                    w.greenCheckpoint.upToDate +
                    w.greenCheckpoint.advancedPrefix +
                    w.greenCheckpoint.notGreen +
                    w.greenCheckpoint.notFastForward +
                    w.greenCheckpoint.createFailed +
                    w.greenCheckpoint.error,
                )}
                tone={
                  w.greenCheckpoint.error > 0 ? 'bad' : w.greenCheckpoint.notGreen > 0 ? 'warn' : 'good'
                }
                sub={
                  w.greenCheckpoint.error > 0
                    ? `${w.greenCheckpoint.notGreen} not-green · ${w.greenCheckpoint.error} died`
                    : `${w.greenCheckpoint.notGreen} not-green`
                }
              />
              <Stat
                label="auto-deploys"
                value={w.deploy.total}
                tone={w.deploy.failed + w.deploy.rolledBack > 0 ? 'warn' : 'neutral'}
                sub={`${w.deploy.ok} ok · ${w.deploy.rolledBack} rolled back · ${w.deploy.failed} failed`}
              />
            </div>
          </section>

          {/* CURRENT STATE */}
          <section className="pc-git__sec">
            <h3 className="pc-git__h">Current state</h3>
            <div className="pc-git__cards">
              <div className="pc-git__card">
                <div className="pc-git__card-h">
                  git-sync <StatusPill tone={statusTone(st.gitSync.lastStatus)} label={st.gitSync.lastStatus ?? '—'} />
                </div>
                <div className="pc-git__kv">
                  <span className="pc-git__k">last sync</span>
                  <span className="pc-git__v">{fmtRel(st.gitSync.lastSyncedAtMs)}</span>
                  <span className="pc-git__k">HEAD</span>
                  <span className="pc-git__v mono">{st.gitSync.headSha?.slice(0, 8) ?? '—'}</span>
                  <span className="pc-git__k">error streak</span>
                  <span className="pc-git__v">
                    {st.gitSync.consecutiveErrorTicks > 0 ? (
                      <StatusPill tone="bad" label={`${st.gitSync.consecutiveErrorTicks} ticks`} />
                    ) : (
                      '0'
                    )}
                  </span>
                  <span className="pc-git__k">last pushed</span>
                  <span className="pc-git__v">{st.gitSync.lastPushed.join(', ') || '—'}</span>
                </div>
              </div>

              <div className="pc-git__card">
                <div className="pc-git__card-h">
                  merge-resolver <span className="pc-git__muted mono">{st.resolver.model}</span>
                </div>
                <div className="pc-git__kv">
                  <span className="pc-git__k">last run</span>
                  <span className="pc-git__v">
                    {st.resolver.lastStatus ? (
                      <StatusPill tone={statusTone(st.resolver.lastStatus)} label={st.resolver.lastStatus} />
                    ) : (
                      'never'
                    )}
                  </span>
                  <span className="pc-git__k">when</span>
                  <span className="pc-git__v">{fmtRel(st.resolver.lastAtMs)}</span>
                  <span className="pc-git__k">exit / http</span>
                  <span className="pc-git__v mono">
                    {st.resolver.lastExitCode ?? '—'} / {st.resolver.lastHttpStatus ?? '—'}
                    {st.resolver.lastTimedOut ? ' · timed-out' : ''}
                  </span>
                  <span className="pc-git__k">scopes</span>
                  <span className="pc-git__v">{st.resolver.lastScopes.join(', ') || '—'}</span>
                </div>
              </div>

              {/* release-pipeline-resilience-2026-06-09 P-011: the green-checkpoint
                  gate — WHY staging→main promotion is (or isn't) blocked, the red
                  streak, the auto-dispatched release-fixer, and chronically-flaky
                  tests (P-004/P-006/P-009). */}
              <div className="pc-git__card">
                <div className="pc-git__card-h">
                  green-checkpoint gate{' '}
                  {st.gate.stalled ? (
                    <StatusPill tone="bad" label="STALLED" />
                  ) : st.gate.consecutiveReds > 0 ? (
                    <StatusPill tone="warn" label="held" />
                  ) : (
                    <StatusPill tone="good" label="green" />
                  )}
                </div>
                <div className="pc-git__kv">
                  <span className="pc-git__k">red streak</span>
                  <span className="pc-git__v">
                    {st.gate.consecutiveReds > 0 ? (
                      <StatusPill tone={st.gate.stalled ? 'bad' : 'warn'} label={`${st.gate.consecutiveReds} checkpoint(s)`} />
                    ) : (
                      '0'
                    )}
                  </span>
                  <span className="pc-git__k">last green</span>
                  <span className="pc-git__v">{fmtRel(st.gate.lastGreenAtMs)}</span>
                  <span className="pc-git__k">release-fixer</span>
                  <span className="pc-git__v">
                    {st.gate.lastFixerStatus ? (
                      <StatusPill tone={statusTone(st.gate.lastFixerStatus)} label={st.gate.lastFixerStatus} />
                    ) : (
                      'never'
                    )}{' '}
                    <span className="pc-git__muted">{fmtRel(st.gate.lastFixerAtMs)}</span>
                  </span>
                  <span className="pc-git__k">flaky tests</span>
                  <span className="pc-git__v">
                    {st.gate.flakyWorkspaces.length > 0 ? (
                      <StatusPill tone="warn" label={st.gate.flakyWorkspaces.join(', ')} />
                    ) : (
                      'none'
                    )}
                  </span>
                  <span className="pc-git__k">test reuse</span>
                  <span className="pc-git__v" data-testid="gate-test-pass-reuse">
                    {st.gate.testPassReuse ? (
                      <>
                        {st.gate.testPassReuse.alarms.length > 0 && (
                          <>
                            <StatusPill
                              tone="bad"
                              label={`${st.gate.testPassReuse.alarms.length} reuse alarm(s)`}
                            />{' '}
                          </>
                        )}
                        {st.gate.testPassReuse.headline}{' '}
                        <span className="pc-git__muted mono">
                          {st.gate.testPassReuse.judgedSha.slice(0, 8)}
                        </span>
                      </>
                    ) : (
                      <span className="pc-git__muted">not measured</span>
                    )}
                  </span>
                  <span className="pc-git__k">round time</span>
                  <span className="pc-git__v" data-testid="gate-round-phases">
                    {st.gate.roundPhases ? (
                      st.gate.roundPhases.breakdown
                    ) : (
                      <span className="pc-git__muted">not measured</span>
                    )}
                  </span>
                </div>
              </div>

              {/* frozen-candidate-stays-frozen-through-all-fixes-2026-09-03 P-021 (D-007 #1):
                  the frozen candidate's REPAIR MANIFEST — one row per leg with its subject
                  paths, status, holder and the exact admit command. The same rows land on the
                  gate-red work-item and in the owner brief; this is the operator's view. */}
              {st.gate.repairQueue?.manifest && (
                <div className="pc-git__card" style={{ gridColumn: '1 / -1' }}>
                  <div className="pc-git__card-h">
                    repair manifest{' '}
                    <span className="pc-git__muted mono">
                      candidate {st.gate.repairQueue.candidate.slice(0, 8)} · repairHead{' '}
                      {st.gate.repairQueue.repairHead.slice(0, 8)} · {st.gate.repairQueue.phase}
                    </span>{' '}
                    {st.gate.repairQueue.manifestSummary && (
                      <>
                        <StatusPill
                          tone={st.gate.repairQueue.manifestSummary.red > 0 ? 'bad' : 'good'}
                          label={`${st.gate.repairQueue.manifestSummary.red} red`}
                        />{' '}
                        <StatusPill tone="warn" label={`${st.gate.repairQueue.manifestSummary.admitted} admitted`} />{' '}
                        <StatusPill tone="good" label={`${st.gate.repairQueue.manifestSummary.green} green`} />{' '}
                        <StatusPill tone="neutral" label={`${st.gate.repairQueue.manifestSummary.claimed} claimed`} />
                        {st.gate.repairQueue.manifestSummary.pathless > 0 && (
                          <>
                            {' '}
                            <StatusPill tone="warn" label={`${st.gate.repairQueue.manifestSummary.pathless} pathless`} />
                          </>
                        )}
                      </>
                    )}
                  </div>
                  <div style={{ overflowX: 'auto' }}>
                    <Table
                      rows={st.gate.repairQueue.manifest.rows}
                      getRowKey={(row) => row.legId}
                      rowStyle={() => ({ verticalAlign: 'top' })}
                      columns={[
                        {
                          key: 'leg',
                          header: 'leg',
                          render: (row) => (
                            <span className="mono">
                              {row.legId}
                              {row.workspace ? <span className="pc-git__muted"> ({row.workspace})</span> : null}
                            </span>
                          ),
                        },
                        { key: 'kind', header: 'kind', render: (row) => row.kind },
                        {
                          key: 'status',
                          header: 'status',
                          render: (row) => <StatusPill tone={manifestStatusTone(row.statusLabel)} label={row.statusLabel} />,
                        },
                        {
                          key: 'paths',
                          header: 'subject paths',
                          render: (row) => (
                            <span className="mono">
                              {row.subjectPaths.length > 0 ? (
                                row.subjectPaths.join(', ')
                              ) : (
                                <span className="pc-git__muted">unknown — name paths by hand</span>
                              )}
                              {row.subjectPathsTruncated > 0 ? (
                                <span className="pc-git__muted"> +{row.subjectPathsTruncated} more</span>
                              ) : null}
                            </span>
                          ),
                        },
                        {
                          key: 'claim',
                          header: 'claim',
                          render: (row) =>
                            row.claim ? (
                              <>
                                <span className="mono">{row.claim.actor}</span>{' '}
                                <span className="pc-git__muted">{fmtRel(row.claim.atMs)}</span>
                              </>
                            ) : (
                              <span className="pc-git__muted">unclaimed</span>
                            ),
                        },
                        {
                          key: 'admit',
                          header: 'admit',
                          cellStyle: { whiteSpace: 'nowrap' },
                          render: (row) => <span className="mono">{row.admitCommand ?? '—'}</span>,
                        },
                      ]}
                    />
                    {st.gate.repairQueue.manifest.rowsTruncated > 0 && (
                      <div className="pc-git__muted" style={{ padding: '4px 6px' }}>
                        +{st.gate.repairQueue.manifest.rowsTruncated} more leg(s) not shown — read the gate-red work-item for the full manifest.
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="pc-git__card">
                <div className="pc-git__card-h">
                  deploy gate
                  {st.deploy.deployedBehindMain === 0 ? (
                    <StatusPill tone="good" label=":3070 current" />
                  ) : (
                    <StatusPill
                      tone="warn"
                      label={`${st.deploy.deployedBehindMain ?? '?'} behind ${st.deploy.integrationBranch}`}
                    />
                  )}
                </div>
                <div className="pc-git__kv">
                  <span className="pc-git__k">{st.deploy.integrationBranch} HEAD</span>
                  <span className="pc-git__v mono">{st.deploy.mainHead?.shortSha ?? '—'}</span>
                  <span className="pc-git__k">{st.deploy.releaseRef} (green pin)</span>
                  <span className="pc-git__v mono">{st.deploy.ready?.shortSha ?? '— unset'}</span>
                  <span className="pc-git__k">deployed :3070</span>
                  <span className="pc-git__v mono">{st.deploy.deployed?.shortSha ?? '—'}</span>
                  <span className="pc-git__k">
                    {st.deploy.releaseRef} vs {st.deploy.integrationBranch} (untested buffer)
                  </span>
                  <span className="pc-git__v">
                    {st.deploy.readyBehindMain === 0 ? (
                      <StatusPill tone="good" label="caught up" />
                    ) : (
                      <StatusPill tone="warn" label={`${st.deploy.readyBehindMain ?? '?'} behind`} />
                    )}
                  </span>
                  <span className="pc-git__k">undeployed ({st.deploy.releaseRef}→:3070)</span>
                  <span className="pc-git__v">{st.deploy.deployedBehindReady ?? '—'}</span>
                </div>
              </div>
            </div>
          </section>

          {/* TIMELINE */}
          <section className="pc-git__sec">
            <h3 className="pc-git__h">Recent events</h3>
            {st.recent.length === 0 ? (
              <div className="pc-git__empty">
                No pipeline events logged yet — they accrue from the next git-sync / green-checkpoint tick.
              </div>
            ) : (
              <div className="pc-git__timeline">
                {st.recent.map((e) => (
                  <div key={e.id} className="pc-git__event">
                    <span className={`pc-git__chip is-${statusTone(e.status)}`}>{KIND_LABEL[e.kind]}</span>
                    <span className="pc-git__event-status">{e.status}</span>
                    <span className="pc-git__event-detail">{eventDetail(e)}</span>
                    <span className="pc-git__event-time">{fmtRel(e.createdAtMs)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {st.deploy.errors.length > 0 && <div className="pc-git__err">{st.deploy.errors.join(' · ')}</div>}
        </div>
      )}

      {/* Per-hive coding pipelines — independent of the operator-home snapshot above. */}
      <PerHiveSection />

      <style>{gitCss}</style>
    </div>
  );
}

/** One-line human summary of an event's detail jsonb. */
function eventDetail(e: PipelineEvent): string {
  const d = e.detail || {};
  if (e.kind === 'git_sync') {
    const conflicts = Array.isArray(d.conflicts) ? (d.conflicts as Array<{ scope: string }>) : [];
    const pushed = Array.isArray(d.pushed) ? (d.pushed as string[]) : [];
    if (conflicts.length) return `conflict in ${conflicts.map((c) => c.scope).join(', ')}`;
    if (pushed.length) return `pushed ${pushed.join(', ')}`;
    return '';
  }
  if (e.kind === 'merge_resolver') {
    const scopes = Array.isArray(d.scopes) ? (d.scopes as string[]) : [];
    return scopes.length ? scopes.join(', ') : '';
  }
  if (e.kind === 'green_checkpoint') {
    const parts: string[] = [];
    if (typeof d.candidate === 'string') parts.push(`@${d.candidate}`);
    if (d.green === false) parts.push('not green');
    return parts.join(' ');
  }
  if (e.kind === 'deploy') {
    const parts: string[] = [];
    if (typeof d.targetSha === 'string') parts.push(`@${d.targetSha.slice(0, 8)}`);
    if (typeof d.commits === 'number') parts.push(`${d.commits} commit(s)`);
    if (typeof d.error === 'string' && d.error) parts.push(d.error.slice(0, 60));
    return parts.join(' ');
  }
  return '';
}

const gitCss = `
  .pc-git { color: var(--fg); padding: 14px 18px 28px; }
  .pc-git__bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
  .pc-git__bar-l { display: flex; align-items: baseline; gap: 10px; }
  .pc-git__bar-l strong { font-size: 15px; letter-spacing: 0; }
  .pc-git__muted { color: color-mix(in srgb, var(--fg), transparent 45%); font-size: 12px; }
  .pc-git__bar-r { display: flex; align-items: center; gap: 8px; }
  .pc-git__seg { display: inline-flex; border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 82%); border-radius: 8px; overflow: hidden; }
  .pc-git__seg-btn { background: transparent; color: color-mix(in srgb, var(--fg), transparent 30%); border: 0; padding: 5px 12px; font-size: 12px; font-weight: 650; cursor: pointer; }
  .pc-git__seg-btn.is-active { background: color-mix(in srgb, var(--accent), transparent 84%); color: var(--fg); }
  .pc-git__refresh { background: rgba(255,255,255,0.03); border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 82%); color: var(--fg); width: 30px; height: 28px; border-radius: 8px; cursor: pointer; }
  .pc-git__refresh:disabled { opacity: 0.5; cursor: default; }

  .pc-git__body { display: grid; gap: 18px; }
  .pc-git__sec { display: grid; gap: 10px; }
  .pc-git__h { margin: 0; font-size: 12px; font-weight: 740; letter-spacing: 0; text-transform: uppercase; color: color-mix(in srgb, var(--fg), transparent 38%); }

  .pc-git__banner { border: 1px solid rgba(251, 191, 36, 0.4); background: rgba(251, 191, 36, 0.08); border-radius: 10px; padding: 10px 12px; font-size: 13px; color: #fde68a; }
  .pc-git__banner-files { margin-top: 6px; font-size: 12px; color: rgba(253, 230, 138, 0.85); display: grid; gap: 2px; }
  .pc-git__banner code, .pc-git code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

  .pc-git__routines { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; }
  .pc-git__routine { border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 86%); border-radius: 10px; padding: 10px 12px; background: rgba(255,255,255,0.015); }
  .pc-git__routine-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .pc-git__routine-name { font-weight: 680; font-size: 13px; flex: 1; }

  .pc-git__stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
  .pc-git__stat { border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 86%); border-radius: 10px; padding: 12px; background: rgba(255,255,255,0.015); }
  .pc-git__stat.is-warn { border-color: rgba(251, 191, 36, 0.4); background: rgba(251, 191, 36, 0.06); }
  .pc-git__stat.is-bad { border-color: rgba(248, 113, 113, 0.45); background: rgba(248, 113, 113, 0.07); }
  .pc-git__stat.is-good { border-color: rgba(52, 211, 153, 0.32); }
  .pc-git__stat-v { font-size: 26px; font-weight: 760; line-height: 1; letter-spacing: 0; }
  .pc-git__stat-l { margin-top: 6px; font-size: 12px; color: color-mix(in srgb, var(--fg), transparent 22%); font-weight: 600; }
  .pc-git__stat-s { margin-top: 2px; font-size: 11px; color: color-mix(in srgb, var(--fg), transparent 50%); }

  .pc-git__cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 10px; }
  .pc-git__card { border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 86%); border-radius: 10px; padding: 12px; background: rgba(255,255,255,0.015); }
  .pc-git__card-h { display: flex; align-items: center; gap: 8px; font-weight: 680; font-size: 13px; margin-bottom: 8px; }

  .pc-git__kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 12px; }
  .pc-git__k { color: color-mix(in srgb, var(--fg), transparent 45%); }
  .pc-git__v { color: var(--fg); text-align: right; }
  .pc-git__v.mono, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

  .pc-git__dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .pc-git__dot.is-on { background: #34d399; box-shadow: 0 0 0 3px rgba(52, 211, 153, 0.16); }
  .pc-git__dot.is-off { background: rgba(148, 163, 184, 0.5); }


  .pc-git__timeline { display: grid; gap: 4px; }
  .pc-git__event { display: grid; grid-template-columns: 88px 90px 1fr auto; gap: 10px; align-items: center; padding: 6px 10px; border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 90%); border-radius: 8px; background: rgba(255,255,255,0.012); font-size: 12px; }
  .pc-git__chip { font-size: 10px; font-weight: 700; letter-spacing: 0; padding: 2px 6px; border-radius: 6px; text-align: center; background: color-mix(in srgb, var(--accent), transparent 88%); color: var(--accent-soft); }
  .pc-git__chip.is-good { background: rgba(52, 211, 153, 0.14); color: #6ee7b7; }
  .pc-git__chip.is-warn { background: rgba(251, 191, 36, 0.14); color: #fcd34d; }
  .pc-git__chip.is-bad { background: rgba(248, 113, 113, 0.16); color: #fca5a5; }
  .pc-git__event-status { font-weight: 620; }
  .pc-git__event-detail { color: color-mix(in srgb, var(--fg), transparent 38%); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
  .pc-git__event-time { color: color-mix(in srgb, var(--fg), transparent 50%); white-space: nowrap; }

  .pc-git__empty { color: color-mix(in srgb, var(--fg), transparent 45%); font-size: 13px; padding: 12px 0; }
  .pc-git__err { color: #fca5a5; font-size: 12px; border: 1px solid rgba(248, 113, 113, 0.35); border-radius: 8px; padding: 8px 10px; }

  /* per-hive pipelines (P-014) */
  .pc-git__hives { display: grid; gap: 6px; }
  .pc-git__hive { border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 86%); border-radius: 10px; background: rgba(255,255,255,0.012); overflow: hidden; }
  .pc-git__hive.is-open { border-color: color-mix(in srgb, var(--accent-strong), transparent 70%); }
  .pc-git__hive-row { display: grid; grid-template-columns: minmax(120px, 1.1fr) auto minmax(140px, 1.6fr) minmax(96px, auto) minmax(120px, auto) minmax(110px, auto) 16px; gap: 10px; align-items: center; width: 100%; text-align: left; background: transparent; border: 0; color: var(--fg); padding: 9px 12px; cursor: pointer; font-size: 12px; }
  .pc-git__hive-row:hover { background: rgba(255,255,255,0.02); }
  .pc-git__hive-slug { font-weight: 680; }
  .pc-git__hive-cmd { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: color-mix(in srgb, var(--fg), transparent 28%); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pc-git__hive-badge { margin-left: 6px; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0; padding: 1px 5px; border-radius: 5px; background: rgba(96, 165, 250, 0.16); color: #93c5fd; }
  .pc-git__hive-gap, .pc-git__hive-green, .pc-git__hive-deploy { font-size: 11px; color: color-mix(in srgb, var(--fg), transparent 45%); white-space: nowrap; }
  .pc-git__hive-caret { color: color-mix(in srgb, var(--fg), transparent 50%); text-align: center; }
  .pc-git__hive-edit { border-top: 1px solid color-mix(in srgb, var(--accent-strong), transparent 90%); padding: 10px 12px; display: grid; gap: 8px; background: rgba(255,255,255,0.012); }
  .pc-git__hive-k { font-size: 11px; color: color-mix(in srgb, var(--fg), transparent 40%); }
  .pc-git__hive-input { width: 100%; box-sizing: border-box; background: rgba(0,0,0,0.18); border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 80%); border-radius: 7px; color: var(--fg); padding: 7px 9px; font-size: 12px; }
  .pc-git__hive-input:focus { outline: none; border-color: color-mix(in srgb, var(--accent), transparent 50%); }
  .pc-git__hive-actions { display: flex; gap: 8px; }
  .pc-git__hive-save, .pc-git__hive-reset { border-radius: 7px; padding: 5px 12px; font-size: 12px; font-weight: 640; cursor: pointer; border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 78%); }
  .pc-git__hive-save { background: color-mix(in srgb, var(--accent), transparent 80%); color: var(--fg); }
  .pc-git__hive-reset { background: transparent; color: color-mix(in srgb, var(--fg), transparent 25%); }
  .pc-git__hive-save:disabled, .pc-git__hive-reset:disabled { opacity: 0.45; cursor: default; }
  .pc-git__hive-meta { font-size: 11px; color: color-mix(in srgb, var(--fg), transparent 50%); }
  .pc-git__hive-meta code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
`;
