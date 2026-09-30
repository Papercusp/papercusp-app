/**
 * A pure structured-block poll reducer — vote parsing + a confidence-weighted
 * tally with an advocate veto. Side-effect-free so the tally + the post-parsing
 * contract are unit-testable in isolation; a step-program's `aggregate` op is a
 * thin wrapper that hands it the collected posts.
 *
 * **The structured-post contract** (the seam between a participant's prompt and
 * the tally) — a voter posts a fenced block, with free-text around it:
 *
 *     ```vote
 *     option: <one of the options>
 *     confidence: <0..1>
 *     ```
 *
 * the advocate posts:
 *
 *     ```advocate
 *     veto: <true|false>
 *     objection: <one line>
 *     ```
 *
 * Parsing is lenient for votes: a fenced block is preferred, but bare
 * `option:`/`confidence:` lines anywhere in the post are also read, so a
 * slightly-off participant still counts. A post with neither a vote nor an
 * advocate block is ignored (e.g. a clarifying reply) — it never silently
 * corrupts the tally.
 */

export interface ParsedVote {
  /** The option the voter chose (canonicalised against `options` when matchable). */
  option: string;
  /** 0..1 confidence (clamped; defaults to 0.5 when unparseable). */
  confidence: number;
  author_id: string | null;
}

export interface ParsedAdvocate {
  veto: boolean;
  objection: string | null;
  author_id: string | null;
}

export interface AggregateInput {
  posts: { author_id: string | null; body: string }[];
  options?: string[];
  method?: 'confidence-weighted' | 'majority';
}

export interface AggregateResult {
  /** The leading option, or null when no votes were cast. */
  winner: string | null;
  /** Normalised lead of the winner: (top − runner-up) / total weight, 0..1. */
  margin: number;
  /** Mean confidence across the cast votes (0 when none). */
  mean_conf: number;
  /** True when the advocate posted a veto. */
  advocate_veto: boolean;
  /** option → summed weight (confidence-weighted, or 1-each for majority). */
  tally: Record<string, number>;
  votes: ParsedVote[];
  advocate: ParsedAdvocate | null;
  /** The advocate's objection text, surfaced for a curated escalation. */
  objection: string | null;
}

/** Pull a fenced ```<tag> … ``` block's inner body, or null. */
function fencedBlock(body: string, tag: string): string | null {
  const re = new RegExp('```' + tag + '\\s*\\n([\\s\\S]*?)```', 'i');
  const m = body.match(re);
  return m ? m[1]! : null;
}

/** Read `key: value` from a block of lines (case-insensitive key). */
function readKey(block: string, key: string): string | null {
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(new RegExp('^\\s*' + key + '\\s*[:=]\\s*(.+?)\\s*$', 'i'));
    if (m) return m[1]!;
  }
  return null;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

/** Canonicalise an option string against the declared options (case-insensitive). */
function canonical(option: string, options?: string[]): string {
  const t = option.trim();
  if (!options) return t;
  const hit = options.find((o) => o.trim().toLowerCase() === t.toLowerCase());
  return hit ?? t;
}

/** Parse a single post into a vote / advocate marker (either, both, or neither). */
export function parsePost(
  post: { author_id: string | null; body: string },
  options?: string[],
): { vote: ParsedVote | null; advocate: ParsedAdvocate | null } {
  const body = post.body ?? '';

  // ── advocate ──
  // STRICT: an advocate is recognised ONLY from a fenced ```advocate block (the
  // advocate prompt's contract). We deliberately do NOT scan the raw body for a
  // bare `veto:` line — that fallback would let a voter's free-text (or a quoted
  // "veto") forge an advocate record, which (first-advocate-wins) would suppress
  // the real advocate AND flip the gate's `advocate_veto`. Votes stay lenient
  // (a forgotten fence just adds a vote); the advocate is the higher-stakes signal.
  let advocate: ParsedAdvocate | null = null;
  const advBlock = fencedBlock(body, 'advocate');
  if (advBlock != null) {
    const vetoRaw = readKey(advBlock, 'veto');
    const objection = readKey(advBlock, 'objection');
    advocate = {
      veto: vetoRaw != null ? /^(true|yes|1)$/i.test(vetoRaw.trim()) : false,
      objection: objection ?? advBlock.trim(),
      author_id: post.author_id,
    };
  }

  // ── vote ──
  let vote: ParsedVote | null = null;
  const voteBlock = fencedBlock(body, 'vote');
  const voteSource = voteBlock ?? body;
  const optionRaw = readKey(voteSource, 'option');
  if (optionRaw != null) {
    const confRaw = readKey(voteSource, 'confidence');
    vote = {
      option: canonical(optionRaw, options),
      confidence: confRaw != null ? clamp01(Number(confRaw)) : 0.5,
      author_id: post.author_id,
    };
  }

  return { vote, advocate };
}

/**
 * Confidence-weighted (default) or majority tally over collected posts. The
 * winner is the highest-weighted option; `margin` is the normalised lead so a
 * gate (`margin >= 0.5`) reads "the winner leads the field by half the total
 * weight." A single advocate veto is surfaced (the gate `NOT advocate_veto`).
 */
export function aggregateVotes(input: AggregateInput): AggregateResult {
  const method = input.method ?? 'confidence-weighted';
  const votes: ParsedVote[] = [];
  let advocate: ParsedAdvocate | null = null;

  for (const post of input.posts) {
    const { vote, advocate: adv } = parsePost(post, input.options);
    if (vote) votes.push(vote);
    // First advocate post wins (one advocate per poll by convention).
    if (adv && !advocate) advocate = adv;
  }

  const tally: Record<string, number> = {};
  for (const v of votes) {
    const weight = method === 'majority' ? 1 : v.confidence;
    tally[v.option] = (tally[v.option] ?? 0) + weight;
  }

  const total = Object.values(tally).reduce((a, b) => a + b, 0);
  const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const winner = ranked.length > 0 ? ranked[0]![0] : null;
  const topWeight = ranked.length > 0 ? ranked[0]![1] : 0;
  const secondWeight = ranked.length > 1 ? ranked[1]![1] : 0;
  const margin = total > 0 ? (topWeight - secondWeight) / total : 0;
  const mean_conf = votes.length > 0 ? votes.reduce((a, v) => a + v.confidence, 0) / votes.length : 0;

  return {
    winner,
    margin,
    mean_conf,
    advocate_veto: advocate?.veto === true,
    tally,
    votes,
    advocate,
    objection: advocate?.objection ?? null,
  };
}
