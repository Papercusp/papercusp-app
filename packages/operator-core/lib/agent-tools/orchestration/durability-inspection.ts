/** A conservative replay preview over the existing projected tool contract. */
import { createHash } from 'node:crypto';
import type { ProjectedTool, StaticToolCall } from '@papercusp/tooldef';

type Effect = 'read' | 'write' | 'unknown';
type Replay = 'read-only' | 'idempotent' | 'uncertain';

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  const record = value as Record<string, unknown>;
  return '{' + Object.keys(record).sort().map((key) => JSON.stringify(key) + ':' + stableJson(record[key])).join(',') + '}';
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

/** The caller's authoring claims cannot upgrade these registered effects. */
export async function inspectDurability(input: {
  script: string;
  bindings: {
    inputs: Record<string, unknown>;
    secretRefs: Record<string, unknown>;
    resourceRefs: Record<string, unknown>;
  };
  calls: readonly StaticToolCall[];
  tools: readonly ProjectedTool[];
  recipeRevision?: string;
}) {
  const sourceSha256 = digest(input.script);
  const bindingsSha256 = digest(stableJson({
    inputs: input.bindings.inputs,
    secretRefs: input.bindings.secretRefs,
    resourceRefs: input.bindings.resourceRefs,
  }));
  const pin = {
    sourceSha256,
    bindingsSha256,
    ...(input.recipeRevision ? { recipeRevision: input.recipeRevision } : {}),
  };
  const byName = new Map(input.tools.map((tool) => [tool.expose.mcp?.name, tool]));
  const steps = input.calls.map((call, index) => {
    const tool = byName.get(call.tool);
    let effect: Effect = tool?.effect ?? 'unknown';
    if (!call.dynamicArgs && tool?.effectForCall) {
      try {
        const classified = tool.effectForCall(call.args);
        if (classified === 'read' || classified === 'write') effect = classified;
      } catch {
        // Keep the declared static effect as the conservative fallback.
      }
    }
    const replay: Replay = effect === 'read'
      ? 'read-only'
      : effect === 'write' && tool?.idempotent === true && !call.dynamicArgs
        ? 'idempotent'
        : 'uncertain';
    return {
      id: digest(sourceSha256 + '\0' + bindingsSha256 + '\0' + index + '\0' + call.tool).slice(0, 24),
      index,
      tool: call.tool,
      effect,
      replay,
      argsStatic: !call.dynamicArgs,
      reason: replay === 'uncertain'
        ? call.dynamicArgs
          ? 'tool arguments are not statically pinned'
          : effect === 'unknown'
            ? 'registered tool effect is unknown'
            : 'write has no registered idempotent contract'
        : null,
    };
  });

  // Static calls alone cannot prove control-flow stability. Inspect the syntax
  // tree so strings/comments mentioning Date.now do not create false alarms.
  const loaded = await import('typescript');
  const ts = loaded.default ?? loaded;
  const file = ts.createSourceFile('orchestration.ts', input.script, ts.ScriptTarget.Latest, true);
  const hazards = new Set<string>();
  const toolAliases = new Set(['tools']);
  function collectAliases(node: import('typescript').Node): void {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.initializer) &&
        toolAliases.has(node.initializer.text)) {
      if (ts.isIdentifier(node.name)) toolAliases.add(node.name.text);
      if (ts.isObjectBindingPattern(node.name)) {
        for (const binding of node.name.elements) {
          if (ts.isIdentifier(binding.name)) toolAliases.add(binding.name.text);
        }
      }
    }
    ts.forEachChild(node, collectAliases);
  }
  collectAliases(file);
  const isLiteralKey = (node: import('typescript').Node | undefined): boolean =>
    !!node && (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node));
  function visit(node: import('typescript').Node): void {
    if (
      ts.isIfStatement(node) || ts.isSwitchStatement(node) ||
      ts.isConditionalExpression(node) || ts.isForStatement(node) ||
      ts.isWhileStatement(node) || ts.isDoStatement(node) ||
      ts.isForOfStatement(node) || ts.isForInStatement(node)
    ) hazards.add('uncheckpointed-control-flow');
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Date') {
      hazards.add('wall-clock');
    }
    if (ts.isCallExpression(node)) {
      const target = node.expression;
      if (ts.isIdentifier(target) &&
          (target.text === 'sleep' || target.text === 'setTimeout' || target.text === 'setInterval')) {
        hazards.add('uncheckpointed-wait');
      }
      if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression) &&
          toolAliases.has(target.expression.text) && target.name.text === 'call' &&
          !isLiteralKey(node.arguments[0])) {
        hazards.add('dynamic-tool-target');
      }
      if (ts.isIdentifier(target) && target.text === 'Date') hazards.add('wall-clock');
      if (ts.isPropertyAccessExpression(target)) {
        const owner = target.expression.getText(file);
        const member = target.name.text;
        if (owner === 'Date' && member === 'now') hazards.add('wall-clock');
        if (owner === 'performance' && member === 'now') hazards.add('wall-clock');
        if (owner === 'Math' && member === 'random') hazards.add('random-control');
        if ((owner === 'crypto' || owner === 'globalThis.crypto') &&
            (member === 'randomUUID' || member === 'randomBytes' || member === 'getRandomValues')) {
          hazards.add('random-control');
        }
      }
    }
    if (ts.isElementAccessExpression(node) && !isLiteralKey(node.argumentExpression)) {
      const base = node.expression;
      if ((ts.isIdentifier(base) && toolAliases.has(base.text)) ||
          (ts.isPropertyAccessExpression(base) && ts.isIdentifier(base.expression) &&
           toolAliases.has(base.expression.text))) {
        hazards.add('dynamic-tool-target');
      }
    }
    if (ts.isPropertyAccessExpression(node) && node.expression.getText(file) === 'process' && node.name.text === 'env') {
      hazards.add('ambient-environment');
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  const diagnostics = [
    ...[...hazards].sort().map((code) => ({ code, message: 'script contains ' + code + '; replay would need a checkpointed decision' })),
    ...steps.filter((step) => step.replay === 'uncertain').map((step) => ({
      code: 'uncertain-effect',
      stepId: step.id,
      message: step.tool + ': ' + step.reason,
    })),
  ];
  return {
    pin,
    steps,
    replayCandidate: diagnostics.length === 0,
    // P-019 supplies the explicit DBOS-backed persistence/replay path. A
    // non-candidate script may still be refused at durable admission below.
    durableExecutionAvailable: true,
    diagnostics,
  };
}
