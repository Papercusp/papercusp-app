/**
 * EI-24556278753778650: static analysis of `createRequire` loaders for the mutation-probe fence.
 *
 * esbuild cannot follow a require made through `createRequire(import.meta.url)`, so the fence used
 * to refuse every test whose closure contained the text `createRequire(` — including the shared
 * db connection module, whose lazy `nodeRequire(id)` helper only ever loads `node:fs`/`node:os`.
 * That turned any peer's probe window into a fleet-wide testing outage.
 *
 * This module reads one source file's AST and returns every specifier its createRequire loaders
 * can load, or why that set cannot be established. The contract is SOUND by construction: every
 * shape it does not positively recognise is `unfollowable`, so an unexpected idiom costs a refusal,
 * never an admitted mutant. Recognised shapes:
 *   - `createRequire(u)('lit')` and `createRequire(u).resolve('lit')`;
 *   - a loader bound to a name (`const req = createRequire(u)`, `r ??= createRequire(u)`,
 *     `(r ??= createRequire(u))(x)`) whose every reference is a call or `.resolve` call;
 *   - one wrapper level: a loader called with a parameter of an unexported function bound to a
 *     name, whose every reference in the file is a call with a literal at that parameter's index.
 * Comments and strings that merely mention createRequire are not loaders (the AST ignores them).
 */
import ts from 'typescript';

export type CreateRequireSpecifiers =
  | { status: 'ok'; specifiers: string[] }
  | { status: 'unfollowable'; reason: string };

function scriptKind(fileName: string): ts.ScriptKind {
  if (/\.tsx$/.test(fileName)) return ts.ScriptKind.TSX;
  if (/\.[mc]?ts$/.test(fileName)) return ts.ScriptKind.TS;
  if (/\.jsx$/.test(fileName)) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

/** Expression wrappers that do not change the runtime value. */
function isTransparent(node: ts.Node): node is ts.ParenthesizedExpression | ts.AsExpression | ts.NonNullExpression | ts.SatisfiesExpression | ts.TypeAssertion {
  return ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)
    || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node);
}

function unwrap(node: ts.Expression): ts.Expression {
  let at: ts.Expression = node;
  for (;;) {
    if (isTransparent(at)) { at = at.expression; continue; }
    // `(0, createRequire)` — the comma form a transpiler emits for an imported call.
    if (ts.isBinaryExpression(at) && at.operatorToken.kind === ts.SyntaxKind.CommaToken) { at = at.right; continue; }
    return at;
  }
}

function isTypePosition(node: ts.Node): boolean {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if (ts.isTypeNode(at) || ts.isTypeQueryNode(at)) return true;
    if (ts.isExpression(at) || ts.isStatement(at)) return false;
  }
  return false;
}

const ASSIGNMENT_OPERATORS = new Set([
  ts.SyntaxKind.EqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.BarBarEqualsToken,
]);

type FunctionLike = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;

function isExported(node: ts.Node): boolean {
  const statement = ts.isVariableDeclaration(node) ? node.parent?.parent : node;
  const modifiers = statement && ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
}

/** The name a function is bound to (`const f = (x) => …` / `function f(x)`), or null. */
function boundName(fn: FunctionLike): { name: string; declaration: ts.Node } | null {
  if (ts.isFunctionDeclaration(fn)) return fn.name ? { name: fn.name.text, declaration: fn } : null;
  let at: ts.Node = fn;
  while (at.parent && isTransparent(at.parent)) at = at.parent;
  const parent = at.parent;
  if (parent && ts.isVariableDeclaration(parent) && parent.initializer === at && ts.isIdentifier(parent.name)) {
    return { name: parent.name.text, declaration: parent };
  }
  return null;
}

function isLiteral(node: ts.Expression | undefined): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return !!node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));
}

/**
 * The first `import(x)` / `require(x)` / `__require(x)` call whose specifier is not a plain string
 * literal, or null. Syntax-aware, so the words `import(...)` inside a string or comment are not a
 * call (a textual scan refused tests for exactly that). A template with substitutions is
 * non-literal: esbuild may expand it into a glob and erase the call from its output.
 */
export function unfollowableImportCall(fileName: string, text: string): string | null {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  let found: string | null = null;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const kind = callee.kind === ts.SyntaxKind.ImportKeyword ? 'import'
        : ts.isIdentifier(callee) && (callee.text === 'require' || callee.text === '__require') ? callee.text : null;
      if (kind && !isLiteral(node.arguments[0] ? unwrap(node.arguments[0]) : undefined)) {
        found = `non-literal ${kind}() (line ${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1})`;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

export function createRequireSpecifiers(fileName: string, text: string): CreateRequireSpecifiers | null {
  if (!text.includes('createRequire')) return null;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  const specifiers = new Set<string>();
  let failure: string | null = null;
  const fail = (node: ts.Node, why: string): void => {
    failure ??= `${why} (line ${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1})`;
  };

  const identifiers: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) identifiers.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const referencesTo = (name: string) => identifiers.filter((id) => id.text === name);

  // Local names the factory is imported under (`import { createRequire as cr }`).
  const factories = new Set<string>(['createRequire']);
  for (const id of identifiers) {
    const spec = id.parent;
    if (ts.isImportSpecifier(spec) && spec.name === id && (spec.propertyName?.text ?? spec.name.text) === 'createRequire') {
      factories.add(id.text);
    }
  }

  const loaderBindings = new Set<string>();
  const wrappersChecked = new Set<string>();

  const handleArgument = (call: ts.CallExpression): void => {
    const arg = call.arguments[0] ? unwrap(call.arguments[0]) : undefined;
    if (isLiteral(arg)) { specifiers.add(arg.text); return; }
    if (!arg || !ts.isIdentifier(arg)) { fail(call, 'createRequire loader called with a non-literal specifier'); return; }
    // One wrapper level: the argument is a parameter of an enclosing, named, unexported function.
    let fn: ts.Node | undefined = call.parent;
    while (fn && !ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn) && !ts.isFunctionDeclaration(fn)) fn = fn.parent;
    const index = fn ? (fn as FunctionLike).parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === arg.text) : -1;
    const bound = fn && index >= 0 ? boundName(fn as FunctionLike) : null;
    if (!fn || index < 0 || !bound || isExported(bound.declaration)) {
      fail(call, `createRequire loader called with ${arg.text}, which is not a parameter of a named local wrapper`);
      return;
    }
    const reassigned = referencesTo(arg.text).some((id) => id.pos >= fn!.pos && id.end <= fn!.end
      && ts.isBinaryExpression(id.parent) && id.parent.left === id && id.parent.operatorToken.kind !== ts.SyntaxKind.CommaToken
      && id.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && id.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment);
    if (reassigned) { fail(call, `wrapper parameter ${arg.text} is reassigned`); return; }
    const key = `${bound.name}#${index}`;
    if (wrappersChecked.has(key)) return;
    wrappersChecked.add(key);
    for (const ref of referencesTo(bound.name)) {
      if (ref.parent === bound.declaration || (ts.isFunctionDeclaration(bound.declaration) && ref === bound.declaration.name)) continue;
      if (isTypePosition(ref)) continue;
      let at: ts.Node = ref;
      while (at.parent && isTransparent(at.parent)) at = at.parent;
      const caller = at.parent;
      if (caller && ts.isCallExpression(caller) && caller.expression === at) {
        const passed = caller.arguments[index] ? unwrap(caller.arguments[index]) : undefined;
        if (isLiteral(passed)) specifiers.add(passed.text);
        else fail(caller, `wrapper ${bound.name} called with a non-literal specifier`);
      } else {
        fail(ref, `wrapper ${bound.name} escapes as a value`);
      }
    }
  };

  /** Follow what one loader VALUE (a factory call, or an assignment evaluating to it) is used for. */
  const followLoader = (value: ts.Node): void => {
    let node: ts.Node = value;
    for (;;) {
      const parent = node.parent;
      if (!parent) { fail(node, 'createRequire loader escapes'); return; }
      if (isTransparent(parent)) { node = parent; continue; }
      if (ts.isBinaryExpression(parent) && parent.right === node && ASSIGNMENT_OPERATORS.has(parent.operatorToken.kind)
        && ts.isIdentifier(parent.left)) {
        loaderBindings.add(parent.left.text);
        node = parent; // the assignment expression itself evaluates to the loader
        continue;
      }
      if (ts.isExpressionStatement(parent)) return; // assignment result discarded
      if (ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isIdentifier(parent.name)) {
        if (isExported(parent)) { fail(parent, 'createRequire loader is exported'); return; }
        loaderBindings.add(parent.name.text);
        return;
      }
      if (ts.isCallExpression(parent) && parent.expression === node) { handleArgument(parent); return; }
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text === 'resolve'
        && parent.parent && ts.isCallExpression(parent.parent) && parent.parent.expression === parent) {
        handleArgument(parent.parent);
        return;
      }
      fail(node, 'createRequire loader escapes as a value');
      return;
    }
  };

  for (const id of identifiers) {
    const isFactoryRef = factories.has(id.text)
      || (id.text === 'createRequire' && ts.isPropertyAccessExpression(id.parent) && id.parent.name === id);
    if (!isFactoryRef) continue;
    if (ts.isImportSpecifier(id.parent) || isTypePosition(id)) continue;
    // `module.createRequire` / `createRequire`, possibly as `(0, createRequire)`.
    let callee: ts.Node = ts.isPropertyAccessExpression(id.parent) && id.parent.name === id ? id.parent : id;
    while (callee.parent && (isTransparent(callee.parent)
      || (ts.isBinaryExpression(callee.parent) && callee.parent.operatorToken.kind === ts.SyntaxKind.CommaToken && callee.parent.right === callee))) {
      callee = callee.parent;
    }
    const call = callee.parent;
    if (call && ts.isCallExpression(call) && call.expression === callee) followLoader(call);
    else fail(id, 'createRequire is referenced as a value');
  }

  for (const name of loaderBindings) {
    for (const ref of referencesTo(name)) {
      if (isTypePosition(ref)) continue;
      const parent = ref.parent;
      if (ts.isVariableDeclaration(parent) && parent.name === ref) continue;
      if (ts.isBinaryExpression(parent) && parent.left === ref && ASSIGNMENT_OPERATORS.has(parent.operatorToken.kind)) {
        const rhs = unwrap(parent.right);
        if (ts.isCallExpression(rhs) && ts.isIdentifier(unwrap(rhs.expression)) && factories.has((unwrap(rhs.expression) as ts.Identifier).text)) continue;
        fail(parent, `loader binding ${name} is reassigned`);
        continue;
      }
      // A read of the binding (`req(x)`, `req.resolve(x)`, or `r ??= …` evaluated) is a loader use.
      followLoader(ref);
    }
  }

  if (failure) return { status: 'unfollowable', reason: failure };
  return { status: 'ok', specifiers: [...specifiers].sort() };
}
