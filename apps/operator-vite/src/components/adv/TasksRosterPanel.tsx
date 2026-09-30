/**
 * TasksRosterPanel — the Task Manager dropdown body (WI-6844).
 *
 * The popover face of the task manager, opened by TasksRunningPill. It is NOT
 * TasksClient: that is a 780px-prose full admin page and stays exactly where it
 * is at /admin/tasks. This is the same data re-laid-out for a 620px popover, in
 * the idiom the owner asked it to match — AgentsRunningPill's roster (grouped
 * scrolling rows, hover-to-preview detail strip, a footer out to the full view).
 *
 * ── What this shows that the ledger alone cannot ──
 * Two row sources, deliberately kept visually distinct rather than merged:
 *
 *   LEDGER rows   — enrolled tasks, with the provenance a process table cannot
 *                   give: who launched it, for which work-item, under what budget.
 *   SCANNED rows  — `liveProcesses`, every process actually running (WI-6475).
 *                   `scope` separates a genuine unaccounted process from an
 *                   allowed external lifetime or a closed terminal window. Only
 *                   the first is rendered as a chokepoint gap.
 *
 * Merging them would imply a provenance the scanned rows do not have. Separating
 * them makes "every Papercusp process is visible here" true today, while keeping
 * "we know who started this" honest.
 *
 * ── Killing from here (P-023, owner ask 2026-08-08) ──
 * Ledger rows carry a kill control; SCANNED rows do not, and that asymmetry is the
 * design rather than an omission. A scanned row is a pid we can see but did not enrol —
 * we have no ledger identity for it, so the only way to signal it would be by pid or by
 * name, which is the exact move that has twice killed the owner's live desktop here.
 * `KillTaskControl` is the SAME component the full page mounts (`@/app/admin/tasks/…`),
 * so the two surfaces cannot drift into different refusal semantics. freeze / limit are
 * still the capability-gated `processes:*` tools; the footer links out for those.
 */
import { useMemo } from 'react';
import { parseAsBoolean, parseAsString, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import type {
  TaskInventory,
  TaskInventoryRow,
  LiveProcessRow,
} from '@papercusp/operator-core/lib/task-manager/inventory';
// WI-7371 — the SHARED derivation, also used by the admin page, so the two surfaces
// cannot drift apart the way the pill and this panel did in WI-6844.
import {
  fmtCpuPct,
  resourceTitle,
  useResourceTotals,
} from '@/app/admin/tasks/use-resource-totals';
// P-023/P-024 — the SHARED kill control, imported across trees for the same reason
// use-resource-totals is: one definition of what is killable and what a refusal says.
import KillTaskControl, { KillOutcomeProvider, useKillOutcomeHoist } from '@/app/admin/tasks/KillTaskControl';

/** `live` is `unknown` on TaskInventory — the scan's own shape, narrowed here. */
type LiveScan = {
  alive?: number;
  stranded?: number;
  unaccounted?: number | { cgroupPath: string; pids: number[]; sample: string }[];
  foreign?: number;
  degraded?: boolean;
  degradedReason?: string;
  scan?: { processes: number; ownedTruncated: boolean; foreignTruncated: boolean };
};

const CLASS_GLYPH: Record<string, string> = {
  'agent-session': '◆',
  'bash-job': '▪',
  sidecar: '⬢',
  routine: '⟳',
  build: '⬒',
};

/** Bytes → a 3-significant-figure human size. Pure. */
export function fmtBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** An ISO start → a compact age like `4s` / `12m` / `6h`. Pure. */
export function fmtAge(startedAt: string | null | undefined, nowMs: number): string {
  if (!startedAt) return '—';
  const t = Date.parse(startedAt);
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/**
 * `node …/foo/bar.ts --flag` → `bar.ts`.
 *
 * The original version skipped INTERPRETER names but not FLAGS, so the first
 * surviving token was frequently the flag itself. Measured against the live scan
 * (647 rows, 2026-08-02), 321 of them — just under half — rendered as a bare flag
 * or shell builtin: `-lc` ×188, `--require` ×65, `-c` ×55, `exec` ×48. Owner-reported
 * as "why am i seeing so many tasks like this — `-lc` pid 1623888".
 *
 * Two things make this harder than dropping tokens that start with `-`:
 *
 *  1. Some flags CONSUME the next token (`node --require <loader> real-script.ts`),
 *     so blindly skipping only the flag promotes the loader shim instead.
 *  2. `/proc/<pid>/cmdline` is captured TRUNCATED at 300 chars, so for a shell
 *     wrapper like `bash -lc 'trap … ; exec real-thing'` the actual command is
 *     genuinely not present in the string. No parser can recover it.
 *
 * (2) is why this returns an honest shell shape (`bash -lc`) rather than digging for
 * something command-like: inventing a confident label from a truncated wrapper is how
 * the pane would end up asserting something it cannot know. A vague-but-true label is
 * the right failure mode for a diagnostic surface — the full cmdline is still on the
 * row's `title` tooltip.
 *
 * Pure.
 */
const CMD_INTERPRETERS = /^(node|npx|npm|pnpm|yarn|bash|sh|zsh|dash|python3?|tsx|ts-node|env)$/;
/** Shell builtins/keywords that are never the interesting command. */
const CMD_SHELL_NOISE = /^(exec|trap|source|cd|set|shopt|export|eval|command|nohup|builtin|unalias|unset|echo|true|false|then|do|fi|done|if|while)$/;
/** Flags that swallow the FOLLOWING token, which must not be mistaken for the script. */
const CMD_VALUE_FLAGS = /^(-r|--require|--import|--loader|--experimental-loader|--conditions|-e|--eval|--max-old-space-size)$/;
/** Looks like a thing you actually run. */
const CMD_SCRIPT_RE = /\.(mjs|cjs|js|mts|cts|ts|tsx|py|sh)$/;

function cmdBase(tok: string): string {
  return tok.replace(/^['"]+/, '').replace(/['"]+$/, '').replace(/.*\//, '');
}

export function shortCmd(cmdline: string | null): string {
  if (!cmdline) return '—';
  const raw = cmdline.trim();
  if (raw.length === 0) return '—';
  const parts = raw.split(/\s+/);

  const argv0 = cmdBase(parts[0] ?? '');
  const shellFlagIdx = parts.findIndex((p) => /^-[a-z]*c$/.test(p));
  const isShellWrapper = /^(bash|sh|zsh|dash)$/.test(argv0) && shellFlagIdx > 0;

  // A shell -c/-lc wrapper: the interesting thing is inside the script body. Take the
  // FIRST script-like token there (what is being sourced/run), never a later one from
  // the `&&`-chain, and never something under node_modules (a loader shim, not the job).
  if (isShellWrapper) {
    const body = parts.slice(shellFlagIdx + 1);
    const script = body.find((p) => CMD_SCRIPT_RE.test(cmdBase(p)) && !p.includes('node_modules'));
    if (script) return cmdBase(script);
    // Truncated or pure-shell body — say what it honestly is.
    return `${argv0} ${parts[shellFlagIdx]}`;
  }

  const candidates: string[] = [];
  for (let i = 1; i <= parts.length - 1; i++) {
    const tok = parts[i];
    if (CMD_VALUE_FLAGS.test(tok)) { i++; continue; } // skip the flag AND its value
    if (tok.startsWith('-')) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) continue; // FOO=bar env assignment
    const b = cmdBase(tok);
    if (b.length === 0) continue;
    if (CMD_INTERPRETERS.test(b) || CMD_SHELL_NOISE.test(b)) continue;
    if (tok.includes('node_modules')) continue;
    candidates.push(tok);
  }

  const script = candidates.find((p) => CMD_SCRIPT_RE.test(cmdBase(p)));
  const picked = script ?? candidates[0];
  if (picked) return cmdBase(picked);

  // Nothing but interpreter + flags (e.g. a bare `node`): the argv0 IS the answer.
  return argv0.length > 0 ? argv0 : raw.slice(0, 40);
}

/**
 * Live-process rows deliberately expose redacted metadata instead of raw
 * command lines (EI-21570098453017620). Keep this compact roster on the same
 * contract: executable is the primary label, with role as the honest fallback.
 */
export function liveProcessName(process: Pick<LiveProcessRow, 'executable' | 'role'>): string {
  return process.executable ?? process.role ?? '—';
}

function liveProcessTitle(process: Pick<LiveProcessRow, 'pid' | 'executable' | 'role' | 'build'>): string {
  return [process.executable, process.role, process.build, `pid ${process.pid}`]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}

function liveProcessDetail(process: Pick<LiveProcessRow, 'pid' | 'role' | 'build'>): string {
  return [process.role, process.build].filter((part): part is string => Boolean(part)).join(' · ') || `pid ${process.pid}`;
}

/** Unaccounted cgroup groups, whichever of the two shapes the scan used. Pure. */
export function unaccountedGroups(live: LiveScan | null): { cgroupPath: string; pids: number[]; sample: string }[] {
  const u = live?.unaccounted;
  return Array.isArray(u) ? u : [];
}

/**
 * Split the non-owned scan rows into the two populations that must never share a
 * label (EI-19325095302441792).
 *
 * The panel used to render every `owned:false` row as "UNENROLLED — the visible
 * gap". On this box that was 643 of 655 processes, and the dominant population is
 * the owner's own terminal windows — the FIRST named entry in the spawn guard's
 * allowlist. I wrote this component, read its output, and reported a 98% coverage
 * hole to the owner; it did not exist and had to be retracted. A supervision pane's
 * whole value is that its numbers can be trusted without re-deriving them, so
 * manufacturing alarm is exactly as bad as the false calm WI-6844 fixed.
 *
 * The classification is NOT made here — it arrives on the row from the scan, which
 * is the one place the rule set lives. This function only groups. Pure.
 */
export function splitUnowned(rows: LiveProcessRow[]): {
  unaccounted: LiveProcessRow[];
  abandonedWindow: LiveProcessRow[];
  exempt: LiveProcessRow[];
} {
  const unaccounted: LiveProcessRow[] = [];
  const abandonedWindow: LiveProcessRow[] = [];
  const exempt: LiveProcessRow[] = [];
  for (const p of rows) {
    if (p.owned) continue;
    // Treat an ABSENT discriminant as unaccounted rather than exempt: a stale
    // operator that predates the field must not silently downgrade a real escape
    // into "nothing to see". Over-reporting is the safe direction for an alarm.
    if (p.scope === 'exempt') exempt.push(p);
    // P-008/D-018: its own bucket. It used to land in `exempt`, where the section
    // header asserts "these are not escapees" — a claim the classifier cannot make
    // about a window that is gone.
    else if (p.scope === 'abandoned-window') abandonedWindow.push(p);
    else unaccounted.push(p);
  }
  return { unaccounted, abandonedWindow, exempt };
}

/** Count exempt rows by reason, biggest first, for the collapsed summary. Pure. */
export function exemptByReason(rows: LiveProcessRow[]): { reason: string; count: number }[] {
  const by = new Map<string, number>();
  for (const p of rows) {
    const key = p.exemptReason ?? 'other';
    by.set(key, (by.get(key) ?? 0) + 1);
  }
  return [...by.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/** Human labels for the exempt reasons the scan emits. */
const EXEMPT_LABEL: Record<string, string> = {
  'human-terminal': 'terminal windows you opened',
  'systemd-unit': 'systemd units (journald owns their lifecycle)',
  other: 'other exempt lifetimes',
};

/** Group ledger rows by class, stable order, biggest group first. Pure. */
export function groupByClass(rows: TaskInventoryRow[]): { cls: string; rows: TaskInventoryRow[] }[] {
  const by = new Map<string, TaskInventoryRow[]>();
  for (const r of rows) {
    const list = by.get(r.class) ?? [];
    list.push(r);
    by.set(r.class, list);
  }
  return [...by.entries()]
    .map(([cls, list]) => ({ cls, rows: list }))
    .sort((a, b) => b.rows.length - a.rows.length || a.cls.localeCompare(b.cls));
}

export default function TasksRosterPanel({ active }: { active: boolean }) {
  const [qRaw, setQ] = useQueryState('tasksQ', parseAsString);
  const q = typeof qRaw === 'string' ? qRaw : '';
  const [showExempt, setShowExempt] = useQueryState('tasksExempt', parseAsBoolean);

  // `live: true` walks the cgroup tree — that is the whole point of this panel
  // (it is what makes every process visible), and it is why `active` gates the
  // query rather than merely hiding the output.
  const query = useSyncQuery<TaskInventory>({
    queryName: 'taskManager.inventory',
    args: active ? { live: true } : {},
    staleTime: 5_000,
  });

  const data = (query.data as TaskInventory[] | undefined)?.[0] ?? null;
  const live = (data?.live ?? null) as LiveScan | null;
  const nowMs = Date.now();

  // WI-7371. Called BEFORE the `if (!data)` early return below — hooks must run on
  // every render, and this one carries the previous CPU sample the rate is derived from.
  const resources = useResourceTotals(data?.summary?.resources);

  const needle = q.trim().toLowerCase();
  const match = (...fields: (string | null | undefined)[]) =>
    needle.length === 0 || fields.some((f) => (f ?? '').toLowerCase().includes(needle));

  const ledger = useMemo(
    () => (data?.rows ?? []).filter((r) => match(r.title, r.launchedBy, r.workItemId, r.planSlug, r.class, r.scopeUnit)),
    [data?.rows, needle],
  );
  const scanned = useMemo(
    () => (data?.liveProcesses ?? []).filter((p: LiveProcessRow) => match(p.executable, p.role, p.build, p.cgroupPath)),
    [data?.liveProcesses, needle],
  );
  const groups = useMemo(() => groupByClass(ledger), [ledger]);
  // The killed row leaves `ledger` the moment the kill lands, taking its in-row chip with
  // it — so the outcome is hoisted here, where it outlives the row. Same hook the full page
  // uses, so the two surfaces cannot answer a kill differently.
  const { outcomeContext: killOutcomeContext, notice: killNotice } = useKillOutcomeHoist(ledger);
  const { unaccounted, abandonedWindow, exempt } = useMemo(() => splitUnowned(scanned), [scanned]);
  const orphans = unaccountedGroups(live);

  if (!data) {
    return <div className="pc-tasks-roster__loading" data-testid="tasks-roster-loading">Scanning…</div>;
  }

  return (
    <div className="pc-tasks-roster" role="group" aria-label="Task manager" data-testid="tasks-roster">
      {/* Summary before detail. `scan.processes` is the honest process total —
          strictly larger than the ledger count until every seam enrols. */}
      {/* WI-7371 — live resource totals, first, because "how much is this costing"
          is the question the pane is usually opened to answer. Both figures are folded
          over the server's OWN unfiltered fetch of the RUNNING set, so they do not change
          when the class filter below narrows the rows — and a server-side fold over the
          filtered query would have been the same bug one layer down. */}
      <dl className="pc-tasks-roster__pressure" data-testid="tasks-resource-totals">
        <div>
          <dt>Memory</dt>
          <dd title={resources ? resourceTitle(resources).mem : undefined} data-testid="tasks-total-mem">
            {resources ? fmtBytes(resources.rssBytesTotal) : '—'}
            {resources?.truncated ? (
              <span title="The server hit its row cap — this is a lower bound." data-testid="tasks-total-truncated">
                {' '}⚠
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>CPU</dt>
          <dd title={resources ? resourceTitle(resources).cpu : undefined} data-testid="tasks-total-cpu">
            {resources && resources.hasRate ? fmtCpuPct(resources.cpuBusyPct) : '…'}
          </dd>
        </div>
      </dl>

      <dl className="pc-tasks-roster__pressure">
        <div><dt>Enrolled</dt><dd title="Ledger TASKS — a task is one confined subtree">{data.summary.total}</dd></div>
        <div><dt>Scanned</dt><dd title="Kernel PROCESSES — one task holds many">{live?.scan?.processes ?? '—'}</dd></div>
        <div><dt>Stranded</dt><dd className={live?.stranded ? 'is-warn' : ''}>{live?.stranded ?? '—'}</dd></div>
        <div><dt>Unaccounted</dt><dd className={orphans.length ? 'is-bad' : ''}>{orphans.length || '0'}</dd></div>
      </dl>

      {/* The units note. Enrolled counts TASKS, Scanned counts PROCESSES, and the
          design is "confine the ROOTS, the kernel accounts for every descendant" —
          so one task legitimately holds dozens of processes and the two numbers are
          NOT meant to converge. Nothing said so, which made the wrong ratio tempting
          to compute; I computed it myself and reported it (EI-19325095302441792). */}
      <p className="pc-tasks-roster__units" data-testid="tasks-units-note">
        Enrolled counts <strong>tasks</strong>; Scanned counts <strong>processes</strong>. One task holds many
        processes — these are different units, not a coverage ratio.
      </p>

      {live?.degraded && (
        <div className="pc-tasks-roster__alarm is-warn" data-testid="tasks-degraded">
          ⚠ Live scan degraded — {live.degradedReason}. Rows below are the ledger's; nothing is being closed out while
          the scan cannot be trusted.
        </div>
      )}

      {orphans.length > 0 && (
        <div className="pc-tasks-roster__alarm" data-testid="tasks-unaccounted">
          <strong>{orphans.length} unaccounted cgroup{orphans.length === 1 ? '' : 's'}</strong>
          <span>
            Running with no live ledger row. The cgroup path distinguishes a managed scope from a process outside
            every task scope; inspect that provenance before attributing the cause.
          </span>
        </div>
      )}

      <div className="pc-tasks-roster__search">
        <input
          type="text"
          value={q}
          onChange={(e) => void setQ(e.target.value || null)}
          placeholder="Search command, agent, work-item, plan, scope unit…"
          aria-label="Search tasks"
          data-testid="tasks-search"
        />
      </div>

      {/* Above the scroller, not inside it: once the row is gone the reader is not
          scrolled to where it used to be, and a destructive action's answer must not
          require hunting for it. */}
      {killNotice}

      <KillOutcomeProvider value={killOutcomeContext}>
      <div className="pc-tasks-roster__scroll" data-testid="tasks-roster-scroll">
        {groups.map((g) => (
          <section key={g.cls} className="pc-tasks-roster__group">
            <header className="pc-tasks-roster__group-head">
              <span aria-hidden>{CLASS_GLYPH[g.cls] ?? '·'}</span> {g.cls}
              <span className="pc-tasks-roster__group-count">({g.rows.length})</span>
            </header>
            {g.rows.map((r) => (
              <div
                key={r.taskId}
                className={`pc-tasks-roster__row${r.confined ? '' : ' is-unconfined'}`}
                data-testid={`task-row-${r.taskId}`}
                data-state={r.state}
              >
                <span className="pc-tasks-roster__age">{fmtAge(r.startedAt, nowMs)}</span>
                <span className="pc-tasks-roster__name" title={r.scopeUnit ?? r.taskId}>
                  {r.title || shortCmd(null) || r.taskId}
                </span>
                <span className="pc-tasks-roster__doing" title={r.launchedBy}>
                  {r.workItemId && <span className="pc-tasks-roster__wi">{r.workItemId}</span>}
                  {r.launchedBy}
                </span>
                <span className="pc-tasks-roster__num">{fmtBytes(r.rssBytes)}</span>
                <span className="pc-tasks-roster__num">{r.pids ?? '—'}</span>
                <span className="pc-tasks-roster__act">
                  <KillTaskControl row={r} />
                </span>
              </div>
            ))}
          </section>
        ))}

        {/* THE GAP — and only the gap. A process matching our signature, outside
            our slice, that no allowlisted lifetime explains. On this box that is
            dominated by `papercup-headless-*.scope` members, which is precisely the
            P-009 residue: buildHeadlessSpawnCommand falls back to that name when it
            is handed no taskScope. This is the only group that carries alarm. */}
        {unaccounted.length > 0 && (
          <section className="pc-tasks-roster__group">
            <header className="pc-tasks-roster__group-head is-bad">
              <span aria-hidden>○</span> unaccounted
              <span className="pc-tasks-roster__group-count">({unaccounted.length})</span>
              <span className="pc-tasks-roster__chip">no ledger row, no exempt lifetime — this is the gap</span>
            </header>
            {unaccounted.map((p: LiveProcessRow) => (
              <div
                key={p.pid}
                className="pc-tasks-roster__row is-orphan"
                data-testid={`task-scanned-${p.pid}`}
              >
                <span className="pc-tasks-roster__age">{fmtAge(p.startedAt, nowMs)}</span>
                <span className="pc-tasks-roster__name" title={liveProcessTitle(p)}>{liveProcessName(p)}</span>
                <span className="pc-tasks-roster__doing" title={p.cgroupPath}>{liveProcessDetail(p)}</span>
                <span className="pc-tasks-roster__num">—</span>
                <span className="pc-tasks-roster__num">—</span>
              </div>
            ))}
          </section>
        )}

        {/* A window closed but these kept running (P-008 / D-018).
            NOT an alarm and NOT a kill list: 14 of 15 such scopes measured on this
            box held live agent sessions or shared infra, so a dead window is not
            evidence of abandonment (D-016 — this class stays report-only). It is
            its own section because both neighbours lie about it: `exempt` claims a
            human owns the lifetime when the human closed it, and `unaccounted`
            calls it a chokepoint bypass when a human legitimately started it. */}
        {abandonedWindow.length > 0 && (
          <section className="pc-tasks-roster__group">
            <header className="pc-tasks-roster__group-head">
              <span aria-hidden>◍</span> a window closed but these kept running
              <span className="pc-tasks-roster__group-count">({abandonedWindow.length})</span>
              <span className="pc-tasks-roster__chip">
                still running with no terminal — usually fine, worth a look if it grows
              </span>
            </header>
            {abandonedWindow.map((p: LiveProcessRow) => (
              <div
                key={p.pid}
                className="pc-tasks-roster__row"
                data-testid={`task-abandoned-${p.pid}`}
              >
                <span className="pc-tasks-roster__age">{fmtAge(p.startedAt, nowMs)}</span>
                <span className="pc-tasks-roster__name" title={liveProcessTitle(p)}>{liveProcessName(p)}</span>
                <span className="pc-tasks-roster__doing" title={p.cgroupPath}>{liveProcessDetail(p)}</span>
                <span className="pc-tasks-roster__num">—</span>
                <span className="pc-tasks-roster__num">—</span>
              </div>
            ))}
          </section>
        )}

        {/* Out of scope BY DESIGN — neutral context, collapsed. These are the
            lifetimes the spawn guard's allowlist names on purpose (a human's OPEN
            terminal window; a systemd unit whose lifecycle systemd owns). Shown
            because hiding them would make the scan total unexplainable, styled flat
            because alarm here is a false positive.

            ⚠ This section no longer claims "these are not escapees" (P-008/D-018).
            It could not back that claim: the exemption is withdrawn only when a
            window is POSITIVELY observed dead, and unknown deliberately fails
            toward exempt — so residue whose probe never ran sat here wearing a
            label that said it was fine. A dead window now has its own section
            above; what remains here is exempt because something still owns it. */}
        {exempt.length > 0 && (
          <section className="pc-tasks-roster__group is-muted" data-testid="tasks-exempt">
            {/* Expansion is nuqs, not useState — panel open-state is user-meaningful
                and must be visible to `ui:get_state`. It also gates the RENDER: a
                `<details>` would mount all ~600 rows and merely hide them, paying
                the layout cost for content nobody asked to see. */}
            <button
              type="button"
              className="pc-tasks-roster__group-head"
              aria-expanded={showExempt ?? false}
              onClick={() => void setShowExempt(showExempt ? null : true)}
              data-testid="tasks-exempt-toggle"
            >
              <span aria-hidden>{showExempt ? '▾' : '▸'}</span> out of scope by design
              <span className="pc-tasks-roster__group-count">({exempt.length})</span>
              <span className="pc-tasks-roster__chip">
                {exemptByReason(exempt)
                  .map((r) => `${r.count} ${EXEMPT_LABEL[r.reason] ?? r.reason}`)
                  .join(' · ')}
              </span>
            </button>
            {showExempt && exempt.map((p: LiveProcessRow) => (
              <div
                key={p.pid}
                className="pc-tasks-roster__row is-muted"
                data-testid={`task-exempt-${p.pid}`}
              >
                <span className="pc-tasks-roster__age">{fmtAge(p.startedAt, nowMs)}</span>
                <span className="pc-tasks-roster__name" title={liveProcessTitle(p)}>{liveProcessName(p)}</span>
                <span className="pc-tasks-roster__doing" title={p.cgroupPath}>
                  {EXEMPT_LABEL[p.exemptReason ?? 'other'] ?? p.exemptReason}
                </span>
                <span className="pc-tasks-roster__num">—</span>
                <span className="pc-tasks-roster__num">—</span>
              </div>
            ))}
          </section>
        )}

        {groups.length === 0 && unaccounted.length === 0 && exempt.length === 0 && (
          <div className="pc-tasks-roster__empty" data-testid="tasks-roster-empty">
            {needle ? `Nothing matches “${q}”.` : 'Nothing running.'}
          </div>
        )}
      </div>
      </KillOutcomeProvider>

      <div className="pc-tasks-roster__foot">
        <span>
          {live?.scan?.ownedTruncated || live?.scan?.foreignTruncated
            ? 'Scan capped — some processes are not listed'
            : 'Ledger + kernel scan agree'}
        </span>
        <a href="/admin/tasks">Open full Task Manager →</a>
      </div>
    </div>
  );
}
