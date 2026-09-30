/**
 * The READER CONTRACT for burn verdicts: nothing states a burn verdict without stating what that
 * verdict RESTS ON (P-005, plan capacity-signal-clarity-and-fleet-capacity-repair-2026-09-01).
 *
 * WHY THIS EXISTS — the defect P-001 fixed is a defect of OMISSION, and omission is the one kind
 * that comes back silently. `THROTTLE` and `SHED` name an action; they do not say whether the
 * provider's own meter is exhausted (wait for the window to reset) or whether this system is
 * pacing itself off a least-squares projection (the accounts still serve; changing the policy is
 * the lever). Those two demand OPPOSITE remedies, and the string that drops the difference reads
 * exactly like the string that keeps it. P-001 stamped `disposition` on `BurnVerdict` and routed
 * every writer through `renderBurnVerdictLabel` — but nothing stops the NEXT writer composing
 * `pool burn '${action}'` by hand, and nothing fails when it does. That next writer already
 * existed when this guard was written: `aggregatePoolBurn` took `readonly BurnAction[]`, so the
 * fleet-concurrency lever's log line had the distinction destroyed at its INPUT boundary, where no
 * amount of care downstream could restore it.
 *
 * TWO LEGS, because a verdict reaches a reader two ways and closing one leaves the class open:
 *
 *  - CARRIERS (structural). Any interface in the burn domain with a `BurnAction`-typed field must
 *    also declare `disposition: BurnDisposition`. This is the leg that catches the input-boundary
 *    loss above, and it is cheap and hard to fool: you cannot add an action-carrying result type
 *    without the compiler-visible field coming with it.
 *
 *  - STRINGS (textual). Any string literal in the burn domain that STATES a verdict — a literal
 *    `throttle`/`shed`/`usage-walled`, or an interpolated action — must sit in a block that also
 *    carries the disposition: the field, a call to a declared renderer, or one of the canonical
 *    phrases those renderers emit. This is the leg that catches a hand-composed log line whose
 *    carrier type was perfectly well-formed.
 *
 * THE DOMAIN IS DERIVED, NOT LISTED (the derived-truth ladder, rung 1). A hand-maintained file
 * list is the failure mode this guard is most likely to die of: it would keep passing while a NEW
 * file emitted unstamped verdicts, which is precisely the "guard that only catches a CHANGE to an
 * existing site" trap. A file can only state a burn verdict if it names the governor's vocabulary,
 * so membership is read from the source itself and a new emitter enrolls itself.
 *
 * DELIBERATELY COMMENT-BLIND, via `stripComments` (reused from `gate-candidate-ref`, which blanks
 * rather than deletes so line numbers survive). This file's own subject is prose about verdict
 * strings; a comment-blind scanner is the difference between judging code and judging the header
 * that documents it.
 *
 * SCOPE, stated because an over-broad absence claim is the sibling failure this family exists to
 * catch: it judges what a textual scan of the derived domain can see. A verdict rendered by a
 * helper that receives the action as an opaque `string`, or assembled from fragments across
 * blocks, is invisible here. It narrows the class; it does not eliminate it.
 */
import { stripComments } from './gate-candidate-ref';

/**
 * A file is IN THE BURN DOMAIN if it names the burn governor's vocabulary — importing it, or
 * referring to any of the identifiers only a burn-verdict producer or consumer has reason to
 * mention. Word-bounded on purpose: Scout's unrelated `DedupBurnVerdict` / `readDedupBurnVerdict`
 * must NOT enroll, and a family-name collision is exactly how a guard ends up judging code it does
 * not understand.
 */
const DOMAIN_MARKERS = [
  /burn-governor/,
  /\bBurnVerdict\b/,
  /\bBurnAction\b/,
  /\bBurnDisposition\b/,
  /\bBurnTransition\b/,
  /\blastBurnAction\b/,
  /\baccountBurnVerdict\b/,
  /\baccountBurnAction\b/,
  /\baggregatePoolBurn\b/,
  /\brenderBurnVerdictLabel\b/,
  /\brenderPoolBurnLabel\b/,
  /\bburn\.disposition\b/,
] as const;

export function isBurnDomainSource(source: string): boolean {
  return DOMAIN_MARKERS.some((re) => re.test(source));
}

/** A verdict-carrying type declaration and whether it states what its action rests on. */
export interface BurnCarrierType {
  readonly file: string;
  readonly line: number;
  readonly name: string;
  /** Declares a `disposition: BurnDisposition` field beside the action. */
  readonly carriesDisposition: boolean;
}

/** A reader-facing string that states a burn verdict, and whether its block states the basis. */
export interface BurnVerdictString {
  readonly file: string;
  readonly line: number;
  /** The literal, clipped — enough to identify it in a violation without dumping the file. */
  readonly excerpt: string;
  /**
   * The UNTRUNCATED literal, for allowlist matching only. Matching on `excerpt` looks equivalent
   * and is not: a 120-char clip silently drops the tail of a long tool description, so an
   * allowlist entry naming a phrase near its end matches nothing and the entry reads as stale
   * while the violation it covers stays live — a guard failing in both directions at once.
   */
  readonly literal: string;
  /** Why it was flagged as a verdict statement: a literal action word, or an interpolated one. */
  readonly via: 'literal-action' | 'interpolated-action';
  readonly carriesDisposition: boolean;
}

/** An emitter that is allowed to state a verdict without its disposition, and why. */
export interface AllowedBareVerdict {
  readonly file: string;
  /** A distinctive fragment of the string, so the entry pins ONE site rather than a whole file. */
  readonly match: string;
  readonly reason: string;
}

export interface BurnDispositionVerdict {
  readonly ok: boolean;
  readonly bareCarriers: readonly BurnCarrierType[];
  readonly bareStrings: readonly BurnVerdictString[];
  /** Allowlist entries whose site is gone — a stale allowlist is drift in the other direction. */
  readonly missing: readonly AllowedBareVerdict[];
  readonly violations: readonly string[];
}

/**
 * The disposition is present when the block carries the FIELD, calls a declared RENDERER, or
 * contains one of the canonical phrases those renderers emit. The phrases are here because a
 * hand-written surface may legitimately spell the disposition out in prose the reader sees
 * (burn-alert's severe-event body does exactly that) rather than interpolating the field.
 */
const DISPOSITION_MARKERS = [
  /\bdisposition\b/i,
  /renderBurnVerdictLabel\s*\(/,
  /renderPoolBurnLabel\s*\(/,
  /\b(?:transition|verdict|burn)\w*\.label\b/i,
  // Interpolating a binding NAMED `label` / `*Label`. This is the one marker that rests on a
  // naming convention rather than the text itself, and it is deliberate: `${label}` is how a
  // renderer's output actually reaches a log line, and a textual guard has no other way to see
  // that the disposition is present at runtime. The convention is what makes it legible — the
  // renderer-derived fields (`BurnTransition.label`, `PoolBurnAggregate.label`) are named `label`
  // precisely so a local bound from one keeps the name.
  /\$\{[^}]*\b\w*[Ll]abel\b[^}]*\}/,
  /measured[- ]wall/i,
  /pacing[- ]projection/i,
  /pacing policy/i,
  /no wall asserted/i,
] as const;

export function carriesDisposition(window: string): boolean {
  return DISPOSITION_MARKERS.some((re) => re.test(window));
}

/**
 * A literal action word inside a string: `shed`/`throttle` and the participles a message reaches
 * for ("shedding effective agent concurrency"). Word-bounded so identifiers cannot trip it.
 *
 * `usage-walled` is deliberately ABSENT. It names the measurement, not the ambiguous action — a
 * string saying "3 accounts are usage-walled" has already stated its own basis, so triggering on
 * it would flag four capacity-rollup sentences whose only repair is to repeat themselves. The
 * class this guard exists for is `THROTTLE`/`SHED`, where the action is visible and the basis is
 * not.
 */
const LITERAL_ACTION = /\b(?:shed|sheds|shedding|throttle|throttles|throttled|throttling)\b/i;

/**
 * A literal action word is only a VERDICT STATEMENT when the string is prose for a reader. A
 * standalone `'shed'` is a VALUE — a union member, a comparison operand, an assigned action — and
 * flagging those would bury the real findings under every type declaration in the domain, which is
 * how a guard gets silenced wholesale. Whitespace is the cheap, robust discriminator: this
 * codebase has no one-word reader-facing messages.
 */
const PROSE = /\s/;

/**
 * An interpolation of an action-bearing expression: `${action}`, `${v.action}`, `${lastBurn}`,
 * `${transition.to}`. This is the shape a hand-composed verdict string actually takes, and it is
 * the one a literal-word scan cannot see.
 */
const INTERPOLATED_ACTION = /\$\{[^}]*(?:\baction\b|\blastBurn\b|\bburnAction\b|\.\s*action\b|\.\s*(?:to|from)\b)[^}]*\}/;

/** String literals, in the three forms this codebase writes them. */
const STRING_LITERALS = /`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g;

/**
 * Interfaces AND object-literal type aliases; the body is located by brace matching, not by regex.
 * The alias form is here because `type X = { action: BurnAction }` is the same carrier wearing
 * different syntax, and a guard that only knew `interface` would hand the next author a one-keyword
 * way around it. An alias built from `Pick<BurnVerdict, …>` needs no check — it inherits the
 * contract from the type it is projecting.
 */
const TYPE_DECL = /\b(?:export\s+)?interface\s+([A-Za-z0-9_]+)\s*(?:extends\s+[^{]+)?\{|\b(?:export\s+)?type\s+([A-Za-z0-9_]+)\s*=\s*\{/g;

const ACTION_TYPED_FIELD = /:\s*BurnAction\b/;
/** Any field whose NAME ends in `disposition` and whose TYPE is `BurnDisposition` — so a persisted
 *  stamp may call itself `lastBurnDisposition` without inventing an exemption. */
const DISPOSITION_TYPED_FIELD = /\b\w*[Dd]isposition\s*\??\s*:\s*BurnDisposition\b/;

/** Blank comments while preserving offsets, so an index into the result maps back to a line. */
function strippedSource(source: string): string {
  return stripComments(source).join('\n');
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) if (source[i] === '\n') line += 1;
  return line;
}

/**
 * The block enclosing `index` — the innermost `{...}` containing it, or the whole file when the
 * position is at module scope.
 *
 * This granularity is the load-bearing choice. An object literal is the block for a `reason:`
 * field, so `evaluateBurn`'s returns are judged against the `disposition:` sitting beside them; a
 * bare call argument's block is the enclosing function body, so a log line is judged against what
 * that function actually knows. Anything coarser (the file) passes everything; anything finer (the
 * string itself) fails everything that interpolates a rendered label.
 *
 * Template interpolations open and close braces in balanced pairs, so they perturb the depth count
 * without breaking it — the fixture controls pin that rather than assuming it.
 */
export function enclosingBlock(source: string, index: number): string {
  let depth = 0;
  let start = -1;
  for (let i = index - 1; i >= 0; i -= 1) {
    const ch = source[i];
    if (ch === '}') depth += 1;
    else if (ch === '{') {
      if (depth === 0) {
        start = i;
        break;
      }
      depth -= 1;
    }
  }
  if (start === -1) return source;
  depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

/** Every verdict-carrying type declared in one file. */
export function findBurnCarrierTypes(file: string, source: string): BurnCarrierType[] {
  const stripped = strippedSource(source);
  const out: BurnCarrierType[] = [];
  TYPE_DECL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TYPE_DECL.exec(stripped)) !== null) {
    const name = m[1] ?? m[2] ?? '';
    const bodyStart = m.index + m[0].length - 1;
    const body = enclosingBlock(stripped, bodyStart + 1);
    if (!ACTION_TYPED_FIELD.test(body)) continue;
    out.push({
      file,
      line: lineOf(stripped, m.index),
      name,
      carriesDisposition: DISPOSITION_TYPED_FIELD.test(body),
    });
  }
  return out;
}

/** Every reader-facing verdict string in one file. */
export function findBurnVerdictStrings(file: string, source: string): BurnVerdictString[] {
  const stripped = strippedSource(source);
  const out: BurnVerdictString[] = [];
  STRING_LITERALS.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STRING_LITERALS.exec(stripped)) !== null) {
    const literal = m[0];
    const interpolated = INTERPOLATED_ACTION.test(literal);
    // Checking the interpolation first keeps `${action}` classified as what it is even when the
    // surrounding sentence also spells an action out.
    if (!interpolated && !(LITERAL_ACTION.test(literal) && PROSE.test(literal.slice(1, -1)))) continue;
    out.push({
      file,
      line: lineOf(stripped, m.index),
      excerpt: literal.length > 120 ? `${literal.slice(0, 117)}...` : literal,
      literal,
      via: interpolated ? 'interpolated-action' : 'literal-action',
      carriesDisposition: carriesDisposition(enclosingBlock(stripped, m.index)),
    });
  }
  return out;
}

export function judgeBurnDispositionContract(
  carriers: readonly BurnCarrierType[],
  strings: readonly BurnVerdictString[],
  allowlist: readonly AllowedBareVerdict[],
): BurnDispositionVerdict {
  const allowed = (s: BurnVerdictString): AllowedBareVerdict | undefined =>
    allowlist.find((a) => a.file === s.file && s.literal.includes(a.match));

  const bareCarriers = carriers.filter((c) => !c.carriesDisposition);
  const bareStrings = strings.filter((s) => !s.carriesDisposition && !allowed(s));
  const missing = allowlist.filter(
    (a) => !strings.some((s) => s.file === a.file && s.literal.includes(a.match)),
  );

  const violations: string[] = [];
  for (const c of bareCarriers) {
    violations.push(
      `${c.file}:${c.line} — type '${c.name}' carries a BurnAction with no ` +
        `'disposition: BurnDisposition' beside it. A reader of this result can see THAT the ` +
        `governor acted but not whether the provider walled us (wait for the reset) or we are ` +
        `pacing ourselves off a projection (the accounts still serve). Add the field and populate ` +
        `it at the branch that decides the action — never re-derive it from a utilization reading, ` +
        `which the stale gate makes unsound.`,
    );
  }
  for (const s of bareStrings) {
    violations.push(
      `${s.file}:${s.line} states a burn verdict (${s.via}) with no disposition in scope: ` +
        `${s.excerpt}. Interpolate 'renderBurnVerdictLabel(verdict)' / 'renderPoolBurnLabel(agg)' ` +
        `instead of composing the action by hand, or state the basis in the same block. If this ` +
        `site genuinely should not carry one, add it to ALLOWED_BARE_VERDICTS with a reason.`,
    );
  }
  for (const a of missing) {
    violations.push(
      `${a.file} is allowlisted for a bare verdict matching '${a.match}', but no such string was ` +
        `found. If the site was fixed or removed, drop the entry — a stale allowlist hides the ` +
        `next real one.`,
    );
  }
  return { ok: violations.length === 0, bareCarriers, bareStrings, missing, violations };
}
