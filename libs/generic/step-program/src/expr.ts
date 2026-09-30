/**
 * `expr` — a small, safe boolean/comparison expression evaluator over a runtime
 * scope. The condition language for a step-program's step `when` guards and the
 * `gate` branch conditions — e.g.
 * `tally.margin >= 0.5 AND tally.mean_conf >= 0.6 AND NOT tally.advocate_veto`
 * or `posts >= payload.quorum OR elapsed > payload.timeout_s`.
 *
 * **NOT `eval`.** A recursive-descent parser → AST → pure tree-walk over the
 * scope. No host access, no function calls, no assignment — only reads of scope
 * paths + comparisons + boolean logic. So an author-supplied (or distributed)
 * condition can never run arbitrary code (a hard requirement once programs are
 * user-authorable / forkable).
 *
 * **Deliberately minimal:** paths, number/string/bool/null literals, the six
 * comparisons, `AND`/`OR`/`NOT` (+ `&&`/`||`/`!` aliases), and parentheses. No
 * arithmetic — add it (one `additive` production) if a real condition ever needs
 * it.
 *
 * Pure: `evalExpr(expr, scope)` reads only its arguments. `parseExpr(expr)`
 * (author-time validation) throws on a malformed expression; `evalExpr` returns a
 * boolean (truthiness of the evaluated value).
 */

// ── AST ──────────────────────────────────────────────────────────────────────

type Ast =
  | { t: 'lit'; v: number | string | boolean | null }
  | { t: 'path'; segments: (string | number)[] }
  | { t: 'not'; x: Ast }
  | { t: 'and'; l: Ast; r: Ast }
  | { t: 'or'; l: Ast; r: Ast }
  | { t: 'cmp'; op: CmpOp; l: Ast; r: Ast };

type CmpOp = '>=' | '>' | '<=' | '<' | '==' | '!=';

// ── Tokenizer ──────────────────────────────────────────────────────────────

type Tok =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'ident'; v: string }
  | { k: 'op'; v: string }
  | { k: 'lparen' }
  | { k: 'rparen' };

const CMP_OPS = new Set(['>=', '>', '<=', '<', '==', '!=']);

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '(') {
      toks.push({ k: 'lparen' });
      i++;
      continue;
    }
    if (c === ')') {
      toks.push({ k: 'rparen' });
      i++;
      continue;
    }
    // String literal — single or double quoted (no escapes; conditions are simple).
    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      let s = '';
      while (j < n && src[j] !== quote) {
        s += src[j];
        j++;
      }
      if (j >= n) throw new Error(`expr: unterminated string literal in "${src}"`);
      toks.push({ k: 'str', v: s });
      i = j + 1;
      continue;
    }
    // Number literal (int or decimal; leading-dot like `.5` not supported).
    if (c >= '0' && c <= '9') {
      let j = i;
      while (j < n && ((src[j]! >= '0' && src[j]! <= '9') || src[j] === '.')) j++;
      const raw = src.slice(i, j);
      const v = Number(raw);
      if (!Number.isFinite(v)) throw new Error(`expr: bad number "${raw}" in "${src}"`);
      toks.push({ k: 'num', v });
      i = j;
      continue;
    }
    // Two-char operators first, then one-char.
    const two = src.slice(i, i + 2);
    if (CMP_OPS.has(two) || two === '&&' || two === '||') {
      toks.push({ k: 'op', v: two });
      i += 2;
      continue;
    }
    if (c === '>' || c === '<') {
      toks.push({ k: 'op', v: c });
      i++;
      continue;
    }
    if (c === '!') {
      toks.push({ k: 'op', v: '!' });
      i++;
      continue;
    }
    // Identifier / path / keyword — a letter/_/$ start, then word chars, dots,
    // and `[<int>]` index segments (kept verbatim; the parser splits the path).
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$.[\]]/.test(src[j]!)) j++;
      toks.push({ k: 'ident', v: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`expr: unexpected character "${c}" at ${i} in "${src}"`);
  }
  return toks;
}

// ── Parser (recursive descent, precedence OR < AND < NOT < comparison) ───────

class Parser {
  private pos = 0;
  constructor(
    private readonly toks: Tok[],
    private readonly src: string,
  ) {}

  parse(): Ast {
    const ast = this.parseOr();
    if (this.pos !== this.toks.length) {
      throw new Error(`expr: trailing tokens in "${this.src}"`);
    }
    return ast;
  }

  private peek(): Tok | undefined {
    return this.toks[this.pos];
  }

  private isKeyword(word: string): boolean {
    const t = this.peek();
    return t?.k === 'ident' && t.v.toUpperCase() === word;
  }

  private isOp(v: string): boolean {
    const t = this.peek();
    return t?.k === 'op' && t.v === v;
  }

  private parseOr(): Ast {
    let l = this.parseAnd();
    while (this.isKeyword('OR') || this.isOp('||')) {
      this.pos++;
      l = { t: 'or', l, r: this.parseAnd() };
    }
    return l;
  }

  private parseAnd(): Ast {
    let l = this.parseNot();
    while (this.isKeyword('AND') || this.isOp('&&')) {
      this.pos++;
      l = { t: 'and', l, r: this.parseNot() };
    }
    return l;
  }

  private parseNot(): Ast {
    if (this.isKeyword('NOT') || this.isOp('!')) {
      this.pos++;
      return { t: 'not', x: this.parseNot() };
    }
    return this.parseComparison();
  }

  private parseComparison(): Ast {
    const l = this.parsePrimary();
    const t = this.peek();
    if (t?.k === 'op' && CMP_OPS.has(t.v)) {
      this.pos++;
      const r = this.parsePrimary();
      return { t: 'cmp', op: t.v as CmpOp, l, r };
    }
    return l;
  }

  private parsePrimary(): Ast {
    const t = this.peek();
    if (!t) throw new Error(`expr: unexpected end of "${this.src}"`);
    if (t.k === 'lparen') {
      this.pos++;
      const inner = this.parseOr();
      const close = this.peek();
      if (close?.k !== 'rparen') throw new Error(`expr: missing ")" in "${this.src}"`);
      this.pos++;
      return inner;
    }
    if (t.k === 'num') {
      this.pos++;
      return { t: 'lit', v: t.v };
    }
    if (t.k === 'str') {
      this.pos++;
      return { t: 'lit', v: t.v };
    }
    if (t.k === 'ident') {
      this.pos++;
      const word = t.v;
      const lower = word.toLowerCase();
      if (lower === 'true') return { t: 'lit', v: true };
      if (lower === 'false') return { t: 'lit', v: false };
      if (lower === 'null') return { t: 'lit', v: null };
      return { t: 'path', segments: splitPath(word) };
    }
    throw new Error(`expr: unexpected token in "${this.src}"`);
  }
}

/** Split `a.b[0].c` → ['a','b',0,'c']. Bare `name` → ['name']. */
function splitPath(raw: string): (string | number)[] {
  const out: (string | number)[] = [];
  for (const part of raw.split('.')) {
    if (!part) continue;
    // pull `key[0][1]` apart
    const m = part.matchAll(/([^[\]]+)|\[(\d+)\]/g);
    for (const g of m) {
      if (g[1] != null) out.push(g[1]);
      else if (g[2] != null) out.push(Number(g[2]));
    }
  }
  return out;
}

// ── Scope read ───────────────────────────────────────────────────────────────

export type Scope = Record<string, unknown>;

/** Resolve a dotted/bracketed path against the scope; missing → undefined. */
export function readPath(scope: Scope, segments: (string | number)[]): unknown {
  let cur: unknown = scope;
  for (const seg of segments) {
    if (cur == null) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[seg as never];
  }
  return cur;
}

// ── Eval ─────────────────────────────────────────────────────────────────────

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Loose equality: numbers numerically (incl. numeric strings), else strict `===`. */
function eq(a: unknown, b: unknown): boolean {
  const an = toNumber(a);
  const bn = toNumber(b);
  if (an != null && bn != null) return an === bn;
  return a === b;
}

function compare(op: CmpOp, a: unknown, b: unknown): boolean {
  if (op === '==') return eq(a, b);
  if (op === '!=') return !eq(a, b);
  // Ordering comparisons: numeric if both coerce to numbers, else string-lexical.
  const an = toNumber(a);
  const bn = toNumber(b);
  let l: number | string;
  let r: number | string;
  if (an != null && bn != null) {
    l = an;
    r = bn;
  } else {
    l = String(a ?? '');
    r = String(b ?? '');
  }
  switch (op) {
    case '>=':
      return l >= r;
    case '>':
      return l > r;
    case '<=':
      return l <= r;
    case '<':
      return l < r;
    default: {
      // Exhaustiveness guard: if CmpOp ever grows a member without a switch arm,
      // fail closed (false) rather than return undefined into the truthiness path.
      const _exhaustive: never = op;
      void _exhaustive;
      return false;
    }
  }
}

/** Truthiness: JS-ish, but an empty array / empty object is falsy (so a `when`
 *  like `voted.errors` reads "are there any" rather than "is it defined"). */
export function truthy(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return Boolean(v);
}

function evalAst(ast: Ast, scope: Scope): unknown {
  switch (ast.t) {
    case 'lit':
      return ast.v;
    case 'path':
      return readPath(scope, ast.segments);
    case 'not':
      return !truthy(evalAst(ast.x, scope));
    case 'and':
      return truthy(evalAst(ast.l, scope)) && truthy(evalAst(ast.r, scope));
    case 'or':
      return truthy(evalAst(ast.l, scope)) || truthy(evalAst(ast.r, scope));
    case 'cmp':
      return compare(ast.op, evalAst(ast.l, scope), evalAst(ast.r, scope));
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Parse an expression into an AST. Throws on a malformed expression — use at
 * author-time (validation) so a bad condition is caught before the program runs.
 * Memoisation is the caller's concern (parse is cheap).
 */
export function parseExpr(expr: string): Ast {
  const toks = tokenize(expr);
  if (toks.length === 0) throw new Error(`expr: empty expression`);
  return new Parser(toks, expr).parse();
}

/** True if `expr` parses; false otherwise. For author-time validation. */
export function isValidExpr(expr: string): boolean {
  try {
    parseExpr(expr);
    return true;
  } catch {
    return false;
  }
}

/**
 * Evaluate a boolean expression against the scope. Returns the **truthiness** of
 * the evaluated value (a bare path `voted.resolved` is treated as a boolean
 * guard, a `cmp`/`and`/`or`/`not` already yields a boolean). Throws only on a
 * parse error — a missing path is `undefined` → falsy, never an error.
 */
export function evalExpr(expr: string, scope: Scope): boolean {
  return truthy(evalAst(parseExpr(expr), scope));
}
