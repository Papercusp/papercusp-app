/**
 * Harness reader helpers — non-route operations shared by route handlers
 * and external callers.
 *
 * Relocated from `app/api/_hono/harness.ts` (endpoint-hono-elimination
 * -2026-05-21 A4 first batch). Routes still live in the legacy file for
 * now; subsequent A4 batches migrate them to `defineTool` modules. This
 * carve-out lets `lib/*` callers stop importing from `app/api/_hono/*`,
 * breaking the layering violation.
 *
 * Caches in this module are realm-pinned so Next dev module re-evaluation
 * doesn't reset them per request — same intent as the original harness.ts,
 * but through `pinModuleState` rather than hand-rolled `globalThis[key]`
 * pairs, so the pin is visible to listModuleDuplications(). See
 * /docs/performance #A5.
 */
import {
  readFileSync, readlinkSync, existsSync, readdirSync, statSync,
  openSync, readSync, closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { pinModuleState } from '@papercusp/module-singleton';
import { harnessQuery } from '@papercusp/db-org';
import {
  HARNESS_SHARED_CONFIG_REL_PATH,
  isHarnessSharedConfig,
} from './harness/harness-shared-config-types';
import {
  canonicalHarnessSlug,
  operatorHomeHarnessSlug,
  HOME_HARNESS_ENV,
} from './harness/operator-home-harness';

import { loadHarnessRegistry, type ProjectEntry } from './harness-registry';
import { readRegistry, activeWorkspaceId } from './workspace-registry';
import { type Phase, phasePath } from './harness-phases';

/* ─────────────────────────────────────────────────────────────────────
 * tailLastResultLine — internal, used by aggregateCostFromLogDir.
 * Reads the last ~8KB of a .jsonl file and returns the last
 * `{"type":"result", ...}` object found there.
 * ───────────────────────────────────────────────────────────────────── */

function tailLastResultLine(filePath: string, lookbackBytes = 8 * 1024): { obj: Record<string, unknown> | null } {
  let fd = -1;
  try {
    const st = statSync(filePath);
    if (st.size === 0) return { obj: null };
    const start = Math.max(0, st.size - lookbackBytes);
    const len = st.size - start;
    fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line.startsWith('{')) continue;
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (obj.type === 'result') return { obj };
      } catch { /* partial line at the start of the window — skip */ }
    }
    return { obj: null };
  } catch {
    return { obj: null };
  } finally {
    if (fd >= 0) try { closeSync(fd); } catch {}
  }
}

/* ─────────────────────────────────────────────────────────────────────
 * countPulsesFromRunLog — total `── iteration N ──` lines across run.log.
 * Incrementally cached; re-scans only the bytes appended since the last
 * cache hit. Eviction implicit when mtime moves backwards (rotation).
 * ───────────────────────────────────────────────────────────────────── */

type PulseCacheEntry = { mtimeMs: number; size: number; count: number };

/* ─────────────────────────────────────────────────────────────────────
 * This module's ENTIRE realm-pinned cache set, pinned ONCE.
 *
 * Previously four hand-rolled `globalThis[key]` pairs (three plain-string
 * keys plus one Symbol.for). Hand-rolling shares the state correctly, but
 * the keys are invisible to listModuleDuplications(), which then answers a
 * confident `[]` while this module is split (EI-19479108855357092).
 *
 * ONE `pinModuleState` call per module body is deliberate: it keeps the
 * primitive's `evaluations` an honest count of module RECORDS, and it
 * forecloses the half-migrated shape where one cache is pinned and its
 * siblings are left module-local — on a split, a bust of the pinned one
 * leaves a sibling serving stale entries for its whole TTL.
 *
 * The entry types are declared further down beside their own functions;
 * type aliases hoist (values do not), so this block holds only the pin.
 * ───────────────────────────────────────────────────────────────────── */
const __caches = pinModuleState<{
  pulse: Map<string, PulseCacheEntry>;
  cost: Map<string, CostCacheEntry>;
  costPerFile: Map<string, CostPerFileEntry>;
  alive: Map<string, AliveCacheEntry>;
}>('@papercusp/operator-core.harnessCoreCaches', () => ({
  pulse: new Map(),
  cost: new Map(),
  costPerFile: new Map(),
  alive: new Map(),
}));

const __pulseCache = __caches.pulse;
const PULSE_RE = /── iteration \d+ ──/g;

export function countPulsesFromRunLog(path: string): number {
  if (!existsSync(path)) return 0;
  let st: { mtimeMs: number; size: number };
  try { st = statSync(path); } catch { return 0; }
  if (st.size === 0) return 0;

  const cached = __pulseCache.get(path);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.count;
  }

  const startOffset =
    cached && cached.mtimeMs <= st.mtimeMs && cached.size <= st.size
      ? cached.size
      : 0;

  let fd = -1;
  let count = startOffset === 0 ? 0 : cached!.count;
  try {
    fd = openSync(path, 'r');
    const CHUNK = 64 * 1024;
    const buf = Buffer.alloc(CHUNK);
    let leftover = '';
    let pos = startOffset;
    while (pos < st.size) {
      const len = Math.min(CHUNK, st.size - pos);
      readSync(fd, buf, 0, len, pos);
      const text = leftover + buf.subarray(0, len).toString('utf8');
      const nl = text.lastIndexOf('\n');
      const scan = nl >= 0 ? text.slice(0, nl) : '';
      leftover = nl >= 0 ? text.slice(nl + 1) : text;
      const m = scan.match(PULSE_RE);
      if (m) count += m.length;
      pos += len;
    }
    const tail = leftover.match(PULSE_RE);
    if (tail) count += tail.length;
  } catch { /* ignore */ } finally {
    if (fd >= 0) try { closeSync(fd); } catch {}
  }

  __pulseCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, count });
  return count;
}

/* ─────────────────────────────────────────────────────────────────────
 * aggregateCostFromLogDir — per-dir + per-file mtime-keyed cache over the
 * tailed `{"type":"result"}` lines of every .jsonl in the log dir.
 * ───────────────────────────────────────────────────────────────────── */

export interface CostAggregate { cost: number; inputTokens: number; outputTokens: number }

type CostCacheEntry = { sig: string; expires: number; value: CostAggregate };
const __costCache = __caches.cost;

type CostPerFileEntry = { mtimeMs: number; size: number; cost: number; inputTokens: number; outputTokens: number };
const __costPerFileCache = __caches.costPerFile;

export function aggregateCostFromLogDir(logDir: string, ttlMs = 5000): CostAggregate {
  const now = Date.now();
  let sig = 'no-dir';
  try {
    if (existsSync(logDir)) {
      const st = statSync(logDir);
      sig = `${st.mtimeMs}:${st.size}`;
    }
  } catch {}
  const cached = __costCache.get(logDir);
  if (cached && cached.sig === sig && cached.expires > now) return cached.value;

  const out: CostAggregate = { cost: 0, inputTokens: 0, outputTokens: 0 };
  try {
    if (existsSync(logDir)) {
      for (const f of readdirSync(logDir)) {
        if (!f.endsWith('.jsonl')) continue;
        const fp = join(logDir, f);
        let st: { mtimeMs: number; size: number };
        try { st = statSync(fp); } catch { continue; }
        const perFile = __costPerFileCache.get(fp);
        let row: { cost: number; inputTokens: number; outputTokens: number };
        if (perFile && perFile.mtimeMs === st.mtimeMs && perFile.size === st.size) {
          row = perFile;
        } else {
          const { obj } = tailLastResultLine(fp);
          row = {
            cost: obj ? (Number(obj.total_cost_usd ?? 0) || 0) : 0,
            inputTokens: 0,
            outputTokens: 0,
          };
          if (obj) {
            const usage = obj.usage as { input_tokens?: number; output_tokens?: number } | undefined;
            if (usage) {
              row.inputTokens = Number(usage.input_tokens ?? 0) || 0;
              row.outputTokens = Number(usage.output_tokens ?? 0) || 0;
            }
          }
          __costPerFileCache.set(fp, { mtimeMs: st.mtimeMs, size: st.size, ...row });
        }
        out.cost += row.cost;
        out.inputTokens += row.inputTokens;
        out.outputTokens += row.outputTokens;
      }
    }
  } catch {}
  __costCache.set(logDir, { sig, expires: now + ttlMs, value: out });
  return out;
}

/* ─────────────────────────────────────────────────────────────────────
 * Project lookups
 * ───────────────────────────────────────────────────────────────────── */

/**
 * Inner registry lookup for an EXACT slug — active workspace first, then a
 * cross-workspace safety-net scan (unless the caller PINNED a workspaceId). Pure
 * over the registry; `resolveProject` layers the retired-slug alias on top.
 *
 * Cross-workspace fallback (resolution safety net): a harness is registered in a
 * SPECIFIC workspace, but the active workspace flaps — multiple SU agents + the
 * desktop switch `registry.current` under us, and each harness typically lives in
 * only ONE workspace. Resolving a NAMED slug must not silently 404 just because the
 * active workspace happens not to carry it: every harness route (status / prompts /
 * features / run / …) funnels through here, so without this the operator could only
 * ever touch the *currently-active* workspace's harnesses. Safe because results +
 * the on-disk folder are SHARED by slug (D-1, link-not-move) — whichever workspace
 * carries the slug resolves the same path. Skipped when the caller PINNED a
 * workspace (durable pipelines pass workspaceId): those must stay in their fixed
 * workspace, miss and all.
 */
async function findRegisteredProjectBySlug(
  slug: string,
  workspaceId?: string,
): Promise<ProjectEntry | null> {
  // Pass workspaceId so callers (e.g. a durable pipeline) can resolve in a FIXED
  // workspace rather than the volatile active one — the active workspace can
  // switch mid-flight (desktop UI), which would otherwise break in-flight runs.
  const reg = await loadHarnessRegistry(workspaceId);
  const hit = reg.projects.find((p) => p.slug === slug);
  if (hit) return hit;

  if (workspaceId !== undefined) return null;
  try {
    for (const ws of readRegistry().workspaces) {
      const other = await loadHarnessRegistry(ws.id);
      const match = other.projects.find((p) => p.slug === slug);
      if (match) return match;
    }
  } catch { /* registry unreadable → fall through to null */ }
  return null;
}

export async function resolveProject(
  slug: string,
  workspaceId?: string,
): Promise<ProjectEntry | null> {
  const direct = await findRegisteredProjectBySlug(slug, workspaceId);
  if (direct) return direct;

  // Retired-slug alias fallback (EI-2224). A lingering reference to a RENAMED
  // harness (the retired `papercup` → the registered `papercusp`, 2026-06-19) must
  // SELF-HEAL here rather than 404 every fire / dispatch / spawn into dispatcher
  // darkness. resolveProject is the single chokepoint for both the HTTP-404
  // "unknown project" fire-path (harness-readers / endpoint routes) AND the
  // spawn-rejection path (operator-spawn), so the alias applied here covers them
  // all. We only reach this branch AFTER a direct hit missed, so a genuine
  // registration under the old slug (should one ever exist) still wins.
  const canonical = canonicalHarnessSlug(slug);
  if (canonical !== slug) {
    const aliased = await findRegisteredProjectBySlug(canonical, workspaceId);
    if (aliased) return aliased;
  }
  return null;
}

/** Structured verdict from {@link checkHomeHarnessResolves}. */
export interface HomeHarnessResolutionCheck {
  /** True when the slug resolves to a registered project (directly or via alias). */
  ok: boolean;
  /** The slug that was checked. */
  slug: string;
  /** The registered slug it resolved to, or null when it resolves to nothing. */
  resolvedSlug: string | null;
  /** True when it resolved ONLY via the retired-slug alias (a drift to clean up). */
  aliased: boolean;
  /** Human-readable, loud-enough-to-log explanation. */
  message: string;
}

/**
 * Recurrence guard for EI-2224: verify the configured operator-home harness slug
 * resolves to a registered project. A RENAME that leaves the home pointer
 * (PAPERCUSP_POT_HOME_SLUG) or a fire-path env on the retired slug used to 404
 * SILENTLY at dispatch time and sit dark for hours; surfacing it at BOOT turns a
 * 34h silent outage into a one-line boot failure. Returns a structured verdict and
 * NEVER throws — the caller (boot path) decides whether to console.error / exit /
 * escalate. `aliased: true` means it resolves but only through the deprecated alias
 * (a warn-but-continue), while `ok: false` means it resolves to nothing (fail loud).
 */
export async function checkHomeHarnessResolves(
  slug: string = operatorHomeHarnessSlug(),
  workspaceId?: string,
): Promise<HomeHarnessResolutionCheck> {
  const project = await resolveProject(slug, workspaceId);
  if (!project) {
    return {
      ok: false,
      slug,
      resolvedSlug: null,
      aliased: false,
      message:
        `operator-home harness "${slug}" does not resolve to any registered project — ` +
        `fire-paths, the auto-implement dispatcher, and cup:spawn will all 404 ("unknown project"). ` +
        `Register it, fix ${HOME_HARNESS_ENV}, or add a retired-slug alias in operator-home-harness.ts.`,
    };
  }
  const aliased = project.slug !== slug;
  return {
    ok: true,
    slug,
    resolvedSlug: project.slug,
    aliased,
    message: aliased
      ? `operator-home harness "${slug}" resolved via the retired-slug alias → "${project.slug}". ` +
        `Update the pointer/env to the current slug to retire the alias.`
      : `operator-home harness "${slug}" resolved → "${project.slug}".`,
  };
}

/**
 * Resolve a harness slug → the workspace_id that carries it, via the AUTHORITATIVE
 * harness registry (`harness_shared.harness_registry` — what pot:create /
 * harness:create write and the work-items path reads). This is the de-facto
 * source of truth for the generic/hive world; `harness_shared.projects` is only
 * the org/department blueprint's PROJECTION (business cols owning_dept/vertical/
 * budget; the sole non-test writer is execute-action.ts' project-create), so a
 * non-papercup harness is resolvable HERE but absent THERE. Plan-scope resolution
 * (resolvePlanScope → fill_workspace_id_from_projects) falls back to this so a
 * hive's plans resolve the same way its work-items already do (closes the
 * split-registry asymmetry — peers su-a7f66 / su-632e0166, sibling EI-1511).
 *
 * Deterministic + confined-by-default:
 *   1. ACTIVE-workspace-FIRST — if the active session workspace carries the slug,
 *      return it, so a scoped session resolves its OWN workspace and never a
 *      foreign one (composes with the scoped-superuser workspace clamp, P-017 —
 *      do not turn this into a cross-workspace read vector).
 *   2. else cross-workspace fallback for an UNSCOPED caller — scan every
 *      workspace's registry: exactly one carrier → that workspace; TWO+ → THROW
 *      (a genuine cross-workspace slug collision, never picked silently); none →
 *      null (the caller fails loud).
 */
/**
 * EI-19286551248996972: thrown by {@link resolveWorkspaceForHarnessSlugIn} when the
 * registry could not be READ at all (a dead pool, a statement timeout, a transient
 * PG blip) — as opposed to a genuine, successfully-read "this slug carries no
 * project in any workspace" absence. The two used to be indistinguishable: both
 * paths returned a bare `null`, which every caller (fill_workspace_id_from_projects
 * → resolvePlanScope → plans:list's regex-keyed swallow) treated as authoritative
 * proof of non-registration — so a transient read fault silently became the
 * confident assertion "register the harness", and `plans:list`/`plans:get` returned
 * `ok:true` with an EMPTY result for a harness that in fact carried live rows (960,
 * in the incident that filed this). Deliberately a DISTINCT class (not reusing the
 * generic `Error` `resolveWorkspaceForHarnessSlug:` ambiguous-collision throw two
 * lines below, and deliberately NOT containing the phrases "not registered" / "not a
 * Hive home" that `plans:list`'s regex swallow and `isUnresolvablePlanScopeError`
 * key off of) so it propagates as a LOUD, visible failure through the whole call
 * chain instead of being folded into the same silent-absence handling.
 */
export class RegistryReadUnavailableError extends Error {
  constructor(slug: string, cause: unknown) {
    super(
      `resolveWorkspaceForHarnessSlug: could not READ the harness registry for slug '${slug}' — ` +
        `the read itself failed (a transient DB/pool fault), so registration status is UNKNOWN, not ` +
        `confirmed absent. Retry, or investigate the underlying read failure, before concluding this ` +
        `harness needs registering.` +
        (cause instanceof Error ? ` Underlying: ${cause.message}` : ''),
    );
    this.name = 'RegistryReadUnavailableError';
    this.cause = cause;
  }
}

export async function resolveWorkspaceForHarnessSlug(slug: string): Promise<string | null> {
  return resolveWorkspaceForHarnessSlugIn(activeWorkspaceId(), slug);
}

/**
 * The explicit-`preferredWs` core of {@link resolveWorkspaceForHarnessSlug}: resolve
 * a harness slug → its workspace, checking `preferredWs` FIRST (so a scoped caller
 * resolves its OWN workspace and never a foreign one), then the collision-aware
 * cross-workspace fallback. Same deterministic + confined-by-default contract as
 * resolveWorkspaceForHarnessSlug (which is just this with `preferredWs = activeWorkspaceId()`).
 *
 * Exposed separately because the scoped-superuser dispatch clamp (P-017) must
 * resolve a per-call `harness` arg's workspace BEFORE the request-scoped ALS is
 * pinned to the clamped workspace — so it can't rely on `activeWorkspaceId()` and
 * passes the session's clamped `ctx.workspaceId` explicitly (mirrors the hive-tier
 * clamp, which likewise hands `ctx.workspaceId` to potHomeSlugForHarness).
 */
export async function resolveWorkspaceForHarnessSlugIn(
  preferredWs: string,
  slug: string,
): Promise<string | null> {
  const raw = slug?.trim();
  if (!raw) return null;
  // EI-19286551248996972: track whether either read GENUINELY FAILED (as opposed to
  // succeeding and legitimately finding nothing) — a failure here must never be
  // indistinguishable from a confirmed absence (see RegistryReadUnavailableError's
  // doc above for the incident this closes).
  let preferredReadFailed: unknown;
  let crossWsReadFailed: unknown;
  // 1. Preferred-workspace-first (confined by default).
  try {
    const reg = await loadHarnessRegistry(preferredWs);
    if (reg.projects.some((p) => p.slug === raw)) return preferredWs;
  } catch (e) {
    preferredReadFailed = e; // fall through to the cross-ws scan
  }
  // 2. Cross-workspace fallback — collision-aware.
  const carriers = new Set<string>();
  try {
    for (const ws of readRegistry().workspaces) {
      if (ws.id === preferredWs) continue; // already checked in step 1
      const reg = await loadHarnessRegistry(ws.id);
      if (reg.projects.some((p) => p.slug === raw)) carriers.add(ws.id);
    }
  } catch (e) {
    crossWsReadFailed = e; // treat as no cross-ws carriers OBSERVED (not confirmed absent)
  }
  if (carriers.size === 0) {
    // EI-19286551248996972: nothing was found — but if EITHER leg never actually
    // completed a read, "nothing was found" is not the same claim as "we looked
    // everywhere and confirmed absence". Throw a distinguishable error rather than
    // returning the same `null` a genuine absence returns.
    if (preferredReadFailed !== undefined || crossWsReadFailed !== undefined) {
      throw new RegistryReadUnavailableError(raw, preferredReadFailed ?? crossWsReadFailed);
    }
    return null;
  }
  if (carriers.size > 1) {
    throw new Error(
      `resolveWorkspaceForHarnessSlug: harness slug '${raw}' is registered in ` +
        `${carriers.size} workspaces (${[...carriers].join(', ')}) and none is the preferred ` +
        `workspace ('${preferredWs}'). Ambiguous cross-workspace collision — pass an explicit ` +
        `workspaceId to disambiguate.`,
    );
  }
  return [...carriers][0]!;
}

export function harnessDir(project: ProjectEntry): string {
  return join(project.path, '.papercusp');
}

export function safeRead(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

/* ─────────────────────────────────────────────────────────────────────
 * Liveness — walk /proc looking for a harness driver process whose
 * cwd lives under projectPath. Cached for 2s; concurrent requests share
 * one walk via the cached value.
 * ───────────────────────────────────────────────────────────────────── */

/**
 * Single source of truth for "is this cmdline a harness driver process?".
 *
 * Matches the legacy bash driver: `autonomous-harness/run.sh` or
 * `/harness/run.sh`. (The TS-orchestrator `orchestrator/bin/run.ts` cmdline
 * match was removed 2026-06-06 — that entrypoint was archived with the legacy
 * run-loop; the live pipeline is the DBOS orchestrator, which runs in-process
 * and is not a separate driver process.)
 */
export function isHarnessDriverCmdline(cmdline: string): boolean {
  return (
    cmdline.includes('autonomous-harness/run.sh') ||
    cmdline.includes('/harness/run.sh')
  );
}

function scanForRunShCwd(projectPath: string): boolean {
  try {
    const procs = readdirSync('/proc');
    for (const pid of procs) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const cwd = readlinkSync(`/proc/${pid}/cwd`);
        if (!cwd.startsWith(projectPath)) continue;
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (isHarnessDriverCmdline(cmdline)) return true;
      } catch { /* perm-denied PID — skip */ }
    }
  } catch { /* /proc unreadable — fall through */ }
  return false;
}

type AliveCacheEntry = { value: boolean; expires: number; pending: Promise<boolean> | null };
const __aliveCache = __caches.alive;

export function isProjectAlive(projectPath: string, ttlMs = 2000): boolean {
  const now = Date.now();
  const cached = __aliveCache.get(projectPath);
  if (cached && cached.expires > now) return cached.value;
  const value = scanForRunShCwd(projectPath);
  __aliveCache.set(projectPath, { value, expires: now + ttlMs, pending: null });
  return value;
}

/* ─────────────────────────────────────────────────────────────────────
 * parseFeatures — read harness_features from the per-harness PG schema.
 * ───────────────────────────────────────────────────────────────────── */

export function rowToFeature(r: any): any {
  return {
    id: r.feature_id,
    title: r.title,
    summary: r.summary ?? undefined,
    status: r.status,
    attempts: typeof r.attempts === 'bigint' ? Number(r.attempts) : r.attempts,
    claims: r.claims ? (typeof r.claims === 'string' ? JSON.parse(r.claims) : r.claims) : undefined,
    notes: r.notes ?? undefined,
    metadata: r.metadata ?? undefined,
    kind: r.kind ?? undefined,
    project_id: r.project_id ?? undefined,
    expected_cost_cents: r.expected_cost_cents == null ? undefined : (typeof r.expected_cost_cents === 'bigint' ? Number(r.expected_cost_cents) : r.expected_cost_cents),
    tags: r.tags ?? undefined,
    needs_human_review: !!r.needs_human_review,
    ts: r.ts == null ? undefined : (typeof r.ts === 'bigint' ? Number(r.ts) : r.ts),
    deprecation_reason: r.deprecation_reason ?? undefined,
    // G1 Provenance (P-004): expose origin + author_pubkey so G2 (auditor) and
    // the UI can read the "is this mine?" signal. Rows inserted before migration
    // 097 have origin='local' by default (via column DEFAULT).
    origin: (r.origin as 'local' | 'remote') ?? 'local',
    author_pubkey: r.author_pubkey ?? null,
  };
}

export type ParseFeaturesProjection = 'full' | 'stream';

export type ParseFeaturesOptions = {
  /**
   * `stream` keeps the legacy Run-view contract while skipping heavyweight
   * detail columns (notably notes and metadata) that the stream drops before
   * serialization. The default remains `full` for existing callers.
   */
  projection?: ParseFeaturesProjection;
};

export const STREAM_FEATURE_SELECT_COLUMNS = [
  'feature_id',
  'title',
  'summary',
  'status',
  'attempts',
  'claims',
  'project_id',
  'tags',
].join(', ');

export async function parseFeatures(
  project: ProjectEntry,
  opts: ParseFeaturesOptions = {},
): Promise<any[]> {
  try {
    const columns = opts.projection === 'stream' ? STREAM_FEATURE_SELECT_COLUMNS : '*';
    const rows = await harnessQuery(project.slug, (sql) => sql.unsafe(`
      SELECT ${columns} FROM harness_features WHERE harness_slug = $1 ORDER BY feature_id
    `, [project.slug])) as any[];
    return rows.map(rowToFeature);
  } catch {
    return [];
  }
}

/* ─────────────────────────────────────────────────────────────────────
 * tailFile — read only the last `maxBytes` of a file via openSync +
 * readSync(offset). Avoids the readFileSync().slice() whole-file alloc.
 * ───────────────────────────────────────────────────────────────────── */

export function tailFile(path: string, maxBytes = 64 * 1024): string {
  let fd = -1;
  try {
    const stat = statSync(path);
    if (stat.size === 0) return '';
    if (stat.size <= maxBytes) return readFileSync(path, 'utf8');
    const len = maxBytes;
    const start = stat.size - len;
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd >= 0) try { closeSync(fd); } catch {}
  }
}

/* ─────────────────────────────────────────────────────────────────────
 * Phase resolution — ?phase= routes pick a sibling worktree.
 * ───────────────────────────────────────────────────────────────────── */

export async function resolvePhasedProject(slug: string, phase: Phase | undefined): Promise<ProjectEntry | null> {
  const base = await resolveProject(slug);
  if (!base) return null;
  if (!phase || phase === 'staging') return base;
  // When the harness-phases flag is OFF, treat every phase as the base
  // project. The phase-suffixed worktrees (sheets-clone--production etc.)
  // only exist for users who explicitly opted into phases — for everyone
  // else, "production" is just a UI label, not a separate worktree.
  const { getFlag } = await import('@papercusp/flags/server');
  const { FLAGS } = await import('@papercusp/flags');
  const phasesEnabled = await getFlag(FLAGS.HARNESS_PHASES, 'system');
  if (!phasesEnabled) return base;
  const p = phasePath(base, phase);
  return { ...base, path: p };
}

/* ─────────────────────────────────────────────────────────────────────
 * getHarnessStatusFull — rich status payload (project + features + cost
 * + liveness + checkpoints + escalation). Shared between desktop and
 * mobile harness-status routes so both see the same shape.
 * ───────────────────────────────────────────────────────────────────── */

export async function getHarnessStatusFull(
  slug: string,
  phaseOverride?: Phase,
  opts?: { includeFeatures?: boolean },
): Promise<Record<string, unknown> | null> {
  // whole-app-sync-payload-audit P-008: the `features` array is the entire weight of
  // this payload — measured 20.6MB (20,228 features) on the /harness/:slug/status
  // route, 2.2s to serialize. The two HTTP boundaries that call this (harness/status.ts,
  // device/harnesses.ts) have NO live consumer that renders the raw array (the desktop
  // route's only reader is the RETIRED apps-web HarnessDashboard; the device UI works off
  // the aggregate `counts`, as its slim list route already proves) — a per-feature UI must
  // use the dedicated, already-slimmed `featuresConsolidated.*` query (P-001's guidance),
  // never this dashboard snapshot. So both routes pass includeFeatures:false to drop the
  // array off the wire. Default stays `true` so the shared function's contract is unchanged
  // for any other/future caller. `counts` (derived from features) is ALWAYS returned.
  const includeFeatures = opts?.includeFeatures ?? true;
  const project = await resolvePhasedProject(slug, phaseOverride);
  if (!project) return null;

  const features = await parseFeatures(project);
  const counts = features.reduce((acc, f) => {
    acc[f.status] = (acc[f.status] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const runLogPath = join(harnessDir(project), 'logs', 'run.log');
  const runLog = tailFile(runLogPath, 16 * 1024);
  const decisionMatch = [...runLog.matchAll(/ORCH decision: (\S[^\n]*)/g)];
  const lastDecision = decisionMatch.length ? decisionMatch[decisionMatch.length - 1][1] : null;
  const iteration = countPulsesFromRunLog(runLogPath);
  const escalation = safeRead(join(harnessDir(project), 'escalation.md'));
  const __agg = aggregateCostFromLogDir(join(harnessDir(project), 'logs'));
  const alive = isProjectAlive(project.path);

  let pendingCheckpoints = 0;
  let activeCompetitions = 0;
  let smokeFail = false;
  try {
    const hd = harnessDir(project);
    if (existsSync(hd)) {
      for (const f of readdirSync(hd)) {
        if (/^checkpoint-[A-Za-z0-9_.-]+\.md$/.test(f) && !existsSync(join(hd, `${f}.granted`))) {
          pendingCheckpoints += 1;
        }
        if (/^competition-[A-Za-z0-9_.-]+\.json$/.test(f)) {
          activeCompetitions += 1;
        }
      }
      smokeFail = existsSync(join(hd, 'smoke-failure.md'));
    }
  } catch {}

  let discord_channel_url: string | null = null;
  try {
    const sharedRaw = safeRead(join(project.path, HARNESS_SHARED_CONFIG_REL_PATH));
    if (sharedRaw) {
      const parsed: unknown = JSON.parse(sharedRaw);
      if (isHarnessSharedConfig(parsed) && parsed.discord_channel) {
        discord_channel_url = parsed.discord_channel;
      }
    }
  } catch {}

  return {
    project: { slug: project.slug, path: project.path },
    // P-008: omit the 20MB features array unless explicitly requested (see the
    // includeFeatures note above). `counts` below carries the per-status totals.
    ...(includeFeatures ? { features } : {}),
    counts,
    iteration,
    lastDecision,
    alive,
    escalated: escalation != null,
    pendingCheckpoints,
    activeCompetitions,
    smokeFail,
    missionCostUsd: __agg.cost,
    missionInputTokens: __agg.inputTokens,
    missionOutputTokens: __agg.outputTokens,
    discord_channel_url,
  };
}
