#!/usr/bin/env node
/**
 * check-guidance-returns-schema.mjs — a tool that authors `guidance.returns`
 * must also register `result`, caught at the AUTHOR'S DESK instead of at the
 * fleet green-checkpoint hours later (EI-22189589517637049).
 *
 * WHY A SECOND GUARD FOR A RULE THAT IS ALREADY ENFORCED. The rule itself is
 * not new and is not getting stricter: `guidance-output-schema-live-guard.test.ts`
 * has enforced it, unchanged, the whole time. What was missing was a signal the
 * author could actually receive. That guard imports the ~900-module tool barrel —
 * ~36s of import for ~24ms of assertions — so nobody runs it while editing one
 * guidance string. It fires at the fleet gate, in a ~55min suite, to a DIFFERENT
 * agent hours later; the author never learns and the gate holder pays.
 *
 * Measured 2026-09-02: the violation count went 0 -> 1 -> 2 within a single day
 * (`scheduler:pull_ledger` at 18:51Z d56a201219, `capability:bash_output` at
 * 21:45Z b0010780cd), each red-pinning the green-checkpoint. Both diffs were
 * EDITS to a live tool that added one prose field.
 *
 * WHY THE RULE KEPT BEING MISSED — it is written in two places an author of a
 * NEW tool reads and an EDITOR of an existing one never does: the live guard's
 * own header comment, and CLAUDE.md's "Adding a tool" section. CLAUDE.md already
 * names this exact shape for the sibling prompt-weight gate ("nearly every
 * prompt-weight gate red has come from *growing* an existing tool's
 * description/guidance, not from adding a new one — and an editor never reads an
 * 'Adding a tool' section"). Same mechanism, different guard; `lint:tool-prompts`
 * is the precedent for answering it with a cheap check on the edit itself.
 *
 * THIS GUARD IS DELIBERATELY WEAKER THAN THE LIVE ONE. It answers only the
 * missing-output-schema question — the one a text scan can answer soundly, and
 * the one both measured violations were. The live guard's other two directional
 * checks (`promised-field-missing`, `generated-clause-omission`) compare authored
 * prose against the REGISTERED schema, which requires resolving Zod through the
 * projection; they stay where they are. This is a fast pre-filter, not a
 * replacement, so it must never contradict the live guard on a clean tree —
 * `check-guidance-returns-schema.test.ts` pins exactly that.
 *
 * EXEMPTIONS ARE DERIVED, NOT COPIED. The live guard's `NON_OBJECT_RETURN_TOOLS`
 * set is parsed out of its source rather than restated here (derived-truth ladder,
 * rung 1). A second hand-maintained copy of that list is precisely the drift this
 * repo's own conventions forbid, and it would fail in the direction that hurts:
 * a tool exempted there but not here would red the gate this guard exists to keep
 * green.
 */
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Roots that define agent tools. Keep in step with the guard registration in affected-tests.mjs. */
export const TOOL_ROOTS = Object.freeze([
  'packages/operator-core/lib/agent-tools',
  'packages/agent-mcp/src',
]);

/** The live guard whose exemption set this one derives from. */
export const LIVE_GUARD_PATH =
  'packages/operator-core/lib/agent-tools/guidance-output-schema-live-guard.test.ts';

function parse(fileName, source) {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function propertyName(node) {
  const name = node.name;
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

function findProperty(objectLiteral, wanted) {
  for (const member of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(member) && !ts.isShorthandPropertyAssignment(member)) continue;
    if (propertyName(member) === wanted) return member;
  }
  return null;
}

function hasSpread(objectLiteral) {
  return objectLiteral.properties.some((member) => ts.isSpreadAssignment(member));
}

function stringValue(node) {
  if (!node) return null;
  const initializer = ts.isPropertyAssignment(node) ? node.initializer : node;
  if (initializer && (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer))) {
    return initializer.text;
  }
  return null;
}

/**
 * The MCP name a tool will be projected under: its own `name`, else an explicit
 * `expose.mcp.name`. Only used to match the derived exemption set, so an
 * unresolvable name simply means "not exempt" — which fails toward reporting.
 */
function toolName(objectLiteral) {
  const direct = stringValue(findProperty(objectLiteral, 'name'));
  if (direct) return direct;
  const expose = findProperty(objectLiteral, 'expose');
  if (!expose || !ts.isPropertyAssignment(expose) || !ts.isObjectLiteralExpression(expose.initializer)) return null;
  const mcp = findProperty(expose.initializer, 'mcp');
  if (!mcp || !ts.isPropertyAssignment(mcp) || !ts.isObjectLiteralExpression(mcp.initializer)) return null;
  return stringValue(findProperty(mcp.initializer, 'name'));
}

/**
 * Parse `NON_OBJECT_RETURN_TOOLS = new Set([...])` out of the live guard's source.
 * Returns null when the declaration cannot be found — the CLI treats that as a
 * hard error rather than an empty exemption set, because an empty set would look
 * exactly like "nothing is exempt" and red-pin the two legitimately-exempt tools.
 */
export function parseExemptToolsFromLiveGuard(source) {
  const sourceFile = parse('live-guard.ts', source);
  let found = null;
  const visit = (node) => {
    if (found) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'NON_OBJECT_RETURN_TOOLS' &&
      node.initializer &&
      ts.isNewExpression(node.initializer) &&
      node.initializer.arguments?.length === 1
    ) {
      const arg = node.initializer.arguments[0];
      if (ts.isArrayLiteralExpression(arg)) {
        const names = [];
        for (const element of arg.elements) {
          const value = stringValue(element);
          if (value) names.push(value);
        }
        found = names;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * The detector. Returns one violation per `defineTool` literal that authors
 * `guidance.returns` with no sibling `result`.
 *
 * A literal containing a SPREAD is skipped: `result` may arrive through it, and
 * this scan cannot resolve that. Under-reporting is the correct direction for a
 * pre-filter whose whole value is that authors trust it — the live guard remains
 * the authority and still catches the spread case at the gate.
 */
export function findGuidanceReturnsWithoutResult(files, exemptTools = []) {
  const exempt = new Set(exemptTools);
  const violations = [];
  for (const { path, text } of files) {
    if (!text.includes('returns:')) continue;
    const sourceFile = parse(path, text);
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'defineTool' &&
        node.arguments.length > 0 &&
        ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        const literal = node.arguments[0];
        const guidance = findProperty(literal, 'guidance');
        const guidanceIsObject =
          guidance && ts.isPropertyAssignment(guidance) && ts.isObjectLiteralExpression(guidance.initializer);
        if (guidanceIsObject && findProperty(guidance.initializer, 'returns')) {
          const name = toolName(literal);
          const indeterminate = hasSpread(literal) || hasSpread(guidance.initializer);
          if (!findProperty(literal, 'result') && !indeterminate && !(name && exempt.has(name))) {
            violations.push({
              path,
              tool: name ?? '<unnamed-tool>',
              line: sourceFile.getLineAndCharacterOfPosition(literal.getStart(sourceFile)).line + 1,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return violations;
}

/**
 * The WORKING TREE's tool sources, not the index's. On this shared tree git-sync
 * commits on a schedule and skips locked paths, so the index routinely lags:
 * `--cached` alone listed a tool file an agent had just deleted (and the read
 * below then threw ENOENT, failing the lint for everyone), and never listed a
 * tool file an agent had just added (so it went unchecked until committed).
 * `--others --exclude-standard` adds the untracked new files; the existence
 * filter drops the deleted ones.
 */
export function listToolSourceFiles(root = ROOT, roots = TOOL_ROOTS) {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', ...roots.map((dir) => `${dir}/**/*.ts`)],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return out
    .split('\0')
    .filter(Boolean)
    .filter((path) => !path.endsWith('.d.ts') && !/\.test\.tsx?$/.test(path))
    .filter((path) => existsSync(resolve(root, path)));
}

export function checkGuidanceReturnsSchema(root = ROOT) {
  const liveGuardSource = readFileSync(resolve(root, LIVE_GUARD_PATH), 'utf8');
  const exemptTools = parseExemptToolsFromLiveGuard(liveGuardSource);
  if (exemptTools === null) {
    throw new Error(
      `could not parse NON_OBJECT_RETURN_TOOLS out of ${LIVE_GUARD_PATH} — refusing to run with an empty exemption set, ` +
        'which would report the legitimately-exempt mixed-content tools as violations',
    );
  }
  const paths = listToolSourceFiles(root);
  const files = paths.map((path) => ({ path, text: readFileSync(resolve(root, path), 'utf8') }));
  return { violations: findGuidanceReturnsWithoutResult(files, exemptTools), scanned: files.length, exemptTools };
}

if (isCliEntry(import.meta.url)) {
  const { violations, scanned, exemptTools } = checkGuidanceReturnsSchema(ROOT);
  if (violations.length === 0) {
    console.log(
      `✓ every tool authoring guidance.returns also registers result: (${scanned} tool source file(s) scanned, ` +
        `${exemptTools.length} mixed-content tool(s) exempt).`,
    );
  } else {
    console.error('✗ guidance.returns authored without a registered result: schema');
    for (const violation of violations) {
      console.error(`  - ${violation.tool}  (${violation.path}:${violation.line})`);
    }
    console.error(
      '\nA tool that authors `guidance.returns` must also declare `result:` (which projects to outputJsonSchema),' +
        '\nso the response shape comes from a registered schema instead of prose becoming a second, unverifiable' +
        '\ntype system. Add a `result:` schema beside the `guidance` block.' +
        `\n\nAuthority: ${LIVE_GUARD_PATH}` +
        '\nIf the tool truly returns mixed MCP content rather than a JSON object, add it to that guard’s' +
        '\nNON_OBJECT_RETURN_TOOLS set WITH a reason — this check derives its exemptions from there.',
    );
    process.exitCode = 1;
  }
}
