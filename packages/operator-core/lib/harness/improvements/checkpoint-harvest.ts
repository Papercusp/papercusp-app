/**
 * checkpoint-harvest.ts — P-020 (su-ideate-learning-substrate-2026-07-10):
 * auto-file lane:observation rows from the insight-bearing free-text agents
 * ALREADY write at BOUNDARIES — a `loop:checkpoint`'s `insight` field and a
 * work-item completion record's `coordNotes` (the design-note residual the
 * structured fields can't hold) — with ZERO new workflow.
 *
 * D-017 rationale: the boundary artifacts DO carry the durable content, yet
 * deliberate lane filings run only ~1.4/agent/week — so HARVEST what's already
 * written instead of asking for more (the explicitly-rejected alternative is a
 * volume quota, which just produces noise the digest must then de-noise).
 *
 * D-016 conventions every new leg copies:
 *   - FAIL-OPEN is the prime directive — a harvest miss must NEVER break or slow
 *     the checkpoint / completion write it rides (the caller fires-and-forgets it);
 *   - env kill switch: PAPERCUSP_SU_CHECKPOINT_HARVEST=off (flag-ON default);
 *   - VITEST-inert unless deps are injected (the semantic prescreen lazy-loads an
 *     ONNX model via findSemanticDupes — the WI-3792 load-scar class);
 *   - never hardcode the embedder — the semantic leg rides the shared 551-vector
 *     work-item dupe guard, which already reads embedding_mode / EMBEDDER_DIM.
 *
 * The harvested row is source-tagged `payload.origin='checkpoint-harvest'`,
 * `created_by` = the checkpointing/completing agent, `filedByRole` preserved.
 *
 * CLAIM-STRENGTH + REFUTATION PROPAGATION (EI-9941, 2026-07-12): the WI-4070 /
 * EI-9881 incident showed a harvested EI silently promoted a mid-investigation
 * hypothesis to what read like settled fact — a second agent (L5) anchored on
 * its bare declarative title, costing 3+ coord round-trips before L1's refutation
 * caught up. Two independent, complementary legs:
 *   - CLAIM-STRENGTH TAGGING: `classifyClaimStrength` is a best-effort LEXICAL
 *     heuristic over the raw insight text — it can only surface a hedge the
 *     WRITER actually used ("suspect", "unconfirmed", "hypothesis", …); it
 *     cannot fact-check a confidently-worded claim that turns out wrong (that's
 *     what refutation propagation below is for). A detected 'hypothesis' or
 *     'verified' marker prefixes the filed title (`[hypothesis] …` /
 *     `[verified] …`) so the strength is visible at a glance in any list view,
 *     never buried only in payload JSON; 'unspecified' (the common case) adds
 *     no prefix — asserting confidence the writer didn't state would be its own
 *     false signal. Also stamped at `payload.claimStrength` +
 *     `payload.provenance` (who stated it, from which boundary) for querying.
 *   - REFUTATION PROPAGATION: `isRefutation` flags an insight that reads as
 *     walking back a prior claim (refuted / ruled out / dead end / withdrawn /
 *     …). When such an insight carries a CLAIM-IDENTIFYING ref (`wi:WI-4070` —
 *     see `isClaimIdentifyingRef`, and READ ITS DOC BEFORE TOUCHING THIS), every
 *     PRIOR harvested observation tagged with that same ref gets its title
 *     prefixed `⚠ REFUTED — ` and a dated refutation note appended to its body
 *     — so a later agent scanning the backlog sees the flag on the ORIGINAL
 *     entry, not just in a separate, easy-to-miss follow-up row. Fails open:
 *     an update failure never blocks filing the refutation's own observation.
 *     The ref gate is LOAD-BEARING, not decorative: this write is destructive and
 *     reaches ACROSS agents, so it may only fire through a ref that names the
 *     claim being refuted. Propagating through the `loop:checkpoint` SOURCE TAG —
 *     which every agent's every checkpoint shares — flagged 40 unrelated true
 *     observations belonging to 11 other agents before EI-10593 caught it.
 *
 * COALESCE (so repeated insights don't pile): the carry-note `insight` commonly
 * persists VERBATIM across consecutive cold wakes, so a naive harvest would file
 * N near-identical rows. The prescreen compares the new insight against THIS
 * agent's OWN recent harvest observations two ways:
 *   1. LEXICAL titleSimilarity — catches the exact/near consecutive-wake repeat
 *      that the ASYNC embedding backfill has not yet vectorised (the dominant
 *      case, and the one a purely-semantic guard would miss precisely because the
 *      freshest rows are the least likely to be embedded yet);
 *   2. SEMANTIC widening via the shared 551-vector guard (findSemanticDupes),
 *      SCOPED to this agent's recent harvest ids — catches a re-WORDED repeat.
 * A hit on either coalesces (skips the file). Both fail open (a dep miss ⇒ file).
 */
import { getOrgPg } from '@papercusp/db-org';
import { captureImprovement, type CaptureImprovementInput, type CaptureImprovementResult } from './capture-core';
import { titleSimilarity } from './digest';
import { findSemanticDupes, type SemanticDupeResult } from '../../agent-tools/work_items/semantic-dupe-guard';
import { getIssue, updateIssue } from '../../issues-engineer';

/** payload.origin source-tag stamped on every harvested observation (P-020). */
export const HARVEST_ORIGIN = 'checkpoint-harvest';
/** Kill switch (flag-ON default): PAPERCUSP_SU_CHECKPOINT_HARVEST=off disables all harvest. */
export const HARVEST_KILL_ENV = 'PAPERCUSP_SU_CHECKPOINT_HARVEST';
/** Bound the observation title (the one-line "what") and body (the full insight). */
export const MAX_TITLE_CHARS = 120;
export const MAX_INSIGHT_CHARS = 1400;
/** titleSimilarity at/above this against a recent harvest row ⇒ coalesce (a repeat). */
export const COALESCE_LEXICAL = 0.82;
/** How far back / how many of the agent's own harvest rows the coalesce prescreen loads. */
export const RECENT_LOOKBACK_DAYS = 14;
export const RECENT_LIMIT = 40;

/** Which boundary produced the insight (stamped at payload.harvestSource). */
export type HarvestSource = 'loop-checkpoint' | 'work-item-completion';

/** EI-9941: best-effort lexical claim-strength classification — see the class doc above. */
export type ClaimStrength = 'hypothesis' | 'verified' | 'unspecified';

/** Title prefix stamped when `classifyClaimStrength` finds an explicit hedge/confirm marker. */
export const CLAIM_STRENGTH_PREFIX: Record<Exclude<ClaimStrength, 'unspecified'>, string> = {
  hypothesis: '[hypothesis] ',
  verified: '[verified] ',
};

/** Title prefix stamped on a harvested EI whose claim was later refuted (EI-9941). */
export const REFUTED_PREFIX = '⚠ REFUTED — ';

const HYPOTHESIS_MARKERS: readonly RegExp[] = [
  /\bhypothes(is|es|i[sz]ed)\b/i,
  /\bunconfirmed\b/i,
  /\bunverified\b/i,
  /\bsuspect(ed)?\b/i,
  /\bpossibly\b/i,
  /\bmay\s+be\b/i,
  /\bmight\s+be\b/i,
  /\bcould\s+be\b/i,
  /\bbelieve[sd]?\b/i,
  /\btheory\b/i,
  /\bguess(ing)?\b/i,
  /\bnot\s+(yet\s+)?confirmed\b/i,
  /\bcandidate\s+(root\s*cause|explanation|mechanism)\b/i,
  /\b(my|our)\s+(best\s+)?read\b/i,
];

const VERIFIED_MARKERS: readonly RegExp[] = [
  /\bconfirmed\b/i,
  /\bverified\b/i,
  /\btested\s+green\b/i,
  /\blanded\s*\+\s*green\b/i,
  /\bon-disk\s+evidence\b/i,
  /\breproduced\b/i,
];

/**
 * Best-effort lexical claim-strength classifier (PURE) — see the class doc's
 * "CLAIM-STRENGTH TAGGING" note. A hedge marker wins over a confirm marker
 * when BOTH appear (conservative: prefer flagging as unsettled). Absence of
 * any marker is 'unspecified', never 'verified' — silence is not confirmation.
 */
export function classifyClaimStrength(text: string): ClaimStrength {
  const hasHedge = HYPOTHESIS_MARKERS.some((re) => re.test(text));
  if (hasHedge) return 'hypothesis';
  const hasConfirm = VERIFIED_MARKERS.some((re) => re.test(text));
  if (hasConfirm) return 'verified';
  return 'unspecified';
}

/**
 * Stamp a claim-strength prefix onto a title (PURE), re-bounding to
 * MAX_TITLE_CHARS so the prefix never pushes the total over the cap. No-op
 * (returns `title` unchanged) for 'unspecified'.
 */
export function applyClaimStrengthPrefix(title: string, strength: ClaimStrength): string {
  if (strength === 'unspecified') return title;
  const prefix = CLAIM_STRENGTH_PREFIX[strength];
  if (title.startsWith(prefix)) return title;
  const budget = MAX_TITLE_CHARS - prefix.length;
  const base = title.length > budget ? `${title.slice(0, Math.max(0, budget - 1)).trimEnd()}…` : title;
  return `${prefix}${base}`;
}

const REFUTATION_MARKERS: readonly RegExp[] = [
  /\brefut(ed|es|ing)?\b/i,
  /\bwas\s+wrong\b/i,
  /\bis\s+incorrect\b/i,
  /\bwithdraw(ing|n)?\b/i,
  /\bwalk(ing|ed)?\s+back\b/i,
  /\bdead\s*[- ]?end\b/i,
  /\bruled?\s+out\b/i,
  /\bnot\s+the\s+root\s+cause\b/i,
  /\bdebunk(ed|ing)?\b/i,
  /\bretract(ed|ing)?\b/i,
];

/**
 * Best-effort lexical refutation-signal classifier (PURE) — see the class
 * doc's "REFUTATION PROPAGATION" note. Only ever gates a FLAG on prior
 * same-`ref` harvested rows, never a suppression of the new insight's own
 * filing — so a false positive costs an extra flag, not a lost observation.
 */
export function isRefutation(text: string): boolean {
  return REFUTATION_MARKERS.some((re) => re.test(text));
}

/**
 * Does this `ref` IDENTIFY A CLAIM — i.e. name a subject a refutation can be *about*?
 * The gate on refutation propagation (EI-10593).
 *
 * `HarvestInsightInput.ref` is overloaded, and the two meanings are not interchangeable:
 *   - a CLAIM ref (`wi:WI-4070`, from a work-item completion) names the thing the insight
 *     is about — two rows sharing it are two statements about the SAME subject;
 *   - a SOURCE TAG (`loop:checkpoint`) names only where the insight came from, and is
 *     IDENTICAL for every agent's every checkpoint — it carries no topical information.
 *
 * Refutation propagation joins prior observations on this ref, so a source tag makes the
 * join VACUOUS: it matches every harvested row in the store, about anything, by anyone.
 * Measured live at EI-10593 filing time: 393 of 525 harvested rows carried the
 * `loop:checkpoint` tag, and ALL 40 refutation flags ever applied went through it — every
 * one landing on a topically unrelated observation belonging to a DIFFERENT agent. The
 * `wi:<id>` path the feature was designed for had never once fired.
 *
 * ALLOWLIST, never a denylist: an unrecognized ref must not authorize a destructive
 * cross-agent write, so a ref shape we cannot read as a claim propagates nothing. The
 * insight still files as its own observation — a missed propagation costs a flag, an
 * unfounded one costs another agent's true finding.
 */
const CLAIM_REF_RE = /^wi:[a-z]+-\d+$/i;

export function isClaimIdentifyingRef(ref: string | undefined): ref is string {
  return CLAIM_REF_RE.test((ref ?? '').trim());
}

export interface HarvestInsightInput {
  /** The raw insight free-text (loop:checkpoint.insight or a completion's coordNotes). */
  insight: string;
  /** The checkpointing / completing agent's ownerId — the observation's created_by. */
  createdBy: string;
  /** Which boundary this came from. */
  source: HarvestSource;
  /** The filer's resolved fine role (preserved at payload.filedByRole). */
  filedByRole?: string;
  /** The pot the observation came from (payload.observation.sourceHive), when scoped. */
  sourceHive?: string;
  /** An attribution ref for payload.observation.refs (e.g. 'loop:checkpoint' | 'wi:<id>'). */
  ref?: string;
  /** Harness scope for the capture + the recency lookup (omit for the unscoped '*' session). */
  harness?: string;
}

/** A recent harvest observation by this agent — the coalesce comparison set. */
export interface RecentHarvest {
  id: string;
  title: string;
}

/** Injectable seams (tests + any future space) — all fail-open at the call sites. */
export interface HarvestDeps {
  capture: (input: CaptureImprovementInput) => Promise<CaptureImprovementResult>;
  /** This agent's recent harvest observations (newest first), for the coalesce prescreen. */
  loadRecent: (createdBy: string, harness?: string) => Promise<RecentHarvest[]>;
  /** The shared 551-vector guard — semantic widening of the coalesce (fail-open null). */
  findSemanticDupes?: (input: { title: string; summary?: string; harness?: string }) => Promise<SemanticDupeResult | null>;
  /** EI-9941: ANY prior harvested observation tagged with this `ref` (not scoped to one agent) — the refutation-propagation target set. */
  findByRef?: (ref: string, harness?: string) => Promise<RecentHarvest[]>;
  /** EI-9941: flag a prior harvested observation as refuted (title prefix + appended note). Returns whether the flag landed. */
  flagRefuted?: (id: string, opts: { by: string; note: string }) => Promise<boolean>;
}

export interface HarvestResult {
  filed: boolean;
  reason?: 'disabled' | 'vitest-inert' | 'blank' | 'coalesced' | 'not-created' | 'error';
  /** The filed observation's id (when filed). */
  issueId?: string;
  /** The recent harvest id this insight coalesced into (when reason==='coalesced'). */
  coalescedWith?: string;
}

/**
 * Strip leading markdown decoration off a harvested title (PURE).
 *
 * EI-19409691124442012: an observation row never enters the work queue, so its TITLE is the
 * entire index into it for the only consumers that exist (the corpus digest and the
 * Observations pane). Checkpoint `insight` text is written as prose for a human reader, and
 * its first line routinely opens with markdown furniture — `**1. THE THING**`, `## Heading`,
 * `- point` — which spends the visible budget on punctuation instead of content.
 *
 * Iterates because the decoration nests in either order (`**1. ` is emphasis-then-ordinal,
 * `1. **` the reverse), then drops any residual emphasis spans: a title is indexed as plain
 * text, so a stray `**` in the middle is noise a reader has to parse around.
 *
 * ⛔ THE RESIDUAL STRIP MUST NOT BE A BLANKET `replace(/\*\*|__/g, '')`. It used to be, and
 * that silently CORRUPTED every identifier containing a double underscore — the harvested
 * title for a real completion stored `routes/root.tsx:92` for `routes/__root.tsx:92`
 * (EI-22376201004890886, minted 2026-09-04T23:40Z). That is the worst possible field to
 * mangle: this title IS the row's whole subject index, so the damage is a path that no
 * longer resolves and no longer matches a search for the file it names. `__` is markdown
 * emphasis only at a whitespace/string boundary; inside a token it is part of the name, and
 * this repo has 1,265 tracked paths that rely on that (`__root.tsx`, `__tests__`,
 * `__mocks__`). So unwrap BALANCED spans whose opener sits on such a boundary, and leave an
 * intra-token marker alone — keeping a rare stray `**` is far cheaper than destroying a
 * subject identifier.
 */
export function stripTitleDecoration(s: string): string {
  let out = s;
  // Bounded: each pass must strictly shrink the string or we stop, so this cannot spin.
  for (let i = 0; i < 6; i += 1) {
    const before = out;
    out = out
      .replace(/^[#>\s]+/, '') // heading / blockquote markers
      .replace(/^[-*+]\s+/, '') // list bullet (requires the space, so `**bold` is not eaten)
      .replace(/^\d+[.)]\s*/, '') // ordinal, "1." or "1)"
      .replace(/^(?:\*\*|__|\*|_)\s*/, ''); // emphasis opener
    if (out === before) break;
  }
  // Emphasis markers are stripped only where they sit on a whitespace/string BOUNDARY, which
  // is where markdown puts them; an intra-token marker is part of the name and survives. The
  // orphan passes are load-bearing, not belt-and-braces: the loop above consumes a LEADING
  // opener (`**1. x**` → `1. x**`), so its partner is left unbalanced and only the orphan
  // rule can clear it. Same boundary test also spares a glob like `src/**/*.ts`.
  return out
    // balanced span whose opener is on a boundary: `a __bold__ b` → `a bold b`
    .replace(/(^|\s)(\*\*|__)(?=\S)([\s\S]+?)\2(?!\w)/g, '$1$3')
    // orphaned opener (partner already eaten by the leading-decoration loop)
    .replace(/(^|\s)(\*\*|__)(?=\S)/g, '$1')
    // orphaned closer, e.g. the trailing `**` of `**1. THE THING**`
    .replace(/(?<=\S)(\*\*|__)(?=\s|$)/g, '')
    .trim();
}

/**
 * Truncate to `max` on a WORD boundary (PURE), never mid-word.
 *
 * Backs off to the last space only when that keeps most of the budget — a single
 * pathologically long token (a URL, a hash, a rule of dashes) would otherwise collapse the
 * title to almost nothing, which is worse than a mid-word cut. Trailing punctuation is
 * dropped so the ellipsis reads as continuation rather than as "…" glued onto a comma.
 */
export function truncateOnWordBoundary(s: string, max: number): string {
  if (s.length <= max) return s;
  const hard = s.slice(0, max - 1);
  const lastSpace = hard.lastIndexOf(' ');
  const kept = lastSpace >= Math.floor(max * 0.6) ? hard.slice(0, lastSpace) : hard;
  const trimmed = kept.replace(/[\s,;:.\-–—]+$/, '');
  return `${trimmed || kept.trimEnd()}…`;
}

/**
 * Bound a raw insight into an observation's { title, body } (PURE). The title is
 * the collapsed first line — stripped of markdown decoration and cut on a word
 * boundary at MAX_TITLE_CHARS; the body is the whole
 * insight bounded to MAX_INSIGHT_CHARS, and is dropped when it carries nothing
 * beyond the title (a short single-line insight lives entirely in the title).
 * Returns null for a blank insight (nothing to harvest).
 *
 * THE FIRST LINE IS AN IDENTIFIER, AND ONLY THE WRITER CAN MAKE IT ONE
 * (observation-and-recall-surface-honesty-2026-08-16 P-001). This function is
 * where a free-text reflection becomes a titled row, and that title is the whole
 * index into the row: `dedupSignature(title)` is what `recurrence-escalation.ts`
 * matches on, so a first line phrased as a reflection rather than as a subject
 * mints a signature that can never collide with a peer's filing of the same
 * friction (measured: 99.3% of stored observation titles are singletons).
 *
 * ⛔ The fix is NOT to rewrite or score the line here. Nothing at this seam knows
 * the stable subject the writer had in mind — inferring one would fabricate an
 * identity, and rejecting a "weak" line would be the write-time quality filter
 * plan D-002 forbids (unfiltered volume is the denominator recurrence divides
 * by). The lever is upstream guidance on the fields that feed this:
 * `HARVESTED_FIRST_LINE_RULE` in ./observation-title-guidance, stated on
 * `loop:checkpoint { insight }` and `work_items:complete { completion.coordNotes }`.
 */
export function boundInsight(raw: string): { title: string; body?: string } | null {
  const full = (raw ?? '').trim();
  if (!full) return null;
  const firstLine = (full.split(/\r?\n/, 1)[0] ?? '').replace(/\s+/g, ' ').trim();
  const rawBase = firstLine || full.replace(/\s+/g, ' ').trim();
  // Fall back to the undecorated line if stripping consumed everything (a first line that is
  // ONLY furniture, e.g. a `---` rule) — an empty title indexes nothing at all.
  const base = stripTitleDecoration(rawBase) || rawBase;
  const title = truncateOnWordBoundary(base, MAX_TITLE_CHARS);
  const boundedBody = full.length > MAX_INSIGHT_CHARS ? `${full.slice(0, MAX_INSIGHT_CHARS - 1).trimEnd()}…` : full;
  const body = boundedBody !== title ? boundedBody : undefined;
  return { title, ...(body ? { body } : {}) };
}

/**
 * The recent harvest row this title lexically repeats (PURE): the highest
 * titleSimilarity at/above `threshold`, or null if none reach it. Catches the
 * verbatim consecutive-wake repeat with no embedding dependency.
 */
export function pickLexicalCoalesce(
  title: string,
  recent: readonly RecentHarvest[],
  threshold: number = COALESCE_LEXICAL,
): string | null {
  let best: { id: string; sim: number } | null = null;
  for (const r of recent) {
    const sim = titleSimilarity(title, r.title);
    if (sim >= threshold && (!best || sim > best.sim)) best = { id: r.id, sim };
  }
  return best?.id ?? null;
}

/**
 * The first HARD semantic hit that is one of THIS agent's recent harvest rows
 * (PURE): the guard ranks the new insight against all OPEN work-items, so scope
 * its verdict to the harvest set before coalescing — an unrelated open work-item
 * clearing the hard bar must never suppress a genuine insight.
 */
export function pickSemanticCoalesce(
  hard: ReadonlyArray<{ id: string }>,
  recentIds: ReadonlySet<string>,
): string | null {
  for (const h of hard) if (recentIds.has(h.id)) return h.id;
  return null;
}

async function loadRecentHarvestReal(createdBy: string, _harness?: string): Promise<RecentHarvest[]> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ issue_id: string; title: string }>>`
    SELECT issue_id, COALESCE(title, '') AS title
      FROM harness_shared.engineer_issues
     WHERE created_by = ${createdBy}
       AND payload->>'origin' = ${HARVEST_ORIGIN}
       AND created_at > now() - (${RECENT_LOOKBACK_DAYS} * INTERVAL '1 day')
     ORDER BY created_at DESC
     LIMIT ${RECENT_LIMIT}`;
  return rows.map((r) => ({ id: r.issue_id, title: r.title }));
}

/**
 * The refutation-propagation target set: prior harvested observations carrying `ref`.
 * Deliberately NOT scoped to one agent — refuting a claim someone ELSE made about the
 * same work item is the point. That cross-agent reach is exactly why `ref` must identify
 * a claim before this is ever called (EI-10593), and why the harness scope below is now
 * honoured rather than accepted-and-ignored.
 */
async function findHarvestedByRefReal(ref: string, harness?: string): Promise<RecentHarvest[]> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ issue_id: string; title: string }>>`
    SELECT issue_id, COALESCE(title, '') AS title
      FROM harness_shared.engineer_issues
     WHERE payload->>'origin' = ${HARVEST_ORIGIN}
       AND payload->'observation'->'refs' ? ${ref}
       ${harness ? sql`AND scope = ${`harness:${harness}`}` : sql``}
     ORDER BY created_at DESC
     LIMIT 20`;
  return rows.map((r) => ({ id: r.issue_id, title: r.title }));
}

async function flagRefutedReal(id: string, opts: { by: string; note: string }): Promise<boolean> {
  const existing = await getIssue(id);
  if (!existing) return false;
  const title = existing.title.startsWith(REFUTED_PREFIX) ? existing.title : `${REFUTED_PREFIX}${existing.title}`;
  const noteLine = `\n\n[REFUTATION FLAG ${new Date().toISOString()} by ${opts.by}]: ${opts.note}`;
  const res = await updateIssue(id, { title, body: `${existing.body ?? ''}${noteLine}`, by: opts.by, confirmShrink: true });
  return !!res && !('shrinkGuardTripped' in res);
}

const realDeps: HarvestDeps = {
  capture: captureImprovement,
  loadRecent: loadRecentHarvestReal,
  findSemanticDupes,
  findByRef: findHarvestedByRefReal,
  flagRefuted: flagRefutedReal,
};

/**
 * Harvest one boundary insight into the observation lane (IMPURE leg). Never
 * throws — every failure mode returns a { filed:false, reason } verdict so the
 * fire-and-forget caller (loop:checkpoint / work_items:complete) is untouched.
 * Coalesces a repeat of the agent's own recent harvest instead of piling rows.
 */
export async function harvestInsight(input: HarvestInsightInput, deps?: HarvestDeps): Promise<HarvestResult> {
  try {
    if (process.env[HARVEST_KILL_ENV] === 'off') return { filed: false, reason: 'disabled' };
    // Inert under vitest unless a test injects deps: the semantic prescreen (and the
    // real capture path) lazy-loads an ONNX model unrelated tests must never pay.
    if (process.env.VITEST && !deps) return { filed: false, reason: 'vitest-inert' };
    const d = deps ?? realDeps;

    const createdBy = (input.createdBy ?? '').trim();
    const bounded = boundInsight(input.insight);
    if (!bounded || !createdBy) return { filed: false, reason: 'blank' };

    // EI-9941: a refutation carrying a CLAIM ref flags every PRIOR harvested row tagged
    // with that same ref — visible on the ORIGINAL entry, not just a follow-up row.
    // EI-10593: the ref must IDENTIFY A CLAIM (see isClaimIdentifyingRef). A source tag
    // like `loop:checkpoint` is shared by every agent's every checkpoint, so joining on it
    // flags 20 unrelated observations belonging to other agents — which is exactly what it
    // did, 40 times, for 0 true refutations.
    // Fails open: never blocks filing this insight's own observation below.
    if (isClaimIdentifyingRef(input.ref) && isRefutation(input.insight)) {
      const findByRef = d.findByRef ?? findHarvestedByRefReal;
      const flagRefuted = d.flagRefuted ?? flagRefutedReal;
      const priors = await findByRef(input.ref, input.harness).catch(() => [] as RecentHarvest[]);
      for (const prior of priors) {
        await flagRefuted(prior.id, { by: createdBy, note: bounded.title }).catch(() => false);
      }
    }

    // Coalesce prescreen — this agent's OWN recent harvest observations.
    const recent = await d.loadRecent(createdBy, input.harness).catch(() => [] as RecentHarvest[]);
    const lex = pickLexicalCoalesce(bounded.title, recent);
    if (lex) return { filed: false, reason: 'coalesced', coalescedWith: lex };
    if (recent.length > 0) {
      const sem = await (d.findSemanticDupes ?? findSemanticDupes)({
        title: bounded.title,
        ...(bounded.body ? { summary: bounded.body } : {}),
        ...(input.harness ? { harness: input.harness } : {}),
      }).catch(() => null);
      if (sem) {
        const hit = pickSemanticCoalesce(sem.hard, new Set(recent.map((r) => r.id)));
        if (hit) return { filed: false, reason: 'coalesced', coalescedWith: hit };
      }
    }

    const observation =
      input.ref || input.sourceHive
        ? {
            observation: {
              ...(input.ref ? { refs: [input.ref] } : {}),
              ...(input.sourceHive ? { sourceHive: input.sourceHive } : {}),
            },
          }
        : {};
    // EI-9941: claim-strength — a best-effort lexical hedge/confirm read on the
    // raw insight (see the class doc). Prefixes the FILED title so it's visible
    // at a glance; the raw classification also rides payload for querying.
    const claimStrength = classifyClaimStrength(input.insight);
    const title = applyClaimStrengthPrefix(bounded.title, claimStrength);
    const res = await d.capture({
      title,
      kind: 'change',
      ...(bounded.body ? { body: bounded.body } : {}),
      severity: 'nit',
      lane: 'observation',
      createdBy,
      ...(input.filedByRole ? { filedByRole: input.filedByRole } : {}),
      ...(input.harness ? { scope: `harness:${input.harness}` } : {}),
      payloadExtra: {
        origin: HARVEST_ORIGIN,
        harvestSource: input.source,
        claimStrength,
        provenance: { statedBy: createdBy, source: input.source, ...(input.filedByRole ? { filedByRole: input.filedByRole } : {}) },
        ...observation,
      },
    });
    if (!res.created) return { filed: false, reason: 'not-created' };
    return { filed: true, ...(res.issue?.id ? { issueId: res.issue.id } : {}) };
  } catch {
    return { filed: false, reason: 'error' };
  }
}
