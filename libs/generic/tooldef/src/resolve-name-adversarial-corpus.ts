/**
 * Adversarial corpus for fuzzy tool-name resolution — the FALSE-RESOLVE guards.
 * (plan `fuzzy-tool-name-resolution-2026-07-02` P-002, feeding P-003's (T,M) sweep and
 * P-004's resolver unit table.)
 *
 * Every case here is an input that must NOT auto-resolve (D-006: threshold + uniqueness
 * + margin; D-007: never a fuzzy guess onto a mutating tool). The golden (must-resolve)
 * corpus is P-001's; the two are swept together by P-003 to pick (T, M) that recovers the
 * most goldens at ZERO false-resolves on this set.
 *
 * ## Derived, not hand-listed (derived-truth-ladder rung 1)
 * The cases are COMPUTED from a frozen candidate universe by `deriveAdversarialCases`, so
 * the 45 measured near-collision pairs (edit distance <= 2 in the 916-name catalog on
 * 2026-09-30: autonomy:policy_get/set, backup:settings_get/set, config:tiers-get/set,
 * pot:get-steering/set-steering, capability:edit/git, ...) are not transcribed by eye and
 * cannot drift from what the resolver actually measures. The universe is FROZEN (a
 * candidate set the resolver is handed per D-009), so this file is self-contained in the
 * `tooldef` submodule and never reads the operator catalog. `ADVERSARIAL_UNIVERSE` is the
 * union of every name involved in a distance-<=2 pair plus a few far-synonym targets.
 *
 * ## Hard vs policy-dependent
 * - `hard`   — MUST abstain for ANY (T, M): exact-distance ties between two valid names,
 *              and far synonyms a weak model invents that no sane T should reach.
 * - `margin` — nearest is unique but the runner-up is only `dSecond - dNearest` farther.
 *              Whether these resolve is exactly what M controls; P-003 reports them
 *              separately so the false-resolve count on `hard` stays the zero-bar.
 *
 * `mutatingTargets` marks the cases whose nearest candidate looks like a WRITE verb, the
 * population D-007 exists to protect (a typo must never become a mutation).
 */

import { editDistance } from './resolve-name-corpus';

// One Levenshtein for the whole calibration corpus (P-001 owns it); re-exported so the
// sweep can take both corpora's helpers from either module.
export { editDistance };

/** edits / max(len) — D-006's normalized distance, so short verbs are not over-forgiving. */
export function normalizedEditDistance(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 0 : editDistance(a, b) / max;
}

/**
 * Separator/case/prefix folding — MUST mirror `normalizeMcpName` in tool-projection.ts
 * (a test pins the agreement). Inputs whose canonical form hits a universe name are
 * stage-1 canonicalize resolutions, not adversarial fuzzy inputs, so the deriver skips them.
 */
export function canonicalKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/^mcp__[^_]+(?:[^_]|_(?!_))*__/, '')
    .replace(/[:_.\-]+/g, ':');
}

/** Names involved in a distance<=2 pair in the real catalog (2026-09-30) + far-synonym targets. */
export const ADVERSARIAL_UNIVERSE: readonly string[] = [
  'accounts:get-session-override',
  'accounts:pin',
  'accounts:set-session-override',
  'accounts:unpin',
  'autonomy:policy_get',
  'autonomy:policy_set',
  'backup:settings_get',
  'backup:settings_set',
  'blueprint:result',
  'blueprint:resume',
  'capability:edit',
  'capability:fetch',
  'capability:git',
  'capability:list',
  'capability:patch',
  'config:doors-get',
  'config:doors-set',
  'config:tiers-get',
  'config:tiers-set',
  'conversations:list',
  'conversations:post',
  'coord:ack',
  'coord:ask',
  'coord:couple',
  'coord:decouple',
  'coord:feed',
  'coord:handoff',
  'coord:handoffs',
  'coord:read',
  'coord:send',
  'coord:thread',
  'docs:search',
  'flags:get',
  'flags:list',
  'flags:set',
  'fleet:admit',
  'fleet:audit',
  'goals:attach-pot',
  'goals:detach-pot',
  'health:ack',
  'health:unack',
  'knowledge_packs:install',
  'knowledge_packs:uninstall',
  'locks:acquire',
  'locks:release',
  'memory:remember',
  'memory:search',
  'mode:get',
  'mode:set',
  'operator:budget',
  'operator:nudge',
  'plan_items:assign',
  'plan_items:unassign',
  'plans:audit',
  'plans:edit',
  'plans:get',
  'plans:get-input-schema',
  'plans:get-output-schema',
  'plans:get-specs',
  'plans:get-template-data',
  'plans:lint',
  'plans:list',
  'plans:new',
  'plans:set-input-schema',
  'plans:set-output-schema',
  'plans:set-specs',
  'plans:set-status',
  'plans:set-template-data',
  'pot:ask',
  'pot:asks',
  'pot:get-steering',
  'pot:set-steering',
  'processes:limit',
  'processes:list',
  'projects:spec_revision',
  'projects:spec_revisions',
  'rubrics:amend',
  'rubrics:trend',
  'scheduler:get_claim_spec',
  'scheduler:set_claim_spec',
  'search:fulltext',
  'testing:run',
  'testing:runs',
  'tools:find',
  'tools:invoke',
  'tui:dispatch',
  'ui:dispatch',
  'work_items:complete',
  'work_items:create',
  'work_items:link',
  'work_items:links',
  'work_items:list',
];

export type AdversarialClass = 'tie' | 'far-synonym' | 'margin-probe';

export interface AdversarialCase {
  /** Stable id (`<class>:<input>`). */
  readonly id: string;
  readonly cls: AdversarialClass;
  /** The mangled/invented name a model might emit. Never an exact or canonical universe hit. */
  readonly rawInput: string;
  /**
   * The candidate set the resolver is handed for this case (D-009: the caller's resolvable
   * set). The frozen `ADVERSARIAL_UNIVERSE` — shared by every case, so ties and margins
   * were measured against exactly this list.
   */
  readonly candidates: readonly string[];
  /** Universe names at the minimal edit distance from `input` (>=2 for a tie). */
  readonly nearest: readonly string[];
  /** Edit distance from `input` to the nearest name(s). */
  readonly dNearest: number;
  /** Distance to the closest name NOT in `nearest` (Infinity when the universe has no other). */
  readonly dSecond: number;
  /** Names a resolver must never dispatch to for this input. */
  readonly mustNotResolveTo: readonly string[];
  /** Subset of `nearest` whose verb reads as a mutation (D-007's protected population). */
  readonly mutatingTargets: readonly string[];
  /** `true` = must abstain for any (T, M); `false` = abstention depends on the margin M. */
  readonly hard: boolean;
  readonly note: string;
}

const MUTATING_VERB =
  /(^|[_-])(set|put|post|send|write|edit|patch|delete|remove|kill|install|uninstall|pin|unpin|assign|unassign|attach|detach|create|new|amend|ack|unack|couple|decouple|release|acquire|complete|nudge|admit|remember|resume|invoke|dispatch|limit)$/;

/** Does the tool's final verb segment read as a mutation? (Heuristic — D-007 uses real tiers.) */
export function looksMutating(name: string): boolean {
  const verb = name.slice(name.lastIndexOf(':') + 1);
  return MUTATING_VERB.test(verb);
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz:_-';

/** All strings one edit (delete / substitute / insert) away from `s`, deduped + sorted. */
function singleEdits(s: string): string[] {
  const out = new Set<string>();
  for (let i = 0; i < s.length; i++) out.add(s.slice(0, i) + s.slice(i + 1));
  for (let i = 0; i < s.length; i++) {
    for (const ch of ALPHABET) if (ch !== s[i]) out.add(s.slice(0, i) + ch + s.slice(i + 1));
  }
  for (let i = 0; i <= s.length; i++) {
    for (const ch of ALPHABET) out.add(s.slice(0, i) + ch + s.slice(i));
  }
  out.delete(s);
  return [...out].sort();
}

interface Measured {
  readonly dNearest: number;
  readonly nearest: string[];
  readonly dSecond: number;
}

function measure(input: string, universe: readonly string[]): Measured {
  let dNearest = Infinity;
  for (const u of universe) dNearest = Math.min(dNearest, editDistance(input, u));
  const nearest: string[] = [];
  let dSecond = Infinity;
  for (const u of universe) {
    const d = editDistance(input, u);
    if (d === dNearest) nearest.push(u);
    else dSecond = Math.min(dSecond, d);
  }
  return { dNearest, nearest, dSecond };
}

/** Far synonyms: plausible invented names with no real tool. Alias-table names (D-010) excluded. */
export const FAR_SYNONYMS: ReadonlyArray<{ input: string; targets: readonly string[] }> = [
  { input: 'flags:delete', targets: ['flags:set'] },
  { input: 'flags:update', targets: ['flags:set', 'flags:get'] },
  { input: 'plans:create', targets: ['plans:new', 'plans:edit'] },
  { input: 'plans:remove', targets: ['plans:new', 'plans:edit'] },
  { input: 'coord:message', targets: ['coord:send', 'coord:ask'] },
  { input: 'coord:reply', targets: ['coord:send', 'coord:read'] },
  { input: 'work_items:update', targets: ['work_items:create', 'work_items:complete'] },
  { input: 'work_items:close', targets: ['work_items:complete'] },
  { input: 'memory:save', targets: ['memory:remember'] },
  { input: 'memory:store', targets: ['memory:remember', 'memory:search'] },
  { input: 'locks:lock', targets: ['locks:acquire'] },
  { input: 'locks:unlock', targets: ['locks:release'] },
  { input: 'mode:toggle', targets: ['mode:set', 'mode:get'] },
  { input: 'docs:read', targets: ['docs:search'] },
  { input: 'tools:call', targets: ['tools:invoke', 'tools:find'] },
];

const TIES_PER_PAIR = 2;

/**
 * Derive the adversarial cases from a candidate universe.
 *  - tie: for every pair (a,b) at distance <= 2, up to TIES_PER_PAIR single-edit mangles of
 *    a or b that are EQUIDISTANT from a and b AND no other universe name is closer — the
 *    resolver cannot pick one without guessing.
 *  - margin-probe: single-edit mangles of a name whose runner-up is exactly 1 farther.
 *  - far-synonym: FAR_SYNONYMS entries (kept when not an exact/canonical universe hit).
 */
export function deriveAdversarialCases(universe: readonly string[]): AdversarialCase[] {
  const canon = new Set(universe.map(canonicalKey));
  const isPlain = (x: string) => !universe.includes(x) && !canon.has(canonicalKey(x));
  const cases = new Map<string, AdversarialCase>();

  const add = (cls: AdversarialClass, input: string, hard: boolean, note: string, forbid?: readonly string[]) => {
    const m = measure(input, universe);
    const id = `${cls}:${input}`;
    if (cases.has(id)) return;
    cases.set(id, {
      id,
      cls,
      rawInput: input,
      candidates: universe,
      nearest: m.nearest,
      dNearest: m.dNearest,
      dSecond: m.dSecond,
      mustNotResolveTo: forbid ?? m.nearest,
      mutatingTargets: m.nearest.filter(looksMutating),
      hard,
      note,
    });
  };

  const sorted = [...universe].sort();
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      if (editDistance(a, b) > 2) continue;
      let taken = 0;
      const seen = new Set<string>();
      for (const x of [...singleEdits(a), ...singleEdits(b)]) {
        if (taken >= TIES_PER_PAIR) break;
        if (seen.has(x) || !isPlain(x)) continue;
        seen.add(x);
        if (editDistance(x, a) !== editDistance(x, b)) continue; // cheap prefilter before the full scan
        const m = measure(x, universe);
        if (m.nearest.length >= 2 && m.nearest.includes(a) && m.nearest.includes(b)) {
          add('tie', x, true, `equidistant (d=${m.dNearest}) between ${a} and ${b}`);
          taken++;
        }
      }
    }
  }

  for (const name of sorted) {
    let taken = 0;
    for (const x of singleEdits(name)) {
      if (taken >= 1) break;
      if (!isPlain(x)) continue;
      const m = measure(x, universe);
      if (m.nearest.length === 1 && m.nearest[0] === name && m.dSecond === m.dNearest + 1) {
        add('margin-probe', x, false, `unique nearest ${name} (d=${m.dNearest}) but runner-up only 1 farther`);
        taken++;
      }
    }
  }

  for (const { input, targets } of FAR_SYNONYMS) {
    if (!isPlain(input)) continue;
    add('far-synonym', input, true, `invented name with no real tool; must not land on ${targets.join(' / ')}`, targets);
  }

  return [...cases.values()];
}

/** The derived adversarial set against the frozen universe. */
export const ADVERSARIAL_CASES: readonly AdversarialCase[] = deriveAdversarialCases(ADVERSARIAL_UNIVERSE);

/** Cases that must abstain for ANY (T, M) — the zero-false-resolve bar for P-003. */
export const HARD_ADVERSARIAL_CASES: readonly AdversarialCase[] = ADVERSARIAL_CASES.filter((c) => c.hard);
/** Cases whose outcome is governed by the margin M — reported separately by the sweep. */
export const MARGIN_ADVERSARIAL_CASES: readonly AdversarialCase[] = ADVERSARIAL_CASES.filter((c) => !c.hard);
