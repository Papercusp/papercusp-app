/**
 * Golden mangle corpus for fuzzy tool-name resolution
 * (plan `fuzzy-tool-name-resolution-2026-07-02`, P-001; consumed by P-003 threshold
 * sweep and P-004's resolver unit table).
 *
 * Each case is `(rawInput -> intendedTool)`: `rawInput` is a tool name a model
 * actually sent (or a deterministic synthesis of the same mangling classes) and
 * `intendedTool` is the canonical `group:verb` catalog name it MEANT.
 *
 * Two populations, deliberately kept apart so a calibration can weight/report them
 * separately:
 *  - `real`      — extracted verbatim from the weak-model (ornith-35b) OMP session
 *                  `session-9662` (2026-07-02), every `Tool … not found` result.
 *  - `synthetic` — generated deterministically (no RNG) from {@link SPINE_TOOLS} by
 *                  separator / prefix / case / typo variants.
 *
 * Real measurement notes (session-9662, 128 tool calls, 77 isError results — most of
 * which are the harness's "Skipped due to queued user message", NOT name errors):
 *  - The plan's "4 literal `tool not found`" undercounts: the raw `not found` results are
 *    16 distinct names. Most (the colon/dash separator classes) are the mangle class this
 *    plan targets.
 *  - The literal phrase also appears inside the tools:find `howToCall` prose
 *    ("If that errors \"tool not found\"…") — that is NOT a failure event.
 *  - Some `not found` calls are NOT recoverable mangles (`todo_write`, `task`, `ast_grep`
 *    are OMP-native tools; `tools_list`/`locks_find` are wrong-verb synonyms, not typos).
 *    They are exported as {@link REAL_NON_MANGLES} for the P-002 adversarial corpus and
 *    must never be auto-resolved.
 *
 * Domain-free: no imports, no registry access — the spine is a snapshot constant so the
 * corpus stays reproducible even as the live catalog grows.
 */

/** Canonical `group:verb` names of the trimmed-session "spine" (the seed surface). */
export const SPINE_TOOLS = [
  'coord:orient',
  'coord:declare-intent',
  'coord:send',
  'coord:inbox',
  'plans:get',
  'plans:items',
  'plans:set-now',
  'plans:set-status',
  'work_items:claim',
  'work_items:complete',
  'work_items:get',
  'work_items:checkpoint',
  'work_items:comment',
  'tools:find',
  'tools:invoke',
  'memory:search',
  'memory:remember',
  'loop:arm',
  'loop:end',
] as const;

export type SpineTool = (typeof SPINE_TOOLS)[number];

export type MangleKind =
  /** wrong/typo'd server prefix (`mcp__papercuss_u_…`) */
  | 'prefix'
  /** `group:verb` sent where the transport form `group_verb` is required (or vice versa) */
  | 'separator'
  /** verb separator `-`↔`_` (`set_now` for `set-now`) */
  | 'verb-separator'
  | 'case'
  /** single-character edit in group or verb */
  | 'typo';

export interface MangleCase {
  readonly id: string;
  readonly rawInput: string;
  /** canonical `group:verb` */
  readonly intendedTool: string;
  readonly source: 'real' | 'synthetic';
  readonly kind: MangleKind;
  readonly note?: string;
}

export interface NonMangleCase {
  readonly id: string;
  readonly rawInput: string;
  /** what the model was reaching for, if that is known; never auto-resolve these */
  readonly reachingFor: string | null;
  readonly why: string;
}

/** OMP client-side prefix for the `papercusp-su` MCP server (dash→underscore by OMP). */
const OMP_PREFIX = 'mcp__papercusp_su_';

// ── real mangles (session-9662) ─────────────────────────────────────────────────────
// Inputs are verbatim tool names from the transcript's toolCall blocks whose toolResult
// read `Tool <name> not found`.
export const REAL_MANGLES: readonly MangleCase[] = [
  { id: 'real-001', rawInput: `${OMP_PREFIX}locks_list`, intendedTool: 'locks:list', source: 'real', kind: 'prefix', note: 'transport form OK; the OMP dash→underscore prefix was not the registered one / tool outside the trimmed set' },
  { id: 'real-002', rawInput: `${OMP_PREFIX}agent_tools_list`, intendedTool: 'agent_tools:list', source: 'real', kind: 'prefix' },
  { id: 'real-003', rawInput: `${OMP_PREFIX}plans_set_now`, intendedTool: 'plans:set-now', source: 'real', kind: 'verb-separator' },
  { id: 'real-004', rawInput: `${OMP_PREFIX}plans:set_now`, intendedTool: 'plans:set-now', source: 'real', kind: 'separator' },
  { id: 'real-005', rawInput: `${OMP_PREFIX}plans:set-now`, intendedTool: 'plans:set-now', source: 'real', kind: 'separator' },
  { id: 'real-006', rawInput: `${OMP_PREFIX}plans:set_status`, intendedTool: 'plans:set-status', source: 'real', kind: 'separator' },
  { id: 'real-007', rawInput: `${OMP_PREFIX}plans:get`, intendedTool: 'plans:get', source: 'real', kind: 'separator' },
  { id: 'real-008', rawInput: 'mcp__papercuss_u_plans:get', intendedTool: 'plans:get', source: 'real', kind: 'prefix', note: 'prefix typo AND colon separator' },
  { id: 'real-009', rawInput: `${OMP_PREFIX}loop:arm`, intendedTool: 'loop:arm', source: 'real', kind: 'separator' },
  { id: 'real-010', rawInput: `${OMP_PREFIX}loop:end`, intendedTool: 'loop:end', source: 'real', kind: 'separator' },
  { id: 'real-011', rawInput: `${OMP_PREFIX}tools:find`, intendedTool: 'tools:find', source: 'real', kind: 'separator' },
  { id: 'real-012', rawInput: `${OMP_PREFIX}tools:invoke`, intendedTool: 'tools:invoke', source: 'real', kind: 'separator' },
  { id: 'real-013', rawInput: `${OMP_PREFIX}work_items:observe`, intendedTool: 'work_items:observe', source: 'real', kind: 'separator' },
];

/**
 * Real `not found` calls that are NOT recoverable mangles. Input for the P-002
 * adversarial corpus: a correct resolver leaves every one of these unresolved.
 */
export const REAL_NON_MANGLES: readonly NonMangleCase[] = [
  { id: 'real-nm-001', rawInput: 'todo_write', reachingFor: null, why: 'OMP-native tool, not in the papercusp catalog' },
  { id: 'real-nm-002', rawInput: `${OMP_PREFIX}tools_list`, reachingFor: null, why: 'wrong-verb synonym (list vs find/agent_tools:list); intent was "show tools loaded" — ambiguous between tools:find and agent_tools:list' },
  { id: 'real-nm-003', rawInput: `${OMP_PREFIX}locks_find`, reachingFor: 'locks:list', why: 'wrong-verb synonym (find vs list), not an edit-distance mangle' },
  { id: 'real-nm-004', rawInput: 'task', reachingFor: null, why: 'client-native Task tool (denied by policy)' },
  { id: 'real-nm-005', rawInput: 'ast_grep', reachingFor: null, why: 'OMP-native tool, not in the papercusp catalog' },
];

// ── synthetic mangles ───────────────────────────────────────────────────────────────

/** Iterative Levenshtein distance (kept local: the corpus must not import the resolver). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** The exact transport (MCP) name of a canonical tool: `group:verb` → `group_verb`. */
export const mcpNameOf = (tool: string): string => tool.replace(':', '_');

function typoVariants(tool: string): string[] {
  const [group, verb] = tool.split(':') as [string, string];
  const out: string[] = [];
  // deletion in the verb (3rd char), transposition in the group (2nd/3rd char),
  // substitution in the verb (last char → 'x'); each yields the transport-form name.
  if (verb.length >= 5) out.push(`${group}_${verb.slice(0, 2)}${verb.slice(3)}`);
  if (group.length >= 5) out.push(`${group[0]}${group[2]}${group[1]}${group.slice(3)}_${verb}`);
  if (verb.length >= 5) out.push(`${group}_${verb.slice(0, -1)}x`);
  return out;
}

function separatorVariants(tool: string): { raw: string; kind: MangleKind }[] {
  const [group, verb] = tool.split(':') as [string, string];
  const out: { raw: string; kind: MangleKind }[] = [
    { raw: tool, kind: 'separator' }, // colon form where transport form is required
    { raw: `${group}-${verb}`, kind: 'separator' },
    { raw: `${group}.${verb}`, kind: 'separator' },
    { raw: `${group}/${verb}`, kind: 'separator' },
    { raw: `${OMP_PREFIX}${tool}`, kind: 'separator' },
  ];
  if (verb.includes('-')) {
    out.push({ raw: `${group}_${verb.replaceAll('-', '_')}`, kind: 'verb-separator' });
    out.push({ raw: `${OMP_PREFIX}${group}_${verb.replaceAll('-', '_')}`, kind: 'verb-separator' });
  }
  if (group.includes('_')) out.push({ raw: `${group.replaceAll('_', '-')}_${verb}`, kind: 'separator' });
  return out;
}

function prefixVariants(tool: string): string[] {
  const m = mcpNameOf(tool);
  return [
    `mcp__papercusp-su__${tool}`, // real prefix, colon body
    `mcp__papercuss_su_${m}`, // prefix typo
    `mcp_papercusp_su_${m}`, // single-underscore mcp
    `papercusp-su__${m}`, // dropped `mcp__`
  ];
}

function caseVariants(tool: string): string[] {
  const m = mcpNameOf(tool);
  return [m.toUpperCase(), m.replace(/(^|_)([a-z])/g, (_x, p: string, c: string) => p + c.toUpperCase())];
}

/**
 * Build the synthetic set. A case is kept only if the mangle is (a) not already an exact
 * catalog name, and (b) closer to its intended spine tool than to every OTHER spine tool
 * (by edit distance on the transport form) — otherwise the "intended" label is not
 * actually recoverable and would poison calibration.
 */
export function buildSyntheticMangles(spine: readonly string[] = SPINE_TOOLS): MangleCase[] {
  const exact = new Set(spine.map(mcpNameOf));
  const bare = (raw: string) => raw.replace(/^(mcp__papercus+p?[-_]su__|mcp__papercus+p?_su_|mcp_papercusp_su_|papercusp-su__)/i, '');
  const norm = (raw: string) => bare(raw).toLowerCase().replaceAll(':', '_').replaceAll('.', '_').replaceAll('/', '_').replaceAll('-', '_');
  const out: MangleCase[] = [];
  // real inputs are already golden cases; never re-emit them as synthetic duplicates
  const seen = new Set<string>(REAL_MANGLES.map((c) => c.rawInput));
  for (const tool of spine) {
    const cands: { raw: string; kind: MangleKind }[] = [
      ...separatorVariants(tool),
      ...prefixVariants(tool).map((raw) => ({ raw, kind: 'prefix' as const })),
      ...caseVariants(tool).map((raw) => ({ raw, kind: 'case' as const })),
      ...typoVariants(tool).map((raw) => ({ raw, kind: 'typo' as const })),
    ];
    for (const { raw, kind } of cands) {
      if (exact.has(raw) || seen.has(raw)) continue;
      const target = norm(mcpNameOf(tool));
      const d = editDistance(norm(raw), target);
      const rival = Math.min(...spine.filter((t) => t !== tool).map((t) => editDistance(norm(raw), norm(mcpNameOf(t)))));
      if (d >= rival) continue; // not uniquely recoverable → excluded
      seen.add(raw);
      out.push({ id: `syn-${String(out.length + 1).padStart(3, '0')}`, rawInput: raw, intendedTool: tool, source: 'synthetic', kind });
    }
  }
  return out;
}

export const SYNTHETIC_MANGLES: readonly MangleCase[] = buildSyntheticMangles();

/** The full golden set: every case is `(rawInput -> intendedTool)` and must auto-resolve. */
export const GOLDEN_MANGLES: readonly MangleCase[] = [...REAL_MANGLES, ...SYNTHETIC_MANGLES];
