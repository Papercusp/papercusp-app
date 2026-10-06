/**
 * code-execution-tool-orchestration B-CX-1A / B-CX-PARSE — static PARSE-CHECK.
 *
 * A fast-fail, pre-execution guard: walks the script's TypeScript AST for references to the
 * injected `tools` facade and reports any that aren't in the agent's allowed set. It resolves the
 * normal forms — `tools.<ns>.<verb>(…)` and the `tools.call('<ns>:<verb>', …)` escape hatch — and
 * also the obfuscated-but-static forms a regex misses:
 *
 *   - computed string-literal access:  `tools['sys']['admin']`, `tools['workItems'].list`
 *   - `tools` aliasing:                `const t = tools; t.sys.admin()`
 *   - namespace / verb destructuring:  `const { coord } = tools; coord.wakeQueue()`
 *                                      `const { list } = tools.workItems; list()`
 *
 * This turns the common typo / disallowed-tool case (incl. an obfuscation attempt) into a clean
 * upfront error listing the offenders, before any tool runs.
 *
 * NOT a security boundary. The runtime WHITELIST in the facade (a disallowed tool is simply
 * absent, and `tools.call` throws on an unknown name) is the boundary; this static walk is a UX +
 * telemetry aid layered on top (the plan §8 consensus). It resolves everything STATICALLY
 * determinable; genuinely dynamic access (`tools[runtimeVar]`, `tools.call(runtimeVar)`) is left
 * to the runtime whitelist by design and is NOT flagged here. If parsing ever fails the walk falls
 * back to a regex scan so the aid degrades gracefully rather than failing open.
 */
import type { SourceFile, Expression, ObjectBindingPattern, Node } from 'typescript';
import type { ProjectedTool } from '../tool-projection';
import { camelNamespace, camelVerb, splitToolName } from './tool-facade';

// PERF (FCP): `typescript` (the compiler) is ~3.4MB minified. This module is
// re-exported through the `@papercusp/tooldef` + `@papercusp/agent-mcp` barrels,
// which the operator webview imports — a STATIC `import ts from 'typescript'`
// here put the whole compiler into the eager client boot bundle (the
// second-largest FCP cost after js-tiktoken; E2E perf sweep 2026-06-23). The TS
// AST walk is pure server-side (code:run parse-check). Load it via a lazy
// dynamic import so it splits into its own chunk fetched ONLY when checkScript
// actually runs (server). `checkScript` stays synchronous; callers must
// `await ensureParseCheckReady()` once before the first call (the two runtime
// entry points — runToolOrchestration + captureRecipe — already do).
// See /internal/docs/performance.
type TsModule = typeof import('typescript');
let _ts: TsModule | null = null;

/** Lazily load the TS compiler (kept out of the eager client bundle). Await once before checkScript(). Idempotent. */
export async function ensureParseCheckReady(): Promise<void> {
  if (!_ts) {
    const m = (await import('typescript')) as unknown as { default?: TsModule } & TsModule;
    const candidate = (m.default ?? m) as TsModule;
    // P-007 / cupboard D-010: a bundle that cannot initialise the compiler (e.g. a Cloudflare
    // Worker ESM bundle with no CJS `__filename`, which typescript.js reads at init) used to
    // leave a half-initialised module here (`{}`), after which every checkScript() silently took
    // the REGEX FALLBACK — which misses destructured calls (`const {coord}=tools; coord.send()`),
    // the exact evasion class authority analysis exists to catch. Refuse loudly instead: never
    // cache a module that cannot parse, so a failed init can never degrade to regex unnoticed.
    if (typeof (candidate as { createSourceFile?: unknown }).createSourceFile !== 'function') {
      throw new Error(
        'parse-check: the TypeScript compiler loaded without createSourceFile (half-initialised module — in a bundled Worker, define __filename/__dirname); refusing to fall back to regex analysis',
      );
    }
    _ts = candidate;
  }
}
function tsc(): TsModule {
  if (!_ts) {
    throw new Error(
      'parse-check: ensureParseCheckReady() must be awaited before checkScript() (the TS compiler is lazy-loaded to keep it out of the eager client bundle)',
    );
  }
  return _ts;
}

export interface ParseCheckResult {
  ok: boolean;
  /** Tool references found in the script that are NOT in the allowed facade. */
  unknownRefs: string[];
  /** All tool references the static scan resolved (for logging/telemetry). */
  refs: string[];
  /** True when TypeScript recovered an AST but reported one or more syntax diagnostics. */
  hasParseErrors: boolean;
  /**
   * Statically resolved tool CALLS, including the literal portion of their
   * argument object. This is deliberately inspection-only: dynamic values are
   * omitted and set `dynamicArgs:true`; the runtime whitelist remains the
   * security boundary. Consumers use this to decide whether a saved script is
   * safe to recommend in a different entity context.
   */
  calls: StaticToolCall[];
}

export interface StaticToolCall {
  /** Canonical `ns:verb` when the projected catalog knows it, otherwise the
   * statically resolved facade member (`ns.verb`). */
  tool: string;
  /** Literal/partially-literal argument value, or null when no value resolved. */
  args: unknown | null;
  /** True when any part of the argument expression was dynamic/unresolved. */
  dynamicArgs: boolean;
  /** 1-based script location of the call expression. */
  position?: StaticSourcePosition;
  /** Local identifiers directly bound to this call's awaited result. */
  resultBindings?: string[];
  /** Statically-read result paths rooted in one of the bound identifiers. */
  resultReads?: StaticToolResultRead[];
}

export interface StaticSourcePosition {
  line: number;
  column: number;
  /** Zero-based offset in the original script. */
  offset: number;
}

export interface StaticToolResultRead {
  /** Property segments, kept separate so literal keys containing dots remain unambiguous. */
  path: string[];
  position: StaticSourcePosition;
  /** Optional result ancestors whose absence is guarded by nearby short-circuit syntax. */
  safeOptionalPaths?: string[][];
}

export function checkScript(
  script: string,
  tools: readonly ProjectedTool[],
  allowed?: ReadonlySet<string>,
): ParseCheckResult {
  const ts = tsc(); // lazy-loaded TS compiler (see ensureParseCheckReady)
  const memberToName = new Map<string, string>(); // "ns.camelVerb" → full name
  const fullNames = new Set<string>();
  for (const t of tools) {
    const name = t.expose?.mcp?.name;
    if (!name) continue;
    // EI-18683272396981279: a plugin-namespaced tool projects with a DOT (`gitnexus.query`),
    // not the canonical colon — recognize both shapes here the same way buildToolFacade does,
    // or a plugin tool that IS reachable at runtime gets falsely flagged as an "unknown ref" by
    // this static pre-check.
    const split = splitToolName(name);
    if (!split) continue;
    if (allowed && !allowed.has(name)) continue;
    memberToName.set(`${camelNamespace(split.rawNs)}.${camelVerb(split.rawVerb)}`, name);
    fullNames.add(name);
  }

  const refs = new Set<string>();
  const unknown = new Set<string>();
  const calls: StaticToolCall[] = [];
  // Accept the snake_case OR camelCase spelling of a `ns.verb` member: the
  // facade exposes BOTH (the canonical MCP name is snake_case), so normalize to
  // the camel key before deciding "unknown". Deterministic, not fuzzy — mirrors
  // the raw-alias registration in buildToolFacade. A member is always exactly
  // `ns.verb` (one dot) as built by `step`.
  const canonMember = (member: string): string => {
    const dot = member.indexOf('.');
    if (dot <= 0) return member;
    return `${camelNamespace(member.slice(0, dot))}.${camelVerb(member.slice(dot + 1))}`;
  };
  const recordMember = (member: string): void => {
    refs.add(member);
    if (!memberToName.has(member) && !memberToName.has(canonMember(member))) unknown.add(member);
  };
  const recordFull = (name: string): void => {
    refs.add(name);
    if (!fullNames.has(name)) unknown.add(name);
  };

  type StaticValue = { value: unknown; complete: boolean };

  /** Preserve every literal leaf we can prove while marking the aggregate
   * incomplete when a computed/spread/runtime value appears. */
  const readStaticValue = (node: Expression): StaticValue => {
    if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) {
      return readStaticValue(node.expression);
    }
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return { value: node.text, complete: true };
    }
    if (ts.isNumericLiteral(node)) return { value: Number(node.text), complete: true };
    if (node.kind === ts.SyntaxKind.TrueKeyword) return { value: true, complete: true };
    if (node.kind === ts.SyntaxKind.FalseKeyword) return { value: false, complete: true };
    if (node.kind === ts.SyntaxKind.NullKeyword) return { value: null, complete: true };
    if (
      ts.isPrefixUnaryExpression(node) &&
      (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken) &&
      ts.isNumericLiteral(node.operand)
    ) {
      const n = Number(node.operand.text);
      return { value: node.operator === ts.SyntaxKind.MinusToken ? -n : n, complete: true };
    }
    if (ts.isArrayLiteralExpression(node)) {
      const out: unknown[] = [];
      let complete = true;
      for (const element of node.elements) {
        if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) {
          complete = false;
          continue;
        }
        const part = readStaticValue(element as Expression);
        complete = complete && part.complete;
        if (part.value !== undefined) out.push(part.value);
      }
      return { value: out, complete };
    }
    if (ts.isObjectLiteralExpression(node)) {
      const out: Record<string, unknown> = {};
      let complete = true;
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property)) {
          complete = false;
          continue;
        }
        const key = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)
          ? property.name.text
          : ts.isNumericLiteral(property.name)
            ? property.name.text
            : null;
        if (key == null) {
          complete = false;
          continue;
        }
        const part = readStaticValue(property.initializer);
        complete = complete && part.complete;
        if (part.value !== undefined) out[key] = part.value;
      }
      return { value: out, complete };
    }
    return { value: undefined, complete: false };
  };

  const canonicalMemberName = (member: string): string =>
    memberToName.get(member) ?? memberToName.get(canonMember(member)) ?? member;

  let source: SourceFile;
  let hasParseErrors = false;
  try {
    source = ts.createSourceFile('script.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    // TypeScript deliberately recovers from syntax errors so callers can inspect a partial AST.
    // That recovery is useful for the advisory tool-reference scan, but it is not trustworthy
    // enough for literal argument/schema validation: an unescaped quote inside a shell command
    // can become a pseudo-property and look like an unsupported tool argument. Keep the signal
    // with the parse result so schema validators can defer to the VM's authoritative compile
    // error instead of refusing on recovered nodes.
    const parseDiagnostics = (source as SourceFile & { parseDiagnostics?: readonly unknown[] }).parseDiagnostics;
    hasParseErrors = (parseDiagnostics?.length ?? 0) > 0;
  } catch {
    // If source creation itself fails, the AST-based argument inspection is unavailable too.
    // Preserve the regex fallback for the advisory reference scan, but mark the result as
    // unparseable so consumers still skip schema validation.
    return regexFallback(script, memberToName, fullNames, true);
  }

  const positionFor = (node: Node): StaticSourcePosition => {
    const offset = node.getStart(source);
    const { line, character } = source.getLineAndCharacterOfPosition(offset);
    return { line: line + 1, column: character + 1, offset };
  };

  // Binding maps, populated in source order during the walk. Straight-line scripts declare an
  // alias (`const t = tools`) before they use it, and chained bindings (`const w = tools.x; const
  // f = w.y`) resolve because the walk is depth-first in source order. The runtime whitelist is
  // the real boundary, so an unusual out-of-order binding that this misses is caught there.
  const toolsAliases = new Set<string>(['tools']);
  const nsBindings = new Map<string, string>(); // ident → ns
  const funcBindings = new Map<string, string>(); // ident → "ns.camelVerb" member

  type Resolved =
    | { kind: 'tools' }
    | { kind: 'callHatch' }
    | { kind: 'ns'; ns: string }
    | { kind: 'member'; member: string }
    | null;

  const literalKey = (node: Expression): string | null =>
    ts.isStringLiteralLike(node) ? node.text : null;

  /** One property step within the facade, given the resolved base. */
  const step = (base: NonNullable<Resolved>, prop: string): Resolved => {
    if (base.kind === 'tools') {
      // `tools.call` is the escape hatch, never a namespace (mirrors buildToolFacade).
      return prop === 'call' ? { kind: 'callHatch' } : { kind: 'ns', ns: prop };
    }
    if (base.kind === 'ns') return { kind: 'member', member: `${base.ns}.${prop}` };
    return null; // 'member' / 'callHatch' have no further facade step
  };

  /** Resolve an expression to a facade position, or null if it isn't one / is dynamically computed. */
  const resolve = (node: Expression): Resolved => {
    if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) {
      return resolve(node.expression);
    }
    if (ts.isIdentifier(node)) {
      const n = node.text;
      if (toolsAliases.has(n)) return { kind: 'tools' };
      const ns = nsBindings.get(n);
      if (ns !== undefined) return { kind: 'ns', ns };
      const member = funcBindings.get(n);
      if (member !== undefined) return { kind: 'member', member };
      return null;
    }
    if (ts.isPropertyAccessExpression(node)) {
      const base = resolve(node.expression);
      return base ? step(base, node.name.text) : null;
    }
    if (ts.isElementAccessExpression(node)) {
      const base = resolve(node.expression);
      if (!base) return null;
      const key = literalKey(node.argumentExpression);
      return key == null ? null : step(base, key); // dynamic key → unresolvable → runtime boundary
    }
    return null;
  };

  const bindElements = (pattern: ObjectBindingPattern, r: { kind: 'tools' } | { kind: 'ns'; ns: string }): void => {
    for (const el of pattern.elements) {
      if (!ts.isIdentifier(el.name)) continue; // nested patterns aren't facade bindings
      const local = el.name.text;
      const pn = el.propertyName;
      const key = pn && ts.isIdentifier(pn)
        ? pn.text
        : pn && ts.isStringLiteralLike(pn)
          ? pn.text
          : local;
      if (r.kind === 'tools') {
        if (key === 'call') continue; // destructured escape hatch — not a namespace
        nsBindings.set(local, key);
      } else {
        funcBindings.set(local, `${r.ns}.${key}`);
      }
    }
  };

  const visit = (node: Node): void => {
    // 1) Binding collection (source order, before this node's own references are recorded).
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const r = resolve(node.initializer);
      if (r) {
        if (ts.isIdentifier(node.name)) {
          if (r.kind === 'tools') toolsAliases.add(node.name.text);
          else if (r.kind === 'ns') nsBindings.set(node.name.text, r.ns);
          else if (r.kind === 'member') funcBindings.set(node.name.text, r.member);
        } else if (ts.isObjectBindingPattern(node.name) && (r.kind === 'tools' || r.kind === 'ns')) {
          bindElements(node.name, r);
        }
      }
    }

    // 2) Reference recording.
    if (ts.isCallExpression(node)) {
      const r = resolve(node.expression);
      if (r?.kind === 'callHatch') {
        const name = node.arguments[0] ? literalKey(node.arguments[0]) : null;
        if (name != null) {
          recordFull(name); // dynamic arg → runtime boundary
          const parsed = node.arguments[1]
            ? readStaticValue(node.arguments[1])
            : { value: null, complete: node.arguments.length < 2 };
          calls.push({
            tool: name,
            args: parsed.value ?? null,
            dynamicArgs: !parsed.complete,
            position: positionFor(node),
          });
        }
      } else if (r?.kind === 'member') {
        recordMember(r.member);
        const parsed = node.arguments[0]
          ? readStaticValue(node.arguments[0])
          : { value: null, complete: true };
        calls.push({
          tool: canonicalMemberName(r.member),
          args: parsed.value ?? null,
          dynamicArgs: !parsed.complete,
          position: positionFor(node),
        });
      }
    } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const r = resolve(node);
      if (r?.kind === 'member') recordMember(r.member);
    }

    ts.forEachChild(node, visit);
  };
  visit(source);

  // Associate simple awaited call results with their local identifiers. This is deliberately
  // limited to syntax whose correspondence is explicit: `const result = await tools.x(...)` and
  // positional destructuring of `await Promise.all([tools.x(...), tools.y(...)])`. Runtime and
  // aliased/dynamic calls remain the orchestration VM's responsibility.
  if (!hasParseErrors && calls.length > 0) {
    const callByOffset = new Map<number, StaticToolCall>();
    for (const call of calls) {
      if (call.position) callByOffset.set(call.position.offset, call);
    }
    const unwrap = (expression: Expression): Expression => {
      let current = expression;
      while (
        ts.isParenthesizedExpression(current) ||
        ts.isNonNullExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isTypeAssertionExpression(current) ||
        ts.isSatisfiesExpression(current)
      ) {
        current = current.expression;
      }
      return current;
    };
    const recordedCall = (expression: Expression): StaticToolCall | undefined => {
      const unwrapped = unwrap(expression);
      if (!ts.isCallExpression(unwrapped)) return undefined;
      return callByOffset.get(unwrapped.getStart(source));
    };
    const awaitedCall = (expression: Expression): StaticToolCall | undefined => {
      const unwrapped = unwrap(expression);
      return ts.isAwaitExpression(unwrapped) ? recordedCall(unwrapped.expression) : undefined;
    };
    const promiseAllCalls = (expression: Expression): Array<StaticToolCall | null> | null => {
      const unwrapped = unwrap(expression);
      if (!ts.isAwaitExpression(unwrapped)) return null;
      const awaited = unwrap(unwrapped.expression);
      if (!ts.isCallExpression(awaited) || !ts.isPropertyAccessExpression(awaited.expression)) return null;
      if (
        !ts.isIdentifier(awaited.expression.expression) ||
        awaited.expression.expression.text !== 'Promise' ||
        awaited.expression.name.text !== 'all' ||
        !awaited.arguments[0] ||
        !ts.isArrayLiteralExpression(awaited.arguments[0])
      ) return null;
      return awaited.arguments[0].elements.map((element) => {
        if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) return null;
        const candidate = unwrap(element as Expression);
        return ts.isAwaitExpression(candidate)
          ? recordedCall(candidate.expression) ?? null
          : recordedCall(candidate) ?? null;
      });
    };

    const bindingsByScope = new Map<Node, Map<string, StaticToolCall | null>>();
    const setBinding = (scope: Node, identifier: string, call: StaticToolCall | null): void => {
      let bindings = bindingsByScope.get(scope);
      if (!bindings) bindingsByScope.set(scope, bindings = new Map());
      if (!bindings.has(identifier)) bindings.set(identifier, call);
      else if (bindings.get(identifier) !== call) bindings.set(identifier, null);
    };
    const variableScope = (node: Node, isVar = false): Node => {
      let current = node.parent;
      while (current) {
        if (isVar && ts.isFunctionLike(current)) return current;
        if (
          ts.isBlock(current) || ts.isModuleBlock(current) || ts.isSourceFile(current) ||
          ts.isForStatement(current) || ts.isForInStatement(current) || ts.isForOfStatement(current) ||
          ts.isCatchClause(current)
        ) return current;
        current = current.parent;
      }
      return source;
    };
    const addResultBinding = (call: StaticToolCall, identifier: string): void => {
      const bindings = call.resultBindings ??= [];
      if (!bindings.includes(identifier)) bindings.push(identifier);
    };
    const samePath = (left: string[], right: string[]): boolean =>
      left.length === right.length && left.every((segment, index) => segment === right[index]);
    const addRead = (
      call: StaticToolCall,
      path: string[],
      position: StaticSourcePosition,
      safeOptionalPaths: string[][] = [],
    ): void => {
      if (path.length === 0) return;
      const reads = call.resultReads ??= [];
      const existing = reads.find((read) => read.position.offset === position.offset && samePath(read.path, path));
      if (existing) {
        const combined = [...(existing.safeOptionalPaths ?? []), ...safeOptionalPaths];
        existing.safeOptionalPaths = combined
          .filter((candidate, index, all) => all.findIndex((other) => samePath(candidate, other)) === index);
      } else {
        reads.push({ path, position, ...(safeOptionalPaths.length > 0 ? { safeOptionalPaths } : {}) });
      }
    };
    const bindPattern = (pattern: Node, call: StaticToolCall, scope: Node, path: string[] = []): void => {
      if (ts.isIdentifier(pattern)) {
        if (path.length === 0) {
          setBinding(scope, pattern.text, call);
          addResultBinding(call, pattern.text);
        } else {
          setBinding(scope, pattern.text, null);
          addRead(call, path, positionFor(pattern));
        }
        return;
      }
      if (ts.isObjectBindingPattern(pattern)) {
        for (const element of pattern.elements) {
          if (element.dotDotDotToken) {
            if (ts.isIdentifier(element.name)) setBinding(scope, element.name.text, null);
            continue;
          }
          const key = element.propertyName
            ? ts.isIdentifier(element.propertyName) || ts.isStringLiteralLike(element.propertyName) || ts.isNumericLiteral(element.propertyName)
              ? element.propertyName.text
              : null
            : ts.isIdentifier(element.name)
              ? element.name.text
              : null;
          if (key == null) {
            if (ts.isIdentifier(element.name)) setBinding(scope, element.name.text, null);
            continue;
          }
          bindPattern(element.name, call, scope, [...path, key]);
        }
      } else if (ts.isArrayBindingPattern(pattern)) {
        pattern.elements.forEach((element, index) => {
          if (ts.isOmittedExpression(element)) return;
          if (element.dotDotDotToken) {
            if (ts.isIdentifier(element.name)) setBinding(scope, element.name.text, null);
            return;
          }
          bindPattern(element.name, call, scope, [...path, String(index)]);
        });
      }
    };

    const shadowPattern = (pattern: Node, scope: Node): void => {
      if (ts.isIdentifier(pattern)) {
        setBinding(scope, pattern.text, null);
      } else if (ts.isObjectBindingPattern(pattern) || ts.isArrayBindingPattern(pattern)) {
        for (const element of pattern.elements) {
          if (!ts.isOmittedExpression(element)) shadowPattern(element.name, scope);
        }
      }
    };

    const bindDeclarations = (node: Node): void => {
      if (ts.isVariableDeclaration(node)) {
        const initializer = node.initializer;
        const declarationList = ts.isVariableDeclarationList(node.parent) ? node.parent : null;
        const isVar = declarationList != null && (declarationList.flags & ts.NodeFlags.BlockScoped) === 0;
        const scope = variableScope(node, isVar);
        if (ts.isIdentifier(node.name)) {
          const direct = initializer ? awaitedCall(initializer) : undefined;
          setBinding(scope, node.name.text, direct ?? null);
          if (direct) addResultBinding(direct, node.name.text);
        } else if (ts.isObjectBindingPattern(node.name)) {
          const direct = initializer ? awaitedCall(initializer) : undefined;
          if (direct) bindPattern(node.name, direct, scope);
          else shadowPattern(node.name, scope);
        } else if (ts.isArrayBindingPattern(node.name)) {
          const direct = initializer ? awaitedCall(initializer) : undefined;
          if (direct) bindPattern(node.name, direct, scope);
          else if (initializer) {
            const results = promiseAllCalls(initializer);
            if (results) {
              node.name.elements.forEach((element, index) => {
                if (ts.isOmittedExpression(element)) return;
                const call = results[index];
                if (call) bindPattern(element.name, call, scope);
                else shadowPattern(element.name, scope);
              });
            } else shadowPattern(node.name, scope);
          } else {
            shadowPattern(node.name, scope);
          }
        }
      } else if (ts.isParameter(node)) {
        const scope = node.parent && ts.isFunctionLike(node.parent) ? node.parent : variableScope(node);
        shadowPattern(node.name, scope);
      } else if (ts.isFunctionDeclaration(node) && node.name) {
        setBinding(variableScope(node), node.name.text, null);
      } else if (ts.isClassDeclaration(node) && node.name) {
        setBinding(variableScope(node), node.name.text, null);
      }
      ts.forEachChild(node, bindDeclarations);
    };
    bindDeclarations(source);

    const propertyPath = (expression: Expression): { root: string; path: string[] } | null => {
      if (ts.isIdentifier(expression)) return { root: expression.text, path: [] };
      if (ts.isPropertyAccessExpression(expression)) {
        const base = propertyPath(expression.expression);
        return base ? { root: base.root, path: [...base.path, expression.name.text] } : null;
      }
      if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
        const base = propertyPath(expression.expression);
        const key = literalKey(expression.argumentExpression) ?? (
          ts.isNumericLiteral(expression.argumentExpression) ? expression.argumentExpression.text : null
        );
        return base && key != null ? { root: base.root, path: [...base.path, key] } : null;
      }
      return null;
    };
    const rootIdentifier = (expression: Expression): import('typescript').Identifier | null => {
      if (ts.isIdentifier(expression)) return expression;
      if (ts.isPropertyAccessExpression(expression)) return rootIdentifier(expression.expression);
      if (ts.isElementAccessExpression(expression)) return rootIdentifier(expression.expression);
      return null;
    };
    const boundCall = (identifier: import('typescript').Identifier): StaticToolCall | undefined => {
      let current: Node | undefined = identifier;
      while (current) {
        const bindings = bindingsByScope.get(current);
        if (bindings?.has(identifier.text)) return bindings.get(identifier.text) ?? undefined;
        current = current.parent;
      }
      return undefined;
    };
    const isWithin = (node: Node, ancestor: Node): boolean => {
      let current: Node | undefined = node;
      while (current) {
        if (current === ancestor) return true;
        current = current.parent;
      }
      return false;
    };
    const isPathPrefix = (prefix: string[], path: string[]): boolean =>
      prefix.length <= path.length && prefix.every((segment, index) => segment === path[index]);
    const boundPath = (expression: Expression): { call: StaticToolCall; path: string[] } | undefined => {
      const resolved = propertyPath(expression);
      const identifier = rootIdentifier(expression);
      const call = identifier ? boundCall(identifier) : undefined;
      return resolved && call ? { call, path: resolved.path } : undefined;
    };
    const optionalPathsGuardedByTypeof = (
      condition: Expression,
      call: StaticToolCall,
      branchIsTrue: boolean,
    ): string[][] => {
      if (!ts.isBinaryExpression(condition)) return [];
      const operator = condition.operatorToken.kind;
      const equals = operator === ts.SyntaxKind.EqualsEqualsToken
        || operator === ts.SyntaxKind.EqualsEqualsEqualsToken;
      const notEquals = operator === ts.SyntaxKind.ExclamationEqualsToken
        || operator === ts.SyntaxKind.ExclamationEqualsEqualsToken;
      if (!equals && !notEquals) return [];

      const check = ts.isTypeOfExpression(condition.left) && ts.isStringLiteralLike(condition.right)
        ? { expression: condition.left.expression, typeName: condition.right.text }
        : ts.isStringLiteralLike(condition.left) && ts.isTypeOfExpression(condition.right)
          ? { expression: condition.right.expression, typeName: condition.left.text }
          : null;
      if (!check) return [];

      const resolved = boundPath(check.expression);
      if (resolved?.call !== call || resolved.path.length === 0) return [];

      // A typeof comparison proves an optional path exists only for the branch that
      // excludes undefined. Keep the accepted result types explicit so an unsupported
      // comparison cannot turn a stale read into a pass.
      const nonUndefinedType = [
        'string',
        'number',
        'bigint',
        'boolean',
        'symbol',
        'function',
        'object',
      ].includes(check.typeName);
      const presentWhenTrue = (equals && nonUndefinedType)
        || (notEquals && check.typeName === 'undefined');
      const presentWhenFalse = (equals && check.typeName === 'undefined')
        || (notEquals && nonUndefinedType);
      if (!(branchIsTrue ? presentWhenTrue : presentWhenFalse)) return [];

      // If a deeper access is proven to exist, its ancestors must exist as well.
      return resolved.path.map((_, index) => resolved.path.slice(0, index + 1));
    };
    const safeOptionalPathsForRead = (
      node: Node,
      call: StaticToolCall,
      resolvedPath: string[],
    ): string[][] => {
      const safePaths: string[][] = [];
      const addSafePath = (path: string[]): void => {
        if (path.length > 0 && !safePaths.some((other) => samePath(other, path))) safePaths.push(path);
      };

      let current: Node | undefined = node;
      while (current) {
        if (ts.isPropertyAccessExpression(current) && current.questionDotToken) {
          const base = boundPath(current.expression);
          if (base?.call === call && isPathPrefix(base.path, resolvedPath)) addSafePath(base.path);
          if (current === node) addSafePath(resolvedPath);
        }

        // Annotated: `current` is reassigned from `parent` below, so an inferred type here is
        // circular (TS7022) and the loop variable widens to `any`.
        if (ts.isConditionalExpression(current)) {
          const branchIsTrue = isWithin(node, current.whenTrue)
            ? true
            : isWithin(node, current.whenFalse)
              ? false
              : null;
          if (branchIsTrue !== null) {
            for (const path of optionalPathsGuardedByTypeof(current.condition, call, branchIsTrue)) {
              addSafePath(path);
            }
          }
        }

        const parent: Node | undefined = current.parent;
        if (!parent) break;
        if (ts.isBinaryExpression(parent)) {
          const operator = parent.operatorToken.kind;
          if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
            const left = boundPath(parent.left);
            if (left?.call === call) {
              if (isWithin(node, parent.right) && isPathPrefix(left.path, resolvedPath)) {
                addSafePath(left.path);
              }
              if (isWithin(node, parent.left) && samePath(left.path, resolvedPath)) {
                addSafePath(resolvedPath);
              }
            }
          } else if (
            operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.QuestionQuestionToken
          ) {
            // A missing optional leaf evaluates to undefined, so a fallback on the expression
            // that reads it makes that leaf safe. Any optional ancestor still needs its own guard.
            if (isWithin(node, parent.left)) addSafePath(resolvedPath);
          }
        }
        current = parent;
      }

      return safePaths;
    };
    const readCandidates: Array<{
      call: StaticToolCall;
      path: string[];
      position: StaticSourcePosition;
      safeOptionalPaths: string[][];
    }> = [];
    const visitResultReads = (node: Node): void => {
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const resolved = propertyPath(node);
        const identifier = rootIdentifier(node);
        const call = identifier ? boundCall(identifier) : undefined;
        if (resolved && resolved.path.length > 0 && call) {
          readCandidates.push({
            call,
            path: resolved.path,
            position: positionFor(node),
            safeOptionalPaths: safeOptionalPathsForRead(node, call, resolved.path),
          });
        }
      }
      ts.forEachChild(node, visitResultReads);
    };
    visitResultReads(source);

    // A chain such as `result.gate.candidate` also visits its `result.gate` prefix. Keep the
    // longest path at each source offset; schema traversal will still report the first unsafe
    // ancestor (for example, optional `gate`).
    for (const candidate of readCandidates) {
      const hasLongerChain = readCandidates.some((other) =>
        other.call === candidate.call &&
        other.position.offset === candidate.position.offset &&
        other.path.length > candidate.path.length,
      );
      if (!hasLongerChain) {
        addRead(candidate.call, candidate.path, candidate.position, candidate.safeOptionalPaths);
      }
    }
  }

  return {
    ok: unknown.size === 0,
    unknownRefs: [...unknown].sort(),
    refs: [...refs].sort(),
    hasParseErrors,
    calls,
  };
}

/** Degrade gracefully if AST parsing ever throws: the original regex scan (dotted + call only). */
function regexFallback(
  script: string,
  memberToName: ReadonlyMap<string, string>,
  fullNames: ReadonlySet<string>,
  hasParseErrors = false,
): ParseCheckResult {
  const refs = new Set<string>();
  const unknown = new Set<string>();
  for (const m of script.matchAll(/\btools\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g)) {
    if (m[1] === 'call') continue;
    const member = `${m[1]}.${m[2]}`;
    const canon = `${camelNamespace(m[1])}.${camelVerb(m[2])}`; // snake OR camel spelling
    refs.add(member);
    if (!memberToName.has(member) && !memberToName.has(canon)) unknown.add(member);
  }
  for (const m of script.matchAll(/\btools\.call\(\s*['"`]([^'"`]+)['"`]/g)) {
    refs.add(m[1]);
    if (!fullNames.has(m[1])) unknown.add(m[1]);
  }
  return {
    ok: unknown.size === 0,
    unknownRefs: [...unknown].sort(),
    refs: [...refs].sort(),
    hasParseErrors,
    calls: [],
  };
}
