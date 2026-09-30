/**
 * prior-attempt-rungs — the ONE extractor that turns free prose into the structured
 * rungs a claim-time briefing compresses against
 * (effort-scoped-continuity-2026-09-02, D-010).
 *
 * WHY ITS OWN MODULE. D-010's fix is to run the READER'S extractor at WRITE time, so
 * an author can see what its note will and will not yield. That gives the extractor
 * two callers — the briefing compiler (prior-attempt-context.ts) and the capture path
 * (effort-thread.ts) — which would otherwise import each other in a cycle. It is also
 * the correct factoring on its own terms: these regexes are the definition of what a
 * "root cause" or a "false premise" IS in this system, and a second copy of them
 * would drift from the first exactly as the derived-truth ladder warns.
 *
 * ⚠ These rungs are KEYWORD-MATCHED PROSE, not data the writer supplies. Measured
 * 2026-09-02 against the live corpora: applying these same patterns to carry_notes
 * WHERE scope LIKE 'workitem:%' (10,325 rows) yields rootCause 4.4%, falsePremise
 * 2.5%, residue 8.9%; to coord_thread_posts (33,629 rows) 6.9% / 5.8% / 8.7%. So a
 * consumer must treat an empty rung as the COMMON case and degrade explicitly, never
 * emit a hollow record that looks like history.
 *
 * Re-check for staleness: re-run those regex-filtered counts. A materially higher
 * rootCause share means D-010 has gone stale, which is the intended outcome of the
 * write-time advisory.
 */

const FILE_RE = /(?:^|[\s`("'])([A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.+-]+)+\.[A-Za-z0-9_-]+)(?=$|[.\s`),:"'])/g;
const TEST_RE = /(?:^|\s)((?:npm|pnpm|yarn)\s+(?:run\s+)?test[^\n;]*|(?:vitest|jest|pytest|cargo\s+test)\s+[^\n;]*)/gi;

/** The trigger vocabulary, named once. The write-time advisory teaches these words;
 *  the reader matches them. Same source, so the lesson cannot drift from the check. */
export const RUNG_PATTERNS = {
  rootCauses: /\b(?:root\s*cause|origin(?:ates|ated)?\s+at)\b/gi,
  falsePremises: /\b(?:false\s+premise|retract(?:ed|ion)?|was\s+wrong|incorrect\s+assumption)\b/gi,
  residue: /\b(?:residue|remaining|follow[- ]?up|still\s+open|deferred)\b/gi,
} as const;

export function boundedLine(text: string, max = 1200): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

export function markedFragments(text: string, labels: RegExp): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    labels.lastIndex = 0;
    if (!labels.test(line)) continue;
    labels.lastIndex = 0;
    const value = boundedLine(line.replace(labels, '').replace(/^\s*[:—-]\s*/, ''), 500);
    if (value) out.push(value);
  }
  return [...new Set(out)].slice(0, 12);
}

export function filesIn(text: string): string[] {
  const out: string[] = [];
  FILE_RE.lastIndex = 0;
  for (const match of text.matchAll(FILE_RE)) out.push(match[1]!);
  return [...new Set(out)].slice(0, 40);
}

export function testsIn(text: string): string[] {
  TEST_RE.lastIndex = 0;
  const commands = [...text.matchAll(TEST_RE)].map((match) => boundedLine(match[1]!, 500));
  const namedFiles = filesIn(text).filter((path) => /(?:^|\/)(?:__tests__\/|[^/]+\.(?:test|spec)\.)/i.test(path));
  return [...new Set([...commands, ...namedFiles])].slice(0, 30);
}

/** The rungs the reader derives from free prose. */
export interface PriorAttemptRungs {
  rootCauses: string[];
  falsePremises: string[];
  residue: string[];
  touchedFiles: string[];
  tests: string[];
}

export function extractPriorAttemptRungs(text: string): PriorAttemptRungs {
  return {
    rootCauses: markedFragments(text, RUNG_PATTERNS.rootCauses),
    falsePremises: markedFragments(text, RUNG_PATTERNS.falsePremises),
    residue: markedFragments(text, RUNG_PATTERNS.residue),
    touchedFiles: filesIn(text),
    tests: testsIn(text),
  };
}

/** Whether a body reads as a retraction — the predicate that promotes a source to
 *  `retraction` authority. Shares `falsePremises`' vocabulary by construction. */
export function retractionText(text: string): boolean {
  RUNG_PATTERNS.falsePremises.lastIndex = 0;
  const hit = RUNG_PATTERNS.falsePremises.test(text);
  RUNG_PATTERNS.falsePremises.lastIndex = 0;
  return hit;
}
