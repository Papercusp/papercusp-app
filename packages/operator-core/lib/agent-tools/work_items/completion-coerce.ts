/**
 * completion-coerce.ts — EI-7031: normalise structured `work_items:complete` input.
 *
 * work_items:complete failed ~15% of calls in the wild (52/348 in 24h). The live
 * `tool_invocations` breakdown showed the failures are NOT connectivity / logic /
 * idempotency — they are almost entirely MALFORMED `completion` SHAPE from LLM
 * callers, and each one means a real, FINISHED unit of work had its completion
 * REJECTED and lost (and the item left claimable, so the auto-loop re-places it):
 *
 *   18×  completion passed as a bare STRING           ("expected object, received string")
 *   ~4×  scalar↔array field swaps                      (whatLanded/deferred/migrations given a
 *                                                        string; tests given an array)
 *    2×  summary omitted                               ("expected string, received undefined")
 *   22×  neither { id, completion } nor items:[…]      (the completion fields passed FLAT,
 *                                                        no `completion` wrapper — the top-level
 *                                                        refine then rejects)
 *
 * EI-7311 (2026-07-04): a related but DISTINCT mis-shape — a JSON-STRINGIFIED completion
 * object (`completion: '{"summary":"...","tests":"..."}'` as a literal string, not an
 * object). This one doesn't reject; it silently SUCCEEDS with the wrong content: the bare-
 * string branch below wraps the whole JSON text as `{ summary: <entire blob> }`, dropping
 * every other field (confirmed live via tool_invocations.args_json on 2 real completions,
 * EI-6516/EI-6528, whose `tests` field vanished this way and tripped a false
 * verificationWarning). Detected + parsed back into an object before the rest of the
 * coercion runs.
 *
 * The durable fix is coercion at the input boundary (a Zod `preprocess`), applied
 * BEFORE validation so structured-but-mis-shaped fields are normalised to the
 * CompletionRecord contract. A bare completion string is deliberately NOT rescued:
 * it has no field boundary for verification evidence, and silently turning it into
 * `{ summary }` can close an item with authority:'proposed' while making the caller
 * believe the full completion was recorded. The schema therefore rejects that shape
 * with an actionable object example, while JSON-object strings remain recoverable.
 */

/** CompletionRecord prose fields that are arrays of strings (a lone scalar → `[scalar]`). */
const ARRAY_FIELDS = ['whatLanded', 'migrations', 'deferred'] as const;
/** CompletionRecord fields that are plain strings (an array → joined). */
const STRING_FIELDS = [
  'summary',
  'status',
  'tests',
  'testsRun',
  'testResult',
  'verifiedHow',
  'deploy',
  'coordNotes',
  'planSlug',
  'agent',
  'title',
  'workItem',
] as const;
const BOOL_FIELDS = ['addedTests'] as const;
/** Every completion-record field name — used to recognise a FLAT completion. */
export const COMPLETION_FIELDS: readonly string[] = [
  ...ARRAY_FIELDS,
  ...STRING_FIELDS,
  ...BOOL_FIELDS,
  'filesChanged',
  'filesDeleted',
  'verification',
  'coverage',
  'rootCauseVerification',
  // Arm-B pilot self-review (D-021). Listed here so a FLAT completion carrying
  // `selfReview` is still recognised as structured rather than being swept into the
  // free-text residue — the gate reads it off the parsed record.
  'selfReview',
];

/**
 * Server-generated fields that can be returned alongside caller-owned completion
 * evidence by `work_items:get`. Keep these out of `CompletionRecordSchema`: they
 * are narrative metadata, not caller-provided verification. Strip only the fields
 * we explicitly know are generated so a read→retry of stored evidence can succeed
 * without weakening strict rejection for unrelated keys.
 *
 * EI-21582975345203826: `checkpointChecksCarried` is folded into persisted
 * `_completionEvidence` immediately before terminal checkpoint cleanup, so it can
 * appear in `terminalCompletionEvidence` even though it is not a completion input.
 * EI-21599866958764530: `treeStamp` and `settlementManifest` are also server-generated
 * fields that can come back in terminal evidence. Strip them at the root so a
 * work_items:get → work_items:complete retry does not reject its own read-side shape;
 * complete.ts observes and writes a fresh stamp for the retry.
 */
const SERVER_GENERATED_COMPLETION_FIELDS = [
  'checkpointChecksCarried',
  'checkpointProseSnapshot',
  'treeStamp',
  'settlementManifest',
] as const;
// A persisted read may expose historyAttestation inside the nested verification
// object. Strip it only at that read-retry location; leaving it out of the root
// completion list keeps caller-authored attestations rejected by the strict schema.
const SERVER_GENERATED_VERIFICATION_FIELDS = [
  ...SERVER_GENERATED_COMPLETION_FIELDS,
  'historyAttestation',
] as const;

/** Exact object-form example shared by the schema error and the tool guidance. */
export const COMPLETION_OBJECT_EXAMPLE =
  '{ summary: "what changed", testsRun: "npm run test:file -- path/to.test.ts", testResult: "passed", ' +
  'verifiedHow: "unit", addedTests: true, filesChanged: ["path/to/file"], filesDeleted: ["path/to/removed"], ' +
  'verification: { coverage: { population: ["all named items"], checked: ["all named items"], ' +
  'notChecked: [], notApplicable: [], residue: ["none"] } } }';

/** Actionable refusal for the lossy prose/string completion shape. */
export const COMPLETION_STRING_REJECTION =
  `completion must be a structured object, not a bare string. Pass completion: ${COMPLETION_OBJECT_EXAMPLE}.`;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * EI-22166136861574482: words a caller reasonably reaches for to say "this close
 * changed no files" — the sibling evidence fields accept exactly this kind of
 * prose (`testsRun: "none — no code change"`, `testResult: "n/a"`), and this
 * schema's own `coverage.residue` already treats a literal `'none'` as a
 * reserved no-op token. Left unrecognized, `coerceFilesChanged` used to wrap the
 * word in a single-element array and hand it to path resolution as if it were a
 * real path, which is absent from the tree by construction and silently
 * downgrades the completion's authority to 'proposed' — a no-code-change close
 * degraded through a field that reads as filled in correctly. Recognize the
 * small, unambiguous set below and normalize it to the array's genuine empty
 * form (`[]`) — the form the tool's own recovery warning already prescribes —
 * BEFORE the single-entry rescue can turn the word into a fabricated path.
 * Anything not on this list, including a real file that merely CONTAINS one of
 * these words (`none.txt`, `na/config.ts`), is left untouched: the check is an
 * exact, case-insensitive match on the WHOLE trimmed string.
 */
const NO_FILES_CHANGED_SENTINELS = new Set([
  'none',
  'n/a',
  'na',
  'nil',
  'null',
  'nothing',
  'no files',
  'no files changed',
  'no changes',
  'no change',
  '-',
]);

function isNoFilesChangedSentinel(v: unknown): v is string {
  return typeof v === 'string' && NO_FILES_CHANGED_SENTINELS.has(v.trim().toLowerCase());
}

/**
 * WI-10005684 (EI-23774140426573307): the sentinel set above only matches a WHOLE
 * string, so a truthful negation written as a SENTENCE — `"None. This is a
 * not-a-defect close, no source, test, or config file was modified."` — fell through
 * to the comma-split list rescue below and was recorded as four fabricated "paths".
 * The close then landed authority:'proposed' with three stacked integrity warnings:
 * the anti-fabrication machinery accusing a caller who had told the exact truth.
 *
 * A string reads as a negation (the empty set) only when BOTH hold:
 *  - it OPENS with a negation lead (`none`, `nothing`, `n/a`, `no files|changes|source|
 *    code|tests|config|repo`) followed by a word boundary or sentence punctuation, and
 *  - NO whitespace-delimited token in it is path-shaped (a `/` or `\` separator, a
 *    dotted extension such as `a.ts`, or a dotfile).
 * The second clause is what keeps this from swallowing real evidence: `"None, but I
 * did edit src/a.ts"` names a path, so it is NOT a negation and still takes the list
 * rescue. It errs toward NOT normalizing — a string this declines to classify behaves
 * exactly as before, so the only behavior change is for sentences with no path in them.
 */
const NO_FILES_PROSE_LEAD =
  /^(?:none|nothing|n\/a|no\s+(?:files?|changes?|source|code|tests?|config|repo(?:sitory)?))(?=$|[\s.,:;!—–-])/i;

function isPathShapedProseToken(token: string): boolean {
  const t = token.replace(/^[("'`[]+/, '').replace(/[)"'`\].,;:!?]+$/, '');
  if (!t || t.toLowerCase() === 'n/a') return false;
  return /[\\/]/.test(t) || /^[\w.-]*\w\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(t) || /^\.[A-Za-z][\w.-]*$/.test(t);
}

function isNoFilesChangedProse(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const t = v.trim();
  if (t.length === 0 || t.length > 500 || !NO_FILES_PROSE_LEAD.test(t)) return false;
  return !t.split(/\s+/).some(isPathShapedProseToken);
}

/**
 * Normalize the path-only `filesChanged` field.
 *
 * Unlike prose arrays such as `whatLanded`, a scalar containing commas,
 * semicolons, or newlines is overwhelmingly a list of paths. Treating that
 * entire string as ONE path makes the integrity warning prescribe an
 * impossible "verify it on disk and retry" loop (EI-21471221125941096).
 * Split only this field; callers with a literal delimiter in a filename can
 * disambiguate it by passing the documented array form.
 */
function coerceFilesChanged(v: unknown): unknown {
  if (isNoFilesChangedSentinel(v) || isNoFilesChangedProse(v)) return [];

  let entries: unknown[];
  if (typeof v === 'string') {
    entries = v
      .split(/[;,]|\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  } else if (Array.isArray(v)) {
    entries = v;
  } else if (v == null) {
    return undefined;
  } else {
    entries = [v];
  }

  // A lone sentinel wrapped in the documented array form (`["none"]`) makes the
  // same "explicitly zero files" claim as the bare scalar handled above.
  if (entries.length === 1 && isNoFilesChangedSentinel(entries[0])) return [];

  return entries.map((entry) => {
    if (!isPlainObject(entry) || typeof entry.path !== 'string' || !entry.path.trim()) return entry;
    return entry.path.trim();
  });
}

/** Join a mis-typed array into the single string the field expects (drops empties). */
function joinToString(v: readonly unknown[]): string {
  return v
    .map((x) => (typeof x === 'string' ? x : x == null ? '' : JSON.stringify(x)))
    .map((s) => s.trim())
    .filter(Boolean)
    .join('; ');
}

/**
 * Normalize the boolean completion flag without guessing at multi-valued input.
 *
 * LLM callers occasionally wrap a scalar in a one-element array while producing
 * the rest of the completion record. Unwrap only that lossless shape; an array
 * with multiple entries remains invalid because it cannot truthfully represent a
 * boolean flag. String spellings retain the existing true/false coercion.
 */
function coerceBooleanFlag(v: unknown): unknown {
  const candidate = Array.isArray(v) && v.length === 1 ? v[0] : v;
  if (typeof candidate !== 'string') return candidate;
  const s = candidate.trim().toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(s)) return true;
  if (['false', 'no', 'n', '0'].includes(s)) return false;
  return candidate;
}

/**
 * EI-7311: a JSON-STRINGIFIED completion object (e.g. `completion: '{"summary":
 * "...", "tests": "..."}'`) used to hit the bare-string branch below and get
 * wrapped whole as `{ summary: <the entire JSON text> }` — silently DROPPING every
 * other field, including `tests`/`deferred`, which then trips the false
 * verificationWarning ("neither tests nor deferred populated") even though the
 * caller's original completion had `tests` populated. Confirmed live via
 * tool_invocations.args_json on 2 real completions (EI-6516, EI-6528) that hit
 * exactly this shape. Detect a string that PARSES to a plain object (as
 * opposed to genuine prose) and recurse into the normal object-coercion path
 * instead of swallowing it as a summary blob.
 */
function tryParseJsonObject(s: string): Record<string, unknown> | undefined {
  const t = s.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return undefined;
  try {
    const parsed: unknown = JSON.parse(t);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Keys that identify a parsed object as a genuine completion record rather than
 * arbitrary JSON. A repaired parse (below) is only ACCEPTED when it yields at
 * least one of these — that is what keeps the repair from capturing prose or an
 * unrelated JSON fragment that merely happens to be closeable.
 */
const COMPLETION_SHAPE_KEYS = new Set([
  'summary',
  'verification',
  'status',
  'tests',
  'testsRun',
  'testResult',
    'verifiedHow',
    'addedTests',
    'filesChanged',
    'filesDeleted',
    'whatLanded',
  'deferred',
  'migrations',
  'coverage',
  'coordNotes',
  'rootCauseVerification',
]);

/**
 * EI-20724228359175431: a JSON-stringified completion that arrives with its TAIL
 * CUT OFF. Measured on two independent real calls (tool_invocations 17274515 and
 * 17276253, both 4.7–5.4KB): each fails `JSON.parse` at end-of-input with a
 * structure still open — 17274515 was missing exactly ONE `}`, and appending it
 * recovered the whole object with `summary` + `verification` intact. Because the
 * truncated text still starts `{` and (coincidentally) ends `}`, it slips past
 * `tryParseJsonObject` and used to land in the bare-string branch, where the ENTIRE
 * 4.7KB of broken JSON was stuffed into `summary` and every structured field — the
 * verification evidence the close is judged on — is destroyed. The completion is
 * then RECORDED that way, and the call also CLOSES the item, so the loss is
 * silent and durable.
 *
 * Rebuild the closers the input is missing by scanning it once (string- and
 * escape-aware, so braces inside string values are not miscounted), then accept
 * the result ONLY if it parses to a plain object carrying a recognised completion
 * key. Anything else — genuine prose in braces, a JSON array, a fragment too
 * mangled to close — falls through to the unchanged bare-string path.
 *
 * This RECOVERS what arrived; it cannot recover what was never delivered. The
 * caller is told loudly (complete.ts) precisely because the record may be short a
 * field that was cut mid-flight.
 */
function repairTruncatedJsonObject(s: string): Record<string, unknown> | undefined {
  const t = s.trim();
  if (!t.startsWith('{')) return undefined;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const c of t) {
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') stack.pop();
  }
  // Nothing left open ⇒ this is a plain malformed-JSON failure, not a truncation.
  // Leave it to the bare-string path rather than guessing at a repair.
  if (!inString && stack.length === 0) return undefined;

  let candidate = t;
  if (inString) candidate += '"';
  else candidate = candidate.replace(/,\s*$/, ''); // a cut right after a separator
  for (let i = stack.length - 1; i >= 0; i -= 1) candidate += stack[i] === '{' ? '}' : ']';

  try {
    const parsed: unknown = JSON.parse(candidate);
    if (!isPlainObject(parsed)) return undefined;
    return Object.keys(parsed).some((k) => COMPLETION_SHAPE_KEYS.has(k)) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * WI-10005684 (EI-24822105308825949): the mirror image of the truncation repair above —
 * a JSON-stringified completion carrying EXTRA trailing closers. Measured on the one
 * ledger row behind the report (tool_invocations 30937604, 2026-10-01, a 3,442-char
 * `completion` string): it began `{`, ended `}`, and `JSON.parse` failed with
 * "Unexpected non-whitespace character after JSON at position 3441" — the caller had
 * emitted ONE `}` too many. It was therefore not a client that "stringified a good
 * object" (the report's inference): the string was malformed, so it fell to the
 * bare-string rejection whose wording ("not a bare string") sent the caller away from
 * the real defect.
 *
 * Extra closers carry no data, so peeling them is LOSSLESS — the recovered object is
 * exactly the complete prefix the caller wrote, which is why (unlike the truncation
 * repair) no incompleteness marker is attached. Only trailing `}` / `]` / whitespace
 * are peeled, at most {@link MAX_PEELED_CLOSERS}, and the result is accepted only if it
 * parses to a plain object carrying a recognised completion key — so a truncated object
 * (a closer MISSING, never in excess) cannot be mistaken for this case: peeling cannot
 * make an unbalanced-short string parse.
 */
const MAX_PEELED_CLOSERS = 8;

function repairExtraTrailingClosers(s: string): Record<string, unknown> | undefined {
  let t = s.trim();
  if (!t.startsWith('{')) return undefined;
  for (let peeled = 0; peeled < MAX_PEELED_CLOSERS; peeled += 1) {
    const last = t[t.length - 1];
    if (last !== '}' && last !== ']') return undefined;
    t = t.slice(0, -1).trimEnd();
    try {
      const parsed: unknown = JSON.parse(t);
      if (!isPlainObject(parsed)) return undefined;
      return Object.keys(parsed).some((k) => COMPLETION_SHAPE_KEYS.has(k)) ? parsed : undefined;
    } catch {
      /* keep peeling — the next closer may be the last excess one */
    }
  }
  return undefined;
}

/**
 * WI-10005684: when `completion` arrives as a STRING that is shaped like a JSON object
 * (`{ … }`) but could not be parsed or repaired, say THAT. The generic
 * {@link COMPLETION_STRING_REJECTION} ("not a bare string") reads as an accusation
 * about prose and gave the 2026-10-01 caller no hint their JSON was merely malformed
 * (they concluded the direct door mangled their object). Returns the parser's own
 * message so the position of the break is named, or `undefined` for genuine prose
 * (not brace-delimited) where the generic rejection is already accurate.
 */
export function describeUnparseableCompletionJsonString(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return undefined;
  try {
    JSON.parse(t);
    return undefined; // parses — not this failure
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return (
      `completion arrived as a STRING that looks like a JSON object but is NOT valid JSON (${reason.slice(0, 160)}) ` +
      'and could not be repaired — send completion as a structured object value, not a JSON-encoded string ' +
      '(if you do send a string it must be one valid JSON object).'
    );
  }
}

/**
 * Normalise ONE `completion` value to the CompletionRecord shape. Handles:
 *  - a JSON-stringified object → parsed + coerced as an object (EI-7311)
 *  - a TRUNCATED JSON-stringified object → closers rebuilt, then coerced as an
 *    object, so surviving evidence is kept instead of destroyed (EI-20724228359175431)
 *  - a bare string        → left as a string so the schema can reject it with an
 *    actionable object-form example
 *  - array-typed field given a scalar → wrapped in a 1-element array (lossless)
 *  - string-typed field given an array → joined with '; '
 *  - a missing/empty summary → derived from title / first whatLanded / status
 *    (turns a hard reject into a recorded completion — far better than losing it,
 *    since this call also closes the item).
 * A value that is neither a string nor a plain object is returned untouched.
 */
export function coerceCompletionShape(raw: unknown): unknown {
  if (typeof raw === 'string') {
    const parsedObject = tryParseJsonObject(raw);
    if (parsedObject) return coerceCompletionShape(parsedObject);
    // WI-10005684: one-or-few EXTRA trailing closers — lossless peel, no marker.
    const peeled = repairExtraTrailingClosers(raw);
    if (peeled) return coerceCompletionShape(peeled);
    // EI-20724228359175431: a TRUNCATED JSON completion — recover the fields that
    // did arrive rather than rejecting the whole broken blob. Mark it distinctly so
    // the caller-facing warning can say the record may be INCOMPLETE.
    const repaired = repairTruncatedJsonObject(raw);
    if (repaired) {
      const coerced = coerceCompletionShape(repaired);
      return isPlainObject(coerced)
        ? { ...coerced, __shapeCoercedFrom: 'truncated-json' as const }
        : coerced;
    }
    // A prose/string completion has no safe way to carry structured evidence. Leave it
    // untouched; the completionSpec preprocess adds COMPLETION_STRING_REJECTION before
    // the object schema runs, so callers get the repair shape instead of a lossy close.
    return raw;
  }
  if (!isPlainObject(raw)) return raw;

  const out: Record<string, unknown> = { ...raw };
  for (const field of SERVER_GENERATED_COMPLETION_FIELDS) delete out[field];

  // The public completion contract exposes the same verification aliases both at the
  // top level and under `verification`. Normalize the nested object before the strict
  // CompletionVerificationEvidenceSchema sees it; otherwise an LLM-shaped array such as
  // `verification.testsRun: ['suite', 'green']` is rejected even though the top-level
  // `testsRun` form is already rescued by STRING_FIELDS (EI-20234587310739072).
  if (isPlainObject(out.verification)) {
    const verification: Record<string, unknown> = { ...out.verification };
    // Persisted evidence can contain server-generated metadata when a caller feeds a
    // work_items:get result back into work_items:complete. Strip the known generated
    // fields at this nested location too, so the retry does not validate its own receipt
    // as caller evidence or reject a nested settlementManifest before the presence-time
    // guidance can explain that the server recreates it (EI-22552507428065516).
    for (const f of SERVER_GENERATED_VERIFICATION_FIELDS) delete verification[f];
    for (const f of ['testsRun', 'testResult', 'verifiedHow', 'summary'] as const) {
      const value = verification[f];
      if (Array.isArray(value)) verification[f] = joinToString(value) || undefined;
    }
    verification.filesChanged = coerceFilesChanged(verification.filesChanged);
    verification.filesDeleted = coerceFilesChanged(verification.filesDeleted);
    verification.addedTests = coerceBooleanFlag(verification.addedTests);
    out.verification = verification;
  }

  // The optional self-review record has the same array-of-prose contract as the
  // top-level `whatLanded`/`migrations`/`deferred` fields. LLM callers commonly
  // provide one finding or one yielded change as a scalar; leave genuine arrays
  // untouched and wrap only the lossless scalar form before Zod validates it.
  if (isPlainObject(out.selfReview)) {
    const selfReview: Record<string, unknown> = { ...out.selfReview };
    // `lookedAt` is persisted as one string, but callers often report the several
    // files they re-read as an array. Join that lossless list using the same
    // separator as the other string-valued completion fields (EI-22579012711003137).
    if (Array.isArray(selfReview.lookedAt)) {
      selfReview.lookedAt = joinToString(selfReview.lookedAt) || undefined;
    }
    for (const f of ['findings', 'changedAsResult'] as const) {
      const value = selfReview[f];
      if (value == null || Array.isArray(value)) continue;
      // `false` is a common compact spelling for "no findings/no change". Preserve
      // that explicit zero as an empty array; wrapping it as `[false]` would still
      // violate the self-review contract's array-of-strings shape. `true` remains
      // invalid because it cannot provide the required review prose.
      if (value === false) {
        selfReview[f] = [];
        continue;
      }
      if (typeof value === 'string') {
        const s = value.trim();
        selfReview[f] = s ? [s] : undefined;
      } else {
        selfReview[f] = [value];
      }
    }
    out.selfReview = selfReview;
  }

  // array-typed fields: a lone scalar becomes a 1-element array (lossless, no splitting).
  for (const f of ARRAY_FIELDS) {
    const val = out[f];
    if (val == null || Array.isArray(val)) continue;
    if (typeof val === 'string') {
      const s = val.trim();
      out[f] = s ? [s] : undefined;
    } else {
      out[f] = [val];
    }
  }

  // `filesChanged` is path-only, so it has a stricter scalar rescue than the
  // prose arrays above: common list delimiters become distinct paths. This also
  // unwraps `{ path, change }` records while leaving invalid entries for schema
  // validation instead of recording "[object Object]".
  out.filesChanged = coerceFilesChanged(out.filesChanged);
  out.filesDeleted = coerceFilesChanged(out.filesDeleted);

  // string-typed fields: an array becomes a joined string.
  for (const f of STRING_FIELDS) {
    const val = out[f];
    if (Array.isArray(val)) out[f] = joinToString(val) || undefined;
  }

  for (const f of BOOL_FIELDS) {
    out[f] = coerceBooleanFlag(out[f]);
  }

  // EI-22691088505562531: `duplicateOf` is optional, but callers that materialize
  // every optional completion field commonly send an empty string for a non-duplicate
  // close. The record schema correctly rejects an explicitly supplied non-empty-id
  // field with an empty value; at this input boundary, a blank identifier has the same
  // meaning as omission. Remove only blank strings so real duplicate IDs retain their
  // exact value and still go through the normal target-resolution/accountability path.
  if (typeof out.duplicateOf === 'string' && out.duplicateOf.trim() === '') {
    delete out.duplicateOf;
  }

  // derive a summary if the caller omitted it (after array-coercion, so whatLanded[0] is safe).
  if (typeof out.summary !== 'string' || !out.summary.trim()) {
    const wl = out.whatLanded;
    const derived =
      (typeof out.title === 'string' && out.title.trim()) ||
      (Array.isArray(wl) && typeof wl[0] === 'string' && wl[0].trim()) ||
      (typeof out.status === 'string' && out.status.trim()) ||
      'done';
    out.summary = String(derived);
  }

  return out;
}

/**
 * EI-21868028531788587 / EI-22073105984724419: `assumptions`, `specAdequacy`, and
 * `outputPayload` are all SIBLINGS of `completion` (declared directly on
 * `itemSpec` in complete.ts), never fields of `CompletionRecordSchema`. An LLM
 * caller naturally reaches for the adjacent, plausible-sounding location —
 * "the assumptions/spec-adequacy/output THIS completion carries" — and nests it
 * inside `completion` instead. Because `CompletionRecordSchema` has none of these
 * fields, Zod 4's default strict-object behaviour rejects the call as an
 * unrecognized key, discarding a genuinely-finished unit of work's closing call
 * exactly like the other LLM mis-shapes this file rescues (a bare-string
 * completion, a scalar/array swap, a flat completion with no wrapper) — and,
 * for `specAdequacy`/`outputPayload`, with no pointer in the runtime error back to
 * the tool's `when` guidance that already states the correct placement.
 *
 * Hoist a field ONLY when its top-level sibling is not already set — an explicit
 * top-level value always wins, and a caller who set BOTH gets the ordinary
 * unrecognized-key refusal (a genuine disagreement, not a shape fumble; mirrors
 * ASSUMPTIONS_CONTRADICTION_MESSAGE's rule of never silently resolving one side of
 * a real conflict).
 */
const HOISTABLE_COMPLETION_SIBLING_FIELDS = ['assumptions', 'specAdequacy', 'outputPayload'] as const;

function hoistCompletionSiblingFields(item: Record<string, unknown>): Record<string, unknown> {
  if (!isPlainObject(item.completion)) return item;
  let completion: Record<string, unknown> | undefined;
  const patch: Record<string, unknown> = {};
  for (const field of HOISTABLE_COMPLETION_SIBLING_FIELDS) {
    if (item[field] !== undefined) continue;
    if (!(field in item.completion)) continue;
    completion ??= { ...item.completion };
    patch[field] = completion[field];
    delete completion[field];
  }
  if (!completion) return item;
  return { ...item, completion, ...patch };
}

/**
 * Apply {@link hoistCompletionSiblingFields} across BOTH call shapes: the single-
 * complete shorthand (each sibling field belongs beside `completion` at the top
 * level) and the bulk `items:[…]` form (each belongs beside each item's own
 * `completion`). Must run BEFORE the strict per-item schema sees the payload —
 * wired into complete.ts's top-level preprocess, ahead of `gatherFlatCompletion`.
 * A non-object `raw`/`completion`, or an object `completion` carrying none of
 * {@link HOISTABLE_COMPLETION_SIBLING_FIELDS}, is returned unchanged (same
 * reference where nothing needed rescuing).
 */
export function hoistMisplacedCompletionFields(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;
  if (Array.isArray(raw.items)) {
    let changed = false;
    const items = raw.items.map((it) => {
      if (!isPlainObject(it)) return it;
      const hoisted = hoistCompletionSiblingFields(it);
      if (hoisted !== it) changed = true;
      return hoisted;
    });
    return changed ? { ...raw, items } : raw;
  }
  return hoistCompletionSiblingFields(raw);
}

/**
 * Rescue a FLAT completion at the top-level args boundary: when the caller passed
 * completion fields directly on the args (no `completion` wrapper) alongside an
 * `id`, gather them into `completion` so the single-complete shorthand validates
 * instead of tripping the "pass { id, completion } …" refine. A call that already
 * has `completion` or `items` (or no completion-ish fields) is returned unchanged.
 *
 * EI-9930: also rescues flat completion-ish SIBLINGS of an EXISTING `completion`
 * object (e.g. a caller who passed `{ id, completion, tests: "…" }` — `tests`
 * outside the wrapper by mistake). The tool's top-level args schema has no such
 * field, so zod's default object parsing silently STRIPS it (no unknown-arg
 * error) — the caller's stated verification vanished and a false
 * verificationWarning ("neither tests nor deferred populated") fired even
 * though they DID say how it was checked (repro: WI-4223, 2026-07-12). Merge
 * any such siblings INTO the completion object, filling only fields the
 * nested object didn't already set — an explicit nested value always wins,
 * never clobbered by a flat sibling.
 *
 * EI-13016: EI-9930 only merged siblings when `completion` was ALREADY a plain
 * object, bailing whenever it was a bare string ("left for coerceCompletionShape")
 * — but coerceCompletionShape runs on the `completion` VALUE alone and never sees
 * the top-level siblings, so they were still dropped. The attempted rescue made the
 * lossy prose shape even harder to notice: `{ id, state, tests: "…", completion:
 * "<prose>" }` became a successful `{ summary, tests }` record despite the caller
 * never supplying a structured completion object. Keep the bail-out for non-object
 * values so the schema rejects the original shape; JSON-object strings still parse to
 * an object here and retain their flat siblings. No siblings found → returned
 * unchanged, same reference, exactly like before.
 */
export function gatherFlatCompletion(args: unknown): unknown {
  if (!isPlainObject(args)) return args;
  if (args.items !== undefined) return args;

  const flat: Record<string, unknown> = {};
  let found = false;
  for (const f of COMPLETION_FIELDS) {
    if (args[f] !== undefined) {
      flat[f] = args[f];
      found = true;
    }
  }

  if (args.completion !== undefined) {
    if (!found) return args;
    // Only an objectifiable completion may merge flat siblings. A prose/string completion
    // stays untouched so the nested schema can reject it with the exact object example;
    // JSON-object strings are objectifiable and still retain the useful sibling fields.
    const base = coerceCompletionShape(args.completion);
    if (!isPlainObject(base)) return args;
    const out: Record<string, unknown> = { ...args };
    for (const f of COMPLETION_FIELDS) delete out[f];
    out.completion = { ...flat, ...base };
    return out;
  }

  if (typeof args.id !== 'string') return args;
  if (!found) return args;

  const out: Record<string, unknown> = { ...args };
  for (const f of COMPLETION_FIELDS) delete out[f];
  out.completion = flat;
  return out;
}
