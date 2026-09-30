/**
 * no-undeclared-workspace-tx.js — ESLint rule.
 *
 * EI-18808330244321407 inverted the projected-tool transaction contract:
 * handlers are transaction-free unless they explicitly declare
 * `needsWorkspaceTx: true`. This rule makes a direct or file-local indirect
 * `ctx.tx` consumer fail lint instead of waiting for the runtime getter.
 *
 * The rule is intentionally file-local. Every current consumer file owns one
 * tool (except a three-tool goals/pots module where all three consume tx), so a
 * tx read anywhere in a tool-definition module requires every `defineTool`
 * object in that module to declare the contract. The runtime guard remains the
 * backstop for deeper cross-module indirection that static syntax cannot prove.
 */
"use strict";

const CONTEXT_NAMES = new Set(["ctx", "context", "toolCtx"]);

function propertyName(node) {
  if (!node || node.type !== "Property") return null;
  if (!node.computed && node.key.type === "Identifier") return node.key.name;
  if (node.key.type === "Literal" && typeof node.key.value === "string")
    return node.key.value;
  return null;
}

function isTrueLiteral(node) {
  return node?.type === "Literal" && node.value === true;
}

function containsContextIdentifier(node, contextNames) {
  if (!node || typeof node !== "object") return false;
  if (node.type === "Identifier" && contextNames.has(node.name)) return true;
  for (const [key, value] of Object.entries(node)) {
    if (
      key === "parent" ||
      key === "loc" ||
      key === "range" ||
      key === "tokens" ||
      key === "comments"
    )
      continue;
    if (Array.isArray(value)) {
      if (value.some((child) => containsContextIdentifier(child, contextNames)))
        return true;
    } else if (
      value &&
      typeof value === "object" &&
      containsContextIdentifier(value, contextNames)
    ) {
      return true;
    }
  }
  return false;
}

function isTxRead(node, contextNames) {
  if (node.type !== "MemberExpression") return false;
  const propertyIsTx = node.computed
    ? node.property.type === "Literal" && node.property.value === "tx"
    : node.property.type === "Identifier" && node.property.name === "tx";
  return (
    propertyIsTx &&
    node.object.type === "Identifier" &&
    contextNames.has(node.object.name)
  );
}

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require `needsWorkspaceTx: true` on every projected tool module that reads ctx.tx.",
    },
    schema: [],
    messages: {
      undeclared:
        "This tool module reads ctx.tx but `{{tool}}` does not declare `needsWorkspaceTx: true`. Transaction-free is the default; declare the opt-in or move the query to an explicitly scoped short transaction.",
    },
  },

  create(context) {
    const contextNames = new Set(CONTEXT_NAMES);
    const definitions = [];
    const txReads = [];

    return {
      VariableDeclarator(node) {
        if (
          node.id.type === "Identifier" &&
          node.init &&
          containsContextIdentifier(node.init, contextNames)
        ) {
          // Covers file-local aliases such as
          // `const scoped = harnessScopedCtx(args.harness, ctx); scoped.tx`.
          contextNames.add(node.id.name);
        }
      },

      CallExpression(node) {
        if (
          node.callee.type !== "Identifier" ||
          node.callee.name !== "defineTool" ||
          node.arguments[0]?.type !== "ObjectExpression"
        ) {
          return;
        }
        definitions.push(node.arguments[0]);
      },

      MemberExpression(node) {
        if (isTxRead(node, contextNames)) txReads.push(node);
      },

      "Program:exit"() {
        if (txReads.length === 0 || definitions.length === 0) return;
        for (const definition of definitions) {
          const declared = definition.properties.some(
            (property) =>
              propertyName(property) === "needsWorkspaceTx" &&
              property.type === "Property" &&
              isTrueLiteral(property.value),
          );
          if (declared) continue;
          const nameProperty = definition.properties.find(
            (property) => propertyName(property) === "name",
          );
          const tool =
            nameProperty?.type === "Property" &&
            nameProperty.value.type === "Literal" &&
            typeof nameProperty.value.value === "string"
              ? nameProperty.value.value
              : "<dynamic tool>";
          context.report({
            node: nameProperty ?? definition,
            messageId: "undeclared",
            data: { tool },
          });
        }
      },
    };
  },
};
