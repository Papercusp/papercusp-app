/**
 * Resolve `AgentSignals` from ACTIONS — context-injection-audit-2026-07-28 P-043 (F-K).
 *
 * WHY THIS EXISTS. P-042 widened the injection seam to carry
 * `{ userText, agentSignals? }` but left `agentSignals` unpopulated. This module
 * populates it, from the three v1 sources in the item's preference order:
 *
 *   (a) the claimed work-item / plan-item title+body — already structured,
 *       already scoped to the agent's real task, and free;
 *   (b) the recent tool-call trajectory — file paths touched, work-item ids,
 *       symbol names;
 *   (c) the active file.
 *
 * ⚠ WHICH LEG THIS FEEDS, because it is NOT the obvious one. P-044 routed these
 * signals to the LEXICAL leg only — `retrievalQueryText()` still ignores them
 * and a tripwire in recall-query.test.ts pins that, permanently. The cosine leg
 * embeds its query as ONE vector, and D-041 measured identifiers pulling that
 * vector off-topic, so folding these into the cosine query is the bug, not the
 * finishing touch. The composition (and its tight per-class caps, which are
 * NOT the caps below) lives in `recall-query.ts`'s `lexicalQueryText`.
 *
 * Live at `turn-start-memory.ts` via `resolveAgentSignalsForOwner` at the
 * bottom of this file.
 *
 * ══ THE DESIGN POINT: DEFAULT-DENY, IDENTIFIERS ONLY ══
 *
 * P-043 excludes the agent's own prose and thinking summaries from v1, and that
 * exclusion is the whole point rather than timidity: prose is what creates the
 * self-confirmation loop — the agent asserts X, retrieval returns X, the agent
 * asserts more X — whereas actions are grounded in verifiable events the agent
 * cannot talk itself into.
 *
 * So extraction is an ALLOWLIST of identifier-bearing argument keys, never a
 * denylist of prose-bearing ones. That direction is load-bearing, because the
 * agent's richest prose reaches `tool_invocations` as ORDINARY TOOL ARGUMENTS:
 * `loop:checkpoint` writes `{did, left, insight, next}`, `work_items:checkpoint`
 * writes a narrative body, `coord:orient` writes a free-text `intent`. Under a
 * denylist every one of those is a prose leak waiting for someone to forget a
 * key; under an allowlist they are simply never read. When adding a key here,
 * the test to apply is "is this value an IDENTIFIER (a path, an id, a symbol) or
 * could it be a sentence?" — and free-prose fields belong to P-047, which
 * settles the prose question on bench evidence.
 *
 * ══ WHERE THE TRAJECTORY ACTUALLY LIVES (measured, 2026-07-28) ══
 *
 * Non-obvious and worth stating, because reading the wrong layer yields almost
 * nothing: `harness_shared.tool_invocations` is dominated by `activity:report`
 * — the PostToolUse hook's telemetry wrapper — and the agent's real
 * file-touching calls are NESTED INSIDE it, not top-level rows. Over a 2h live
 * window: 3,970 `activity:report` rows carrying inner `Bash` (1,660), `Edit`
 * (469), `Read` (384) and `Write` (110) calls, whose `tool_input.file_path` is
 * the actual path signal. A resolver that only read top-level `tool_name` would
 * see coordination plumbing and conclude the signal was absent.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Sql } from 'postgres';
import type { AgentSignals } from './recall-query';
import { withMemoryTimeout, MemoryTimeoutError } from './op-deadline';

/** One `harness_shared.tool_invocations` row, reduced to what extraction needs. */
export interface RawInvocation {
  /** The row's `tool_name` — may be the `activity:report` wrapper. */
  toolName: string;
  /** The row's `args_json`. */
  args?: unknown;
}

/** The claimed work-item, as stored (authored text — never agent narration). */
export interface ClaimedItem {
  id?: string | null;
  title?: string | null;
  body?: string | null;
}

// ─────────────────────────────── caps ───────────────────────────────
// How much SIGNAL this resolver carries. Ordered most-recent-first (the caller
// passes rows newest first and extraction preserves that order, so a cap keeps
// the RECENT end).
//
// ⚠ NOT the query budget. `recall-query.ts` applies its OWN, much tighter caps
// (4/4/2) to what may enter the scored lexical query, because that score is
// normalized by query-token count — see LEXICAL_MAX_PATHS there. Widening these
// does not widen that, and it should not: the two bound different things.

/** Max distinct file paths carried. */
export const MAX_PATHS = 12;
/** Max distinct work-item / plan-item ids carried. */
export const MAX_IDS = 8;
/** Max distinct symbol names carried. */
export const MAX_SYMBOLS = 8;
/**
 * Max chars scanned inside a single free-form string value (a Bash `command`).
 * Bounds the work; a `Write` payload can be a whole file.
 */
export const MAX_SCAN_CHARS = 4_000;
/**
 * Work-item body clamp. The body is authored text and can run to thousands of
 * chars; the consumer (P-044) may clamp further, but an unbounded body flowing
 * into a query is a footgun the resolver should not hand off.
 */
export const MAX_BODY_CHARS = 1_200;

/** Default trajectory lookback. Long enough to span a turn's real work, short
 *  enough that yesterday's unrelated task does not bleed in. */
export const DEFAULT_LOOKBACK_MINUTES = 45;
/** Default rows fetched. `activity:report` is chatty — see the header note. */
export const DEFAULT_INVOCATION_LIMIT = 200;
/** Resolver deadline. Signals are a best-effort enhancement to a hot per-turn
 *  path; missing them must never delay a turn. */
export const DEFAULT_RESOLVE_DEADLINE_MS = 1_500;

// ───────────────────────── key allowlists ─────────────────────────
// Matched against LOWERCASED argument keys (see `keyOf`).

/** Keys whose value is a filesystem path (or an array of them). */
const PATH_KEYS: ReadonlySet<string> = new Set([
  'file_path',
  'filepath',
  'path',
  'paths',
  'notebook_path',
  'notebookpath',
]);

/** Keys whose value names a work-item / plan-item / plan. */
const ID_KEYS: ReadonlySet<string> = new Set([
  'id',
  'ids',
  'item',
  'itemid',
  'itemids',
  'work_item_id',
  'workitemid',
  'slug',
  'target',
  'targetid',
  'ref',
  'refid',
  'related_msg_id',
]);

/** Keys whose value may name a code symbol. Value must ALSO pass the strict
 *  identifier shape — `name` is a real symbol on `gitnexus.context` but a
 *  colon-form tool name on `tools:invoke`, and the shape check separates them. */
const SYMBOL_KEYS: ReadonlySet<string> = new Set(['symbol', 'symbolname', 'name', 'pattern']);

/**
 * Keys holding a free-form command line. TOKEN-SCANNED ONLY: matched paths and
 * ids are extracted, the text itself is never carried. Safe under the
 * default-deny rule because the OUTPUT is identifiers regardless of the input.
 */
const SCAN_KEYS: ReadonlySet<string> = new Set(['command']);

/** Inner tools that indicate the agent is WRITING a file — the strongest
 *  evidence of "the file I am working in" for `activeFile`. */
const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'edit',
  'write',
  'multiedit',
  'notebookedit',
]);

/** Inner tools that READ a named file. Weaker evidence than a write, but still
 *  a file the agent deliberately opened — unlike a path merely named on a
 *  command line. Any OTHER tool's `file_path` is treated as a mention. */
const READ_TOOLS: ReadonlySet<string> = new Set(['read', 'notebookread']);

// ─────────────────────────── regexes ───────────────────────────

/** `WI-6635`, `EI-18881202063786528`, `P-042`. Anchored to token boundaries so a
 *  substring inside a longer identifier is not harvested. */
const ID_RE = /\b(?:WI|EI)-\d{1,24}\b|\bP-\d{3,}\b/g;

/**
 * A path-shaped token inside a command line: at least one `/` and a file
 * extension, which excludes bare words and most prose.
 *
 * ⚠ THE LEADING `/` IS PART OF THE MATCH, and it is not cosmetic. Without it
 * this regex silently STRIPPED the character that makes the non-repo exclusion
 * work: `/tmp/claude-1000/…/out.log` matched as `tmp/claude-1000/…/out.log`,
 * which `relativizeRepoPath` then read as an ordinary REPO-RELATIVE path — so
 * `NON_REPO_ABS_RE` never saw an absolute path to reject and every scratch
 * file, log tail and /proc read an agent had grepped was harvested as if it
 * were repo work. Measured live 2026-08-02 before the fix: 3 of the 4
 * most-recent paths for a real session were /tmp scratch files. Harmless while
 * nothing consumed the trajectory; not harmless once P-044 spends a 4-path
 * query budget on them.
 */
const PATH_TOKEN_RE = /\/?(?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z][\w]{0,5}\b/g;

/** A plausible code symbol: identifier chars only, ≥3 long, not all-lowercase
 *  prose like "true". Deliberately strict — a false symbol is pure query noise. */
const STRICT_IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]{2,63}$/;

/** Absolute paths outside the repo that are never repo artifacts. */
const NON_REPO_ABS_RE = /^\/(?:tmp|proc|sys|dev|etc|var|run|usr|bin|sbin|lib|opt)\//;

// ─────────────────────── small helpers ───────────────────────

const keyOf = (k: string): string => k.toLowerCase();

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Push unique, non-empty values, preserving first-seen (= most recent) order. */
function pushUnique(into: string[], seen: Set<string>, value: string, cap: number): void {
  if (into.length >= cap) return;
  const v = value.trim();
  if (!v || seen.has(v)) return;
  seen.add(v);
  into.push(v);
}

/**
 * Normalize a path to repo-relative, or return null if it is not a repo
 * artifact. Only repo-relative paths survive, on purpose: an absolute path
 * outside the tree (a /tmp log, a systemd unit) will never match text in the
 * memory corpus, so carrying it is pure query noise.
 */
export function relativizeRepoPath(raw: string, repoRoot?: string): string | null {
  let p = raw.trim();
  if (!p) return null;
  // Strip a file:// scheme and any surrounding quotes a command line may carry.
  p = p.replace(/^file:\/\//, '').replace(/^['"]|['"]$/g, '');
  if (repoRoot) {
    const root = repoRoot.endsWith('/') ? repoRoot : `${repoRoot}/`;
    if (p.startsWith(root)) p = p.slice(root.length);
  }
  if (p.startsWith('/')) {
    // Still absolute — outside the repo (or repoRoot unknown).
    if (NON_REPO_ABS_RE.test(p)) return null;
    return null;
  }
  if (p.startsWith('./')) p = p.slice(2);
  if (!p || p === '.' || p.startsWith('..')) return null;
  // Dependency trees and build output are not the agent's work. `build` is
  // deliberately NOT excluded — this repo has source dirs by that name, and a
  // false exclusion silently drops real signal.
  if (/(?:^|\/)(?:node_modules|\.git|dist|coverage)(?:\/|$)/.test(p)) return null;
  return p;
}

/** Levels to walk up looking for a repo root. Mirrors detect-harness-slug's. */
const MAX_ROOT_WALK_DEPTH = 32;

/** Memoized per cwd — the same handful of session cwds recur every turn. */
const repoRootCache = new Map<string, string | undefined>();

/**
 * The repo root containing `cwd`, by walking up to the nearest `.git`.
 *
 * ⚠ NOT OPTIONAL PLUMBING — without it this resolver harvests almost nothing
 * (P-044). `relativizeRepoPath` drops any path it cannot make repo-relative, and
 * the agent tools that carry the strongest path signal REQUIRE an absolute
 * `file_path` (Read, Edit, Write all do), so in production essentially every
 * trajectory path arrives absolute. With no root every one of them relativizes
 * to null and `trajectory.paths` comes back empty — a resolver that looks like
 * it is working and silently returns nothing.
 *
 * A WRONG root is fail-safe in the same direction (paths outside it are
 * dropped, never mis-attributed), so a miss costs recall, never correctness.
 */
export function resolveRepoRootSync(cwd: string | undefined): string | undefined {
  const start = (cwd ?? '').trim();
  if (!start || !path.isAbsolute(start)) return undefined;
  const cached = repoRootCache.get(start);
  if (cached !== undefined || repoRootCache.has(start)) return cached;

  let dir = start;
  let found: string | undefined;
  for (let i = 0; i < MAX_ROOT_WALK_DEPTH; i++) {
    try {
      // `.git` is a DIRECTORY in a normal checkout and a FILE in a submodule or
      // worktree — `existsSync` covers both, and this tree is full of the latter.
      if (fs.existsSync(path.join(dir, '.git'))) {
        found = dir;
        break;
      }
    } catch {
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (repoRootCache.size > 256) repoRootCache.clear();
  repoRootCache.set(start, found);
  return found;
}

/**
 * The tool a row actually represents. `activity:report` is the PostToolUse
 * telemetry wrapper — its `tool_name`/`tool_input` carry the REAL call, which is
 * where Read/Edit/Write/Bash live (see the header note). Returns a normalized
 * lowercase tool name plus the real arguments.
 */
export function effectiveCall(inv: RawInvocation): { tool: string; input: unknown } | null {
  const outer = normalizeToolName(inv.toolName);
  if (outer === 'activity_report') {
    const args = asRecord(inv.args);
    if (!args) return null;
    const inner = typeof args.tool_name === 'string' ? args.tool_name : '';
    if (!inner) return null;
    return { tool: normalizeToolName(inner), input: args.tool_input };
  }
  return { tool: outer, input: inv.args };
}

/**
 * Normalize a tool name to a comparable form: strip the MCP client mangling
 * (`mcp__papercusp-su__work_items_get`) and fold `:` to `_`, so the colon form
 * every doc writes (`work_items:get`) and the mangled form the hook records
 * compare equal.
 */
export function normalizeToolName(name: string): string {
  const bare = name.replace(/^mcp__.*?__/, '');
  return bare.replace(/[:.]/g, '_').toLowerCase();
}

// ───────────────────── the pure extraction core ─────────────────────

interface Acc {
  paths: string[];
  ids: string[];
  symbols: string[];
  pathSeen: Set<string>;
  idSeen: Set<string>;
  symbolSeen: Set<string>;
  activeFile?: string;
  /** Set once a WRITE-class call has supplied `activeFile` — a later read must
   *  not downgrade it. */
  activeFileFromWrite: boolean;
}

function harvestIds(acc: Acc, text: string): void {
  const scan = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
  for (const m of scan.matchAll(ID_RE)) {
    pushUnique(acc.ids, acc.idSeen, m[0], MAX_IDS);
  }
}

/**
 * How a path was observed — this decides `activeFile` eligibility.
 *
 *   `write`   an Edit/Write `file_path` — the agent is working IN it.
 *   `read`    a Read `file_path` — browsing; fills the slot only until a
 *             write appears.
 *   `mention` a path parsed out of a command line, or a lock claim. Evidence of
 *             TOUCHING, never of working-in — a `rg` or a test run names a file
 *             without the agent editing it, so a mention is never eligible for
 *             `activeFile` even when it is the only path seen.
 */
type PathKind = 'write' | 'read' | 'mention';

function harvestPath(acc: Acc, raw: string, repoRoot: string | undefined, kind: PathKind): void {
  const rel = relativizeRepoPath(raw, repoRoot);
  if (!rel) return;
  // Rows arrive newest-first, so the first write seen wins and nothing older may
  // override it.
  if (kind !== 'mention' && (!acc.activeFile || (kind === 'write' && !acc.activeFileFromWrite))) {
    acc.activeFile = rel;
    if (kind === 'write') acc.activeFileFromWrite = true;
  }
  pushUnique(acc.paths, acc.pathSeen, rel, MAX_PATHS);
}

/** Walk one call's arguments under the key allowlists. Depth-bounded. */
function harvestArgs(
  acc: Acc,
  value: unknown,
  repoRoot: string | undefined,
  pathKind: PathKind,
  depth = 0,
): void {
  if (depth > 3) return;
  const rec = asRecord(value);
  if (!rec) return;
  for (const [rawKey, v] of Object.entries(rec)) {
    const key = keyOf(rawKey);
    const values: unknown[] = Array.isArray(v) ? v.slice(0, 32) : [v];

    if (PATH_KEYS.has(key)) {
      for (const item of values) {
        if (typeof item === 'string') harvestPath(acc, item, repoRoot, pathKind);
      }
      continue;
    }
    if (ID_KEYS.has(key)) {
      for (const item of values) {
        if (typeof item === 'string') harvestIds(acc, item);
      }
      continue;
    }
    if (SYMBOL_KEYS.has(key)) {
      for (const item of values) {
        if (typeof item === 'string' && STRICT_IDENT_RE.test(item.trim())) {
          pushUnique(acc.symbols, acc.symbolSeen, item, MAX_SYMBOLS);
        }
      }
      continue;
    }
    if (SCAN_KEYS.has(key)) {
      for (const item of values) {
        if (typeof item !== 'string') continue;
        const scan = item.length > MAX_SCAN_CHARS ? item.slice(0, MAX_SCAN_CHARS) : item;
        harvestIds(acc, scan);
        for (const m of scan.matchAll(PATH_TOKEN_RE)) {
          harvestPath(acc, m[0], repoRoot, 'mention');
        }
      }
      continue;
    }
    // Not an allowlisted key. Recurse into nested objects ONLY (an allowlisted
    // key may sit one level down), never harvest this value itself.
    if (asRecord(v)) harvestArgs(acc, v, repoRoot, pathKind, depth + 1);
  }
}

/**
 * Extract the trajectory + active file from recent invocations.
 *
 * `invocations` MUST be ordered NEWEST FIRST — the caps keep the head of each
 * list, and `activeFile` resolves to the most recent write.
 */
export function extractTrajectory(
  invocations: readonly RawInvocation[],
  opts: { repoRoot?: string } = {},
): { trajectory?: AgentSignals['trajectory']; activeFile?: string } {
  const acc: Acc = {
    paths: [],
    ids: [],
    symbols: [],
    pathSeen: new Set(),
    idSeen: new Set(),
    symbolSeen: new Set(),
    activeFileFromWrite: false,
  };

  for (const inv of invocations) {
    const call = effectiveCall(inv);
    if (!call) continue;
    const pathKind: PathKind = WRITE_TOOLS.has(call.tool)
      ? 'write'
      : READ_TOOLS.has(call.tool)
        ? 'read'
        : 'mention';
    harvestArgs(acc, call.input, opts.repoRoot, pathKind, 0);
  }

  const trajectory: NonNullable<AgentSignals['trajectory']> = {};
  if (acc.paths.length) trajectory.paths = acc.paths;
  if (acc.ids.length) trajectory.ids = acc.ids;
  if (acc.symbols.length) trajectory.symbols = acc.symbols;

  const out: { trajectory?: AgentSignals['trajectory']; activeFile?: string } = {};
  if (Object.keys(trajectory).length) out.trajectory = trajectory;
  if (acc.activeFile) out.activeFile = acc.activeFile;
  return out;
}

/**
 * Assemble `AgentSignals` from the three v1 sources. PURE — no IO.
 *
 * Returns `undefined` (not an empty object) when nothing was resolved, so a
 * caller can carry `agentSignals` as genuinely absent and P-044/P-046 can test
 * "were signals available for this turn?" without inspecting field-by-field.
 */
export function buildAgentSignals(input: {
  claimedItem?: ClaimedItem | null;
  invocations?: readonly RawInvocation[];
  repoRoot?: string;
}): AgentSignals | undefined {
  const signals: AgentSignals = {};

  const item = input.claimedItem;
  if (item) {
    const workItem: NonNullable<AgentSignals['workItem']> = {};
    const id = (item.id ?? '').trim();
    const title = (item.title ?? '').trim();
    const body = (item.body ?? '').trim();
    if (id) workItem.id = id;
    if (title) workItem.title = title;
    if (body) workItem.body = body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) : body;
    if (Object.keys(workItem).length) signals.workItem = workItem;
  }

  if (input.invocations?.length) {
    const { trajectory, activeFile } = extractTrajectory(input.invocations, {
      ...(input.repoRoot ? { repoRoot: input.repoRoot } : {}),
    });
    if (trajectory) signals.trajectory = trajectory;
    if (activeFile) signals.activeFile = activeFile;
  }

  return Object.keys(signals).length ? signals : undefined;
}

// ─────────────────────────── the IO shell ───────────────────────────

/**
 * Where the resolver's two reads come from. A PORT rather than a direct PG
 * dependency, so the resolver's ordering, deadline and never-throws behavior are
 * unit-testable without a database.
 */
export interface AgentSignalsSource {
  /** The item this agent currently holds, or null. */
  claimedItem(): Promise<ClaimedItem | null>;
  /** Recent invocations for this agent, NEWEST FIRST. */
  recentInvocations(): Promise<readonly RawInvocation[]>;
}

/**
 * Statuses meaning the item is FINISHED. A terminal item keeps its `taken_by`
 * — one of the 12 claimed rows measured on 2026-07-28 was already `done` — so
 * without this filter a completed task would keep feeding signals indefinitely,
 * pulling retrieval toward work the agent has moved on from.
 */
const TERMINAL_STATUSES: readonly string[] = [
  'done',
  'closed',
  'resolved',
  'deprecated',
  'dropped',
  'passed',
];

/**
 * The production source: the agent's own claim + its own recent tool calls.
 *
 * Both reads are single-index lookups keyed by the agent's coord owner id
 * (`hfc_taken_by_idx` on `(workspace_id, taken_by) WHERE taken_by IS NOT NULL`,
 * and `tool_invocations_coord_owner_idx` on `(coord_owner_id, invoked_at DESC)`),
 * which is what makes this affordable on the per-turn path.
 *
 * ⚠ CLAIMS LIVE ON `work_items.taken_by`, NOT IN `work_item_claims`. That table
 * is the obvious-looking source and it is a DECOY: measured 2026-07-28 it held
 * ZERO rows table-wide, while `work_items.taken_by` held 12 (11 non-terminal).
 * A resolver reading the claims table returns nothing in production forever,
 * silently — and no unit test with a fake `sql` can catch that, because the
 * query is perfectly well-formed. Verified against live data before landing.
 *
 * ⚠ `expires_at` IS USUALLY NULL — 11 of those 12 rows had no expiry — so an
 * `expires_at > now()` predicate drops nearly every real claim. NULL means "no
 * expiry", not "expired".
 *
 * ⚠ Both queries are workspace-scoped: these tables are multi-tenant, keyed on
 * `(workspace_id, …)`, so a bare owner filter can match another tenant's rows.
 */
export function pgAgentSignalsSource(
  sql: Sql,
  opts: {
    ownerId: string;
    workspaceId: string;
    lookbackMinutes?: number;
    invocationLimit?: number;
  },
): AgentSignalsSource {
  const lookback = opts.lookbackMinutes ?? DEFAULT_LOOKBACK_MINUTES;
  const limit = opts.invocationLimit ?? DEFAULT_INVOCATION_LIMIT;

  return {
    async claimedItem() {
      // Most recent progress first: an agent may legitimately hold several
      // items, and the one it last moved is the one it is working on.
      const rows = (await sql`
        SELECT feature_id AS id, title, summary AS body
        FROM harness_shared.work_items
        WHERE workspace_id = ${opts.workspaceId}
          AND taken_by     = ${opts.ownerId}
          AND status <> ALL (${TERMINAL_STATUSES as string[]})
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY COALESCE(last_progress_at, taken_at) DESC NULLS LAST
        LIMIT 1
      `) as unknown as ReadonlyArray<{
        id: string | null;
        title: string | null;
        body: string | null;
      }>;
      return rows[0] ?? null;
    },

    async recentInvocations() {
      // NEWEST FIRST — `extractTrajectory` depends on this ordering for both
      // its caps and its `activeFile` resolution.
      const rows = (await sql`
        SELECT tool_name, args_json
        FROM harness_shared.tool_invocations
        WHERE coord_owner_id = ${opts.ownerId}
          AND workspace_id   = ${opts.workspaceId}
          AND invoked_at     > now() - make_interval(mins => ${lookback})
        ORDER BY invoked_at DESC
        LIMIT ${limit}
      `) as unknown as ReadonlyArray<{ tool_name: string; args_json: unknown }>;
      return rows.map((r) => ({ toolName: r.tool_name, args: r.args_json }));
    },
  };
}

/**
 * Resolve signals for an agent. NEVER THROWS and is deadline-bounded: signals
 * are a best-effort enhancement to the hot per-turn injection path, so a slow or
 * failing read must degrade to `undefined` (no signals) rather than fail — or
 * materially delay — the turn. Identical posture to `buildClaimRecallBlock`.
 *
 * A partial read still yields signals: if the trajectory read fails but the
 * claimed item resolves, the item alone is returned.
 */
export async function resolveAgentSignals(
  source: AgentSignalsSource,
  opts: { repoRoot?: string; deadlineMs?: number } = {},
): Promise<AgentSignals | undefined> {
  const deadlineMs = opts.deadlineMs ?? DEFAULT_RESOLVE_DEADLINE_MS;
  try {
    const settle = async (): Promise<{
      claimedItem: ClaimedItem | null;
      invocations: readonly RawInvocation[];
    }> => {
      const [itemRes, invRes] = await Promise.allSettled([
        source.claimedItem(),
        source.recentInvocations(),
      ]);
      return {
        claimedItem: itemRes.status === 'fulfilled' ? itemRes.value : null,
        invocations: invRes.status === 'fulfilled' ? invRes.value : [],
      };
    };

    const read =
      deadlineMs > 0
        ? await withMemoryTimeout(settle(), 'agent-signals', deadlineMs)
        : await settle();

    return buildAgentSignals({
      claimedItem: read.claimedItem,
      invocations: read.invocations,
      ...(opts.repoRoot ? { repoRoot: opts.repoRoot } : {}),
    });
  } catch (err) {
    // Swallow deliberately — including the deadline. Signals are optional by
    // construction, and the seam carries `agentSignals?`.
    if (!(err instanceof MemoryTimeoutError) && process.env.NODE_ENV !== 'test') {
      // Non-timeout failures are worth one quiet line; a timeout is expected
      // under load and already bounded.
      console.warn(`[memory] agent-signals resolve failed: ${String(err)}`);
    }
    return undefined;
  }
}

/**
 * The one-call form the injection ENDPOINTS use: resolve this owner's signals
 * from the operator database, given only what a hook already sends.
 *
 * Exists so a route does not have to assemble the PG plumbing itself. That is
 * not only tidiness — `@papercusp/db-org` is a heavy module with a generated
 * schema surface, and a route that imports it directly forces every colocated
 * test to whole-module-mock it, which then breaks the OTHER importers sharing
 * that worker (`agent-mcp/src/tools/harness/get.ts` reads `generated.*` at
 * module scope and dies on a partial mock). Keeping the dependency behind this
 * seam lets a route's test mock THIS module and nothing else.
 *
 * Same posture as `resolveAgentSignals`: never throws, deadline-bounded, and
 * `undefined` on any failure.
 */
export async function resolveAgentSignalsForOwner(opts: {
  ownerId: string;
  workspaceId: string;
  /** The session's cwd, for repo-relative path resolution. */
  cwd?: string;
  deadlineMs?: number;
}): Promise<AgentSignals | undefined> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const repoRoot = resolveRepoRootSync(opts.cwd);
    return await resolveAgentSignals(
      pgAgentSignalsSource(sql, { ownerId: opts.ownerId, workspaceId: opts.workspaceId }),
      {
        ...(repoRoot ? { repoRoot } : {}),
        ...(opts.deadlineMs !== undefined ? { deadlineMs: opts.deadlineMs } : {}),
      },
    );
  } catch {
    // A missing/failed PG handle is the same class as a failed read: no signals.
    return undefined;
  }
}

/**
 * Resolve only the caller's current work-item id for injection ports that do
 * not already carry the full structured agent signals (notably PostToolBatch).
 * This keeps the pointer disambiguation read to the claim query instead of
 * paying for the trajectory query as well. Best-effort and deadline-bounded:
 * a missing scope marker must never suppress or delay the pointer leg.
 */
export async function resolveClaimedWorkItemIdForOwner(opts: {
  ownerId: string;
  workspaceId: string;
  deadlineMs?: number;
}): Promise<string | undefined> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const item = await withMemoryTimeout(
      pgAgentSignalsSource(sql, {
        ownerId: opts.ownerId,
        workspaceId: opts.workspaceId,
      }).claimedItem(),
      'agent-current-work-item',
      opts.deadlineMs ?? 500,
    );
    const id = item?.id?.trim();
    return id || undefined;
  } catch {
    return undefined;
  }
}
