/**
 * stale-prompt-render-sweep.ts — the DELIVERY half of
 * `stale-prompt-render-in-live-sessions-2026-08-02` P-004.
 *
 * The verdict is computed by the pure detector in `prompt-material-signals.ts`;
 * this module is the /proc read, the source union, the debounce, and the coord
 * delivery. Same chassis as its siblings (`agent-state-divergence-sweep.ts`,
 * `wall-lapse-watchdog.ts`): a pure formatter unit-tested with no IO, a thin sweep
 * wired into `routinesTick` as one durable step, fail-soft throughout, and the
 * shared fires-ledger debounce so a session is told once per window rather than
 * once per tick.
 *
 * ── WHY THIS EXISTS AT ALL, GIVEN P-002 SHIPPED ─────────────────────────────
 *
 * P-002 makes a carry-respawn re-render its persona from current sources. That is
 * the durable fix and it is live. But per D-003 it reaches NEITHER of two cohorts:
 *
 *   1. a session whose `adv_sessions` row predates migration 738 has no
 *      `launch_spec`, so the refresh returns `no-launch-spec` and it keeps
 *      inheriting the predecessor's file FOREVER — no future respawn will help it;
 *   2. any session at all, between now and its NEXT respawn.
 *
 * Measured when the plan was written: 27 of 53 live claude sessions were running a
 * render up to 14 days old. Those sessions cannot be re-rendered in place — the
 * `--system-prompt-file` was read once at exec. So the only remaining channel is
 * to TELL them, over coord, which reaches a running agent mid-turn.
 *
 * ── THE DESIGN CONSTRAINT IS QUIETNESS ──────────────────────────────────────
 *
 * The plan is explicit: gate on MATERIAL drift only, because "firing on every
 * whitespace edit makes it chatter and it gets ignored, which is worse than
 * silence". Two things enforce that here: the detector's narrow families (see
 * `prompt-material-signals.ts`), and the fires-ledger debounce keyed on
 * (ownerId, drift fingerprint) so a session hears about one drift exactly once.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promptHarnessRoot } from '@papercusp/harness/paths';
import {
  detectMaterialRenderDrift,
  driftFingerprint,
  type MaterialRenderDrift,
} from './prompt-material-signals';
import { claimWatchdogFire } from './pot/watchdog';
import { sendMessage } from './agent-tools/coordination/messages';
import type { AgentIdentity } from './agent-tools/coordination/identity';

/** Re-notify the same (owner, drift) at most once per this many hours. A render
 *  cannot change under a running session, so a repeat notice can only ever be
 *  noise — the window is long on purpose. */
export const STALE_RENDER_DEBOUNCE_HOURS = 24;

/** Bound on sessions examined per sweep. A bound on work, never on the counts a
 *  verdict reports. */
export const SWEEP_SESSION_CAP = 500;

const DEFAULT_INSTALL_SLUG = 'papercusp';

/** Synthetic identity for the background notification (mirrors the siblings). */
const STALE_RENDER_IDENTITY: AgentIdentity = {
  ownerId: 'stale-prompt-render-detector',
  ownerLabel: 'system · stale-prompt-render-detector',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

// ── the /proc read ───────────────────────────────────────────────────────────

/** One live agent process and the prompt render it is actually running. */
export interface LiveSessionRender {
  /** The coord ownerId — `PAPERCUSP_SID` in the child's environ. */
  ownerId: string;
  pid: number;
  /** Absolute path from the child's `--system-prompt-file` argv. */
  promptFile: string;
  workspaceId: string | null;
  harnessSlug: string | null;
}

/**
 * Every live agent process on this box, with the render file it is serving.
 *
 * WHY /proc AND NOT THE SESSION TABLE. The question is not "what did this session
 * launch with" — that is what `adv_sessions` records, and for these cohorts it is
 * exactly the value that turned out to be wrong. The question is "what bytes is
 * this process ACTUALLY reading its persona from right now", and `--system-prompt-file`
 * on the live argv is the only authoritative answer: a respawn rewrites argv without
 * touching the row. This is the same read that established the plan's P-001 root
 * cause. Injectable so the sweep unit-tests with no /proc at all.
 *
 * Best-effort per pid: a process that exits mid-scan, or whose environ is
 * unreadable, is skipped rather than failing the sweep.
 */
export function listLiveSessionRenders(
  procRoot = '/proc',
  cap: number = SWEEP_SESSION_CAP,
): LiveSessionRender[] {
  let pids: string[];
  try {
    pids = readdirSync(procRoot).filter((d) => /^\d+$/.test(d));
  } catch {
    return []; // no /proc (non-Linux dev) — nothing to sweep
  }
  const out: LiveSessionRender[] = [];
  for (const pid of pids) {
    let cmdline: string;
    try {
      cmdline = readFileSync(join(procRoot, pid, 'cmdline'), 'utf8');
    } catch {
      continue; // exited between readdir and read, or not ours
    }
    const argv = cmdline.split('\0');
    const i = argv.indexOf('--system-prompt-file');
    if (i === -1 || !argv[i + 1]) continue;
    const promptFile = argv[i + 1];

    let environ: string;
    try {
      environ = readFileSync(join(procRoot, pid, 'environ'), 'utf8');
    } catch {
      continue;
    }
    const env = new Map<string, string>();
    for (const entry of environ.split('\0')) {
      const eq = entry.indexOf('=');
      if (eq > 0) env.set(entry.slice(0, eq), entry.slice(eq + 1));
    }
    const ownerId = env.get('PAPERCUSP_SID');
    // No coord identity ⇒ nobody to notify. A prompt-file argv without a SID is
    // not an agent session we own (a hand-run claude, a test fixture).
    if (!ownerId) continue;
    out.push({
      ownerId,
      pid: Number(pid),
      promptFile,
      workspaceId: env.get('PAPERCUSP_WORKSPACE') ?? null,
      harnessSlug: env.get('PAPERCUSP_HARNESS_SLUG') ?? null,
    });
    if (out.length >= cap) break;
  }
  return out;
}

// ── the source union ─────────────────────────────────────────────────────────

/** The current persona sources, and whether they can be trusted as COMPLETE. */
export interface PersonaSourceUnion {
  texts: string[];
  /**
   * False when a source that CONTRIBUTES to a live render could not be read — a
   * live prompt override, most importantly. An incomplete union makes every
   * mechanism in it look retired, so the route family is suppressed rather than
   * fired on a partial picture (see `detectMaterialRenderDrift`'s fail-closed note).
   */
  complete: boolean;
  reason?: string;
}

/**
 * The operator `prompts/` dir. Deliberately the SAME cwd-rooted candidate list as
 * prompt-studio's `resolvePromptsDir` — that one is proven against both operator
 * layouts (repo root and `apps/operator`), and a second, cleverer resolver here
 * would be a fork that can silently resolve somewhere else.
 */
export function resolvePromptsDir(): string | null {
  const cwd = process.cwd();
  for (const c of [join(cwd, 'apps', 'operator', 'prompts'), join(cwd, 'prompts')]) {
    if (existsSync(join(c, 'papercusp-su-engineer.tools.md'))) return c;
  }
  return null;
}

/** The base domain-neutral su persona, read from the root the RUNTIME resolves
 *  prompts through — not a repo-relative guess. `promptHarnessRoot()` is what a
 *  real launch reads, so a decoupled/staging prompt root is honoured here too
 *  (the same resolution `prompt-divergence.ts` compares against). */
function basePersonaPath(): string | null {
  try {
    return join(promptHarnessRoot(), 'blueprints', 'base', 'prompts', 'su.md');
  } catch {
    return null;
  }
}

export interface SourceUnionDeps {
  /** (workspaceId, harnessSlug) pairs whose LIVE overrides must be folded in. */
  scopes?: ReadonlyArray<{ workspaceId: string; harnessSlug: string }>;
  getPromptOverride?: (w: string, h: string, role: string) => Promise<string | null>;
  potHomeSlugForHarness?: (w: string, h: string) => Promise<string | null>;
  getHiveInstancePromptOverride?: (w: string, p: string, role: string) => Promise<string | null>;
  promptsDir?: string | null;
  basePersonaPath?: string | null;
}

/**
 * Assemble the CURRENT persona sources a live render should agree with.
 *
 * Two tiers, both required:
 *   - the version-controlled layer FILES (base persona, client overlays, the
 *     pot-instance override sources, the legacy playbooks);
 *   - the LIVE prompt overrides in the datastore, which is what a launch actually
 *     reads. The pot-instance file is explicitly only the *source* that gets seeded
 *     into `hive_settings`, so a store that has moved ahead of its file would make
 *     every su render look like it names retired mechanisms — the one way this
 *     detector could page the entire fleet about nothing. Hence: any override read
 *     that FAILS marks the union incomplete and the route family stands down.
 */
export async function readCurrentPersonaSources(
  deps: SourceUnionDeps = {},
): Promise<PersonaSourceUnion> {
  const texts: string[] = [];
  const dir = deps.promptsDir !== undefined ? deps.promptsDir : resolvePromptsDir();
  const readIf = (p: string | null): void => {
    if (!p) return;
    try {
      if (existsSync(p)) texts.push(readFileSync(p, 'utf8'));
    } catch {
      /* unreadable layer — the union is still usable, it just lacks this file */
    }
  };

  readIf(deps.basePersonaPath !== undefined ? deps.basePersonaPath : basePersonaPath());
  if (dir) {
    for (const f of [
      'papercusp-su.claude.md',
      'papercusp-su.omp.md',
      'papercusp-su.codex.md',
      'papercusp-su-engineer.tools.md',
      'papercusp-su-power.tools.md',
    ]) {
      readIf(join(dir, f));
    }
    // Every pot-instance override source, not just this pot's: a render examined
    // here may belong to any harness on the box.
    const potDir = join(dir, 'pot-instances');
    try {
      for (const f of readdirSync(potDir)) if (f.endsWith('.md')) readIf(join(potDir, f));
    } catch {
      /* no pot-instances dir — file tier simply has no override layer */
    }
  }

  // ── the live override tier (fail CLOSED) ──────────────────────────────────
  const scopes = deps.scopes ?? [];
  if (scopes.length > 0) {
    const getHarness =
      deps.getPromptOverride ??
      (async (w, h, role) => (await import('./harness-prompt-overrides')).getPromptOverride(w, h, role));
    const getPotSlug =
      deps.potHomeSlugForHarness ??
      (async (w, h) => (await import('./hive-federation')).potHomeSlugForHarness(w, h));
    const getHive =
      deps.getHiveInstancePromptOverride ??
      (async (w, p, role) =>
        (await import('./hive-settings-store')).getHiveInstancePromptOverride(w, p, role));
    for (const { workspaceId, harnessSlug } of scopes) {
      try {
        const harnessOverride = await getHarness(workspaceId, harnessSlug, 'su');
        if (harnessOverride) texts.push(harnessOverride);
        const potSlug = await getPotSlug(workspaceId, harnessSlug);
        if (potSlug) {
          const potOverride = await getHive(workspaceId, potSlug, 'su');
          if (potOverride) texts.push(potOverride);
        }
      } catch (e) {
        return {
          texts,
          complete: false,
          reason: `live prompt-override read failed for ${workspaceId}/${harnessSlug}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        };
      }
    }
  }

  if (texts.length === 0) {
    return { texts, complete: false, reason: 'no persona sources could be read' };
  }
  return { texts, complete: true };
}

// ── pure formatter (unit-tested without IO) ──────────────────────────────────

/**
 * PURE: the message a running agent receives about its own stale render.
 *
 * Second person, evidence first, and it says plainly what the agent CANNOT do:
 * a `--system-prompt-file` is read once at exec, so there is no in-place fix and
 * telling the agent to "re-read" the file would be a fabricated remedy. What it
 * can do is disregard the specific stale rules named here, which is why the
 * message is a delta and not a diff.
 */
export function formatStaleRenderAlert(opts: {
  drift: MaterialRenderDrift;
  promptFile: string;
  renderedAt: string | null;
}): { summary: string; body: string } {
  const { drift } = opts;
  const parts: string[] = [];
  if (drift.deniedRecommendations.length) {
    const many = drift.deniedRecommendations.length > 1;
    parts.push(
      `it RECOMMENDS ${drift.deniedRecommendations.map((t) => `\`${t}\``).join(', ')}, which ` +
        `${many ? 'are' : 'is'} DENIED to you — ${many ? 'those tools are' : 'that tool is'} not in ` +
        `your toolset, so offering a route built on ${many ? 'them' : 'it'} promises the owner ` +
        `something you cannot execute`,
    );
  }
  if (drift.retiredRouteMechanisms.length) {
    parts.push(
      `its route rules name ${drift.retiredRouteMechanisms.map((m) => `\`${m}\``).join(', ')}, which no ` +
        `current prompt source names any more — treat those routes as retired`,
    );
  }
  const summary =
    drift.deniedRecommendations.length > 0
      ? `Your system prompt recommends a DENIED tool (${drift.deniedRecommendations.join(', ')}) — it is stale`
      : `Your system prompt names retired route mechanisms (${drift.retiredRouteMechanisms.join(', ')})`;

  return {
    summary,
    body:
      `The prompt render this session is running (${opts.promptFile}` +
      `${opts.renderedAt ? `, written ${opts.renderedAt}` : ''}) has drifted from current sources:\n\n` +
      parts.map((p) => `• ${p}`).join('\n') +
      `\n\nWHY YOU CANNOT FIX THIS IN PLACE: \`--system-prompt-file\` is read once when the process ` +
      `execs, so nothing you do this turn re-reads it. A carry-respawn now re-renders the persona ` +
      `(stale-prompt-render-in-live-sessions-2026-08-02 P-002), so your NEXT respawn will pick up ` +
      `current sources — unless this session predates migration 738, in which case it never will and ` +
      `this notice is the only correction you will get.\n\n` +
      `WHAT TO DO: disregard the specific rules named above for the rest of this session. This is a ` +
      `MATERIAL-drift notice only — wording and formatting differences are deliberately not reported, ` +
      `so everything listed here changes what you would actually do.`,
  };
}

/** Debounce key — per (owner, drift), so a session that is stale in two distinct
 *  ways hears about both, and about neither twice. */
export function staleRenderFireKey(ownerId: string, drift: MaterialRenderDrift): string {
  return `${ownerId}:${driftFingerprint(drift)}`;
}

/** `recentWatchdogFires`/`claimWatchdogFire` match a `scopeKey` as
 *  `reason LIKE '%scopeKey%'`, so the key MUST appear verbatim in the reason —
 *  the exact contract whose breach silently disabled the sibling sweep's debounce
 *  for its entire life (EI-18824142520274965). */
export function staleRenderFireReason(key: string, summary: string): string {
  return `[${key}] ${summary}`;
}

// ── the sweep ────────────────────────────────────────────────────────────────

export interface StaleRenderOutcome {
  ownerId: string;
  outcome: 'notified' | 'debounced' | 'clean' | 'unreadable' | 'error';
  reason: string;
}

export interface StaleRenderSweepResult {
  outcomes: StaleRenderOutcome[];
  examined: number;
  /** True when the route family was suppressed because the source union was
   *  incomplete — carried out so the caller can log WHY a quiet sweep was quiet. */
  routeFamilySuppressed: boolean;
  suppressionReason?: string;
}

export interface StaleRenderSweepDeps {
  listLiveSessionRenders?: typeof listLiveSessionRenders;
  readCurrentPersonaSources?: typeof readCurrentPersonaSources;
  readRender?: (path: string) => { text: string; mtime: string | null };
  claimWatchdogFire?: typeof claimWatchdogFire;
  sendMessage?: typeof sendMessage;
  workspaceId?: string;
  installSlug?: string;
}

function defaultReadRender(path: string): { text: string; mtime: string | null } {
  const text = readFileSync(path, 'utf8');
  let mtime: string | null = null;
  try {
    mtime = statSync(path).mtime.toISOString();
  } catch {
    /* mtime is decoration on the alert, never a verdict input */
  }
  return { text, mtime };
}

/**
 * Renders are IMMUTABLE once written (a session's `--system-prompt-file` is not
 * rewritten under it — that is the whole bug), so the signal for a given
 * path+mtime+size can be computed once and reused for every later tick. Without
 * this the sweep re-reads and re-parses ~130KB per live session per tick forever.
 * Bounded so a long-lived operator cannot grow it without limit.
 */
const driftMemo = new Map<string, MaterialRenderDrift>();
const DRIFT_MEMO_CAP = 2_000;

function memoKey(path: string, text: string, mtime: string | null): string {
  return `${path}:${mtime ?? '?'}:${text.length}`;
}

/**
 * One sweep: read every live session's ACTUAL render, compare it against current
 * sources, and notify each affected agent once per debounce window.
 *
 * Fail-soft per session AND overall — a detector that throws guards nothing.
 */
export async function stalePromptRenderSweep(
  deps: StaleRenderSweepDeps = {},
): Promise<StaleRenderSweepResult> {
  const workspaceId = deps.workspaceId ?? 'papercusp-workspace';
  const installSlug = deps.installSlug ?? DEFAULT_INSTALL_SLUG;
  const outcomes: StaleRenderOutcome[] = [];

  let sessions: LiveSessionRender[];
  try {
    sessions = (deps.listLiveSessionRenders ?? listLiveSessionRenders)();
  } catch (e) {
    return {
      outcomes: [{ ownerId: '*', outcome: 'error', reason: e instanceof Error ? e.message : String(e) }],
      examined: 0,
      routeFamilySuppressed: true,
      suppressionReason: 'session enumeration failed',
    };
  }
  if (sessions.length === 0) {
    return { outcomes: [], examined: 0, routeFamilySuppressed: false };
  }

  // Distinct (workspace, harness) scopes whose live overrides contribute.
  const scopeKeys = new Set<string>();
  const scopes: Array<{ workspaceId: string; harnessSlug: string }> = [];
  for (const s of sessions) {
    if (!s.workspaceId || !s.harnessSlug) continue;
    const k = `${s.workspaceId}\x00${s.harnessSlug}`;
    if (scopeKeys.has(k)) continue;
    scopeKeys.add(k);
    scopes.push({ workspaceId: s.workspaceId, harnessSlug: s.harnessSlug });
  }

  let union: PersonaSourceUnion;
  try {
    union = await (deps.readCurrentPersonaSources ?? readCurrentPersonaSources)({ scopes });
  } catch (e) {
    union = { texts: [], complete: false, reason: e instanceof Error ? e.message : String(e) };
  }

  const readRender = deps.readRender ?? defaultReadRender;
  for (const s of sessions) {
    try {
      let text: string;
      let mtime: string | null;
      try {
        ({ text, mtime } = readRender(s.promptFile));
      } catch (e) {
        outcomes.push({
          ownerId: s.ownerId,
          outcome: 'unreadable',
          reason: `${s.promptFile}: ${e instanceof Error ? e.message : String(e)}`,
        });
        continue;
      }

      const key = memoKey(s.promptFile, text, mtime);
      let drift = driftMemo.get(key);
      if (!drift) {
        drift = detectMaterialRenderDrift({
          renderText: text,
          sourceTexts: union.texts,
          includeRouteFamily: union.complete,
        });
        if (driftMemo.size >= DRIFT_MEMO_CAP) driftMemo.clear();
        driftMemo.set(key, drift);
      }
      if (!drift.material) {
        outcomes.push({ ownerId: s.ownerId, outcome: 'clean', reason: 'render matches current sources' });
        continue;
      }

      const { summary, body } = formatStaleRenderAlert({
        drift,
        promptFile: s.promptFile,
        renderedAt: mtime,
      });
      const fireKey = staleRenderFireKey(s.ownerId, drift);

      // Claim the debounce slot ATOMICALLY, and only notify if we won it — the
      // check-then-act pair races every concurrent tick into duplicate pages.
      const claimed = await (deps.claimWatchdogFire ?? claimWatchdogFire)({
        workspaceId,
        installSlug,
        source: 'stale-prompt-render',
        reason: staleRenderFireReason(fireKey, summary),
        wakeAt: null,
        windowHours: STALE_RENDER_DEBOUNCE_HOURS,
        scopeKey: fireKey,
      });
      if (!claimed) {
        outcomes.push({ ownerId: s.ownerId, outcome: 'debounced', reason: 'fires-ledger debounce' });
        continue;
      }

      // The agent ITSELF, and only the agent: nobody else can act on this, and a
      // leader escalation would spend a second agent's attention on a condition
      // that no agent can repair in place.
      await (deps.sendMessage ?? sendMessage)(STALE_RENDER_IDENTITY, {
        to: [s.ownerId],
        summary,
        body,
        category: 'self-correction',
      });
      outcomes.push({ ownerId: s.ownerId, outcome: 'notified', reason: summary });
    } catch (e) {
      outcomes.push({
        ownerId: s.ownerId,
        outcome: 'error',
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    outcomes,
    examined: sessions.length,
    routeFamilySuppressed: !union.complete,
    suppressionReason: union.complete ? undefined : union.reason,
  };
}

/** Where launch renders live — exported for tests/diagnostics that want to sweep
 *  the on-disk corpus rather than live processes. */
export function launchContextDirPath(): string {
  return process.env.PAPERCUSP_LAUNCH_CONTEXT_DIR || join(homedir(), '.papercusp', 'launch-context');
}
