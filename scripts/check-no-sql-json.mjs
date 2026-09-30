#!/usr/bin/env node
/**
 * Canonical postgres-js JSON/JSONB serializer contract guard.
 *
 * The historical implementation of this command banned `sql.json(value)` in
 * code that could use a db-org client. That became actively wrong once
 * `buildClient` started installing `restoreRawJsonbSerializer`: canonical
 * clients now use one sticky HYBRID serializer that JSON.stringify's raw JS
 * values and passes already-stringified values through. Both `sql.json(value)`
 * and `${JSON.stringify(value)}::jsonb` are therefore supported.
 *
 * Keep the filename and `lint:no-sql-json` package-script entry as a compatibility
 * surface for CI callers, but guard the root cause instead of valid consumers:
 *
 *   1. the shared serializer must remain hybrid and sticky for OIDs 114 + 3802;
 *   2. the production `buildClient` factory must install it; and
 *   3. the production-shaped org test fixture must install it too.
 *
 * Behavioral coverage lives in
 * `libs/papercusp/libs/db/src/connection-jsonb-serializers.test.ts`; detector
 * positive controls live in
 * `packages/operator-core/lib/__tests__/check-no-sql-json.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const CONTRACT_PATHS = Object.freeze({
  connection: 'libs/papercusp/libs/db/src/connection.ts',
  serializer: 'libs/papercusp/libs/db/src/raw-serializers.ts',
  orgTestFixture: 'packages/operator-core/test/_org-test-db.ts',
});

function parse(fileName, source) {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function unwrap(node) {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isSatisfiesExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

function findFunction(sourceFile, name) {
  let found = null;
  const visit = (node) => {
    if (!found && ts.isFunctionDeclaration(node) && node.name?.text === name)
      found = node;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function hasCall(root, calleeName, firstArgName) {
  let found = false;
  const visit = (node) => {
    const callee = ts.isCallExpression(node) ? unwrap(node.expression) : null;
    const firstArg = ts.isCallExpression(node)
      ? unwrap(node.arguments[0])
      : null;
    if (
      !found &&
      callee &&
      ts.isIdentifier(callee) &&
      callee.text === calleeName &&
      firstArg &&
      ts.isIdentifier(firstArg) &&
      firstArg.text === firstArgName
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function stringArrayInitializer(sourceFile, declarationName) {
  let values = null;
  const visit = (node) => {
    if (
      !values &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === declarationName
    ) {
      const initializer = unwrap(node.initializer);
      if (initializer && ts.isArrayLiteralExpression(initializer)) {
        values = initializer.elements
          .filter(ts.isStringLiteralLike)
          .map((element) => element.text);
      }
    }
    if (!values) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return values;
}

function isJsonStringifyOf(node, argName) {
  const expression = unwrap(node);
  if (!expression || !ts.isCallExpression(expression)) return false;
  const callee = unwrap(expression.expression);
  const firstArg = unwrap(expression.arguments[0]);
  return (
    callee &&
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'JSON' &&
    callee.name.text === 'stringify' &&
    firstArg &&
    ts.isIdentifier(firstArg) &&
    firstArg.text === argName
  );
}

function isStringTypeofCheck(node, argName) {
  const expression = unwrap(node);
  if (!expression || !ts.isBinaryExpression(expression)) return false;
  if (
    ![
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsEqualsToken,
    ].includes(expression.operatorToken.kind)
  ) {
    return false;
  }
  const pairs = [
    [unwrap(expression.left), unwrap(expression.right)],
    [unwrap(expression.right), unwrap(expression.left)],
  ];
  return pairs.some(
    ([left, right]) =>
      left &&
      right &&
      ts.isTypeOfExpression(left) &&
      ts.isIdentifier(unwrap(left.expression)) &&
      unwrap(left.expression).text === argName &&
      ts.isStringLiteralLike(right) &&
      right.text === 'string',
  );
}

function hasHybridSerializer(functionNode) {
  let found = false;
  const visit = (node) => {
    if (
      !found &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'hybrid'
    ) {
      const initializer = unwrap(node.initializer);
      const parameter =
        initializer && ts.isArrowFunction(initializer)
          ? unwrap(initializer.parameters[0]?.name)
          : null;
      const arg =
        parameter && ts.isIdentifier(parameter) ? parameter.text : null;
      const body =
        initializer && ts.isArrowFunction(initializer)
          ? unwrap(initializer.body)
          : null;
      const whenTrue =
        body && ts.isConditionalExpression(body) ? unwrap(body.whenTrue) : null;
      if (
        arg &&
        body &&
        ts.isConditionalExpression(body) &&
        isStringTypeofCheck(body.condition, arg) &&
        whenTrue &&
        ts.isIdentifier(whenTrue) &&
        whenTrue.text === arg &&
        isJsonStringifyOf(body.whenFalse, arg)
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(functionNode);
  return found;
}

function hasStickyAccessors(functionNode) {
  let found = false;
  const visit = (node) => {
    const callee = ts.isCallExpression(node) ? unwrap(node.expression) : null;
    const target = ts.isCallExpression(node) ? unwrap(node.arguments[0]) : null;
    const descriptor = ts.isCallExpression(node)
      ? unwrap(node.arguments[2])
      : null;
    if (
      !found &&
      callee &&
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === 'Object' &&
      callee.name.text === 'defineProperty' &&
      target &&
      ts.isIdentifier(target) &&
      target.text === 'serializers' &&
      descriptor &&
      ts.isObjectLiteralExpression(descriptor)
    ) {
      const names = new Set(
        descriptor.properties
          .map((property) => property.name)
          .filter(Boolean)
          .map((name) =>
            ts.isIdentifier(name) || ts.isStringLiteralLike(name)
              ? name.text
              : null,
          )
          .filter(Boolean),
      );
      if (names.has('get') && names.has('set')) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(functionNode);
  return found;
}

export function inspectJsonbSerializerContract(sources) {
  const problems = [];
  const connection = parse(CONTRACT_PATHS.connection, sources.connection);
  const serializer = parse(CONTRACT_PATHS.serializer, sources.serializer);
  const fixture = parse(CONTRACT_PATHS.orgTestFixture, sources.orgTestFixture);

  const buildClient = findFunction(connection, 'buildClient');
  if (
    !buildClient ||
    !hasCall(buildClient, 'restoreRawJsonbSerializer', 'client')
  ) {
    problems.push(
      `${CONTRACT_PATHS.connection}: buildClient must call restoreRawJsonbSerializer(client) before returning the canonical client`,
    );
  }

  const restore = findFunction(serializer, 'restoreRawJsonbSerializer');
  if (!restore) {
    problems.push(
      `${CONTRACT_PATHS.serializer}: export restoreRawJsonbSerializer(client)`,
    );
  } else {
    const modifiers = restore.modifiers?.map((modifier) => modifier.kind) ?? [];
    if (!modifiers.includes(ts.SyntaxKind.ExportKeyword)) {
      problems.push(
        `${CONTRACT_PATHS.serializer}: restoreRawJsonbSerializer must remain exported`,
      );
    }
    if (!hasHybridSerializer(restore)) {
      problems.push(
        `${CONTRACT_PATHS.serializer}: restoreRawJsonbSerializer must pass strings through and JSON.stringify raw JS values`,
      );
    }
    if (!hasStickyAccessors(restore)) {
      problems.push(
        `${CONTRACT_PATHS.serializer}: restoreRawJsonbSerializer must install sticky get/set accessors with Object.defineProperty`,
      );
    }
  }

  const jsonOids = stringArrayInitializer(
    serializer,
    'DRIZZLE_MUTATED_JSON_OIDS',
  );
  if (!jsonOids || !jsonOids.includes('114') || !jsonOids.includes('3802')) {
    problems.push(
      `${CONTRACT_PATHS.serializer}: DRIZZLE_MUTATED_JSON_OIDS must cover JSON OID 114 and JSONB OID 3802`,
    );
  }

  const applyFixtureFixes = findFunction(fixture, 'applyRawSerializerFixes');
  if (
    !applyFixtureFixes ||
    !hasCall(applyFixtureFixes, 'restoreRawJsonbSerializer', 'client')
  ) {
    problems.push(
      `${CONTRACT_PATHS.orgTestFixture}: applyRawSerializerFixes must call restoreRawJsonbSerializer(client) so tests match production`,
    );
  }

  return problems;
}

export function checkJsonbSerializerContract(root = ROOT) {
  return inspectJsonbSerializerContract({
    connection: readFileSync(resolve(root, CONTRACT_PATHS.connection), 'utf8'),
    serializer: readFileSync(resolve(root, CONTRACT_PATHS.serializer), 'utf8'),
    orgTestFixture: readFileSync(
      resolve(root, CONTRACT_PATHS.orgTestFixture),
      'utf8',
    ),
  });
}

export function isDirectCliInvocation(entry = process.argv[1]) {
  return Boolean(entry) && resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectCliInvocation()) {
  const problems = checkJsonbSerializerContract(ROOT);
  if (problems.length === 0) {
    console.log(
      '✓ canonical postgres-js clients install the sticky hybrid JSON/JSONB serializer (sql.json and pre-stringified casts are both supported).',
    );
  } else {
    console.error('✗ canonical JSON/JSONB serializer contract is incomplete:');
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
      '\nBehavioral authority: libs/papercusp/libs/db/src/connection-jsonb-serializers.test.ts',
    );
    process.exitCode = 1;
  }
}
