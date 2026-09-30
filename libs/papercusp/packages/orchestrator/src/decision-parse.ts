/**
 * Parse the orchestrator's decision string. Mirrors bash:
 *
 *   sed -E 's/[*`]+//g; s/^[[:space:]]+//; s/[[:space:]]+$//' \
 *   | grep -oE '(DONE|CONVERTED|NEXT_WORKER_CEO_MODE|NEXT_WORKER|...|CHECKPOINT)([[:space:]]+[A-Za-z0-9_.-]+)?' \
 *   | tail -1
 *
 * The orchestrator prompt instructs the agent to end with one of these
 * verbs; in practice LLMs sometimes wrap them in markdown emphasis
 * (`**NEXT_WORKER F-001**`) or code fences (\`\`\`NEXT_WORKER F-001\`\`\`).
 * Strip those decorations before matching. Return the *last* match in case
 * the agent emits multiple decisions (rare but observed).
 */

/**
 * Recognized decision verbs. Order matters in the regex below — longer
 * prefixes must come first (NEXT_WORKER_CEO_MODE before NEXT_WORKER).
 */
export const DECISION_VERBS = [
  'NEXT_WORKER_CEO_MODE',
  'NEXT_WORKER',
  'NEXT_VALIDATOR',
  'NEXT_ARCHITECT',
  'NEXT_TESTER',
  'NEXT_SECURITY',
  'NEXT_SCOPER',
  'GENERATE_TESTS',
  'RUN_TESTS',
  'NEXT_MONITOR',
  // Opt-in quality gates (P-013/P-014) — recognized + classified, but a harness's
  // director only EMITS them when it opts in (config + the right claim), so they
  // are dormant by default ("wiring ≠ forcing cost"):
  //   NEXT_CROSSCHECK — a different-model second opinion after a validator PASS.
  //   NEXT_UI_QA      — a verdict-tool visual/interaction check on a VAL-UI-* feature.
  'NEXT_CROSSCHECK',
  'NEXT_UI_QA',
  'READY_FOR_PROD',
  'FEATURE_FREEZE',
  'NEXT_HARNESS',
  'CONVERTED',
  'ESCALATE',
  'IDLE',
  'DONE',
  // Deprecated — milestone gates are now needs-human plan items.
  // Kept here so parseDecision captures it and routes to the deprecation
  // handler in main-loop.ts rather than returning null (which would
  // cause the loop to retry instead of escalating cleanly).
  'CHECKPOINT',
] as const;

export type DecisionVerb = typeof DECISION_VERBS[number];

export interface ParsedDecision {
  /** The decision verb. */
  verb: DecisionVerb;
  /** Optional argument (feature id, harness slug, etc.). null when absent. */
  arg: string | null;
  /**
   * Optional adaptive-mode worker count. Set by `NEXT_WORKER F-X N=k`
   * (parsed case-insensitively). null when the verb didn't include an
   * `N=` token. Validated against the configured tier set in the
   * adaptive handler — invalid values clamp to the smallest tier.
   */
  n: number | null;
  /** The exact line that matched (post-stripping). */
  raw: string;
}

/**
 * A parsed decision over an ARBITRARY verb vocabulary (a blueprint's spine verbs).
 * Structurally identical to `ParsedDecision` but `verb` is a plain string — the
 * vocabulary is per-blueprint, not the fixed built-in set.
 */
export interface ParsedSpineDecision {
  verb: string;
  arg: string | null;
  n: number | null;
  raw: string;
}

/**
 * Build the VERB[ arg][ N=<int>] matcher for a vocabulary. Verbs are sorted
 * LONGEST-FIRST so a prefix (NEXT_WORKER) can never shadow a longer verb
 * (NEXT_WORKER_CEO_MODE), and each is regex-escaped (vocabularies are
 * blueprint-authored, so don't assume they're `[A-Z_]`-only).
 */
function buildDecisionRe(verbs: readonly string[]): RegExp {
  const alt = [...verbs]
    .sort((a, b) => b.length - a.length)
    .map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  return new RegExp('(' + alt + ')(?:\\s+([A-Za-z0-9_.-]+))?(?:\\s+[Nn]=([0-9]+))?', 'g');
}

const DECISION_RE = buildDecisionRe(DECISION_VERBS);

/**
 * Parse a decision against an ARBITRARY verb vocabulary — the blueprint engine
 * passes its spine's verbs (`Object.keys(spine.edges)`) so a non-coding harness
 * (research, …) can define its own vocabulary (D-002, pipeline-as-data).
 * `parseDecision` is this specialized to the built-in coding verbs.
 */
export function parseDecisionFor(verbs: readonly string[], text: string): ParsedSpineDecision | null {
  const re = verbs === DECISION_VERBS ? DECISION_RE : buildDecisionRe(verbs);
  // Strip markdown emphasis + code fences, then trim each line.
  const cleaned = text
    .replace(/[*`]+/g, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .join('\n');

  let lastMatch: ParsedSpineDecision | null = null;
  for (const m of cleaned.matchAll(re)) {
    const nStr = m[3];
    const n = nStr ? parseInt(nStr, 10) : null;
    lastMatch = {
      verb: m[1]!,
      arg: m[2] ?? null,
      n: Number.isFinite(n) && n !== null && n > 0 ? n : null,
      raw: (m[0] ?? '').trim(),
    };
  }
  return lastMatch;
}

/**
 * Parse the agent's free-form output and extract the last built-in decision verb.
 * Returns null if no recognized verb appears.
 *
 *   parseDecision('Some thinking…\n**NEXT_WORKER F-001**\n')
 *   // → { verb: 'NEXT_WORKER', arg: 'F-001', n: null, raw: 'NEXT_WORKER F-001' }
 *
 *   parseDecision('done')
 *   // → null  (case-sensitive: must be uppercase DONE)
 */
export function parseDecision(text: string): ParsedDecision | null {
  const r = parseDecisionFor(DECISION_VERBS, text);
  return r === null ? null : { ...r, verb: r.verb as DecisionVerb };
}

/**
 * Verbs that may NOT appear in a multi-decision batch — they imply a
 * state change other dispatched items would race against, so they
 * have to be the sole decision in their turn. Anything not in this
 * set (currently only NEXT_WORKER) can batch.
 */
const SOLO_VERBS = new Set<DecisionVerb>([
  'NEXT_VALIDATOR',
  'NEXT_ARCHITECT',
  'NEXT_TESTER',
  'NEXT_SECURITY',
  'NEXT_SCOPER',
  'GENERATE_TESTS',
  'RUN_TESTS',
  'NEXT_MONITOR',
  // P-013/P-014: both imply a state change (crosscheck can revert passed→failing;
  // ui-qa is a post-pass gate), so they run as the sole decision of their turn.
  'NEXT_CROSSCHECK',
  'NEXT_UI_QA',
  'READY_FOR_PROD',
  'FEATURE_FREEZE',
  'NEXT_HARNESS',
  'NEXT_WORKER_CEO_MODE',
  'CONVERTED',
  'ESCALATE',
  'IDLE',
  'DONE',
  'CHECKPOINT',
]);

/**
 * Parse a multi-decision batch. The orchestrator MAY emit multiple
 * decisions in one turn for batchable verbs (NEXT_WORKER on independent
 * features) wrapped in a `DECISIONS … END` envelope:
 *
 *   DECISIONS
 *   NEXT_WORKER F-AUTH-001
 *   NEXT_WORKER F-PAY-007 N=2
 *   NEXT_WORKER F-DOCS-012
 *   END
 *
 * If no envelope is present, falls back to single-decision parsing
 * (parseDecision) and wraps the result in a 1-element array. Returns
 * an empty array on any parse failure.
 *
 * Validation:
 *   - SOLO_VERBS may not appear in a batch with other decisions. If
 *     a batch contains any solo verb, the whole batch is rejected
 *     (returns []). Solo decisions emitted alone — with or without
 *     the envelope — are accepted.
 *   - Duplicate feature ids in the same batch are rejected (return []).
 *   - Empty envelope (DECISIONS … END with nothing between) returns [].
 */
export function parseDecisions(text: string): ParsedDecision[] {
  const cleaned = text.replace(/[*`]+/g, '');
  const envelope =
    /(?:^|\n)\s*DECISIONS\s*\n([\s\S]*?)\n\s*END\b/m.exec(cleaned);
  if (!envelope) {
    // No envelope: treat as legacy single decision.
    const single = parseDecision(text);
    return single ? [single] : [];
  }
  const body = envelope[1];
  const parsed: ParsedDecision[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const decision = parseDecision(line);
    if (!decision) continue; // ignore non-decision lines (comments)
    parsed.push(decision);
  }
  if (parsed.length === 0) return [];

  // If the batch is a single decision, allow solo verbs.
  if (parsed.length === 1) return parsed;

  // Multi-decision batch: every entry must be batchable.
  const hasSolo = parsed.some((d) => SOLO_VERBS.has(d.verb));
  if (hasSolo) return [];

  // Reject duplicate feature ids.
  const seenArgs = new Set<string>();
  for (const d of parsed) {
    if (d.arg) {
      if (seenArgs.has(d.arg)) return [];
      seenArgs.add(d.arg);
    }
  }

  return parsed;
}
