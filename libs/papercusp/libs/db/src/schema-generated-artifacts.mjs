import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const TABLE_DECLARATION =
  /^export const ([A-Za-z_$][\w$]*) = (?:[A-Za-z_$][\w$]*\.table|pgTable)\(/gm;
const NEXT_EXPORT = '\nexport const ';
const FOREIGN_TABLE_REFERENCE =
  /foreignColumns:\s*\[\s*([A-Za-z_$][\w$]*)\./g;
const UNTYPED_EXTRA_CONFIG = '}, (table) => [';
const TYPED_EXTRA_CONFIG = '}, (table): PgTableExtraConfigValue[] => [';

const GENERATED_TABLE_DECLARATION =
  /^export const ([A-Za-z_$][\w$]*) = ([A-Za-z_$][\w$]*)\.table\("([^"]+)", \{/gm;
const GENERATED_RELATIONS_DECLARATION =
  /^export const [A-Za-z_$][\w$]*Relations = relations\(([A-Za-z_$][\w$]*),/gm;

function camelToSnake(value) {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function generatedTableBlocks(source) {
  const matches = [...source.matchAll(GENERATED_TABLE_DECLARATION)];
  return matches.map((match, index) => {
    const start = match.index;
    const end = index + 1 < matches.length ? matches[index + 1].index : source.length;
    const block = source.slice(start, end);
    const columnsEnd = block.indexOf('\n}, (table)');
    const columnsSource = columnsEnd === -1 ? block : block.slice(0, columnsEnd);
    const columns = new Map();

    for (const line of columnsSource.split('\n')) {
      const column = /^\s*([A-Za-z_$][\w$]*):\s*[A-Za-z_$][\w$]*(?:<[^>]+>)?\(\s*(?:(["'])(.*?)\2)?/.exec(
        line,
      );
      if (!column) continue;
      const property = column[1];
      columns.set(column[3] || property, property);
    }

    return {
      start,
      end,
      block,
      variable: match[1],
      schemaName: camelToSnake(match[2]),
      tableName: match[3],
      columns,
    };
  });
}

function generatedRelationBlocks(source) {
  const matches = [...source.matchAll(GENERATED_RELATIONS_DECLARATION)];
  return matches.map((match, index) => ({
    start: match.index,
    end: index + 1 < matches.length ? matches[index + 1].index : source.length,
    block: source.slice(
      match.index,
      index + 1 < matches.length ? matches[index + 1].index : source.length,
    ),
    variable: match[1],
  }));
}

function rebuildModifiedBlocks(source, blocks) {
  let result = source;
  for (const block of [...blocks].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, block.start) + block.block + result.slice(block.end);
  }
  return result;
}

/**
 * Repair drizzle-kit's composite-FK artifacts from the authoritative PG
 * constraint catalog.
 *
 * drizzle-kit v0.31 can independently corrupt the two generated surfaces:
 *   1. schema.ts reorders the referenced columns to the target PK order while
 *      leaving local columns in constraint order;
 *   2. relations.ts collapses every composite relation to its first column.
 *
 * The DB already knows the exact ordered pairs in pg_constraint.conkey /
 * confkey, so this fix consumes that catalog result instead of trying to infer
 * order from the generated text. Only composite constraints are touched.
 *
 * @param {{
 *   schema: string,
 *   relations: string,
 *   foreignKeys: Array<{
 *     constraintName: string,
 *     schemaName: string,
 *     tableName: string,
 *     foreignSchemaName: string,
 *     foreignTableName: string,
 *     columns: string[],
 *     foreignColumns: string[],
 *   }>,
 * }} input
 * @returns {{
 *   schema: string,
 *   relations: string,
 *   schemaChanged: number,
 *   relationsChanged: number,
 *   unresolved: string[],
 * }}
 */
export function repairCompositeForeignKeyArtifacts({ schema, relations, foreignKeys }) {
  const composite = foreignKeys.filter(
    (foreignKey) => foreignKey.columns.length > 1 || foreignKey.foreignColumns.length > 1,
  );
  const schemaBlocks = generatedTableBlocks(schema);
  const tableByIdentity = new Map(
    schemaBlocks.map((table) => [`${table.schemaName}.${table.tableName}`, table]),
  );
  const unresolved = [];
  let schemaChanged = 0;

  for (const foreignKey of composite) {
    const local = tableByIdentity.get(`${foreignKey.schemaName}.${foreignKey.tableName}`);
    const foreign = tableByIdentity.get(
      `${foreignKey.foreignSchemaName}.${foreignKey.foreignTableName}`,
    );
    if (!local || !foreign) {
      unresolved.push(`${foreignKey.constraintName}: generated table declaration missing`);
      continue;
    }

    const localProperties = foreignKey.columns.map((column) => local.columns.get(column));
    const foreignProperties = foreignKey.foreignColumns.map((column) => foreign.columns.get(column));
    if (localProperties.some((column) => !column) || foreignProperties.some((column) => !column)) {
      unresolved.push(`${foreignKey.constraintName}: generated column mapping missing`);
      continue;
    }

    const constraintPattern = new RegExp(
      `(foreignKey\\(\\{\\s*columns:\\s*)\\[[^\\]]*\\]` +
        `(\\s*,\\s*foreignColumns:\\s*)\\[[^\\]]*\\]` +
        `(\\s*,\\s*name:\\s*["']${escapeRegExp(foreignKey.constraintName)}["'])`,
    );
    if (!constraintPattern.test(local.block)) {
      unresolved.push(`${foreignKey.constraintName}: generated foreignKey block missing`);
      continue;
    }

    const localArray = `[${localProperties.map((column) => `table.${column}`).join(', ')}]`;
    const foreignArray = `[${foreignProperties
      .map((column) => `${foreign.variable}.${column}`)
      .join(', ')}]`;
    const repaired = local.block.replace(
      constraintPattern,
      `$1${localArray}$2${foreignArray}$3`,
    );
    if (repaired !== local.block) {
      local.block = repaired;
      schemaChanged++;
    }
  }

  schema = rebuildModifiedBlocks(schema, schemaBlocks);

  const relationBlocks = generatedRelationBlocks(relations);
  const relationByVariable = new Map(relationBlocks.map((block) => [block.variable, block]));
  const pairCounts = new Map();
  for (const foreignKey of composite) {
    const local = tableByIdentity.get(`${foreignKey.schemaName}.${foreignKey.tableName}`);
    const foreign = tableByIdentity.get(
      `${foreignKey.foreignSchemaName}.${foreignKey.foreignTableName}`,
    );
    if (!local || !foreign) continue;
    const key = `${local.variable}->${foreign.variable}`;
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }

  let relationsChanged = 0;
  for (const foreignKey of composite) {
    const local = tableByIdentity.get(`${foreignKey.schemaName}.${foreignKey.tableName}`);
    const foreign = tableByIdentity.get(
      `${foreignKey.foreignSchemaName}.${foreignKey.foreignTableName}`,
    );
    if (!local || !foreign) continue;
    const pairKey = `${local.variable}->${foreign.variable}`;
    if (pairCounts.get(pairKey) !== 1) {
      unresolved.push(`${foreignKey.constraintName}: multiple FKs share one relation pair`);
      continue;
    }

    const relation = relationByVariable.get(local.variable);
    if (!relation) {
      unresolved.push(`${foreignKey.constraintName}: generated relations block missing`);
      continue;
    }
    const localProperties = foreignKey.columns.map((column) => local.columns.get(column));
    const foreignProperties = foreignKey.foreignColumns.map((column) => foreign.columns.get(column));
    if (localProperties.some((column) => !column) || foreignProperties.some((column) => !column)) {
      continue; // already reported by the schema pass
    }

    const relationPattern = new RegExp(
      `(^\\s*[A-Za-z_$][\\w$]*:\\s*one\\(${escapeRegExp(foreign.variable)},\\s*\\{` +
        `\\s*fields:\\s*)\\[[^\\]]*\\]` +
        `(\\s*,\\s*references:\\s*)\\[[^\\]]*\\]`,
      'm',
    );
    const matches = [...relation.block.matchAll(new RegExp(relationPattern.source, 'gm'))];
    if (matches.length !== 1) {
      unresolved.push(
        `${foreignKey.constraintName}: expected one generated relation, found ${matches.length}`,
      );
      continue;
    }

    const localArray = `[${localProperties
      .map((column) => `${local.variable}.${column}`)
      .join(', ')}]`;
    const foreignArray = `[${foreignProperties
      .map((column) => `${foreign.variable}.${column}`)
      .join(', ')}]`;
    const repaired = relation.block.replace(
      relationPattern,
      `$1${localArray}$2${foreignArray}`,
    );
    if (repaired !== relation.block) {
      relation.block = repaired;
      relationsChanged++;
    }
  }

  relations = rebuildModifiedBlocks(relations, relationBlocks);
  return { schema, relations, schemaChanged, relationsChanged, unresolved };
}

/**
 * Break TypeScript's inference cycle for mutually-referencing composite FKs.
 *
 * drizzle-kit renders composite foreign keys in table extra-config callbacks.
 * When table A references table B and B references A, TypeScript must infer A
 * while it is still inferring B (TS7022/TS7024). Drizzle's supported escape
 * hatch for circular schema inference is an explicit type boundary; for a
 * composite FK, the boundary belongs on the extra-config callback rather than
 * on an individual column.
 *
 * The transform discovers cycles from the generated foreignColumns clauses and
 * annotates only tables that participate in one. It is intentionally generic:
 * a later migration that introduces another mutual composite FK is covered by
 * the same generator fix instead of adding another table-name allow-list.
 *
 * @param {string} source drizzle-kit's generated schema source
 * @returns {{ schema: string, circularTables: string[] }}
 */
export function annotateCircularForeignKeyExtraConfigs(source) {
  const matches = [...source.matchAll(TABLE_DECLARATION)];
  /** @type {Map<string, { name: string, start: number, end: number, block: string }>} */
  const tables = new Map();

  for (const match of matches) {
    const name = match[1];
    const start = match.index;
    const next = source.indexOf(NEXT_EXPORT, start + match[0].length);
    const end = next === -1 ? source.length : next + 1;
    tables.set(name, { name, start, end, block: source.slice(start, end) });
  }

  /** @type {Map<string, Set<string>>} */
  const edges = new Map();
  for (const table of tables.values()) {
    const dependencies = new Set(
      [...table.block.matchAll(FOREIGN_TABLE_REFERENCE)]
        .map((match) => match[1])
        .filter((name) => tables.has(name)),
    );
    edges.set(table.name, dependencies);
  }

  /**
   * @param {string} current
   * @param {string} target
   * @param {Set<string>} seen
   */
  function reaches(current, target, seen) {
    if (current === target) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    for (const dependency of edges.get(current) ?? []) {
      if (reaches(dependency, target, seen)) return true;
    }
    return false;
  }

  const circularTables = [...tables.values()]
    .filter((table) =>
      [...(edges.get(table.name) ?? [])].some((dependency) =>
        reaches(dependency, table.name, new Set()),
      ),
    )
    .map((table) => table.name);

  if (circularTables.length === 0) return { schema: source, circularTables };

  let schema = source;
  const circularSet = new Set(circularTables);
  const reverseBlocks = [...tables.values()]
    .filter((table) => circularSet.has(table.name))
    .sort((a, b) => b.start - a.start);

  for (const table of reverseBlocks) {
    if (table.block.includes(TYPED_EXTRA_CONFIG)) continue;
    if (!table.block.includes(UNTYPED_EXTRA_CONFIG)) {
      throw new Error(
        `Circular composite-FK table ${table.name} has no generated array extra-config callback to annotate`,
      );
    }
    const patched = table.block.replace(UNTYPED_EXTRA_CONFIG, TYPED_EXTRA_CONFIG);
    schema = schema.slice(0, table.start) + patched + schema.slice(table.end);
  }

  if (!schema.includes('type PgTableExtraConfigValue')) {
    const importPattern = /(import \{[^\n]*)( \} from "drizzle-orm\/pg-core")/;
    if (!importPattern.test(schema)) {
      throw new Error('Generated schema has no single-line drizzle-orm/pg-core import to extend');
    }
    schema = schema.replace(
      importPattern,
      '$1, type PgTableExtraConfigValue$2',
    );
  }

  return { schema, circularTables };
}

/**
 * Promote drizzle-kit's temporary schema artifacts, then remove the ignored
 * source names so the package typecheck cannot compile a stale second mirror.
 * Copy-before-remove keeps a failed promotion recoverable.
 *
 * @param {{ schemaPath: string, relationsPath: string, schemaDir: string }} input
 * @returns {{ generatedSchemaPath: string, generatedRelationsPath: string | null }}
 */
export function promoteGeneratedSchemaArtifacts({ schemaPath, relationsPath, schemaDir }) {
  const generatedSchemaPath = join(schemaDir, 'generated.ts');
  const generatedRelationsPath = join(schemaDir, 'generated-relations.ts');
  if (resolve(schemaPath) === resolve(generatedSchemaPath)) {
    throw new Error('Refusing to promote a schema artifact onto itself');
  }

  copyFileSync(schemaPath, generatedSchemaPath);
  const promotedRelations = existsSync(relationsPath);
  if (promotedRelations) copyFileSync(relationsPath, generatedRelationsPath);

  rmSync(schemaPath, { force: true });
  if (promotedRelations) rmSync(relationsPath, { force: true });

  return {
    generatedSchemaPath,
    generatedRelationsPath: promotedRelations ? generatedRelationsPath : null,
  };
}
