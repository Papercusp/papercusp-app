/**
 * EI-19408574209859155: normalize a migration's SQL down to its EXECUTABLE
 * content, so two versions of the same applied migration can be compared for a
 * difference that actually *ran* — rather than for a difference in bytes.
 *
 * Why this exists. `computeContentDrift` (migration-drift.ts) compares the raw
 * sha256 of an applied migration's on-disk bytes against the sha recorded when
 * it ran. Any byte difference is drift. That conflates two things with opposite
 * severity:
 *  - a real HALF-LANDED migration — executable DDL added after apply, which
 *    never ran and never will (the mig-708 hazard, EI-19365742982915607);
 *  - a COMMENT-ONLY edit — provably zero executable change.
 *
 * And the second is not hypothetical: `lint:migration-forward-compat`'s designed
 * escape hatch is a `-- FORWARD-COMPAT:` COMMENT written into the migration
 * file, so the prescribed remedy for one guard necessarily trips the other.
 * Observed live on 727-widen-prose-embedding-cols-to-gemma-native-768.sql
 * (15 inserted lines, every one beginning with `--`).
 *
 * ── The safety property ────────────────────────────────────────────────────
 * Misclassifying a real half-landed migration as benign is the ONLY expensive
 * error here — it silences exactly the signal the detector exists to carry.
 * Everything below therefore fails TOWARD reporting drift:
 *  - string literals and NON-CODE dollar-quoted bodies are PRESERVED VERBATIM,
 *    never blanked. A change inside a literal IS an executable change. (This is
 *    why `stripSqlBodies()` from scripts/lint-migrations.mjs could not be
 *    reused: it blanks strings and skips dollar-quoted bodies wholesale, which
 *    is right for transaction-control detection and wrong here.)
 *  - anything that cannot be lexed with confidence — an unterminated string,
 *    block comment or dollar-quote — returns a DEFINITE FAILURE, and the caller
 *    reports drift rather than guessing.
 *  - only comments and inter-token whitespace are removed. Case, token order
 *    and punctuation are all preserved: a case change is executable-equivalent
 *    but it is still a real edit, and calling it benign is a stretch this does
 *    not take.
 *
 * ── Why comments must be stripped INSIDE dollar-quoted code bodies ─────────
 * 727's `-- FORWARD-COMPAT:` comment sits inside a `DO $$ ... $$` block. A
 * normalizer that treats every dollar-quoted body as opaque would therefore
 * still report it as drift — i.e. it would not fix the case that motivated the
 * work. plpgsql lexes `--` as a comment normally inside the body, so we recurse
 * into a body that is genuinely CODE.
 *
 * "Genuinely code" is decided by the token immediately preceding the opening
 * tag: `DO $$…$$`, `AS $$…$$` (function bodies) and `LANGUAGE plpgsql $$…$$`.
 * Every other dollar-quoted body — notably one used as a DATA literal, e.g.
 * `INSERT INTO t VALUES ($$a -- b$$)`, where the preceding token is `(` — stays
 * opaque and byte-compared. That asymmetry is deliberate: treating a data
 * literal as code could strip a `--` that is real data, which is precisely the
 * over-strip that fails toward silence.
 */

/** Successful normalization — `normalized` is the executable-content form. */
export interface MigrationSqlNormalizeOk {
  ok: true;
  normalized: string;
}

/**
 * The SQL could not be lexed with confidence. Callers MUST treat this as
 * "cannot classify" and report drift — never as "no difference".
 */
export interface MigrationSqlNormalizeFail {
  ok: false;
  reason: string;
}

export type MigrationSqlNormalizeResult = MigrationSqlNormalizeOk | MigrationSqlNormalizeFail;

/**
 * Bound on recursion into nested dollar-quoted code bodies. Postgres requires
 * distinct tags to nest, so real migrations sit at depth 1–2; anything beyond
 * this is far likelier to be a lexing mistake than genuine SQL, and an
 * unclassifiable result is reported as drift rather than guessed at.
 */
const MAX_DOLLAR_DEPTH = 8;

/** `$tag$` / `$$` opener. The tag cannot start with a digit, which is what
 *  keeps `$1` positional parameters out of this branch. Sticky so it can be
 *  anchored at an offset without slicing the string. */
const DOLLAR_TAG_RE = /\$([A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)?\$/y;

const WHITESPACE = new Set([' ', '\t', '\n', '\r', '\f', '\v']);

/** First character of an unquoted identifier. */
function isIdentStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c >= '\u0080';
}

/**
 * Identifier continuation. `$` is deliberately EXCLUDED even though Postgres
 * permits it, so that a `$` always reaches the dollar-quote branch and cannot
 * be silently swallowed into an identifier. The cost is that an identifier
 * containing `$` lexes as two tokens — harmless, since both sides of the
 * comparison lex it identically.
 */
function isIdentPart(c: string): boolean {
  return isIdentStart(c) || (c >= '0' && c <= '9');
}

/** Tokens after which a dollar-quoted body is CODE (see the header note). */
const CODE_BODY_PRECEDING_TOKENS = new Set(['DO', 'AS', 'PLPGSQL']);

/**
 * Reduce `text` to its executable content: comments removed, runs of
 * inter-token whitespace collapsed to a single space, string literals and
 * non-code dollar-quoted bodies preserved byte-for-byte.
 *
 * Returns a definite failure (never a best guess) on anything it cannot lex.
 */
export function normalizeMigrationSql(text: string, depth = 0): MigrationSqlNormalizeResult {
  if (depth > MAX_DOLLAR_DEPTH) {
    return { ok: false, reason: `dollar-quote nesting deeper than ${MAX_DOLLAR_DEPTH}` };
  }

  const out: string[] = [];
  const n = text.length;
  let i = 0;
  /** Last identifier token emitted, uppercased — decides code-vs-data bodies.
   *  Whitespace and comments do NOT reset it (they are not tokens); any other
   *  character does. */
  let lastWord = '';

  const emitSpace = () => {
    if (out.length > 0 && out[out.length - 1] !== ' ') out.push(' ');
  };

  while (i < n) {
    const c = text[i];

    // ── whitespace: collapse to one space ──────────────────────────────────
    if (WHITESPACE.has(c)) {
      emitSpace();
      i++;
      continue;
    }

    // ── line comment ───────────────────────────────────────────────────────
    if (c === '-' && text[i + 1] === '-') {
      i += 2;
      while (i < n && text[i] !== '\n') i++;
      // A comment separates tokens, so it must not let them merge.
      emitSpace();
      continue;
    }

    // ── block comment (Postgres nests these) ───────────────────────────────
    if (c === '/' && text[i + 1] === '*') {
      const start = i;
      let nesting = 0;
      while (i < n) {
        if (text[i] === '/' && text[i + 1] === '*') {
          nesting++;
          i += 2;
          continue;
        }
        if (text[i] === '*' && text[i + 1] === '/') {
          nesting--;
          i += 2;
          if (nesting === 0) break;
          continue;
        }
        i++;
      }
      if (nesting !== 0) {
        return { ok: false, reason: `unterminated block comment at offset ${start}` };
      }
      emitSpace();
      continue;
    }

    // ── string literal — PRESERVED VERBATIM ────────────────────────────────
    if (c === "'") {
      // E'…' enables backslash escapes, so `\'` does not close the literal.
      // The E must be immediately adjacent and not the tail of a longer word.
      const isEscapeString =
        i > 0 &&
        (text[i - 1] === 'E' || text[i - 1] === 'e') &&
        !(i > 1 && (isIdentPart(text[i - 2]) || text[i - 2] === '$'));
      const start = i;
      i++;
      let closed = false;
      while (i < n) {
        if (isEscapeString && text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === "'") {
          if (text[i + 1] === "'") {
            i += 2; // doubled quote — an escaped ', not the terminator
            continue;
          }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) {
        return { ok: false, reason: `unterminated string literal at offset ${start}` };
      }
      out.push(text.slice(start, i));
      lastWord = '';
      continue;
    }

    // ── quoted identifier — PRESERVED VERBATIM ─────────────────────────────
    if (c === '"') {
      const start = i;
      i++;
      let closed = false;
      while (i < n) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) {
        return { ok: false, reason: `unterminated quoted identifier at offset ${start}` };
      }
      out.push(text.slice(start, i));
      lastWord = '';
      continue;
    }

    // ── dollar-quoted string ───────────────────────────────────────────────
    if (c === '$') {
      DOLLAR_TAG_RE.lastIndex = i;
      const m = DOLLAR_TAG_RE.exec(text);
      if (m && m.index === i) {
        const tag = m[0];
        const bodyStart = i + tag.length;
        // Postgres lexes a dollar body as OPAQUE: it ends at the first
        // occurrence of the tag, even one inside what looks like a nested
        // literal. indexOf is therefore the correct terminator search.
        const end = text.indexOf(tag, bodyStart);
        if (end < 0) {
          return { ok: false, reason: `unterminated dollar-quoted string ${tag} at offset ${i}` };
        }
        const body = text.slice(bodyStart, end);
        if (CODE_BODY_PRECEDING_TOKENS.has(lastWord)) {
          const inner = normalizeMigrationSql(body, depth + 1);
          if (!inner.ok) return inner;
          out.push(tag, inner.normalized, tag);
        } else {
          // Data literal (or an unrecognized construct): opaque, byte-compared.
          out.push(tag, body, tag);
        }
        i = end + tag.length;
        lastWord = '';
        continue;
      }
      // Not an opener — a `$1` positional parameter or a stray `$`.
      out.push(c);
      i++;
      lastWord = '';
      continue;
    }

    // ── identifier / keyword ───────────────────────────────────────────────
    if (isIdentStart(c)) {
      let j = i;
      while (j < n && isIdentPart(text[j])) j++;
      const word = text.slice(i, j);
      out.push(word);
      lastWord = word.toUpperCase();
      i = j;
      continue;
    }

    // ── anything else: punctuation, operators, digits ──────────────────────
    out.push(c);
    i++;
    lastWord = '';
  }

  return { ok: true, normalized: out.join('').trim() };
}

/**
 * True when two migration texts have IDENTICAL executable content — i.e. they
 * differ only in comments and inter-token whitespace.
 *
 * Returns a failure (never `false` dressed as a verdict, and never `true`) when
 * either side cannot be lexed, so an unclassifiable pair is reported as drift.
 */
export function executableSqlEquivalent(
  a: string,
  b: string,
): { ok: true; equivalent: boolean } | MigrationSqlNormalizeFail {
  const na = normalizeMigrationSql(a);
  if (!na.ok) return na;
  const nb = normalizeMigrationSql(b);
  if (!nb.ok) return nb;
  return { ok: true, equivalent: na.normalized === nb.normalized };
}
