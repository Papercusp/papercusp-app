/**
 * Repair drizzle-kit's pgPolicy predicate rendering from the authoritative
 * pg_policies catalog.
 *
 * drizzle-kit can attach a table's USING / WITH CHECK expressions to only one
 * of several policies when introspection order changes. Policy names are the
 * stable identity, so repair each generated pgPolicy call by its qualified
 * schema, table, and policy name rather than relying on declaration order.
 */

function camelToSnake(value) {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function skipQuoted(source, index, quote) {
  let cursor = index + 1;
  while (cursor < source.length) {
    if (source[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (source[cursor] === quote) return cursor + 1;
    cursor++;
  }
  return source.length;
}

function skipTemplate(source, index) {
  let cursor = index + 1;
  while (cursor < source.length) {
    if (source[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (source[cursor] === '`') return cursor + 1;
    cursor++;
  }
  return source.length;
}

function skipComment(source, index) {
  if (source[index + 1] === '/') {
    const end = source.indexOf('\n', index + 2);
    return end === -1 ? source.length : end;
  }
  if (source[index + 1] === '*') {
    const end = source.indexOf('*/', index + 2);
    return end === -1 ? source.length : end + 2;
  }
  return index;
}

function matchingBrace(source, openIndex) {
  let depth = 0;
  for (let cursor = openIndex; cursor < source.length; cursor++) {
    const character = source[cursor];
    if (character === '/' && (source[cursor + 1] === '/' || source[cursor + 1] === '*')) {
      cursor = skipComment(source, cursor) - 1;
      continue;
    }
    if (character === '"' || character === "'") {
      cursor = skipQuoted(source, cursor, character) - 1;
      continue;
    }
    if (character === '`') {
      cursor = skipTemplate(source, cursor) - 1;
      continue;
    }
    if (character === '{') depth++;
    if (character === '}' && --depth === 0) return cursor;
  }
  return -1;
}

function splitObjectFields(source, openIndex, closeIndex) {
  const fields = [];
  let start = openIndex + 1;
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;

  for (let cursor = start; cursor < closeIndex; cursor++) {
    const character = source[cursor];
    if (character === '/' && (source[cursor + 1] === '/' || source[cursor + 1] === '*')) {
      cursor = skipComment(source, cursor) - 1;
      continue;
    }
    if (character === '"' || character === "'") {
      cursor = skipQuoted(source, cursor, character) - 1;
      continue;
    }
    if (character === '`') {
      cursor = skipTemplate(source, cursor) - 1;
      continue;
    }
    if (character === '(') parentheses++;
    else if (character === ')') parentheses--;
    else if (character === '[') brackets++;
    else if (character === ']') brackets--;
    else if (character === '{') braces++;
    else if (character === '}') braces--;
    else if (character === ',' && parentheses === 0 && brackets === 0 && braces === 0) {
      fields.push(source.slice(start, cursor));
      start = cursor + 1;
    }
  }
  fields.push(source.slice(start, closeIndex));
  return fields.map((field) => field.trim()).filter(Boolean);
}

function fieldName(field) {
  return /^(using|withCheck)\s*:/.exec(field)?.[1] ?? null;
}

function renderPredicate(predicate) {
  const escaped = String(predicate).replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  return `sql\`${escaped}\``;
}

function policyPredicate(policy, key, fallbackKey) {
  if (Object.prototype.hasOwnProperty.call(policy, key)) return policy[key];
  if (Object.prototype.hasOwnProperty.call(policy, fallbackKey)) return policy[fallbackKey];
  return null;
}

function policyIdentity(policy) {
  const schemaName = policy.schemaName ?? policy.schemaname ?? policy.schema;
  const tableName = policy.tableName ?? policy.tablename ?? policy.table;
  const policyName = policy.policyName ?? policy.policyname ?? policy.name;
  if (!schemaName || !tableName || !policyName) return null;
  return `${schemaName}.${tableName}.${policyName}`;
}

function rewritePolicyObject(objectSource, policy) {
  const fields = splitObjectFields(objectSource, 0, objectSource.length - 1);
  const desired = {
    using: policyPredicate(policy, 'qual', 'using'),
    withCheck: policyPredicate(policy, 'with_check', 'withCheck'),
  };
  const desiredFields = {
    using: desired.using == null ? null : `using: ${renderPredicate(desired.using)}`,
    withCheck: desired.withCheck == null ? null : `withCheck: ${renderPredicate(desired.withCheck)}`,
  };

  const existing = new Map();
  for (const field of fields) {
    const name = fieldName(field);
    if (name) existing.set(name, field);
  }

  let changed = false;
  for (const name of ['using', 'withCheck']) {
    const current = existing.get(name);
    const wanted = desiredFields[name];
    if (wanted === null) {
      if (current !== undefined) changed = true;
    } else if (current !== wanted) {
      changed = true;
    }
  }
  if (!changed) return { source: objectSource, changed: false };

  const retained = fields.filter((field) => {
    const name = fieldName(field);
    return !name || desiredFields[name] !== null;
  });
  const outputFields = retained.map((field) => {
    const name = fieldName(field);
    return name && desiredFields[name] !== null ? desiredFields[name] : field;
  });
  for (const name of ['using', 'withCheck']) {
    if (desiredFields[name] !== null && !existing.has(name)) outputFields.push(desiredFields[name]);
  }

  if (objectSource.includes('\n')) {
    const indentation = objectSource.match(/\n([ \t]+)/)?.[1] ?? '  ';
    return {
      source: `{\n${outputFields.map((field) => `${indentation}${field}`).join(',\n')}\n}`,
      changed: true,
    };
  }
  return { source: `{ ${outputFields.join(', ')} }`, changed: true };
}

/**
 * @param {{ source: string, policies: Array<Record<string, unknown>> }} input
 * @returns {{ source: string, changed: boolean, repaired: number, unresolved: string[] }}
 */
export function repairPgPolicyPredicates({ source, policies }) {
  const policyByIdentity = new Map();
  const unresolved = [];
  for (const policy of policies) {
    const identity = policyIdentity(policy);
    if (!identity) {
      unresolved.push('authoritative policy row has no schema, table, or policy name');
      continue;
    }
    policyByIdentity.set(identity, policy);
  }

  const tablePattern =
    /^export const ([A-Za-z_$][\w$]*) = ([A-Za-z_$][\w$]*)\.table\("([^"]+)", \{/gm;
  const tables = [...source.matchAll(tablePattern)].map((match, index, matches) => ({
    start: match.index,
    end: index + 1 < matches.length ? matches[index + 1].index : source.length,
    schemaName: camelToSnake(match[2]),
    tableName: match[3],
  }));
  const matchedPolicies = new Set();
  const changedBlocks = [];
  let repaired = 0;

  for (const table of tables) {
    const block = source.slice(table.start, table.end);
    const policyPattern = /pgPolicy\(\s*(["'])(.*?)\1\s*,\s*\{/g;
    const replacements = [];
    let match;
    while ((match = policyPattern.exec(block)) !== null) {
      const policyName = match[2];
      const identity = `${table.schemaName}.${table.tableName}.${policyName}`;
      const policy = policyByIdentity.get(identity);
      if (!policy) {
        unresolved.push(`${identity}: generated policy has no authoritative catalog row`);
        continue;
      }
      matchedPolicies.add(identity);
      const openIndex = match.index + match[0].length - 1;
      const closeIndex = matchingBrace(block, openIndex);
      if (closeIndex === -1) {
        unresolved.push(`${identity}: generated policy object is unbalanced`);
        continue;
      }
      const objectSource = block.slice(openIndex, closeIndex + 1);
      const rewritten = rewritePolicyObject(objectSource, policy);
      if (rewritten.changed) {
        replacements.push({ start: openIndex, end: closeIndex + 1, source: rewritten.source });
        repaired++;
      }
    }

    if (replacements.length > 0) {
      let repairedBlock = block;
      for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
        repairedBlock =
          repairedBlock.slice(0, replacement.start) +
          replacement.source +
          repairedBlock.slice(replacement.end);
      }
      changedBlocks.push({ start: table.start, end: table.end, block: repairedBlock });
    }
  }

  for (const identity of policyByIdentity.keys()) {
    if (!matchedPolicies.has(identity)) unresolved.push(`${identity}: authoritative policy has no generated call`);
  }
  if (unresolved.length > 0) {
    return { source, changed: false, repaired: 0, unresolved };
  }

  let repairedSource = source;
  for (const block of changedBlocks.sort((a, b) => b.start - a.start)) {
    repairedSource =
      repairedSource.slice(0, block.start) + block.block + repairedSource.slice(block.end);
  }
  return {
    source: repairedSource,
    changed: repairedSource !== source,
    repaired,
    unresolved,
  };
}
