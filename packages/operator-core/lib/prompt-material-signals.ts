/**
 * MATERIAL signals in an assembled agent prompt — the pure detector half of
 * `stale-prompt-render-in-live-sessions-2026-08-02` P-004.
 *
 * ── WHY "MATERIAL" IS THE WHOLE DESIGN ──────────────────────────────────────
 *
 * P-002 made a carry-respawn re-render its persona, but that acts only at a
 * session's NEXT respawn and only for adv rows carrying a `launch_spec` (D-003).
 * The 27 sessions already running a render up to 14 days old are unreachable by
 * it, so the only channel left is to TELL them — over coord, mid-turn.
 *
 * A byte-diff would fire on every whitespace edit, become chatter, and get muted.
 * The plan is explicit that this is worse than silence. So a render is compared
 * on two families only, both chosen because a difference in them changes what the
 * agent would DO:
 *
 *   1. DENY-LIST RECOMMENDATIONS — the render tells the agent to use a tool that
 *      is deny-listed to it today. This needs NO reference document: the deny list
 *      is live CODE (`NO_SUBAGENT_TOOLS_DENY`), so a recommendation of a currently
 *      denied tool is wrong however old the render is. This is the family that
 *      catches the 2026-08-01 incident that motivated the plan — an agent read
 *      "use the `Task` tool to fan out", offered the owner that route, and only
 *      found out at execution time that the tool had been removed a month earlier.
 *
 *   2. ROUTE MECHANISMS — the `server:verb` a ROUTE RULE names as the way to do a
 *      thing (the numbered/lettered route menu the agent offers the owner, and the
 *      papercusp-way routing-gate table). A mechanism the render's route rules name
 *      that no CURRENT source names is a route the agent would offer and could not
 *      execute — the same failure as family 1, one layer out.
 *
 * Keying route rules on the MECHANISM rather than the prose label is deliberate:
 * labels and trigger phrasings get reworded constantly and a rename is not a
 * material change, while a changed verb always is. That choice is what keeps this
 * quiet enough to stay trusted.
 *
 * Pure — string in, sorted string[] out. No FS, no DB, no clock. The delivery half
 * (the /proc sweep, the source union, the debounce, the coord send) is
 * `stale-prompt-render-sweep.ts`.
 */
import { NO_SUBAGENT_TOOLS_DENY } from '@papercusp/orchestrator/no-subagent-deny';

/**
 * Markers that make a paragraph a PROHIBITION rather than a recommendation. Kept
 * generous on purpose: the job is to catch "use the `Task` tool", not to police
 * phrasing. Mentioning a denied tool is fine and often necessary; mentioning it
 * WITHOUT saying it is denied is the bug.
 */
export const PROHIBITION_MARKERS: readonly string[] = [
  'denied',
  'deny',
  'do not',
  "don't",
  'never',
  '⛔',
  'disallow',
  'not in your toolset',
  'instead of',
  'not available',
  'forbidden',
  'retired',
  'absent',
];

/**
 * Deny-listed names mentioned as a markdown CODE SPAN in a paragraph carrying no
 * prohibition marker.
 *
 * Code-span matching is what keeps prose ("the agent", "any task with 3+ steps")
 * and sibling tool names (`TaskCreate`, `TaskUpdate`, `TaskList` — different
 * tokens, all legitimate) out of the results.
 *
 * `denied` is injectable so a test can drive the detector without depending on the
 * live deny list's current membership; the DEFAULT is that live list, which is what
 * makes this family reference-free (see the module docstring).
 */
export function findDeniedToolRecommendations(
  md: string,
  denied: ReadonlySet<string> = new Set(NO_SUBAGENT_TOOLS_DENY),
): string[] {
  const found = new Set<string>();
  for (const para of md.split(/\n\s*\n/)) {
    const spans = [...para.matchAll(/`([^`\n]{1,40})`/g)].map((m) => m[1]);
    const hits = spans.filter((s) => denied.has(s));
    if (hits.length === 0) continue;
    const low = para.toLowerCase();
    if (PROHIBITION_MARKERS.some((p) => low.includes(p))) continue;
    for (const h of hits) found.add(h);
  }
  return [...found].sort();
}

/**
 * A route-menu line: the enumerated routes an su offers the owner when asked to
 * implement a plan. Two spellings exist in the corpus and both are load-bearing —
 * the pot instance override numbers them `**(0)**…`, the domain-neutral base
 * persona letters them `**A.**…`.
 *
 * The letter class is bounded (A–H) rather than `[A-Z]` so an unrelated bolded
 * `**Q. …**` in spliced project prose cannot masquerade as a route. A route added
 * past H is simply not extracted — silence, never a false alarm, which is the safe
 * direction for a detector whose whole value is being quiet.
 */
const ROUTE_MENU_LINE = /^\s*(?:[-*]|\d+\.)\s+\*\*(?:\(\d\)|[A-H]\.)\s/;

/** The papercusp-way routing-gate table's header row — the ONLY table whose rows
 *  are route rules. Matching on the header (rather than "any markdown table")
 *  keeps the many unrelated tables spliced into a render — the bash-routing table,
 *  the pipeline-position table — out of the signal entirely. */
const ROUTING_GATE_HEADER = /^\s*\|\s*when the ask sounds like\s*\|\s*the papercusp way\s*\|/i;

/**
 * A tool/verb reference: `server:verb` (the papercusp form) or `plugin.verb` (the
 * plugin-namespaced form, e.g. `design-phase.search_registry`). Anchored on both
 * ends so a prose code span (`staging`, `--files`) is never mistaken for a verb.
 */
const VERB_SPAN = /^[a-z][a-z0-9_-]*[.:][a-z][a-z0-9_-]*$/;

/**
 * Every `server:verb`-shaped code span in one line of markdown.
 *
 * ⚠ The ARGS SUFFIX must be stripped, and forgetting it is not a cosmetic miss.
 * The corpus writes a route's mechanism with its call shape inline —
 * `` `fleet:launch-on-plan { name, plan, count }` `` — so an anchored match against
 * the raw span rejects the single most load-bearing mechanism in the whole route
 * menu (measured: routes (3) and (4) both extracted as EMPTY before this cut), and
 * the family would have looked healthy while being blind to exactly the rules it
 * exists to watch.
 */
function verbSpansIn(line: string): string[] {
  return [...line.matchAll(/`([^`\n]{1,80})`/g)]
    .map((m) => m[1].trim().split(/[\s{(]/, 1)[0])
    .filter((s) => VERB_SPAN.test(s));
}

/**
 * The mechanisms (`server:verb`) that ROUTE RULES name — from the route menu and
 * from the papercusp-way routing gate.
 *
 * Note what is deliberately NOT here: a verb named anywhere else in the document.
 * A render splices a whole project guide and a tool catalogue, both of which name
 * hundreds of verbs that have nothing to do with routing; folding those in would
 * make the set enormous and its diff meaningless.
 */
export function extractRouteMechanisms(md: string): string[] {
  const out = new Set<string>();
  let inRoutingGate = false;
  for (const line of md.split('\n')) {
    if (ROUTING_GATE_HEADER.test(line)) {
      inRoutingGate = true;
      continue;
    }
    if (inRoutingGate) {
      // The table ends at the first line that is not a row. The `|---|---|`
      // separator carries no verbs, so it needs no special case.
      if (!line.trimStart().startsWith('|')) inRoutingGate = false;
      else {
        for (const v of verbSpansIn(line)) out.add(v);
        continue;
      }
    }
    if (ROUTE_MENU_LINE.test(line)) for (const v of verbSpansIn(line)) out.add(v);
  }
  return [...out].sort();
}

/** The two material families of one prompt document. */
export interface MaterialSignals {
  /** Deny-listed tools this document RECOMMENDS (no prohibition marker nearby). */
  deniedRecommendations: string[];
  /** `server:verb` mechanisms this document's ROUTE RULES name. */
  routeMechanisms: string[];
}

export function extractMaterialSignals(
  md: string,
  denied?: ReadonlySet<string>,
): MaterialSignals {
  return {
    deniedRecommendations: findDeniedToolRecommendations(md, denied),
    routeMechanisms: extractRouteMechanisms(md),
  };
}

/** What a live render carries that current sources no longer support. */
export interface MaterialRenderDrift {
  /** Deny-listed tools the render recommends. Reference-free — see family 1. */
  deniedRecommendations: string[];
  /** Route mechanisms named by the render's route rules and by NO current source's. */
  retiredRouteMechanisms: string[];
  /** True when there is anything worth waking an agent for. */
  material: boolean;
}

/**
 * Compare ONE live render against the current prompt sources.
 *
 * ── ONLY THE STALE DIRECTION IS REPORTED, AND THAT IS A DECISION ────────────
 *
 * A signal present in the SOURCES but missing from the render ("you don't know
 * about a new route") is NOT reported. It cannot be distinguished from ordinary
 * layer variance: a session launched at a trimmed persona tier, on a different
 * profile, or in another harness legitimately never carried some layer, so that
 * direction would fire constantly on sessions that are perfectly current — which
 * is the chatter the plan forbids. The additive direction is already covered by
 * P-002, whose re-render reproduces the correct layers for that session.
 *
 * The stale direction has no such ambiguity: a render can only contain a route
 * mechanism that some layer once carried, so a mechanism absent from EVERY current
 * source means that source changed under a running session.
 *
 * `includeRouteFamily: false` suppresses family 2 for this comparison — the caller
 * passes false when it could not establish the source union with confidence
 * (e.g. a live prompt-override read failed). Fail CLOSED: an incomplete source set
 * makes every mechanism look retired, which is the one way this detector could
 * page the whole fleet about nothing.
 */
export function detectMaterialRenderDrift(opts: {
  renderText: string;
  sourceTexts: readonly string[];
  denied?: ReadonlySet<string>;
  includeRouteFamily?: boolean;
}): MaterialRenderDrift {
  const deniedRecommendations = findDeniedToolRecommendations(opts.renderText, opts.denied);

  let retiredRouteMechanisms: string[] = [];
  if (opts.includeRouteFamily !== false) {
    const current = new Set<string>();
    for (const src of opts.sourceTexts) for (const v of extractRouteMechanisms(src)) current.add(v);
    // An empty source union means the sources could not be read at all, not that
    // every mechanism was retired — same fail-closed reasoning as the flag above.
    if (current.size > 0) {
      retiredRouteMechanisms = extractRouteMechanisms(opts.renderText).filter((v) => !current.has(v));
    }
  }

  return {
    deniedRecommendations,
    retiredRouteMechanisms,
    material: deniedRecommendations.length > 0 || retiredRouteMechanisms.length > 0,
  };
}

/** Stable per-render drift key — the debounce scope. Two genuinely different
 *  drifts on the same session page independently; the same drift pages once per
 *  window however many ticks observe it. */
export function driftFingerprint(d: MaterialRenderDrift): string {
  return [
    d.deniedRecommendations.length ? `deny=${d.deniedRecommendations.join('+')}` : '',
    d.retiredRouteMechanisms.length ? `route=${d.retiredRouteMechanisms.join('+')}` : '',
  ]
    .filter(Boolean)
    .join(';');
}
