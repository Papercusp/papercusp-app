#!/usr/bin/env node
'use strict';

// D-154 / D-159 evidence collector. Reuse the installed TypeScript parser rather
// than recognizing imports with regexes. This reports syntax and exact bytes;
// it does not infer a dataflow boundary or authorize a producer omission.
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { builtinModules } = require('node:module');
const { execFileSync } = require('node:child_process');
const { fileURLToPath } = require('node:url');
const ts = require('typescript');

const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function collectImports(file) {
  file = path.resolve(file);
  const bytes = fs.readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('non-UTF8 module refused');
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.getScriptKindFromFileName(file));
  if (tree.parseDiagnostics.length) throw new Error(`module parse errors: ${tree.parseDiagnostics.length}`);

  // Binding is local to this exact source file. Do not load project config,
  // imported code, or host declarations while assigning lexical symbol identities.
  const options = { allowJs: true, noResolve: true, noLib: true };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => path.resolve(name) === file ? tree : undefined;
  const checker = ts.createProgram([file], options, host).getTypeChecker();
  const binding = (node) => checker.getSymbolAtLocation(node) || `unbound:${node.text}`;

  const factories = new Set();
  const loaders = new Set(['unbound:require', 'unbound:__require']);
  const generators = new Set(['unbound:Function', 'unbound:eval']);
  const records = [];
  const visit = (node, fn) => { fn(node); ts.forEachChild(node, (child) => visit(child, fn)); };
  const literal = (node) => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));
  const bare = (node, names) => ts.isIdentifier(node) && names.has(binding(node));
  const property = (node, name) => (ts.isPropertyAccessExpression(node) && node.name.text === name)
    || (ts.isElementAccessExpression(node) && literal(node.argumentExpression) && node.argumentExpression.text === name);
  const unwrapped = (node) => {
    while (node && (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node))) node = node.expression;
    return node;
  };
  const loaderValue = (node) => {
    node = unwrapped(node);
    if (!node) return false;
    if (bare(node, loaders)) return true;
    if (property(node, 'require')) return true;
    if (ts.isCallExpression(node)) return bare(node.expression, factories) || property(node.expression, 'createRequire');
    if (ts.isConditionalExpression(node)) return loaderValue(node.whenTrue) || loaderValue(node.whenFalse);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken) return loaderValue(node.right);
    return false;
  };
  const record = (node, kind, argument, extra = {}) => {
    const start = node.getStart(tree), end = node.end;
    records.push({ kind, start, end, source: text.slice(start, end),
      specifier: literal(argument) ? argument.text : null, ...extra });
  };

  visit(tree, (node) => {
    if (ts.isIdentifier(node) && ['require', '__require'].includes(node.text)) loaders.add(binding(node));
  });
  visit(tree, (node) => {
    if (ts.isImportDeclaration(node) && literal(node.moduleSpecifier)
        && ['node:module', 'module'].includes(node.moduleSpecifier.text)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName || element.name).text === 'createRequire') factories.add(binding(element.name));
        }
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
      const value = unwrapped(node.initializer);
      if (value && ts.isCallExpression(value) && literal(value.arguments[0])
          && ['node:module', 'module'].includes(value.arguments[0].text)
          && (bare(value.expression, loaders) || value.expression.kind === ts.SyntaxKind.ImportKeyword)) {
        for (const element of node.name.elements) {
          if (ts.isIdentifier(element.name) && (element.propertyName || element.name).getText(tree) === 'createRequire') {
            factories.add(binding(element.name));
          }
        }
      }
    }
  });
  // Include aliases and conditional factory assignments used by esbuild. An
  // alias census is deliberately conservative: a reassigned loader stays in it.
  // These names never suffice as proof that a nonliteral argument is safe.
  let changed;
  do {
    changed = false;
    visit(tree, (node) => {
      let left, right;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        left = binding(node.name); right = node.initializer;
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
          && ts.isIdentifier(node.left)) {
        left = binding(node.left); right = node.right;
      }
      if (!right || !left) return;
      right = unwrapped(right);
      if ((bare(right, factories) || property(right, 'createRequire')) && !factories.has(left)) {
        factories.add(left); changed = true;
      }
      if (bare(right, generators) && !generators.has(left)) { generators.add(left); changed = true; }
      if (loaderValue(right) && !loaders.has(left)) { loaders.add(left); changed = true; }
    });
  } while (changed);

  visit(tree, (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const clause = ts.isImportDeclaration(node) ? node.importClause : node;
      // `import { type T }` can emit `import {}` with verbatimModuleSyntax:
      // the module still executes. Only a declaration-level `type` guarantees
      // removal independently of compiler options or native type stripping.
      if (node.moduleSpecifier) record(node, 'static-module', node.moduleSpecifier,
        { typeOnly: Boolean(clause?.isTypeOnly) });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      record(node, 'static-module', node.moduleReference.expression,
        { typeOnly: Boolean(node.isTypeOnly), resolutionMode: 'require' });
    } else if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (expression.kind === ts.SyntaxKind.ImportKeyword) record(node, 'dynamic-import', node.arguments[0]);
      else if (bare(expression, loaders) || property(expression, 'require')
          || (ts.isCallExpression(expression) && (bare(expression.expression, factories)
            || property(expression.expression, 'createRequire')))) {
        record(node, 'require', node.arguments[0], { callee: expression.getText(tree) });
      } else if (bare(expression, generators)) {
        record(node, 'generated-code', null, { callee: expression.getText(tree) });
      }
    } else if (ts.isNewExpression(node) && bare(node.expression, generators)) {
      record(node, 'generated-code', null, { callee: node.expression.getText(tree) });
    }
  });

  // One ordered pass converts UTF-16 parser positions to UTF-8 byte offsets.
  // Repeated prefix encoding is quadratic on the 60 MB release bundle.
  const positions = [...new Set(records.flatMap((r) => [r.start, r.end]))].sort((a, b) => a - b);
  const offsets = new Map();
  let prior = 0, offset = 0;
  for (const position of positions) {
    offset += Buffer.byteLength(text.slice(prior, position), 'utf8');
    offsets.set(position, offset); prior = position;
  }
  return {
    schema: 'papercusp-runtime-import-census-v1',
    file, sha256: hash(bytes), parser: { name: 'typescript', version: ts.version },
    coverage: 'Syntax census of static imports/exports, dynamic import, require and createRequire aliases, property require candidates, Function/eval and direct aliases. Generated bodies and per-site dataflow remain unproved.',
    loaderAliases: [...new Set([...loaders].map((key) => typeof key === 'string' ? key.slice('unbound:'.length) : key.name))].sort(),
    imports: records.map(({ start, end, ...r }) => ({ ...r,
      byteStart: offsets.get(start), byteEnd: offsets.get(end),
      sha256: hash(bytes.subarray(offsets.get(start), offsets.get(end))) })),
    closureAccepted: false,
  };
}

// Resolve syntax without executing candidate modules. Node supplies both sets
// of conditions: require.resolve for CJS and import.meta.resolve for ESM. Both
// run in a child with host NODE_OPTIONS/NODE_PATH removed. ESM also needs the
// explicit-parent flag so it cannot use this collector's tree.
// Binder-only name lookup avoids asking the JS type checker to infer enormous
// bundled initializers. A seed identifies one lexical binding by exact bytes;
// equal spellings in other scopes or property names never join its population.
function collectLexicalReferences(file, seeds) {
  file = path.resolve(file);
  const bytes = fs.readFileSync(file), text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('non-UTF8 module refused');
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (tree.parseDiagnostics.length) throw new Error(`module parse errors: ${tree.parseDiagnostics.length}`);
  if (!Array.isArray(seeds) || !seeds.length) throw new Error('exact lexical seeds required');
  ts.bindSourceFile(tree, { allowJs: true, noResolve: true, noLib: true });
  const names = new Set(seeds.map((seed) => seed.name));
  const nodes = [];
  const visit = (node) => {
    if (ts.isIdentifier(node) && names.has(node.text)) nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  const lexical = (node) => {
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
    if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)
        || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)
        || ts.isPropertyDeclaration(parent)) && parent.name === node) return false;
    if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
    if (ts.isImportSpecifier(parent) && parent.propertyName === node) return false;
    if (ts.isExportSpecifier(parent) && parent.propertyName && parent.name === node) return false;
    if (ts.isLabeledStatement(parent)
        || ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) return false;
    return true;
  };
  const binding = (node) => {
    if (!lexical(node)) return null;
    const name = ts.escapeLeadingUnderscores(node.text);
    for (let scope = node.parent; scope; scope = scope.parent) {
      // Default parameter initializers have a separate environment from a
      // function body. A binder table alone cannot decide those references.
      if (ts.isParameter(scope) && scope.initializer
          && node.getStart(tree) >= scope.initializer.getStart(tree)) {
        throw new Error('parameter-default lexical reference requires semantic proof');
      }
      if (ts.isWithStatement(scope)) throw new Error('with-scope lexical reference refused');
      const symbol = scope.locals?.get(name);
      if (symbol) return symbol;
    }
    return null;
  };
  const positions = [...new Set(nodes.flatMap((node) =>
    [node.getStart(tree), node.end, node.parent.getStart(tree), node.parent.end]))].sort((a, b) => a - b);
  const offsets = new Map(); let previous = 0, offset = 0;
  for (const position of positions) {
    offset += Buffer.byteLength(text.slice(previous, position), 'utf8');
    offsets.set(position, offset); previous = position;
  }
  const citation = (node) => {
    const start = offsets.get(node.getStart(tree)), end = offsets.get(node.end);
    return { byteStart: start, byteEnd: end, sha256: hash(bytes.subarray(start, end)),
      kind: ts.SyntaxKind[node.kind], source: text.slice(node.getStart(tree), node.end) };
  };
  const populations = seeds.map((seed) => {
    const node = nodes.find((candidate) => candidate.text === seed.name
      && offsets.get(candidate.getStart(tree)) === seed.byteStart);
    if (!node) throw new Error(`lexical seed not found: ${seed.name}@${seed.byteStart}`);
    const symbol = binding(node);
    if (!symbol) throw new Error(`lexical seed is unbound or a property name: ${seed.name}@${seed.byteStart}`);
    const references = nodes.filter((candidate) => candidate.text === seed.name && binding(candidate) === symbol);
    return { seed: citation(node), references: references.map((reference) =>
      ({ identifier: citation(reference), context: citation(reference.parent) })) };
  });
  return { schema: 'papercusp-lexical-reference-census-v1', file, sha256: hash(bytes),
    parser: { name: 'typescript', version: ts.version },
    coverage: 'Binder-local lexical identifiers and local export names only. Parameter defaults and with scopes refuse; property names, type inference, alias dataflow and generated bodies are not resolved.',
    populations, closureAccepted: false };
}

function collectStaticClosure(root, entrypoints) {
  root = fs.realpathSync(root);
  const inside = (file) => { const p = path.relative(root, file); return p !== '..' && !p.startsWith(`..${path.sep}`) && !path.isAbsolute(p); };
  const builtin = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
  const files = [], outside = [], failures = [], manifests = new Map(), seen = new Set();
  let pending = entrypoints.map((file) => path.resolve(root, file));
  const resolver = `import { pathToFileURL } from 'node:url';
    import { createRequire } from 'node:module';
    const queries = JSON.parse(process.argv[1]);
    console.log(JSON.stringify(queries.map(({file, specifier, mode}) => {
      try { return {target: mode === 'require' ? pathToFileURL(createRequire(file).resolve(specifier)).href
        : import.meta.resolve(specifier, pathToFileURL(file).href)}; }
      catch (error) { return {errorCode: error.code || error.name}; }
    })));`;
  const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_PATH;
  const bindManifests = (file) => {
    for (let dir = path.dirname(file); inside(dir); dir = path.dirname(dir)) {
      const manifest = path.join(dir, 'package.json');
      if (fs.existsSync(manifest)) manifests.set(manifest, hash(fs.readFileSync(manifest)));
      if (dir === root) break;
    }
  };
  while (pending.length) {
    const batch = pending; pending = [];
    const queries = [];
    for (const candidate of batch) {
      let file;
      try { file = fs.realpathSync(candidate); }
      catch (error) { failures.push({ file: candidate, errorCode: error.code }); continue; }
      if (!inside(file)) { outside.push({ file: candidate, target: file }); continue; }
      if (seen.has(file)) continue;
      seen.add(file); bindManifests(file);
      let census;
      try {
        if (path.extname(file) === '.json') {
          const bytes = fs.readFileSync(file), text = bytes.toString('utf8');
          if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('non-UTF8 JSON refused');
          JSON.parse(text);
          census = { file, sha256: hash(bytes), imports: [], resourceKind: 'json' };
        } else census = collectImports(file);
      } catch (error) { failures.push({ file, error: error.message }); continue; }
      const row = { file: path.relative(root, file), sha256: census.sha256, imports: [] };
      if (census.resourceKind) row.resourceKind = census.resourceKind;
      files.push(row);
      for (const site of census.imports) {
        const edge = { site }; row.imports.push(edge);
        if (site.typeOnly) { edge.typeOnly = true; continue; }
        if (site.specifier === null || site.kind === 'generated-code') { edge.unresolved = true; continue; }
        if (builtin.has(site.specifier)) { edge.builtin = true; continue; }
        edge.resolutionMode = site.resolutionMode || (site.kind === 'require' ? 'require' : 'import');
        queries.push({ file, edge });
      }
    }
    if (queries.length) {
      const input = queries.map(({ file, edge }) => ({ file, specifier: edge.site.specifier, mode: edge.resolutionMode }));
      const resolutions = JSON.parse(execFileSync(process.execPath,
        ['--experimental-import-meta-resolve', '--input-type=module', '-e', resolver, JSON.stringify(input)],
        { env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
      if (resolutions.length !== queries.length) throw new Error('Node resolver population mismatch');
      resolutions.forEach((resolution, index) => {
        const edge = queries[index].edge;
        if (resolution.errorCode) { edge.errorCode = resolution.errorCode; edge.unresolved = true; return; }
        try { finish(edge, fileURLToPath(resolution.target)); }
        catch (error) { edge.errorCode = error.code || error.name; edge.unresolved = true; }
      });
    }
  }
  function finish(edge, target) {
    target = fs.realpathSync(target);
    if (!inside(target)) { edge.unresolved = true; outside.push({ site: edge.site, target }); return; }
    bindManifests(target); edge.target = path.relative(root, target); pending.push(target);
  }
  return { schema: 'papercusp-static-module-closure-v1', root, entrypoints, nodeVersion: process.version,
    resolution: 'Node default require/import conditions; no candidate execution; realpaths must remain inside root',
    files, manifests: [...manifests].map(([file, sha256]) => ({ file: path.relative(root, file), sha256 })),
    outside, failures, unresolved: files.flatMap((file) => file.imports.filter((edge) => edge.unresolved).map((edge) => ({ file: file.file, ...edge }))),
    closureAccepted: false };
}

module.exports = { collectImports, collectStaticClosure, collectLexicalReferences };
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--static-closure' && args.length >= 3) {
      process.stdout.write(`${JSON.stringify(collectStaticClosure(args[1], args.slice(2)), null, 2)}\n`);
    } else {
      if (args.length !== 1) throw new Error('usage: runtime-import-census.cjs <module> | --static-closure <root> <entry>…');
      process.stdout.write(`${JSON.stringify(collectImports(args[0]), null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`); process.exitCode = 1;
  }
}
