/**
 * Repair drizzle-kit's operator-class placement in generated index builders.
 *
 * drizzle-kit can preserve the right operator classes but attach them to the
 * wrong fields in a multi-column index. PostgreSQL's catalog is authoritative;
 * this helper applies that ordered metadata to the matching generated index
 * declaration without guessing from TypeScript column types.
 */

function skipQuotedOrComment(source, start) {
  const quote = source[start];

  if (quote === '/' && source[start + 1] === '/') {
    const newline = source.indexOf('\n', start + 2);
    return newline === -1 ? source.length : newline;
  }
  if (quote === '/' && source[start + 1] === '*') {
    const close = source.indexOf('*/', start + 2);
    return close === -1 ? source.length : close + 2;
  }
  if (quote === '`') {
    let i = start + 1;
    while (i < source.length) {
      if (source[i] === '\\') {
        i += 2;
        continue;
      }
      if (source[i] === '`') return i + 1;
      i += 1;
    }
    return source.length;
  }

  let i = start + 1;
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2;
      continue;
    }
    if (source[i] === quote) return i + 1;
    i += 1;
  }
  return source.length;
}

function findBalancedClose(source, openAt, open, close) {
  let depth = 1;
  for (let i = openAt + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '/' && (source[i + 1] === '/' || source[i + 1] === '*')) {
      i = skipQuotedOrComment(source, i) - 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipQuotedOrComment(source, i) - 1;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findCallExpressionEnd(source, openAt) {
  let depth = 0;
  for (let i = openAt; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '/' && (source[i + 1] === '/' || source[i + 1] === '*')) {
      i = skipQuotedOrComment(source, i) - 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipQuotedOrComment(source, i) - 1;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (depth === 0 && (ch === ',' || ch === ']')) return i;
  }
  return -1;
}

function tableBlocks(source) {
  const blocks = [];
  const tableRe = /export const (\w+) = (\w+)\.table\("([^"]+)",\s*\{/g;
  let match;
  while ((match = tableRe.exec(source)) !== null) {
    const openBrace = tableRe.lastIndex - 1;
    const closeBrace = findBalancedClose(source, openBrace, '{', '}');
    if (closeBrace === -1) continue;

    const callOpen = source.indexOf('(', match.index);
    const callClose = findBalancedClose(source, callOpen, '(', ')');
    if (callOpen === -1 || callClose === -1) continue;

    blocks.push({
      start: match.index,
      end: callClose + 1,
      schemaVar: match[2],
      tableName: match[3],
    });
  }
  return blocks;
}

function escapedRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string} source generated schema source
 * @param {Array<{schemaName:string, tableName:string, indexName:string, opclasses:(string|null)[], expression?:boolean}>} metadata
 * @returns {{source:string, matched:number, changed:number, skipped:number}}
 */
export function repairIndexOperatorClasses(source, metadata) {
  const schemaVars = new Map();
  const schemaRe = /export const (\w+) = pgSchema\("([^"]+)"\)/g;
  let schemaMatch;
  while ((schemaMatch = schemaRe.exec(source)) !== null) {
    schemaVars.set(schemaMatch[2], schemaMatch[1]);
  }

  let output = source;
  let matched = 0;
  let changed = 0;
  let skipped = 0;

  for (const row of metadata) {
    if (!row || !Array.isArray(row.opclasses) || row.opclasses.length === 0) {
      skipped += 1;
      continue;
    }
    if (row.expression === true) {
      skipped += 1;
      continue;
    }

    const schemaVar = schemaVars.get(row.schemaName);
    if (!schemaVar) {
      skipped += 1;
      continue;
    }

    const blocks = tableBlocks(output).filter(
      (block) => block.schemaVar === schemaVar && block.tableName === row.tableName,
    );
    if (blocks.length !== 1) {
      skipped += 1;
      continue;
    }

    const block = blocks[0];
    const blockSource = output.slice(block.start, block.end);
    const indexRe = new RegExp(
      `\\b(?:index|uniqueIndex)\\(\\s*"${escapedRegExp(row.indexName)}"\\s*\\)`,
    );
    const indexMatch = indexRe.exec(blockSource);
    if (!indexMatch) {
      skipped += 1;
      continue;
    }

    const indexOpen = block.start + indexMatch.index + indexMatch[0].indexOf('(');
    const indexEnd = findCallExpressionEnd(output, indexOpen);
    if (indexEnd === -1) {
      skipped += 1;
      continue;
    }

    const indexSource = output.slice(indexOpen, indexEnd);
    const opRe = /\.op\(\s*(?:"[^"]*"|null)\s*\)/g;
    const operators = [...indexSource.matchAll(opRe)];
    if (operators.length !== row.opclasses.length) {
      skipped += 1;
      continue;
    }
    matched += 1;

    let repairedIndex = indexSource;
    for (let i = operators.length - 1; i >= 0; i -= 1) {
      const operator = operators[i];
      // PostgreSQL has no operator class for INCLUDE attributes. The catalog
      // query pads indclass with nulls for those attrs, while drizzle-kit
      // renders the unsupported value as `.op(null)`. Remove that call so the
      // generated mirror remains valid TypeScript; ordinary attrs use the
      // authoritative catalog class as before.
      const replacement =
        row.opclasses[i] == null
          ? ''
          : operator[0].replace(/"[^"]*"/, JSON.stringify(row.opclasses[i]));
      repairedIndex =
        repairedIndex.slice(0, operator.index) + replacement + repairedIndex.slice(operator.index + operator[0].length);
    }

    if (repairedIndex !== indexSource) {
      output = output.slice(0, indexOpen) + repairedIndex + output.slice(indexEnd);
      changed += 1;
    }
  }

  return { source: output, matched, changed, skipped };
}
