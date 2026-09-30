/**
 * Equivalence pairs — the FILE-READ family (plan
 * `bash-to-tool-substitution-2026-07-26`, P-005).
 *
 * Population: `sed -n 'N,Mp'`, `cat FILE`, `head`/`tail` against a path.
 * Proposed replacement: `capability:read` (3 uses in the 7d window, against
 * ~3,920 bash file reads — the single worst adoption gap in the audit).
 *
 * ── What sampling the real corpus changed about this item ────────────────────
 * The plan assumed one "file-read family" verdict. The corpus says that would
 * have been wrong in both directions:
 *
 *  1. `head`/`tail` are dominated by PIPE FILTERS, not file reads — 11,381
 *     `head` atoms but only 408 distinct, because the overwhelming form is
 *     `… | head -20` with no file operand at all. Those are stream shaping, and
 *     no file-read tool replaces them. They must be excluded by the PATTERN,
 *     not merely rejected by the envelope.
 *  2. `cat` includes heredoc WRITES (`cat > /tmp/x << 'EOF'`), which are the
 *     opposite of a read and must never attract a "use capability:read" nudge.
 *
 * So this family is four narrow patterns, not one broad one — per D-008, the
 * pattern is the unit of enforcement, so a pattern is narrowed until every
 * command it claims has a faithful tool expression.
 *
 * ── The envelope, read from the tool, not assumed ────────────────────────────
 * `capability:read` (packages/operator-core/lib/agent-tools/capability/read.ts)
 * takes line windows (`offset`/`limit`/`tail`) and exact byte pages
 * (`byte_offset`/`byte_limit`). Notably:
 *  • An ABSOLUTE path bypasses the capability base dir entirely, so /tmp and
 *    /var/log — a large share of real targets — ARE readable. The plan flagged
 *    this as a risk; it is not one.
 *  • Line windowing supports both start-anchored ranges and `tail: N`.
 *  • Byte pages are start-offset, bounded, and returned as structured base64.
 *    That is useful for exact/resumable inspection, but it is not the raw-byte
 *    stdout emitted by `head -c` / `tail -c`; tail bytes also need an
 *    EOF-relative offset the tool does not accept. Those commands therefore
 *    remain outside this answer-equivalent substitution family.
 *  • One `file_path` per call.
 */

import type { AnswerEnvelope, CoverageResult, ReplayToolCall, BashSubstitutionPair } from '../types';

/**
 * ⚠ THIS FAMILY TEACHES, IT DOES NOT BLOCK — and that is a settled ruling, not a
 * tier nobody got around to raising (D-045, superseding D-044).
 *
 * These four rows were promoted to `deny` on 2026-08-18 and rolled back the same
 * hour. The rollback is the instructive part, so it is recorded here rather than
 * only in the plan: matching is per-ATOM and `atomize` splits a pipeline into its
 * stages, so the pattern never sees the pipe. `cat FILE | grep X` presents as the
 * bare atom `cat FILE` and is claimed. At `advise` that is a slightly-off
 * suggestion; at `deny` it HARD-FAILED a command whose advised replacement cannot
 * serve it, because `capability:read` returns a numbered, headed, paged rendering
 * rather than the raw stdout the next stage consumes.
 *
 * The blast-radius test did not catch it: all 15 of its cases were bare atoms, so
 * the entire pipeline class was structurally invisible to a guard that looked
 * thorough. A well-formed test gave complete false assurance.
 *
 * The standing rule this produced (owner, 2026-08-18): guidance fires ONLY where
 * the tool is a fully equivalent substitute for what the agent actually wrote.
 * That is now enforced for this family in `match.ts` — a `capability:read` row is
 * suppressed when the matched atom's stdout feeds a pipe.
 *
 * Every form `capability:read` cannot express — piped stdin filters, heredocs and
 * redirects, `cat -A/-v/-e/-t`, `-c` byte windows, `tail -f`, `cat -` — is OUTSIDE
 * these patterns by D-008 and must stay outside.
 */

/**
 * How to strip `capability:read`'s framing to reach the file content (P-021).
 *
 * Every pattern here is copied from the tool's own handler rather than guessed,
 * because a normalizer that strips slightly the wrong thing is how an output-diff
 * harness reports a clean sweep it did not earn:
 *
 *  • header  — `${abs} (${n} lines[, showing a–b])`, emitted once at the top.
 *  • prefix  — `${String(n).padStart(6)}\t`, one per line.
 *  • footer  — `\n\n… [${k} more lines — re-read with offset=${x}]`, when paged.
 *
 * The header pattern carries a `(?!\s*\d+\t)` guard, which is the whole reason it
 * is written out rather than approximated. Header stripping runs BEFORE prefix
 * stripping, so at that moment every content line still wears its line number —
 * and a real file line reading `foo (3 lines)` would otherwise match the header
 * pattern and be deleted as framing. The guard says "framing has no line number",
 * which is exactly what distinguishes the two.
 *
 * NOT stripped, deliberately: the `(empty)` body the tool emits for an empty
 * slice. It is framing, but no pattern can distinguish it from a file whose
 * content is the literal text `(empty)`, and inventing one to make a case pass
 * would be the normalizer deciding the verdict. An empty-file replay therefore
 * reports `differs`, which is the honest answer — the two sides genuinely return
 * different bytes there.
 */
const CAPABILITY_READ_ENVELOPE: AnswerEnvelope = {
  stripLeadingLines: /^(?!\s*\d+\t).*\(\d+ lines(?:, showing \d+–\d+)?\)$/,
  stripLinePrefix: /^\s*\d+\t/,
  stripTrailing: /\n\n… \[\d+ more lines — re-read with offset=\d+\]$/,
};

/**
 * Build a `capability:read` rewrite from an already-scored atom.
 *
 * Every pair's `rewrite` funnels through here and starts by calling its own
 * `cover()`: a rewrite must never produce a call for an atom the envelope
 * rejected, and re-deriving that judgement independently would let the two drift
 * until the harness replays commands the registry says are not covered.
 */
function readRewrite(
  pair: Pick<BashSubstitutionPair, 'cover'>,
  atom: string,
  args: (parsed: ParsedAtom) => Record<string, unknown> | null,
): ReplayToolCall | null {
  if (!pair.cover(atom).covered) return null;
  const built = args(parseAtom(atom));
  if (!built) return null;
  return { toolName: 'capability:read', args: built };
}

/**
 * `capability:read`'s default page size, mirrored from the tool definition.
 * Exported so `pairs/model-drift.test.ts` can pin it to the tool's real
 * `DEFAULT_LIMIT` (WI-6157/D-015) — the mirror is deliberate, the DRIFT is not.
 */
export const READ_DEFAULT_LIMIT = 2000;

/**
 * `head`'s own default line count when no `-n` is given: POSIX says 10.
 *
 * This constant exists because the P-021 replay harness found it MISSING. Bare
 * `head FILE` fell back to {@link READ_DEFAULT_LIMIT}, so the advisory told the
 * agent to read 2000 lines where `head` returns 10 — a 200x over-read, on a pair
 * whose `equivalent` verdict was entirely honest, because the tool genuinely CAN
 * express the command. Expressibility was answering a different question, and
 * only executing both sides could tell them apart.
 *
 * `tail` had the same default written correctly a few lines down, which is the
 * uncomfortable part: the two were never compared because nothing in the
 * expressibility harness ever put a bash answer next to a tool answer.
 */
export const HEAD_DEFAULT_LINES = 10;

/**
 * Tokens that make an operand unresolvable to a literal path: shell variable
 * expansion, command substitution, or a glob. `capability:read` takes a literal
 * string, so an agent would have to resolve these in a shell first — meaning
 * bash is genuinely the right tool and the pattern must not claim them.
 */
const DYNAMIC_OPERAND = /[$`*?]/;

/**
 * A redirect token, captured as `(fd)(operator)`.
 *
 * The fd matters. `2>/dev/null` and `2>&1` are stderr plumbing that appear on a
 * large share of real read commands and change nothing about the read — the
 * tool simply returns a structured error instead. Only an stdout redirect
 * (`>`, `1>`, `>>`) means the atom WRITES and is therefore not a read at all.
 * Treating every `>` as a write mis-scored a third of the `cat` sample on the
 * harness's first run.
 */
const REDIRECT_TOKEN = /^(\d*)(>>|>|<)/;

/** Flags that consume the following token as their argument (`-n 40`). */
const FLAGS_WITH_ARG = new Set(['-n', '-c', '--lines', '--bytes']);

interface ParsedAtom {
  verb: string;
  flags: string[];
  /** Resolved flag arguments, e.g. `-n` → `40` (from `-n 40`, `-n40`, or `-40`). */
  flagArgs: Map<string, string>;
  operands: string[];
  /** An stdout redirect is present: this atom WRITES, so it is not a read. */
  writes: boolean;
}

/** Whitespace tokeniser that keeps simple quoted spans intact. */
function tokenize(atom: string): string[] {
  return atom.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

function unquote(token: string): string {
  if (token.length >= 2 && (token[0] === '"' || token[0] === "'") && token[token.length - 1] === token[0]) {
    return token.slice(1, -1);
  }
  return token;
}

function parseAtom(atom: string): ParsedAtom {
  const [verbToken, ...rest] = tokenize(atom);
  const flags: string[] = [];
  const flagArgs = new Map<string, string>();
  const operands: string[] = [];
  let writes = false;

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];

    const redirect = REDIRECT_TOKEN.exec(token);
    if (redirect) {
      const [, fd, op] = redirect;
      if (op !== '<' && (fd === '' || fd === '1')) writes = true;
      // A bare `2> file` spends the next token on the target filename.
      if (/^\d*(?:>>|>|<)$/.test(token)) i += 1;
      continue;
    }

    if (token.startsWith('-') && token !== '-') {
      // `-40` / `-n40` / `-c1200`: the count rides on the flag itself.
      const inline = /^-(?:([nc])\s*)?(\d+)$/.exec(token);
      if (inline) {
        flags.push(inline[1] ? `-${inline[1]}` : '-n');
        flagArgs.set(inline[1] ? `-${inline[1]}` : '-n', inline[2]);
        continue;
      }
      flags.push(token);
      // `-n 40`: the count is the NEXT token and must not be mistaken for a file.
      if (FLAGS_WITH_ARG.has(token) && i + 1 < rest.length && /^\d+$/.test(rest[i + 1])) {
        flagArgs.set(token, rest[i + 1]);
        i += 1;
      }
      continue;
    }

    operands.push(unquote(token));
  }

  return { verb: unquote(verbToken ?? ''), flags, flagArgs, operands, writes };
}

/**
 * Pattern fragment excluding atoms this family must never claim:
 *  • `$` / backtick — shell expansion the tool cannot resolve to a literal path
 *  • `{}` — a `find -exec` placeholder, not a real path
 *  • an stdout redirect — a write, not a read
 * Per D-008 these are excluded by the PATTERN rather than merely failed by the
 * envelope, because a pattern that claims them would nudge agents toward a tool
 * that genuinely cannot serve them.
 */
const EXCLUDE_UNEXPRESSIBLE = String.raw`(?![^\n]*[$\`])(?![^\n]*\{\})(?![^\n]*(?:^|\s)1?>)`;

/** Compose a family pattern with the shared exclusions applied. */
function readPattern(body: string): RegExp {
  return new RegExp(`^${EXCLUDE_UNEXPRESSIBLE}${body}`);
}

/**
 * Characters a literal path operand is made of. `:` is included because this
 * box's scratch dirs are named after tool verbs (`…/scratch/ws/coord:inbox/…`).
 * `-` is appended LAST at every use site so it can never open a character range.
 */
const PATH_CHARS = String.raw`A-Za-z0-9_.~@/:+`;

/**
 * EXACTLY ONE literal path — bare, or wholly quoted (a quoted path may contain
 * spaces). An unbalanced quote is deliberately NOT accepted: `atomize` is not a
 * shell parser, so an inlined script payload leaves fragments like
 * `~/mac-flip-e2e.log'` that look like paths and are not.
 */
const ONE_PATH = String.raw`(?:"[${PATH_CHARS} -]+"|'[${PATH_CHARS} -]+'|(?!-)[${PATH_CHARS}-]+)`;

/**
 * Only stderr plumbing may trail the operand. `2>/dev/null` and `2>&1` ride on a
 * large share of real reads and change nothing about them; anything ELSE after
 * the path is a second operand, which `capability:read` cannot express.
 */
const TRAILING_STDERR = String.raw`(?:\s+2>[^\s]+|\s+2>&\d)*\s*$`;

/**
 * The shared operand tail for the whole family: one literal path, then the end
 * of the atom. Matching is per-ATOM (see `match.ts`), so anchoring at `$` asks
 * "is this whole command a single-file read?" — which is exactly the question.
 *
 * ── Why this replaced a trailing `\/` (EI-18799531134810488) ─────────────────
 * `head`/`tail` used to require a SLASH in the operand. The stated intent was
 * only "has a file operand" — the dominant `… | head -20` pipe filter has no
 * operand at all and was already excluded — so the slash was an accident that
 * silently dropped every bare filename: `head -n 20 foo.ts` was unclaimed while
 * the sibling `sed`/`cat` rows claimed the same file. Measured live against the
 * registry, that was the one miss in a 17-case probe battery.
 *
 * Dropping the slash naively re-admits three junk classes the slash had been
 * masking (a real path almost always contains one; a fragment almost never
 * does), all found by re-running the harness over the RAW corpus rather than the
 * frozen sample:
 *   • globs              `head -1 serve-a-*.log`      — no literal path to pass
 *   • atomize fragments  `head ===`, `tail -150 &`, `head -5 a.ts'],`
 *   • inlined script     `tail = data[idx+len(needle):…]`  (EI-18733363666718163)
 * Per D-008 each is excluded by the PATTERN, not apologised for in `cover()`.
 *
 * The same shape then fixed a hole the slash had been hiding in ALL FOUR rows:
 * multi-file reads and globs were being claimed and then failed by the envelope.
 * That never showed up in the recorded verdicts because the frozen 24-atom
 * samples happened to miss them — the population told a different story (head
 * 4/191, tail 11/1879, cat 43/1505, sed 3/3730 claimed-but-unexpressible). All
 * four are now 0.
 */
const SINGLE_FILE_OPERAND = `${ONE_PATH}${TRAILING_STDERR}`;

/**
 * Coverage checks shared by every member of the family: exactly one operand,
 * and that operand a literal path `capability:read` can be handed as-is.
 */
function checkSingleLiteralFile(parsed: ParsedAtom): CoverageResult | null {
  if (parsed.writes) {
    return { covered: false, reason: 'redirects output — this is a write, not a file read' };
  }
  if (parsed.operands.length === 0) {
    return { covered: false, reason: 'no file operand (reads stdin from a pipe); capability:read requires a file_path' };
  }
  if (parsed.operands.length > 1) {
    return {
      covered: false,
      reason: `reads ${parsed.operands.length} files in one call; capability:read takes a single file_path`,
    };
  }
  if (DYNAMIC_OPERAND.test(parsed.operands[0])) {
    return {
      covered: false,
      reason: `operand "${parsed.operands[0]}" is a shell expansion or glob, not a literal path`,
    };
  }
  return null;
}

/**
 * `-c`/`--bytes` emits raw bytes. capability:read can inspect the same bytes,
 * but its byte mode deliberately returns a structured base64 page + cursor.
 * The replay contract only strips framing; it never decodes or rewrites an
 * answer, so treating the two outputs as equivalent would be a false green.
 */
function checkByteWindow(parsed: ParsedAtom): CoverageResult | null {
  if (parsed.flags.some((f) => f === '-c' || f.startsWith('--bytes'))) {
    return {
      covered: false,
      reason: 'byte-count window (-c) emits raw bytes; capability:read byte pages return structured base64',
    };
  }
  return null;
}

/**
 * P-005a — `sed -n 'N,Mp' FILE`: an explicit line range against a real file.
 * The cleanest substitution in the audit: it maps exactly onto offset+limit.
 * The pattern requires a trailing operand so the piped `… | sed -n '1,200p'`
 * stdin-filter form (which has no tool expression) falls outside it.
 */
export const sedRangeRead: BashSubstitutionPair = {
  id: 'file-read.sed-range',
  intentLabel: 'file-range-read',
  bashPattern: readPattern(String.raw`sed\s+-n\s+['"]?\s*\d+\s*,\s*\d+\s*p['"]?\s+${SINGLE_FILE_OPERAND}`),
  toolName: 'capability:read',
  advisoryText:
    "capability:read { file_path, offset, limit } reads a line range directly — sed -n 'N,Mp' FILE is offset=N, limit=M-N+1. " +
    'Line ranges are inclusive: when combining adjacent reads, start the next range at the previous end + 1 (or label each range); overlapping endpoints repeat a source line and can fabricate duplicate-content findings. ' +
    'capability:read is a DEFERRED MCP tool (ToolSearch select:mcp__papercusp-su__capability_read first if not already loaded) ' +
    "— but a Claude Code (psu) session's ambient Read tool takes the SAME { file_path, offset, limit } shape directly, no ToolSearch needed there.",
  routing: {
    want: 'a line RANGE of one file',
    use: '`capability:read { file_path, offset, limit }`',
    insteadOf: "`sed -n 'N,Mp' FILE` (offset=N, limit=M-N+1)",
  },
  expectedVerdict: 'equivalent',
  cover(atom: string): CoverageResult {
    const parsed = parseAtom(atom);
    // Drop the sed script itself (`-n` is a flag; `'1,80p'` parses as an operand).
    const range = parsed.operands.find((op) => /^\s*\d+\s*,\s*\d+\s*p\s*$/.test(op));
    const files = parsed.operands.filter((op) => op !== range);
    const shared = checkSingleLiteralFile({ ...parsed, operands: files });
    if (shared) return shared;

    const match = /(\d+)\s*,\s*(\d+)/.exec(range ?? '');
    if (!match) return { covered: false, reason: 'line range not parseable' };
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (end < start) return { covered: false, reason: `inverted range ${start},${end}` };

    return {
      covered: true,
      expression: `capability:read { file_path: "${files[0]}", offset: ${start}, limit: ${end - start + 1} }`,
    };
  },
  replayEnvelope: CAPABILITY_READ_ENVELOPE,
  rewrite(atom: string): ReplayToolCall | null {
    return readRewrite(sedRangeRead, atom, (parsed) => {
      const range = parsed.operands.find((op) => /^\s*\d+\s*,\s*\d+\s*p\s*$/.test(op));
      const files = parsed.operands.filter((op) => op !== range);
      const match = /(\d+)\s*,\s*(\d+)/.exec(range ?? '');
      if (!match || files[0] === undefined) return null;
      const start = Number(match[1]);
      const end = Number(match[2]);
      return { file_path: files[0], offset: start, limit: end - start + 1 };
    });
  },
};

/**
 * P-005b — `cat FILE`: whole-file read of one literal path. The pattern
 * excludes heredocs and redirects (writes), and `cat -` (stdin).
 *
 * `-n`/`--number` is the one flag admitted: `capability:read` returns the file
 * WITH line numbers, so `cat -n FILE` is a faithful substitution. `cat -A`/`-v`
 * are not — showing non-printing characters is a different intent with no tool
 * form, so per D-008 they fall outside the pattern rather than being claimed and
 * then quietly mis-expressed (they were, on 32 real atoms).
 */
export const catFileRead: BashSubstitutionPair = {
  id: 'file-read.cat-file',
  intentLabel: 'file-whole-read',
  bashPattern: readPattern(String.raw`cat\s+(?:(?:-n|--number)\s+)?${SINGLE_FILE_OPERAND}`),
  toolName: 'capability:read',
  advisoryText:
    'capability:read { file_path } returns the file with line numbers, paged at 2000 lines — no shell round-trip. ' +
    'capability:read is a DEFERRED MCP tool (ToolSearch select:mcp__papercusp-su__capability_read first if not already loaded) ' +
    "— but a Claude Code (psu) session's ambient Read tool reads the whole file the same way with no args (it just does not number lines).",
  routing: {
    want: 'the WHOLE of one file',
    use: '`capability:read { file_path }`',
    insteadOf: '`cat FILE` (a heredoc or redirect is a WRITE — not this)',
  },
  expectedVerdict: 'equivalent',
  cover(atom: string): CoverageResult {
    const parsed = parseAtom(atom);
    if (/<</.test(atom)) return { covered: false, reason: 'heredoc — this is a write, not a read' };
    // Mirrors the pattern's exclusion, and deliberately so: `tail -f` sets the
    // convention that an excluded intent is ALSO unexpressible here. If the
    // pattern's exclusion ever regresses, such an atom reaches this envelope,
    // scores NOT covered, and flips the recorded verdict — loudly. Scoring it
    // covered instead would let a wrong advisory ship in silence.
    if (parsed.flags.some((f) => /^-[Avet]+$|^--(show-|binary)/.test(f))) {
      return {
        covered: false,
        reason: 'renders non-printing characters (-A/-v/-e/-t); capability:read returns text only',
      };
    }
    const shared = checkSingleLiteralFile(parsed);
    if (shared) return shared;
    return {
      covered: true,
      expression: `capability:read { file_path: "${parsed.operands[0]}" }` +
        ` // paged at ${READ_DEFAULT_LIMIT} lines; re-read with offset for more`,
    };
  },
  replayEnvelope: CAPABILITY_READ_ENVELOPE,
  rewrite(atom: string): ReplayToolCall | null {
    return readRewrite(catFileRead, atom, (parsed) =>
      parsed.operands[0] === undefined ? null : { file_path: parsed.operands[0] },
    );
  },
};

/**
 * P-005c — `head -n N FILE`: the first N lines of a real file. Maps onto
 * `limit`. The pattern requires a file operand so the dominant `… | head -20`
 * pipe-filter form is excluded.
 */
export const headFileRead: BashSubstitutionPair = {
  id: 'file-read.head',
  intentLabel: 'file-head-read',
  bashPattern: readPattern(String.raw`head\s+(?:-n\s*\d+\s+|-\d+\s+)?${SINGLE_FILE_OPERAND}`),
  toolName: 'capability:read',
  advisoryText:
    'capability:read { file_path, limit: N } returns the first N lines — the head -n N FILE equivalent. ' +
    'capability:read is a DEFERRED MCP tool (ToolSearch select:mcp__papercusp-su__capability_read first if not already loaded) ' +
    "— but a Claude Code (psu) session's ambient Read tool takes the same limit: N directly, no ToolSearch needed there.",
  routing: {
    want: 'the FIRST N lines of a file',
    use: '`capability:read { file_path, limit: N }`',
    insteadOf: '`head -n N FILE` (a `… | head` pipe filter is not this)',
  },
  expectedVerdict: 'equivalent',
  cover(atom: string): CoverageResult {
    const parsed = parseAtom(atom);
    const byteWindow = checkByteWindow(parsed);
    if (byteWindow) return byteWindow;
    const shared = checkSingleLiteralFile(parsed);
    if (shared) return shared;

    const limit = parsed.flagArgs.get('-n') ?? String(HEAD_DEFAULT_LINES);
    return {
      covered: true,
      expression: `capability:read { file_path: "${parsed.operands[0]}", limit: ${limit} }`,
    };
  },
  replayEnvelope: CAPABILITY_READ_ENVELOPE,
  rewrite(atom: string): ReplayToolCall | null {
    return readRewrite(headFileRead, atom, (parsed) => {
      if (parsed.operands[0] === undefined) return null;
      // Mirrors `cover()`'s default exactly — deliberately, so the replay
      // measures the envelope rather than a corrected copy of it. That is how
      // the `HEAD_DEFAULT_LINES` bug below was caught: both sides said 2000, the
      // replay said 10, and the disagreement was the finding.
      const limit = parsed.flagArgs.get('-n') ?? String(HEAD_DEFAULT_LINES);
      return { file_path: parsed.operands[0], limit: Number(limit) };
    });
  },
};

/**
 * P-005d — `tail -n N FILE`: the LAST N lines of a real file.
 *
 * This was the family's genuine gap, and finding it is what this audit was for.
 * `capability:read` originally windowed forward from line 1 only, so the single
 * most common real file read on this box — checking the end of a build or gate
 * log, 1,752 atoms across 63 sessions — had NO tool expression at all. Naive
 * enforcement would have nudged every one of those agents toward a tool that
 * could not do the job, which is precisely the failure D-001 exists to prevent.
 *
 * Closed by widening the tool rather than by lowering the bar: `capability:read`
 * now takes `tail: N`. Streaming (`tail -f`) remains a different intent. Byte
 * windows (`-c`) remain outside because byte mode returns structured base64
 * rather than raw stdout, and has no EOF-relative byte offset.
 */
export const tailFileRead: BashSubstitutionPair = {
  id: 'file-read.tail',
  intentLabel: 'file-tail-read',
  // `-f`/`--follow` and `-c` are excluded by the pattern: a stream follow and a
  // raw-byte stdout window are different answer shapes, so per D-008 they fall
  // outside rather than dragging the verdict down.
  bashPattern: readPattern(
    String.raw`tail\s+(?!-f\b)(?!--follow\b)(?!-c\b)(?:-n\s*\d+\s+|-\d+\s+)?${SINGLE_FILE_OPERAND}`,
  ),
  toolName: 'capability:read',
  advisoryText:
    'capability:read { file_path, tail: N } returns the last N lines — the tail -n N FILE equivalent. ' +
    'capability:read is a DEFERRED MCP tool — ToolSearch select:mcp__papercusp-su__capability_read before calling it. ' +
    "A Claude Code (psu) session's ambient Read tool has NO tail param (offset/limit only, counted from the START) — " +
    'passing tail to Read fails with InputValidationError (EI-18856178945306155); you need the deferred capability:read tool here, not the ambient one.',
  routing: {
    want: 'the LAST N lines of a file (a build / gate log tail)',
    use: '`capability:read { file_path, tail: N }`',
    insteadOf: '`tail -n N FILE` (`tail -f` streaming has no tool form — keep using bash)',
  },
  expectedVerdict: 'equivalent',
  cover(atom: string): CoverageResult {
    const parsed = parseAtom(atom);
    if (parsed.flags.includes('-f') || parsed.flags.includes('--follow') || /--pid=/.test(atom)) {
      return { covered: false, reason: 'follow mode (tail -f) — capability:read has no streaming form' };
    }
    const byteWindow = checkByteWindow(parsed);
    if (byteWindow) return byteWindow;
    const shared = checkSingleLiteralFile(parsed);
    if (shared) return shared;

    const tail = parsed.flagArgs.get('-n') ?? '10'; // POSIX tail defaults to 10 lines
    return {
      covered: true,
      expression: `capability:read { file_path: "${parsed.operands[0]}", tail: ${tail} }`,
    };
  },
  replayEnvelope: CAPABILITY_READ_ENVELOPE,
  rewrite(atom: string): ReplayToolCall | null {
    return readRewrite(tailFileRead, atom, (parsed) => {
      if (parsed.operands[0] === undefined) return null;
      const tail = parsed.flagArgs.get('-n') ?? '10';
      return { file_path: parsed.operands[0], tail: Number(tail) };
    });
  },
};

/** Every pair in the file-read family, in registry order. */
export const FILE_READ_PAIRS: BashSubstitutionPair[] = [sedRangeRead, catFileRead, headFileRead, tailFileRead];
