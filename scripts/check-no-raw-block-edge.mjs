#!/usr/bin/env node
/**
 * check-no-raw-block-edge.mjs — fail-loud guards against dependency writes that
 * bypass either the polymorphic-link boundary or canonical candidate admission.
 *
 * dependency-graph-admission-and-health-2026-08-26 P-006 extends the original guard to:
 *   - raw coord_links `blocks` writes that bypass the canonical link facades;
 *   - raw work_item_deps INSERT/UPDATE/DELETE outside an exact capability list;
 *   - the retired enforceAcyclicity:false escape hatch; and
 *   - compatibility/link facades that stop calling mutateWorkItemDependencies.
 *
 * WHY THIS IS A BUILD GUARD AND NOT A TEST. A feature→feature `blocks` CYCLE
 * permanently deadlocks the dispatch frontier: every feature in the cycle is
 * forever non-ready, because its blocker never terminates. The policy that
 * prevents this lives in ONE module — `packages/operator-core/lib/dbos/
 * feature-blockers-edges.ts` — via two sanctioned entry points:
 *
 *   - `syncFeatureBlockEdges(...)`  the AUTHORITATIVE replace-semantics writer,
 *     which enforces acyclicity itself (throws on a cycle-closing set);
 *   - `guardFeatureBlockEdgeAcyclic(src, dst)` for a capability-confined raw
 *     coord_links writer that cannot use the canonical work-item graph.
 *
 * Since P-006, `linkWorkItem` and `linkIssue` are SAFE FACADES: work-item `blocks`
 * edges route through mirrorWorkItemBlockingEdge → mutateWorkItemDependencies, while
 * polymorphic/non-block links alone remain in coord_links. The guard therefore scans
 * direct `links.link` / raw SQL writes and separately proves those facades still
 * contain their canonical routes. Treating every caller of a safe facade as a raw
 * writer would both false-positive and teach callers to duplicate admission policy.
 *
 * The existing acyclicity tests (feature-blockers-acyclicity{,.integration}.test.ts,
 * feature-blockers-edges.integration.test.ts, link.test.ts) cover the BEHAVIOUR of
 * those functions thoroughly. What they cannot cover is a NEW call site that never
 * calls them at all — a behaviour test cannot observe code that bypasses it. That
 * gap is exactly how the frontier acquires a silent, permanent deadlock, so it is
 * closed here at build time.
 *
 *   node scripts/check-no-raw-block-edge.mjs
 *
 * THE TELL — a WRITE of a blocks edge, never a read: the file touches a RAW
 * coord_links primitive (`links.link(...)` or `INSERT INTO ... coord_links`) AND
 * carries a `'blocks'` rel literal. `linkWorkItem(...)` / `linkIssue(...)` are not raw
 * primitives; their definitions are structural guard inputs below. A raw writer is
 * CLEARED when it references a sanctioned entry point. Comments are stripped first,
 * so prose about blocks edges never trips it.
 *
 * The match is FILE-LEVEL rather than argument-level, which is a measured trade — see
 * `writesRawBlocksEdge` for why the tighter form was implemented, tested, and rejected
 * (it missed the one real in-tree caller, which passes the rel as a variable).
 *
 * Deliberately NOT flagged (verified against the live tree): READS such as
 * `listIn(ref, { rel: 'blocks' })` / `listInMany(dsts, { rel: 'blocks' })` in
 * work-items-events.ts — reading the blocker set cannot create a cycle. A rel other
 * than 'blocks' is out of scope entirely: only feature→feature blocking deadlocks
 * the frontier.
 *
 * EXCLUDED (never scanned): vendored / build output / _retired / tests / non-source.
 *
 * ALLOWLIST: the policy module itself — it necessarily contains both the raw INSERT
 *   and the 'blocks' literal, and it IS the thing every other site must route through.
 *
 * BASELINE: EMPTY, and must stay empty. Verified 2026-08-02 across 5003 tracked .ts
 *   files: zero offenders. There is no grandfathered debt here, so a hit is always a
 *   genuine NEW bypass — never a BASELINE addition.
 *
 * The predicate (`writesRawBlocksEdge`) is exported + unit-tested
 * (packages/operator-core/lib/dbos/no-raw-block-edge-guard.test.ts) so the
 * "fails on a NEW bypass" property is durably verified rather than merely
 * green-on-a-clean-tree — a guard nobody has ever seen FAIL is not a guard.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { describeUnscanned, listTrackedFiles } from "./lib/tracked-files.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

/**
 * Permanently-allowed files. ONLY the policy module: it holds the authoritative
 * writer + the tool-facing guard, so it legitimately contains the raw INSERT and
 * the 'blocks' literal. Nothing else belongs here — a new site that needs to write
 * a blocks edge should CALL one of its entry points, not be exempted from them.
 */
export const ALLOWLIST = new Set([
  // The policy module: holds the authoritative writer + the tool-facing guard, so it
  // legitimately contains the raw INSERT and the 'blocks' literal. It IS the thing
  // every other site must route through.
  "packages/operator-core/lib/dbos/feature-blockers-edges.ts",
]);

/**
 * Grandfathered offenders. EMPTY on purpose and must remain so — the tree was clean
 * when this guard landed, so any hit is a genuine new bypass to fix at the call site.
 */
export const BASELINE = new Set([]);

/**
 * Exact, capability-confined raw work_item_deps DML sites.
 *
 * This is intentionally a path map, not a directory exemption: a new migration or another
 * goal writer must trip the guard and explain why it cannot use P-005. The reasons are part of
 * the reviewed capability boundary and are asserted non-empty by the guard tests.
 */
export const RAW_WORK_ITEM_DEPS_CAPABILITIES = new Map([
  [
    "packages/operator-core/lib/dbos/work-item-deps-store.ts",
    "Canonical P-005 store: applyStoredEdgeDiff is the sole normal-runtime physical DML site.",
  ],
  [
    "packages/operator-core/lib/testing/dependency-fixture.ts",
    "Test-only defect seeder: must mint malformed rows that canonical admission correctly refuses.",
  ],
  [
    "packages/operator-core/test/_work-items-schema.ts",
    "Test-only schema/trigger fixture used to stand up real-Postgres integration databases.",
  ],
  [
    "packages/agent-mcp/src/tools/goals/goal-deps.ts",
    "Goal-only graph policy: every DML predicate pins blocked_kind=goal; goals have distinct lifecycle semantics.",
  ],
  [
    "libs/papercusp/libs/db/sql/370-backfill-work-item-deps.sql",
    "Immutable one-time historical migration predating canonical admission.",
  ],
  [
    "libs/papercusp/libs/db/sql/734-repoint-qualified-refs-on-rehome.sql",
    "Topology-preserving re-home trigger: renames one feature identity in-place and cannot call TypeScript from PostgreSQL.",
  ],
  [
    "libs/papercusp/libs/db/sql/935-canonical-work-item-blocking-edges.sql",
    "Immutable one-time cutover migration that canonicalized historical coord_links rows.",
  ],
]);

/** Vendored / generated / non-source / test files are never scanned. */
export const isExcluded = (f) =>
  f.startsWith("_retired/") ||
  f.includes("/_retired/") ||
  f.includes("/node_modules/") ||
  f.includes("/dist/") ||
  f.includes("/.next/") ||
  f.includes("/build/") ||
  f.includes("/storybook-static/") ||
  f.includes("/code-server/") ||
  f.includes("/env-sidecars/") ||
  f.includes("/spa/assets/") ||
  f.includes("/holepunch-spike/") ||
  /\.(test|spec)\.[cm]?tsx?$/.test(f) ||
  !/\.(ts|mjs|cjs|sql)$/.test(f);

/** Strip block + line comments so prose about blocks edges isn't flagged. */
export function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/--[^\n]*/g, "");
}

/**
 * A call into a RAW coord_links WRITE primitive: the low-level relation writer, or a
 * raw INSERT. The work-item facades are deliberately absent: P-006 routes their
 * work-item `blocks` branch through canonical candidate admission, and a separate
 * structural check below prevents that route from regressing. Reads (`listIn` /
 * `listInMany` / `listOut`) are absent — reading a blocker set cannot create a cycle.
 */
const WRITE_PRIMITIVE =
  /\b(?:blockingLinks|links)\.link\s*\(|INSERT\s+INTO\s+harness_shared\.coord_links/i;
/** A `blocks` rel literal in any quoting style. */
const BLOCKS_LITERAL = /['"`]blocks['"`]/;
/** Referencing either sanctioned entry point means the policy is being applied. */
const SANCTIONED =
  /syncFeatureBlockEdges|guardFeatureBlockEdgeAcyclic|mirrorWorkItemBlockingEdge/;

/**
 * Does this source WRITE a feature→feature `blocks` edge without going through the
 * acyclicity policy? Pure (text → boolean) so it is unit-testable in isolation.
 *
 * FILE-LEVEL on purpose, and this is a deliberate trade rather than laziness. The
 * obvious tighter predicate — require the `'blocks'` literal INSIDE the call's own
 * arguments — was implemented first and MEASURED against the tree: it missed callers
 * that pass the rel as a VARIABLE after an `it.rel === 'blocks'` branch.
 * Since the one real in-tree caller already uses the variable form, a
 * literal-in-call predicate would miss the realistic bypass shape while looking
 * precise — the worst combination for a guard.
 *
 * So: a file that touches a coord_links write primitive AND traffics in a `blocks`
 * rel must reference the policy, or be allowlisted. Measured cost of the coarser
 * form on the live tree (2026-08-02, 5680 scanned files): exactly ONE additional
 * file, `work-items.ts`, which merely DEFINES linkWorkItem — allowlisted above with
 * a reason, the same way the sibling guards allowlist their own definition sites.
 */
export function writesRawBlocksEdge(text) {
  const t = stripComments(text);
  return (
    WRITE_PRIMITIVE.test(t) && BLOCKS_LITERAL.test(t) && !SANCTIONED.test(t)
  );
}

/** Physical canonical-table mutation — reads and DDL do not match. */
const RAW_WORK_ITEM_DEPS_DML =
  /\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE)\s+(?:ONLY\s+)?harness_shared\.work_item_deps\b/i;

/** A source file contains raw canonical dependency-table DML. */
export function writesRawWorkItemDependency(text) {
  return RAW_WORK_ITEM_DEPS_DML.test(stripComments(text));
}

/** The blanket bypass P-006 retired. Capability-confined migrations do not use this TS option. */
export function usesDependencyAdmissionBypass(text) {
  return /\benforceAcyclicity\s*:\s*false\b/.test(stripComments(text));
}

const CANONICAL_STORE_FACADES = [
  "mirrorWorkItemBlockingEdge",
  "removeMirroredWorkItemBlockingEdge",
  "syncWorkItemDepEdges",
];

/**
 * P-006 link-facade contract. Callers are allowed to trust `linkWorkItem` / `linkIssue`
 * only while these four definitions keep routing work-item `blocks` mutations through
 * the canonical mirror/remove facades. Checking both family branches prevents the
 * guard fix for WI-225867 from becoming a blanket exemption for a future regression.
 */
const CANONICAL_LINK_FACADES = [
  {
    source: "work-items",
    name: "linkWorkItem",
    required: ["linkIssue", "mirrorWorkItemBlockingEdge"],
  },
  {
    source: "work-items",
    name: "unlinkWorkItem",
    required: ["unlinkIssue", "removeMirroredWorkItemBlockingEdge"],
  },
  {
    source: "issues-engineer",
    name: "linkIssue",
    required: ["mirrorWorkItemBlockingEdge"],
  },
  {
    source: "issues-engineer",
    name: "unlinkIssue",
    required: ["removeMirroredWorkItemBlockingEdge"],
  },
];

/** Which canonical link facades are missing, or have lost one of their family routes. */
export function canonicalLinkFacadeRoutingOffenders(
  workItemsText,
  issuesEngineerText,
) {
  const sources = {
    "work-items": stripComments(workItemsText),
    "issues-engineer": stripComments(issuesEngineerText),
  };
  return CANONICAL_LINK_FACADES.filter(({ source, name, required }) => {
    const body = functionSlice(sources[source], name, true);
    return (
      body === null ||
      required.some((route) => !new RegExp(`\\b${route}\\s*\\(`).test(body))
    );
  }).map(({ name }) => name);
}

/**
 * Extract one exported function through the next exported declaration. This intentionally checks
 * a coarse source contract, just like writesRawBlocksEdge: the negative-control tests prove the
 * detector can fire, while runtime/integration tests prove behavior.
 */
function functionSlice(text, name, exportedOnly = false) {
  const prefix = exportedOnly ? "export\\s+" : "(?:export\\s+)?";
  const start = text.search(
    new RegExp(`\\b${prefix}async\\s+function\\s+${name}\\s*\\(`),
  );
  if (start < 0) return null;
  const next = text.indexOf("\nexport ", start + 1);
  return text.slice(start, next < 0 ? text.length : next);
}

/** Which required facades are missing or no longer submit to P-005. */
export function canonicalFacadeRoutingOffenders(text) {
  return CANONICAL_STORE_FACADES.filter((name) => {
    const body = functionSlice(stripComments(text), name, true);
    return body === null || !/\bmutateWorkItemDependencies\s*\(/.test(body);
  });
}

/**
 * A capability is narrower than a file allowlist. Prove the two runtime-capability files keep
 * their DML inside the named function, and that the goal writer stays goal-only.
 */
function rawCapabilityScopeViolation(path, text) {
  const stripped = stripComments(text);
  if (path === "packages/operator-core/lib/dbos/work-item-deps-store.ts") {
    const body = functionSlice(stripped, "applyStoredEdgeDiff");
    if (body === null || !writesRawWorkItemDependency(body))
      return "canonical diff applier missing its DML";
    if (writesRawWorkItemDependency(stripped.replace(body, "")))
      return "raw DML exists outside applyStoredEdgeDiff";
  }
  if (path === "packages/agent-mcp/src/tools/goals/goal-deps.ts") {
    const body = functionSlice(stripped, "replaceGoalBlockedBy", true);
    if (body === null || !writesRawWorkItemDependency(body))
      return "goal replace capability missing its DML";
    if (writesRawWorkItemDependency(stripped.replace(body, "")))
      return "raw DML exists outside replaceGoalBlockedBy";
    if (
      !/blocked_kind\s*=\s*\$\{GOAL_DEP_KIND\}/.test(body) ||
      !/\$\{GOAL_DEP_KIND\}/.test(body)
    ) {
      return "goal DML is no longer pinned to GOAL_DEP_KIND";
    }
  }
  return null;
}

/**
 * Scan the tracked tree for offenders. Enumerates via `listTrackedFiles`, which
 * recurses into submodules — a bare `git ls-files` emits one gitlink entry per
 * submodule and would silently report ✓ for all of them (the WI-6730 failure the
 * sibling guards already learned). Returns coverage alongside offenders so `main`
 * can state what it could not check rather than implying a clean tree.
 */
export function findOffenders() {
  const { files: tracked, unscanned } = listTrackedFiles(ROOT);

  const offenders = [];
  const rawWorkItemDepsOffenders = [];
  const bypassOffenders = [];
  for (const f of tracked) {
    if (isExcluded(f)) continue;
    let text;
    try {
      text = readFileSync(new URL(f, `file://${ROOT}`), "utf8");
    } catch {
      continue;
    }
    if (!ALLOWLIST.has(f) && !BASELINE.has(f) && writesRawBlocksEdge(text))
      offenders.push(f);
    if (writesRawWorkItemDependency(text)) {
      if (!RAW_WORK_ITEM_DEPS_CAPABILITIES.has(f)) {
        rawWorkItemDepsOffenders.push(f);
      } else {
        const scopeViolation = rawCapabilityScopeViolation(f, text);
        if (scopeViolation)
          rawWorkItemDepsOffenders.push(`${f} (${scopeViolation})`);
      }
    }
    // The detector source necessarily spells the banned option inside its own regex.
    if (
      f !== "scripts/check-no-raw-block-edge.mjs" &&
      usesDependencyAdmissionBypass(text)
    ) {
      bypassOffenders.push(f);
    }
  }
  const storePath = "packages/operator-core/lib/dbos/work-item-deps-store.ts";
  const storeText = readFileSync(new URL(storePath, `file://${ROOT}`), "utf8");
  const facadeRoutingOffenders = canonicalFacadeRoutingOffenders(storeText);
  const workItemsText = readFileSync(
    new URL("packages/operator-core/lib/work-items.ts", `file://${ROOT}`),
    "utf8",
  );
  const issuesEngineerText = readFileSync(
    new URL("packages/operator-core/lib/issues-engineer.ts", `file://${ROOT}`),
    "utf8",
  );
  const linkFacadeRoutingOffenders = canonicalLinkFacadeRoutingOffenders(
    workItemsText,
    issuesEngineerText,
  );
  return {
    offenders,
    rawWorkItemDepsOffenders,
    bypassOffenders,
    facadeRoutingOffenders,
    linkFacadeRoutingOffenders,
    unscanned,
  };
}

function main() {
  const {
    offenders,
    rawWorkItemDepsOffenders,
    bypassOffenders,
    facadeRoutingOffenders,
    linkFacadeRoutingOffenders,
    unscanned,
  } = findOffenders();
  if (
    offenders.length === 0 &&
    rawWorkItemDepsOffenders.length === 0 &&
    bypassOffenders.length === 0 &&
    facadeRoutingOffenders.length === 0 &&
    linkFacadeRoutingOffenders.length === 0
  ) {
    console.log(
      "✓ no dependency edge write bypasses canonical admission or its confined capabilities." +
        describeUnscanned(unscanned),
    );
    process.exit(0);
  }
  if (offenders.length > 0) {
    console.error(
      "✗ coord_links blocks-edge write(s) bypassing the feature policy:",
    );
    for (const o of offenders) console.error("    " + o);
  }
  if (rawWorkItemDepsOffenders.length > 0) {
    console.error("✗ raw work_item_deps DML outside a named capability:");
    for (const o of rawWorkItemDepsOffenders) console.error("    " + o);
    console.error(
      "  Route normal runtime writes through a facade in dbos/work-item-deps-store.ts.",
    );
  }
  if (bypassOffenders.length > 0) {
    console.error(
      "✗ retired enforceAcyclicity:false dependency-admission bypass:",
    );
    for (const o of bypassOffenders) console.error("    " + o);
  }
  if (facadeRoutingOffenders.length > 0) {
    console.error(
      "✗ compatibility facade(s) no longer route through mutateWorkItemDependencies:",
    );
    for (const o of facadeRoutingOffenders) console.error("    " + o);
  }
  if (linkFacadeRoutingOffenders.length > 0) {
    console.error(
      "✗ work-item link facade(s) no longer route blocks through canonical admission:",
    );
    for (const o of linkFacadeRoutingOffenders) console.error("    " + o);
  }
  console.error(
    "\n  See dependency-graph-admission-and-health-2026-08-26 P-006.",
  );
  process.exit(1);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
