/**
 * Repair drizzle-kit's rendering of NOT VALID check constraints.
 *
 * PostgreSQL appends `NOT VALID` to `pg_get_constraintdef()` for an
 * unvalidated check. drizzle-kit assumes the check expression ends the
 * definition, so its generated `sql` template can retain that clause and
 * acquire unmatched closing parentheses. Drizzle's `check()` builder has no
 * validity state, so the clause is not representable in the generated mirror.
 *
 * Keep this transform separate from the CLI so it can be regression-tested
 * without connecting to the live database.
 *
 * @param {string} source drizzle-kit's generated schema source
 * @returns {{source: string, fixed: number}} repaired source and check count
 */

function skipQuotedOrComment(source, start) {
  const ch = source[start];

  if (ch === '-' && source[start + 1] === '-') {
    const newline = source.indexOf('\n', start + 2);
    return newline === -1 ? source.length : newline;
  }
  if (ch === '/' && source[start + 1] === '*') {
    const close = source.indexOf('*/', start + 2);
    return close === -1 ? source.length : close + 2;
  }

  const quote = ch;
  for (let i = start + 1; i < source.length; i += 1) {
    if (source[i] === '\\') {
      i += 1;
      continue;
    }
    if (source[i] !== quote) continue;
    // SQL escapes a quote inside a quoted literal/identifier by doubling it.
    if (source[i + 1] === quote) {
      i += 1;
      continue;
    }
    return i + 1;
  }
  return source.length;
}

function parenBalance(source) {
  let balance = 0;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '-' && source[i + 1] === '-') {
      i = skipQuotedOrComment(source, i) - 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i = skipQuotedOrComment(source, i) - 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      i = skipQuotedOrComment(source, i) - 1;
      continue;
    }
    if (ch === '(') balance += 1;
    else if (ch === ')') balance -= 1;
  }
  return balance;
}

function repairNotValidBody(body) {
  if (!/\s+NOT\s+VALID\s*$/i.test(body)) return null;

  let expression = body.replace(/\s+NOT\s+VALID\s*$/i, '');
  const balance = parenBalance(expression);

  if (balance < 0) {
    // The drizzle-kit bug leaves unmatched closers at the end of the
    // expression. Only remove that exact suffix; never guess at an interior
    // or otherwise malformed expression.
    const end = expression.length;
    const excess = -balance;
    if (expression.slice(end - excess, end) !== ')'.repeat(excess)) return null;
    expression = expression.slice(0, end - excess);
  }

  return parenBalance(expression) === 0 ? expression : null;
}

const CHECK_SQL_RE = /(\bcheck\s*\(\s*["'][^"']*["']\s*,\s*sql`)([\s\S]*?)(`)/g;

/**
 * @param {string} source generated schema source
 * @returns {{source: string, fixed: number}}
 */
export function repairNotValidChecks(source) {
  let fixed = 0;
  const repaired = source.replace(CHECK_SQL_RE, (full, prefix, body, quote) => {
    const expression = repairNotValidBody(body);
    if (expression == null) return full;
    fixed += 1;
    return prefix + expression + quote;
  });

  return { source: repaired, fixed };
}
