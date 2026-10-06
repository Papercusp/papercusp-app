/**
 * Shared static tool/unit catalog builder — pure source-graph derivation, no
 * operator process, no network, no PG.
 *
 * Originally inlined in `__tests__/blueprint-deps-catalog.test.ts` (which
 * itself mirrors `__tests__/tools-md-sync.test.ts`'s catalog builder).
 * Extracted here (agent-trap-guards-2026-07-26 P-007) so a SECOND static
 * catalog scanner didn't need constructing for
 * `__tests__/prompt-blueprint-verb-catalog.test.ts` — both tests now import
 * the same scan instead of each maintaining their own copy that can drift.
 *
 * - built-in tools = literal MCP identities from actual `defineTool` /
 *   `defineUITool` calls reachable from the production MCP registry entrypoint;
 * - distribution units = libs/papercusp/plugins/<x>/papercusp.json manifests
 *   (manifest kind=pack → pack, else plugin), tool names from `tools[]`
 *   (`expose.mcp.name` ?? `<short>.<tool.name>`) + dynamic `tools:<g>:<v>`
 *   capabilities.
 */
import { existsSync, globSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';

/** The same side-effect entrypoint imported by the live catalog generator. */
export const PRODUCTION_TOOL_REGISTRY_ENTRYPOINT = 'packages/operator-core/lib/agent-tools/index.ts';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const;
const SOURCE_EXTENSION_SET = new Set<string>(SOURCE_EXTENSIONS);

interface WorkspacePackage {
  readonly root: string;
  readonly manifest: Record<string, unknown>;
}

interface ToolSourceSnapshot {
  readonly graphFiles: readonly string[];
  readonly fileIndex: ReadonlyMap<string, readonly string[]>;
}

const snapshotCache = new Map<string, ToolSourceSnapshot>();

function readJsonObject(path: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function workspacePackages(repoRoot: string): ReadonlyMap<string, WorkspacePackage> {
  const rootManifest = readJsonObject(join(repoRoot, 'package.json'));
  const patterns = Array.isArray(rootManifest?.workspaces)
    ? rootManifest.workspaces.filter((value): value is string => typeof value === 'string')
    : [];
  const packages = new Map<string, WorkspacePackage>();
  for (const pattern of patterns) {
    for (const manifestRel of globSync(`${pattern}/package.json`, { cwd: repoRoot })) {
      const manifestPath = join(repoRoot, manifestRel);
      const manifest = readJsonObject(manifestPath);
      if (typeof manifest?.name !== 'string') continue;
      packages.set(manifest.name, { root: dirname(manifestPath), manifest });
    }
  }
  return packages;
}

function exportTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const target = exportTarget(candidate);
      if (target) return target;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const condition of ['source', 'import', 'node', 'default', 'types']) {
    const target = exportTarget(record[condition]);
    if (target) return target;
  }
  for (const candidate of Object.values(record)) {
    const target = exportTarget(candidate);
    if (target) return target;
  }
  return undefined;
}

function packageExportTarget(pkg: WorkspacePackage, subpath: string): string | undefined {
  const exportsField = pkg.manifest.exports;
  const key = subpath ? `./${subpath}` : '.';
  if (typeof exportsField === 'string' || Array.isArray(exportsField)) {
    return subpath ? undefined : exportTarget(exportsField);
  }
  if (exportsField && typeof exportsField === 'object') {
    const exportsMap = exportsField as Record<string, unknown>;
    const exact = exportTarget(exportsMap[key]);
    if (exact) return exact;
    // Node matches the longest base before '*', then the longest pattern.
    // Declaration order must not let ./lib/* shadow ./lib/*.mjs.
    const patterns = Object.entries(exportsMap)
      .filter(([pattern]) => pattern.includes('*'))
      .sort(([a], [b]) => b.indexOf('*') - a.indexOf('*') || b.length - a.length);
    for (const [pattern, value] of patterns) {
      const star = pattern.indexOf('*');
      if (star < 0) continue;
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (key.length < prefix.length + suffix.length || !key.startsWith(prefix) || !key.endsWith(suffix)) continue;
      const wildcard = key.slice(prefix.length, key.length - suffix.length);
      const target = exportTarget(value);
      // A matched null/unsupported target cannot fall through to a broader export.
      return target?.replaceAll('*', wildcard);
    }
    if (!subpath && !Object.keys(exportsMap).some((candidate) => candidate.startsWith('.'))) {
      return exportTarget(exportsMap);
    }
  }
  if (subpath) return subpath;
  return typeof pkg.manifest.main === 'string' ? pkg.manifest.main : 'src/index.ts';
}

function sourceFileCandidate(base: string): string | undefined {
  const candidates: string[] = [];
  const extension = extname(base);
  if (extension) {
    candidates.push(base);
    if (['.js', '.jsx', '.mjs', '.cjs'].includes(extension)) {
      const stem = base.slice(0, -extension.length);
      candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`);
    }
  } else {
    candidates.push(...SOURCE_EXTENSIONS.map((candidate) => `${base}${candidate}`));
  }
  candidates.push(...SOURCE_EXTENSIONS.map((candidate) => join(base, `index${candidate}`)));
  for (const candidate of candidates) {
    if (existsSync(candidate) && SOURCE_EXTENSION_SET.has(extname(candidate))) return resolve(candidate);
  }
  return undefined;
}

function packageNameAndSubpath(specifier: string): { name: string; subpath: string } | undefined {
  const parts = specifier.split('/');
  if (!specifier.startsWith('@') || parts.length < 2) return undefined;
  return { name: `${parts[0]}/${parts[1]}`, subpath: parts.slice(2).join('/') };
}

function resolveGraphImport(
  specifier: string,
  containingFile: string,
  repoRoot: string,
  packages: ReadonlyMap<string, WorkspacePackage>,
): string | undefined {
  let candidate: string | undefined;
  if (specifier.startsWith('.') || isAbsolute(specifier)) {
    if (/\.(?:json|css|scss|sass|less|svg)$/i.test(specifier)) return undefined;
    candidate = sourceFileCandidate(resolve(dirname(containingFile), specifier));
    if (!candidate) {
      throw new Error(`Static tool catalog could not resolve ${specifier} from ${relative(repoRoot, containingFile)}`);
    }
  } else {
    const parsed = packageNameAndSubpath(specifier);
    const pkg = parsed ? packages.get(parsed.name) : undefined;
    if (!parsed || !pkg) return undefined; // external dependency: not part of this workspace graph
    const target = packageExportTarget(pkg, parsed.subpath);
    candidate = target ? sourceFileCandidate(resolve(pkg.root, target)) : undefined;
    if (!candidate) {
      throw new Error(`Static tool catalog could not resolve workspace import ${specifier}`);
    }
  }
  const rel = relative(repoRoot, candidate);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Static tool catalog import escaped the repository: ${candidate}`);
  }
  return candidate;
}

function runtimeModuleSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      const named = clause?.namedBindings;
      const onlyNamedTypes =
        named && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly);
      if (clause?.isTypeOnly || onlyNamedTypes) continue;
      if (ts.isStringLiteralLike(statement.moduleSpecifier)) specifiers.push(statement.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      if (statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)) {
        specifiers.push(statement.moduleSpecifier.text);
      }
    } else if (
      ts.isImportEqualsDeclaration(statement) &&
      !statement.isTypeOnly &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      statement.moduleReference.expression &&
      ts.isStringLiteralLike(statement.moduleReference.expression)
    ) {
      specifiers.push(statement.moduleReference.expression.text);
    }
  }
  return specifiers;
}

function propertyValue(object: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name;
    const text = ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
    if (text === key) return property.initializer;
  }
  return undefined;
}

function sameFileStringConstants(sourceFile: ts.SourceFile): ReadonlyMap<string, string> {
  const constants = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const value = declaration.initializer;
      if (value && (ts.isStringLiteralLike(value) || ts.isNoSubstitutionTemplateLiteral(value))) {
        constants.set(declaration.name.text, value.text);
      }
    }
  }
  return constants;
}

/** Strip `as const` / `satisfies T` / parentheses / `<T>x`: type-only wrappers never change the literal. */
function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** Name registry objects in scope: local binding → { key → literal }. */
type StringObjectConstants = ReadonlyMap<string, ReadonlyMap<string, string>>;

/**
 * `const NAMES = { submit: 'blueprint:submit', … } as const` → NAMES → { submit → 'blueprint:submit' }.
 * A tool family that keeps its MCP identities in one shared name registry declares
 * `defineTool({ name: NAMES.submit })`; without resolving that property access the
 * scan silently misses the whole family (WI-10003582: all seven blueprint:* lifecycle tools).
 */
function stringObjectConstants(
  sourceFile: ts.SourceFile,
  exportedOnly: boolean,
): Map<string, Map<string, string>> {
  const objects = new Map<string, Map<string, string>>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    if (exportedOnly && !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const value = unwrapExpression(declaration.initializer);
      if (!ts.isObjectLiteralExpression(value)) continue;
      const entries = new Map<string, string>();
      for (const property of value.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const key =
          ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) ? property.name.text : undefined;
        const initializer = unwrapExpression(property.initializer);
        if (key && (ts.isStringLiteralLike(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer))) {
          entries.set(key, initializer.text);
        }
      }
      if (entries.size > 0) objects.set(declaration.name.text, entries);
    }
  }
  return objects;
}

function literalString(
  expression: ts.Expression | undefined,
  constants: ReadonlyMap<string, string>,
  objects: StringObjectConstants = new Map(),
): string | undefined {
  if (!expression) return undefined;
  const value = unwrapExpression(expression);
  if (ts.isStringLiteralLike(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (ts.isIdentifier(value)) return constants.get(value.text);
  if (ts.isPropertyAccessExpression(value) && ts.isIdentifier(value.expression)) {
    return objects.get(value.expression.text)?.get(value.name.text);
  }
  return undefined;
}

function toolNamesIn(sourceFile: ts.SourceFile, importedObjects: StringObjectConstants = new Map()): string[] {
  const names: string[] = [];
  const constants = sameFileStringConstants(sourceFile);
  const objects: StringObjectConstants = new Map([
    ...importedObjects,
    ...stringObjectConstants(sourceFile, false),
  ]);
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === 'defineTool' || node.expression.text === 'defineUITool')
    ) {
      const input = node.arguments[0];
      if (input && ts.isObjectLiteralExpression(input)) {
        const expose = propertyValue(input, 'expose');
        const mcp = expose && ts.isObjectLiteralExpression(expose) ? propertyValue(expose, 'mcp') : undefined;
        const projected =
          mcp && ts.isObjectLiteralExpression(mcp)
            ? literalString(propertyValue(mcp, 'name'), constants, objects)
            : undefined;
        const name = projected ?? literalString(propertyValue(input, 'name'), constants, objects);
        if (name) names.push(name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

function scriptKind(path: string): ts.ScriptKind {
  if (/\.[cm]?tsx$/i.test(path)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(path)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/i.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Named imports that bind an EXPORTED `const X = { key: 'literal' }` name registry,
 * resolved through the same graph resolver the scan already walks, keyed by the
 * local binding (so `import { NAMES as N }` resolves `N.submit`).
 */
function importedStringObjectConstants(
  sourceFile: ts.SourceFile,
  file: string,
  repoRoot: string,
  packages: Parameters<typeof resolveGraphImport>[3],
  cache: Map<string, Map<string, Map<string, string>>>,
): StringObjectConstants {
  const imported = new Map<string, ReadonlyMap<string, string>>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings) || bindings.elements.length === 0) continue;
    const target = resolveGraphImport(statement.moduleSpecifier.text, file, repoRoot, packages);
    if (!target) continue;
    const exported = exportedStringObjectConstants(target, repoRoot, packages, cache);
    for (const element of bindings.elements) {
      const entries = exported.get((element.propertyName ?? element.name).text);
      if (entries) imported.set(element.name.text, entries);
    }
  }
  return imported;
}

/**
 * The string-object constants a module EXPORTS, including ones it re-exports
 * (`export { X } from './y'`, `export * from './y'`). Without the re-export hop, moving a
 * tool-name object into its own module behind a barrel silently drops every tool that names
 * itself through it from the derived catalog.
 */
function exportedStringObjectConstants(
  target: string,
  repoRoot: string,
  packages: Parameters<typeof resolveGraphImport>[3],
  cache: Map<string, Map<string, Map<string, string>>>,
): Map<string, Map<string, string>> {
  const cached = cache.get(target);
  if (cached) return cached;
  const exported = new Map<string, Map<string, string>>();
  // Seeded before the walk so a re-export cycle terminates instead of recursing.
  cache.set(target, exported);
  const targetSource = ts.createSourceFile(
    target,
    readFileSync(target, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    scriptKind(target),
  );
  for (const [name, entries] of stringObjectConstants(targetSource, true)) exported.set(name, entries);
  for (const statement of targetSource.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.isTypeOnly ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      continue;
    }
    const source = resolveGraphImport(statement.moduleSpecifier.text, target, repoRoot, packages);
    if (!source) continue;
    const reexported = exportedStringObjectConstants(source, repoRoot, packages, cache);
    const clause = statement.exportClause;
    if (!clause) {
      for (const [name, entries] of reexported) if (!exported.has(name)) exported.set(name, entries);
    } else if (ts.isNamedExports(clause)) {
      for (const element of clause.elements) {
        if (element.isTypeOnly) continue;
        const entries = reexported.get((element.propertyName ?? element.name).text);
        if (entries) exported.set(element.name.text, entries);
      }
    }
  }
  return exported;
}

function buildToolSourceSnapshot(repoRootInput: string): ToolSourceSnapshot {
  const repoRoot = resolve(repoRootInput);
  const cached = snapshotCache.get(repoRoot);
  if (cached) return cached;
  const entrypoint = sourceFileCandidate(join(repoRoot, PRODUCTION_TOOL_REGISTRY_ENTRYPOINT));
  if (!entrypoint) throw new Error(`Static tool catalog entrypoint is missing: ${PRODUCTION_TOOL_REGISTRY_ENTRYPOINT}`);
  const packages = workspacePackages(repoRoot);
  const pending = [entrypoint];
  const visited = new Set<string>();
  const fileIndex = new Map<string, string[]>();
  const objectConstantCache = new Map<string, Map<string, Map<string, string>>>();
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const sourceFile = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      scriptKind(file),
    );
    const importedObjects = importedStringObjectConstants(sourceFile, file, repoRoot, packages, objectConstantCache);
    for (const name of toolNamesIn(sourceFile, importedObjects)) {
      const existing = fileIndex.get(name);
      if (existing) existing.push(file);
      else fileIndex.set(name, [file]);
    }
    for (const specifier of runtimeModuleSpecifiers(sourceFile)) {
      const dependency = resolveGraphImport(specifier, file, repoRoot, packages);
      if (dependency && !visited.has(dependency)) pending.push(dependency);
    }
  }
  const snapshot: ToolSourceSnapshot = {
    graphFiles: [...visited].sort(),
    fileIndex: new Map([...fileIndex].map(([name, files]) => [name, [...new Set(files)].sort()] as const)),
  };
  snapshotCache.set(repoRoot, snapshot);
  return snapshot;
}

/** Every source module in the production tool registry's static import graph. */
export function buildProductionToolSourceFiles(repoRoot: string): string[] {
  return [...buildToolSourceSnapshot(repoRoot).graphFiles];
}

/** Reachable production modules that contain at least one literal tool declaration. */
export function buildBuiltinToolSourceFiles(repoRoot: string): string[] {
  return [...new Set([...buildToolSourceSnapshot(repoRoot).fileIndex.values()].flatMap((files) => [...files]))].sort();
}

/** Every literal MCP identity declared by a reachable production tool call. */
export function buildBuiltinToolCatalog(repoRoot: string): Set<string> {
  return new Set(buildToolSourceSnapshot(repoRoot).fileIndex.keys());
}

/**
 * Tool name → the source file(s) whose `defineTool({ name: … })` declares it,
 * absolute paths. Same single scan as {@link buildBuiltinToolCatalog} (that one
 * throws the paths away); this keeps them so a caller holding only a NAME — e.g.
 * one derived from prompt text — can import the owning module and read the REAL
 * descriptor (`agentRoles`, `capability`) instead of re-parsing the source.
 *
 * A name maps to a list, not a single path: `register()` deliberately tolerates a
 * benign re-import of the same tool, so a duplicate is a fact about the tree the
 * caller should see rather than a silently-dropped entry.
 */
export function buildBuiltinToolFileIndex(repoRoot: string): Map<string, string[]> {
  return new Map([...buildToolSourceSnapshot(repoRoot).fileIndex].map(([name, files]) => [name, [...files]]));
}

export interface DistributionUnitInfo {
  name: string;
  kind: 'plugin' | 'pack';
  tools: string[];
}

/** Every libs/papercusp/plugins/<x>/papercusp.json manifest's declared tool names. */
export function buildDistributionUnits(repoRoot: string): DistributionUnitInfo[] {
  const units: DistributionUnitInfo[] = [];
  const pluginsRoot = join(repoRoot, 'libs/papercusp/plugins');
  if (!existsSync(pluginsRoot)) return units;
  for (const entry of readdirSync(pluginsRoot)) {
    const manifestPath = join(pluginsRoot, entry, 'papercusp.json');
    if (!existsSync(manifestPath)) continue;
    const json = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    const short = String(json.name ?? entry).replace(/^@[^/]+\//, '');
    const tools: string[] = [];
    if (Array.isArray(json.tools)) {
      for (const tool of json.tools as Array<Record<string, any>>) {
        tools.push(tool.expose?.mcp?.name ?? `${short}.${tool.name}`);
      }
    }
    if (Array.isArray(json.capabilities)) {
      for (const cap of json.capabilities as string[]) {
        const m = /^tools:([a-zA-Z0-9_-]+):([a-zA-Z0-9_-]+)$/.exec(cap);
        if (m) tools.push(`${m[1]}.${m[2]}`);
      }
    }
    units.push({ name: short, kind: json.kind === 'pack' ? 'pack' : 'plugin', tools });
  }
  return units;
}

/** Convenience: the flat union of every builtin tool name + every distribution unit's projected tool name. */
export function buildFullToolNameCatalog(repoRoot: string): Set<string> {
  const all = buildBuiltinToolCatalog(repoRoot);
  for (const unit of buildDistributionUnits(repoRoot)) {
    for (const t of unit.tools) all.add(t);
  }
  return all;
}
