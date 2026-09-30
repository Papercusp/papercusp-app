/**
 * Stabilize the DECLARATION ORDER of drizzle-kit's introspected schema output.
 *
 * drizzle-kit emits `export const <name> = <schemaObj>.table(...)` (and
 * `.sequence(...)` / `.view(...)`) declarations in PostgreSQL CATALOG order,
 * which is a function of table-creation order in the live database, not of
 * anything in the generated file itself. Every time a new table is created
 * (by any migration, anywhere in the schema), the catalog order of EXISTING
 * tables can shift, so `pull-schema.mjs` regenerating after a one-column
 * migration produces a diff touching most of the ~500 table declarations —
 * only a handful of lines are the real change; the rest is pure reorder
 * (EI-22145279419639902).
 *
 * This module re-sorts the top-level declarations into a stable order that
 * depends only on the declarations' own names, so re-running pull-schema.mjs
 * against an unchanged schema (module names notwithstanding) always emits the
 * same order and a real change produces a minimal, reviewable diff.
 *
 * Both functions are pure (string in, string out) and unit-tested without a
 * live DB, per the convention in the sibling schema-*.mjs fixups.
 */

/** Declaration kinds, in the group order they're emitted. */
const KIND_ORDER = ['schema', 'sequence', 'table', 'view'];

/**
 * Classify one top-level `export const NAME = ...` block and extract its
 * sort key. Returns null for a block this stabilizer doesn't recognize
 * (e.g. a future drizzle-kit declaration kind) — such blocks are left in
 * their ORIGINAL relative position, after every recognized/sorted block,
 * rather than silently dropped or reordered blind.
 */
function classifyDeclaration(block) {
  let m = /^export const (\w+) = pgSchema\("([^"]*)"\)/.exec(block);
  if (m) return { kind: 'schema', schemaObj: m[1], name: m[2] };

  m = /^export const \w+ = (\w+)\.sequence\("([^"]*)"/.exec(block);
  if (m) return { kind: 'sequence', schemaObj: m[1], name: m[2] };

  m = /^export const \w+ = (\w+)\.table\("([^"]*)"/.exec(block);
  if (m) return { kind: 'table', schemaObj: m[1], name: m[2] };

  m = /^export const \w+ = (\w+)\.view\("([^"]*)"/.exec(block);
  if (m) return { kind: 'view', schemaObj: m[1], name: m[2] };

  return null;
}

/**
 * Split `source` into a header (everything before the first top-level
 * `export const` declaration) and the list of declaration blocks. Each block
 * runs from the start of its `export const` line up to (not including) the
 * start of the next one — trailing separator whitespace travels with the
 * block ahead of it and is normalized away by `sortTopLevelDeclarations`.
 */
function splitDeclarations(source) {
  const starts = [];
  const re = /^export const \w+ = /gm;
  let match;
  while ((match = re.exec(source)) !== null) starts.push(match.index);

  if (starts.length === 0) return { header: source, blocks: [] };

  const header = source.slice(0, starts[0]);
  const blocks = starts.map((start, i) =>
    source.slice(start, i + 1 < starts.length ? starts[i + 1] : source.length),
  );
  return { header, blocks };
}

/**
 * Re-sort every recognized top-level declaration in `source` into a stable
 * order: kind group (schema, sequence, table, view — matching drizzle-kit's
 * own emission order for a FRESH pull), then by (schemaObj, name) within each
 * group. Unrecognized blocks keep their original relative order, appended
 * after every recognized+sorted block. Separator whitespace between blocks is
 * normalized to exactly one blank line so re-running this on already-sorted
 * input is a true no-op (idempotent).
 *
 * Returns { source, changed, declarationCount } — `changed` is false when the
 * input was already in stable order (byte-identical output).
 */
export function sortTopLevelDeclarations(source) {
  const { header, blocks } = splitDeclarations(source);
  if (blocks.length === 0) return { source, changed: false, declarationCount: 0 };

  const classified = blocks.map((block, originalIndex) => ({
    block: block.replace(/\s+$/, ''), // drop trailing whitespace; re-add a normalized separator on join
    originalIndex,
    key: classifyDeclaration(block),
  }));

  const recognized = classified.filter((c) => c.key !== null);
  const unrecognized = classified.filter((c) => c.key === null);

  recognized.sort((a, b) => {
    const ka = a.key;
    const kb = b.key;
    const kindDiff = KIND_ORDER.indexOf(ka.kind) - KIND_ORDER.indexOf(kb.kind);
    if (kindDiff !== 0) return kindDiff;
    if (ka.schemaObj !== kb.schemaObj) return ka.schemaObj < kb.schemaObj ? -1 : 1;
    if (ka.name !== kb.name) return ka.name < kb.name ? -1 : 1;
    // Exceedingly unlikely (would mean two declarations for the same
    // schema-qualified name) — fall back to original position for stability.
    return a.originalIndex - b.originalIndex;
  });

  const ordered = [...recognized, ...unrecognized];
  const rebuilt = header.replace(/\s+$/, '\n\n') + ordered.map((c) => c.block).join('\n\n') + '\n';

  return {
    source: rebuilt,
    changed: rebuilt !== source,
    declarationCount: blocks.length,
  };
}

/**
 * Sort the named-import specifier list on the `drizzle-orm/pg-core` import
 * line alphabetically (a `type X` specifier sorts by `X`, ignoring the `type`
 * keyword, so value and type imports interleave by name rather than the
 * order drizzle-kit happened to first need them in). No-ops if the import
 * line isn't present (e.g. a schema with no pg-core-typed columns at all).
 */
export function sortPgCoreImportSpecifiers(source) {
  const re = /^import \{ ([^}]*) \} from "drizzle-orm\/pg-core"$/m;
  const match = re.exec(source);
  if (!match) return { source, changed: false };

  const specifiers = match[1].split(',').map((s) => s.trim()).filter(Boolean);
  const sortKey = (s) => s.replace(/^type\s+/, '');
  const sorted = [...specifiers].sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  const rebuilt = `import { ${sorted.join(', ')} } from "drizzle-orm/pg-core"`;
  const out = source.slice(0, match.index) + rebuilt + source.slice(match.index + match[0].length);
  return { source: out, changed: out !== source };
}
