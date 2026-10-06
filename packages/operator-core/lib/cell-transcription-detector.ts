/**
 * cell-transcription-detector.ts — P-017 (c) of unified-agent-state-plane-2026-07-27.
 *
 * "This value has a cell — read it."
 *
 * D-016 records three behaviours as UNCOVERED, one of them: *read a cell instead of
 * transcribing a value*, whose available tier is "DETECTOR + make the right path the
 * lazy path". D-047 row 4 assigns it tier 1+3: orient FOLDS the cell (so reading is
 * cheaper than transcribing), and this detector catches what still slips through.
 *
 * It is a DETECTOR, never a gate. It never refuses a call, never mutates a payload,
 * and never fails a send — it appends an advisory. A gate here would be wrong: the
 * agent may have an entirely legitimate reason to quote a sha (a postmortem, a
 * historical citation), and refusing those would make the tool unusable.
 *
 * ── PRECISION IS THE WHOLE DESIGN, NOT A TUNING KNOB ────────────────────────
 *
 * The repo already paid for this lesson (EI-10949, work_items/complete.ts): a
 * duplicate-detection nudge keyed on the bare phrase /dup(licate)? of/ fired on a
 * completion describing a duplicated TYPE INTERFACE. The conclusion recorded there
 * is the one that governs this file:
 *
 *   "A false positive here is not free … this warning shares a channel with real
 *    ones, and a heuristic that misfires on ordinary prose teaches agents to skim
 *    past the channel entirely — including the time it is right."
 *
 * A bare `[0-9a-f]{7,40}` over agent prose would fire on hashes, ids, hex colours,
 * and half the nouns in a stack trace. So a hit REQUIRES TWO things:
 *
 *   1. a VALUE that matches a cell-backed shape, and
 *   2. a STATE-CLAIM CONTEXT within a small window of it.
 *
 * "see commit abc1234 for the rationale" is a citation — no hit. ":3070 is serving
 * abc1234" is a transcribed cell value — hit. The second is the failure this exists
 * to catch: a value that was TRUE when copied and silently rots in the message.
 *
 * ── WHY THE PATTERN TABLE LIVES HERE AND NOT ON CellSpec ───────────────────
 *
 * The obvious alternative is a `valuePatterns` field on CellSpec so a cell declares
 * its own detectable shapes. Deliberately not done: D-038's contract is ratified at
 * six axes (plus P-019's visibility/federation), and widening it for one detector's
 * convenience would make every future cell author answer a question that has nothing
 * to do with whether their cell is well-formed.
 *
 * The cost is real and is named rather than hidden: **a newly registered cell is NOT
 * automatically detected** — it must be added here. The guard against silent drift is
 * the other direction, which is the one that actually rots: `cell-transcription-detector.test.ts`
 * asserts every `cell` named below IS registered, so a pattern pointing at a cell that
 * was renamed or never shipped fails the suite instead of silently never matching.
 */

/** One detectable transcription: a value shape plus the context that makes it a CLAIM. */
interface TranscriptionPattern {
  /** The registered cell that answers this authoritatively. */
  cell: string;
  /** The field of that cell the value corresponds to. */
  field: string;
  /** Human phrase for the advisory. */
  what: string;
  /** The value shape. MUST be global (`g`) — callers rely on lastIndex scanning. */
  value: RegExp;
  /** Required state-claim context within CONTEXT_WINDOW chars of the value. */
  context: RegExp;
  /** The value is claimed to be a commit sha, so a commit resolver may veto it. */
  commitSha?: boolean;
}

export interface DetectOptions {
  /**
   * Does this hex token name a real commit? `true` keeps the hit, `false` drops it,
   * `null` means "could not tell" and keeps it (fail-open, like the detector itself).
   *
   * EI-24684014950807803: shape alone cannot tell a sha from the other hex ids that
   * travel in coord prose — an agent short id (`c0b38c83` for `su-c0b38c83-…`), a
   * chunk-group id, a contentHash. One exclusion per id kind never converges;
   * resolving the token does. The detector stays PURE and synchronous: a caller that
   * can reach git resolves the tokens first (`cellTranscriptionHintResolvingCommits`
   * in `git-commit-resolver.ts`) and passes the verdicts in here.
   */
  resolvesToCommit?: (token: string) => boolean | null;
}

/**
 * How far either side of a matched value we look for a state-claim context word.
 * Deliberately tight: a sha and the word "deployed" 400 chars apart are usually two
 * unrelated sentences, and widening this trades precision for recall in exactly the
 * direction EI-10949 warns against.
 */
export const CONTEXT_WINDOW = 60;

/**
 * A source checkout's HEAD is not a pipeline position. Keep this anchored to the
 * value's left edge so an unrelated word such as "release" later in the same
 * sentence cannot turn a source citation into a deployment claim.
 */
const SOURCE_HEAD_VALUE_PREFIX =
  /\b(?:current|local|root|source|working(?:\s+tree)?)\s+(?:git\s+)?head(?:\s+(?:sha|commit))?\s*(?:is|=|:)?\s*$/i;

/**
 * If a source HEAD value is explicitly described as deployed/serving/live, it is
 * still a real pipeline claim and must remain detectable. A bare source HEAD next
 * to separate pipeline prose is only a citation and should stay quiet.
 */
const EXPLICIT_PIPELINE_STATE_AFTER_SOURCE_HEAD =
  /^\s*(?:is|was|now|currently)\s+(?:(?:(?:the|a)\s+)?(?:deploy(?:ed|ing|ment)?|serving|serves|live|release[d]?|candidate|gate|green[- ]?checkpoint|staging|main|running|shipped)\b|at\s+:(?:3070|3170)\b)/i;

/**
 * A target/reference commit is often mentioned next to the pipeline words that
 * describe what will be checked about it (for example, "validate target commit
 * abc1234 main/deployed ancestry"). That is a citation, not a transcription of
 * the current pipeline position. Keep the exception narrow and retain a hit when
 * the value is explicitly followed by a live-state claim ("is deployed", etc.).
 */
const REFERENCE_COMMIT_PREFIX =
  /\b(?:target|reference|historical|prior|baseline|validate|check|verify|prove|trace|inspect|confirm|test|assert|ensure)\b[^\n]{0,50}\bcommit\s*$/i;

const EXPLICIT_PIPELINE_STATE_AFTER_VALUE =
  /^\s*(?:is|was|now|currently)\s+(?:(?:(?:the|a)\s+)?(?:deploy(?:ed|ing|ment)?|serving|serves|live|release[d]?|staging|main|running|shipped)\b|at\s+:(?:3070|3170)\b)/i;

/**
 * A commit explicitly described as committed locally/on staging is path evidence,
 * not evidence that the commit is the deployed pipeline position. Keep this tied to
 * the value's `commit` label and its immediate state phrase: a generic `staging`
 * mention elsewhere must still keep ordinary staging-position claims detectable.
 */
const STAGING_ONLY_COMMIT_PREFIX = /\bcommit\s*$/i;
const EXPLICIT_STAGING_ONLY_COMMIT_AFTER =
  /^\s+(?:was\s+)?committed\s+(?:locally\s*\/\s*on\s+staging|on\s+staging)\b/i;

/**
 * Lock and lease ids are hex-shaped by design, but they are not Git state. Keep
 * this exclusion anchored to the value so an unrelated lock mention elsewhere in
 * a message cannot suppress a real deployment claim. The qualifier list covers the
 * labels used by the coordination/resource-lock surfaces (including the
 * backtick-quoted id in `desktop-sidecar lock `cac76150``).
 */
const LOCK_OR_LEASE_VALUE_PREFIX =
  /\b(?:lock|lease)(?:[-\s]+(?:id|identifier|token|key|prefix|handle|value|uuid)){0,2}\s*(?:[:=#]\s*|["'`]\s*)?$/i;
const LOCK_OR_LEASE_VALUE_SUFFIX =
  /^\s*["'`]?\s*(?:(?:is|was)\s+)?(?:an?\s+)?(?:lock|lease)(?:[-\s]+(?:id|identifier|token|key|prefix|handle|value|uuid)){0,2}\b/i;

function isExplicitLockOrLeaseIdentifier(haystack: string, valueStart: number, valueLength: number): boolean {
  const before = haystack.slice(Math.max(0, valueStart - CONTEXT_WINDOW), valueStart);
  const afterStart = valueStart + valueLength;
  const after = haystack.slice(afterStart, Math.min(haystack.length, afterStart + CONTEXT_WINDOW));
  return LOCK_OR_LEASE_VALUE_PREFIX.test(before) || LOCK_OR_LEASE_VALUE_SUFFIX.test(after);
}

/**
 * A work-item checkpoint's contentHash is an artifact fingerprint, not a Git or
 * deployment SHA. The label is often immediately adjacent to the value (for
 * example, `checkpoint 721...` or `(contentHash 562...)`), while an unrelated
 * phrase such as "live Vite locks" appears later in the same coord summary. Keep
 * this exclusion anchored to the value so that ordinary checkpoint prose does not
 * weaken the detector's state-claim context globally.
 */
const CHECKPOINT_VALUE_PREFIX = /\bcheckpoint\s*$/i;
const CONTENT_HASH_VALUE_PREFIX = /\bcontent[- ]?hash\s*(?::|=)?\s*$/i;

/**
 * Memory-store identifiers are often rendered as their leading eight hex digits.
 * A nearby word like "live" can satisfy the broad pipeline context window, but the
 * immediate `memory <id>` label identifies an artifact id rather than a Git SHA.
 */
const MEMORY_ID_VALUE_PREFIX =
  /\b(?:memory(?:[-\s]+(?:id|identifier))?|mem0(?:[-\s]+memory)?(?:[-\s]+(?:id|identifier))?)\s*(?:[:=#]\s*)?$/i;

/**
 * Git blob object ids are hex-shaped, but a blob is an object artifact rather than
 * a commit or pipeline position. Keep this exclusion anchored to the value: the
 * reported `InboxPane staging blob <sha>` shape must stay quiet even though
 * `staging` is a valid pipeline context word nearby, while an unrelated `blob`
 * mention elsewhere cannot suppress a real deployment claim.
 */
const GIT_BLOB_VALUE_PREFIX =
  /\b(?:git\s+)?blob(?:[-\s]+(?:id|identifier|hash|sha|oid)){0,2}\s*(?:[:=]\s*)?$/i;

/**
 * coord:send prepends these exact generated lines to over-cap message parts. The
 * 8-hex group id is a content fingerprint, not an authored pipeline position;
 * nearby prose such as ":3070 is serving" must not turn it into a cell hit even
 * when that short id happens to resolve to a Git commit. Mask the whole generated
 * line while preserving offsets and the surrounding authored text.
 */
const GENERATED_COORD_CHUNK_HEADER_LINE = /^⟦part \d+\/\d+ g:[0-9a-f]{8}(?: cont)?⟧\r?$/gm;

function maskGeneratedCoordChunkHeaders(text: string): string {
  return text.replace(GENERATED_COORD_CHUNK_HEADER_LINE, (header) => ' '.repeat(header.length));
}

function isCheckpointMetadataValue(haystack: string, valueStart: number): boolean {
  const before = haystack.slice(Math.max(0, valueStart - CONTEXT_WINDOW), valueStart);
  return CHECKPOINT_VALUE_PREFIX.test(before) || CONTENT_HASH_VALUE_PREFIX.test(before);
}

function isExplicitMemoryIdentifier(haystack: string, valueStart: number): boolean {
  const before = haystack.slice(Math.max(0, valueStart - CONTEXT_WINDOW), valueStart);
  return MEMORY_ID_VALUE_PREFIX.test(before);
}

function isGitBlobHash(haystack: string, valueStart: number): boolean {
  const before = haystack.slice(Math.max(0, valueStart - CONTEXT_WINDOW), valueStart);
  return GIT_BLOB_VALUE_PREFIX.test(before);
}

function isUnlinkedSourceHeadCitation(haystack: string, valueStart: number, valueLength: number): boolean {
  const before = haystack.slice(Math.max(0, valueStart - CONTEXT_WINDOW), valueStart);
  if (!SOURCE_HEAD_VALUE_PREFIX.test(before)) return false;

  const afterStart = valueStart + valueLength;
  const after = haystack.slice(afterStart, Math.min(haystack.length, afterStart + CONTEXT_WINDOW));
  return !EXPLICIT_PIPELINE_STATE_AFTER_SOURCE_HEAD.test(after);
}

function isUnlinkedReferenceCommitCitation(haystack: string, valueStart: number, valueLength: number): boolean {
  const before = haystack.slice(Math.max(0, valueStart - CONTEXT_WINDOW), valueStart);
  if (!REFERENCE_COMMIT_PREFIX.test(before)) return false;

  const afterStart = valueStart + valueLength;
  const after = haystack.slice(afterStart, Math.min(haystack.length, afterStart + CONTEXT_WINDOW));
  return !EXPLICIT_PIPELINE_STATE_AFTER_VALUE.test(after);
}

function isStagingOnlyCommitCitation(haystack: string, valueStart: number, valueLength: number): boolean {
  const before = haystack.slice(Math.max(0, valueStart - CONTEXT_WINDOW), valueStart);
  if (!STAGING_ONLY_COMMIT_PREFIX.test(before)) return false;

  const afterStart = valueStart + valueLength;
  const after = haystack.slice(afterStart, Math.min(haystack.length, afterStart + CONTEXT_WINDOW));
  return EXPLICIT_STAGING_ONLY_COMMIT_AFTER.test(after);
}

/**
 * ⚠ Every `cell` here must be REGISTERED — asserted by the test suite.
 *
 * Both patterns currently point at `git.pipelinePosition`, which genuinely answers
 * both: its shape is
 * `{ positions, positionsUnknown[], stages[], serving, changeInCandidate, gitSync, sweepExposure, summary }`.
 * P-007 splits out finer-grained cells (`git.mainBehindStaging`, `deploy.3070.sha`);
 * when those register, re-point these `cell`/`field` values at them — the advisory
 * text is generated from these fields, so it follows automatically.
 */
const PATTERNS: readonly TranscriptionPattern[] = [
  {
    cell: 'gate.greenCheckpoint.candidate',
    field: 'changeInCandidate.judgingSha',
    what: 'a commit sha stated as the green-checkpoint candidate',
    // Candidate state has its own registered cell. Keep it ahead of the generic
    // pipeline-position pattern and do not let a gate candidate be described as
    // the deployed/serving commit.
    value: /(?<![0-9A-Za-z#-])(?=[0-9a-f]{7,40}(?![0-9A-Za-z-]))[0-9a-f]*[a-f][0-9a-f]*(?![0-9A-Za-z-])/gi,
    context: /\b(candidate|green[- ]?checkpoint)\b/i,
    commitSha: true,
  },
  {
    cell: 'git.pipelinePosition',
    field: 'positions.deployed / serving.startedSinceCodeChange',
    what: 'a commit sha stated as the deployed/serving/gate position',
    // 7-40 hex, REQUIRING at least one a-f letter: a pure-digit run like "1234567" is
    // a number far more often than a sha, and admitting it is a large false-positive
    // surface for no recall worth having.
    //
    // ⚠ The lookaround is load-bearing, and a plain `\b` is NOT enough — this was a
    // real false positive caught by the suite, not a hypothetical. `\b` treats `-` as a
    // boundary, so every AGENT ID matched: `su-8d9a671c-ccda-4aa9-b4f4-8f0d1c7a4804`
    // offers `8d9a671c` and `8f0d1c7a4804` as "shas", and ids travel in coord messages
    // beside words like "live" constantly — it would have fired on a large share of
    // real traffic, which is exactly the EI-10949 channel-poisoning failure.
    //
    // So the run must not ABUT an alphanumeric, a hyphen, or a '#': that excludes uuid
    // segments (both interior and leading, via the trailing lookahead), hyphenated
    // identifiers, and hex colours, while leaving a standalone sha untouched.
    value: /(?<![0-9A-Za-z#-])(?=[0-9a-f]{7,40}(?![0-9A-Za-z-]))[0-9a-f]*[a-f][0-9a-f]*(?![0-9A-Za-z-])/gi,
    context:
      /\b(deploy(ed|ing|ment)?|serving|serves|live|release[d]?|staging|main|:3070|:3170|running|shipped)\b/i,
    commitSha: true,
  },
  {
    cell: 'git.pipelinePosition',
    field: 'positions / gitSync',
    what: 'a branch behind/ahead count stated as current pipeline state',
    value: /(?<![A-Za-z0-9#-])\d{1,4}\s+commits?\b|\bbehind\s+by\s+\d{1,4}\b/gi,
    context: /\b(behind|ahead|main|staging|origin|unpushed|not\s+pushed|sync)\b/i,
  },
] as const;

export interface CellTranscription {
  /** The registered cell that answers this authoritatively. */
  cell: string;
  /** The field of that cell. */
  field: string;
  /** The exact text matched. */
  value: string;
  /** What kind of transcription this is, for the advisory. */
  what: string;
}

/** Case/whitespace-insensitive key so the same sha claimed twice reports once. */
function dedupeKey(hit: CellTranscription): string {
  return `${hit.cell}::${hit.value.toLowerCase().replace(/\s+/g, ' ')}`;
}

/**
 * PURE. Find values in `text` that a registered cell answers authoritatively.
 *
 * Returns [] for anything unparseable, empty, or oversized — a detector that throws
 * inside a `coord:send` would turn an advisory into an outage, which is the one
 * failure mode a tier-3 mechanism must never have.
 */
export function detectCellTranscriptions(text: unknown, options: DetectOptions = {}): CellTranscription[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  // Bound the work: a 100KB message body is not worth a full scan, and the scan is
  // on the hot path of every send.
  const boundedText = text.length > 20_000 ? text.slice(0, 20_000) : text;
  const haystack = maskGeneratedCoordChunkHeaders(boundedText);

  const out: CellTranscription[] = [];
  const seen = new Set<string>();

  for (const p of PATTERNS) {
    // Fresh regex per scan: a module-level /g regex carries lastIndex between calls,
    // so sharing one across invocations makes results depend on call ORDER — a
    // genuinely nasty intermittent this avoids by construction.
    const re = new RegExp(p.value.source, p.value.flags.includes('g') ? p.value.flags : `${p.value.flags}g`);
    let m: RegExpExecArray | null;
    while ((m = re.exec(haystack)) !== null) {
      // Zero-length match guard — without this a pattern that can match empty spins forever.
      if (m[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      const start = Math.max(0, m.index - CONTEXT_WINDOW);
      const end = Math.min(haystack.length, m.index + m[0].length + CONTEXT_WINDOW);
      const window = haystack.slice(start, end);
      if (!p.context.test(window)) continue; // a citation, not a claim

      // A broad context window is intentional for ordinary pipeline prose, but it
      // must not connect a source `current HEAD <sha>` to a separate nearby
      // "release"/"staging" sentence. Only an explicit state phrase attached to
      // that HEAD value keeps it classified as a deployment claim.
      if (
        isExplicitLockOrLeaseIdentifier(haystack, m.index, m[0].length) ||
        isExplicitMemoryIdentifier(haystack, m.index) ||
        (p.field === 'positions.deployed / serving.startedSinceCodeChange' &&
          (isUnlinkedSourceHeadCitation(haystack, m.index, m[0].length) ||
            isUnlinkedReferenceCommitCitation(haystack, m.index, m[0].length) ||
            isStagingOnlyCommitCitation(haystack, m.index, m[0].length) ||
            isCheckpointMetadataValue(haystack, m.index) ||
            isGitBlobHash(haystack, m.index)))
      ) {
        continue;
      }

      if (p.commitSha && options.resolvesToCommit && resolvesSafely(options.resolvesToCommit, m[0]) === false) {
        continue; // hex-shaped, but not a commit — an agent id, hash, or other artifact id
      }

      const hit: CellTranscription = { cell: p.cell, field: p.field, value: m[0], what: p.what };
      const key = dedupeKey(hit);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(hit);
    }
  }
  return out;
}

function resolvesSafely(resolve: (token: string) => boolean | null, token: string): boolean | null {
  try {
    return resolve(token);
  } catch {
    return null;
  }
}

/**
 * Render the advisory. Names the CELL and the tool that reads it, because "this value
 * has a cell" is useless without the call that replaces the transcription — the same
 * reason D-016 prefers making the right path the lazy path over exhorting people onto it.
 */
export function formatCellTranscriptionHint(hits: CellTranscription[]): string | null {
  if (hits.length === 0) return null;
  const listed = hits
    .slice(0, 3)
    .map((h) => `"${h.value}" (${h.what} — cell \`${h.cell}\`, field ${h.field})`)
    .join('; ');
  const more = hits.length > 3 ? ` …and ${hits.length - 3} more` : '';
  return (
    `this text states ${hits.length} value(s) that a registered CELL answers authoritatively: ${listed}${more}. ` +
    'A transcribed value was true when you copied it and rots silently afterwards — the reader cannot tell a ' +
    'stale one from a fresh one. Prefer naming the cell so the reader resolves it live (state:read / the orient ' +
    'fold). If you are deliberately quoting HISTORICAL state, say so in the text — this is an advisory, nothing ' +
    'was blocked or changed.'
  );
}

/** Convenience: detect + format in one call. Returns null when there is nothing to say. */
export function cellTranscriptionHint(text: unknown, options: DetectOptions = {}): string | null {
  return formatCellTranscriptionHint(detectCellTranscriptions(text, options));
}

/**
 * One suggested `dependsOn` cell, plus the evidence that produced it (P-007).
 *
 * The evidence travels WITH the suggestion on purpose: a bare "depend on X" is an
 * assertion the caller has to take on faith, while "you wrote '<value>', which cell X
 * answers" is a claim they can check in the text they just typed. That difference is
 * what makes an unwanted suggestion cheap to dismiss instead of confusing.
 */
export interface DependsOnSuggestion {
  /** The registered cell to depend on. */
  cell: string;
  /** The exact text in the body that a cell answers authoritatively. */
  value: string;
  /** What kind of transcription it is, for the advisory. */
  what: string;
}

/** Never suggest more than this many cells — see the rationale in {@link suggestDependsOnCells}. */
export const MAX_DEPENDS_ON_SUGGESTIONS = 3;

/**
 * PURE. Which cells a fact body transcribes and therefore ought to DEPEND ON (P-007).
 *
 * A fact whose body states a live value silently rots: the value was true when written
 * and nothing re-checks it. Declaring `dependsOn` for the cell that answers that value
 * is what arms staleness detection, so the body itself is decent evidence of which
 * dependency was meant.
 *
 * PRECISION-FIRST (EI-10949) — this is the whole design constraint, not a footnote.
 * EI-10949 is a detector that fired on the bare word "duplicate" with no work-item id
 * near it; its lesson is that a heuristic must not state a derived conclusion with more
 * confidence than its evidence supports, and its cost model is that every false positive
 * is "a small tax on trusting the REAL warnings from the same tool". `facts:assert`
 * already emits several genuinely load-bearing disclosures (truncation, unresolved
 * dependencies, eviction/survival, the P-006 normalization receipt), so a chatty
 * suggestion here does not merely annoy — it devalues those. Four guards, in order:
 *
 *  1. Reuse {@link detectCellTranscriptions} rather than matching loosely here. It already
 *     requires a state-claim CONTEXT word within {@link CONTEXT_WINDOW} (60) chars of the
 *     value — that proximity requirement IS the corroborating token EI-10949 prescribes —
 *     and it already rejects the "a citation, not a claim" and unlinked-source-HEAD cases.
 *  2. Never suggest a cell the caller ALREADY declared. Restating a caller's own input as
 *     advice is the purest form of the tax above.
 *  3. Collapse to ONE suggestion per cell. The detector dedupes by cell+value because it is
 *     reporting transcriptions; a dependency is per-CELL, so three sha mentions are one
 *     dependency, not three.
 *  4. Cap the list. A suggestion list long enough to skim is one nobody reads.
 *
 * Deliberately NOT done here: attaching the dependency. The spec is suggestion-only until
 * precision is MEASURED in production — auto-attaching would write a caller-visible field
 * off a regex, and a wrong dependency is worse than none because it reports a fact stale
 * (or fresh) on the wrong subject's account.
 *
 * Fail-soft like its detector: returns [] for anything unparseable rather than throwing.
 */
export function suggestDependsOnCells(
  body: unknown,
  declaredCells: readonly string[] = [],
  options: DetectOptions = {},
): DependsOnSuggestion[] {
  const declared = new Set(
    declaredCells.map((c) => (typeof c === 'string' ? c.trim().toLowerCase() : '')).filter(Boolean),
  );

  const out: DependsOnSuggestion[] = [];
  const seenCells = new Set<string>();

  for (const hit of detectCellTranscriptions(body, options)) {
    const cellKey = hit.cell.toLowerCase();
    if (declared.has(cellKey)) continue; // guard 2
    if (seenCells.has(cellKey)) continue; // guard 3
    seenCells.add(cellKey);
    out.push({ cell: hit.cell, value: hit.value, what: hit.what });
    if (out.length >= MAX_DEPENDS_ON_SUGGESTIONS) break; // guard 4
  }

  return out;
}
