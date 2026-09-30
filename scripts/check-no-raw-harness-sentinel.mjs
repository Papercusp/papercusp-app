#!/usr/bin/env node
/**
 * check-no-raw-harness-sentinel.mjs — fail-loud guard against a NEW use of the
 * operator-scope `ctx.harnessSlug` sentinel as though it were a concrete slug.
 *
 * `http-projection` sets `ctx.harnessSlug = '*'` for every superuser/operator-scope
 * call. `'*'` is a real, truthy string, but it is not a registered harness. A raw
 * nullish fallback (`args.harness ?? ctx.harnessSlug ?? ''`), an identity field
 * (`{ harnessSlug: ctx.harnessSlug }`), or a non-sentinel predicate therefore
 * silently addresses the wrong bucket. The failure is usually an empty result or
 * a no-op write, not an exception.
 *
 * The canonical resolver seams are `resolveHarnessScope`,
 * `resolveConcreteHarnessSlug`, `resolvePotHomeSlug`, `harnessScopedCtx`, and
 * `isAllHarnessSentinel`. New code should route through one of those seams before
 * using the value as an identity. This guard intentionally detects only the
 * high-signal syntactic shapes (fallbacks, identity-bearing object fields, and
 * non-sentinel predicates); free-form metadata and log labels are not identities.
 *
 *   node scripts/check-no-raw-harness-sentinel.mjs
 *   node scripts/check-no-raw-harness-sentinel.mjs --list
 *
 * `--list` is the measurement command used to seed the shrink-only BASELINE. It
 * lists every candidate, including existing candidates that are still being
 * audited. A new candidate is never made green by adding it to BASELINE: fix it,
 * route it through a resolver, or record a relation-level allowlist decision.
 *
 * The predicate and real-tree scanner are exported + unit-tested in
 * `packages/operator-core/lib/agent-tools/no-raw-harness-sentinel-guard.test.ts`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { describeUnscanned, listTrackedFiles } from './lib/tracked-files.mjs';
import { stripCommentsAndStrings, stripCommentsOnly } from './lib/strip-comments-and-strings.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

/** The detector itself contains its own syntax examples and is therefore exempt. */
export const ALLOWLIST = new Set(['scripts/check-no-raw-harness-sentinel.mjs']);

/**
 * Existing, measured candidates pending an audit. This set may only shrink.
 *
 * Measured at HEAD f0338f50b55fb0710f082c7883ecb2a37d0e88fe with `--list` on
 * 2026-08-12. The issue deliberately did not claim these sites were all defects:
 * they are the population the detector makes visible so each relation/call-site
 * can be audited without silently growing the grandfather set. The capability:bash
 * site was subsequently fixed through the canonical resolver, shrinking the
 * pending baseline to 67. The facts:assert site was then fixed through the same
 * resolver, shrinking the pending baseline to 66. The work-items:update plan
 * stamp sites were then fixed through the same resolver, shrinking it to 63.
 * The events/watch.ts predicate-branch binding was then fixed through
 * resolvePotHomeSlug (EI-20664974139266563), shrinking it to 62 — that binding
 * fed both the dedup lookup and the persisted predicate_watches.harness_slug,
 * so the two bare `harnessSlug,` uses downstream of it are fixed with it.
 * The testing:flakiness fallback and work-item identity sites were then fixed
 * through resolveConcreteHarnessSlug (8bbee8979e), shrinking the pending
 * baseline to 60.
 * A source fingerprint makes a REWRITTEN or removed site fail closed.
 *
 * Keys are LINE-INSENSITIVE (`file:kind#occurrence:text`) — see `findingKey`.
 * They carried a line number until 2026-08-12, which made a baselined site red
 * the shared release gate whenever an unrelated edit shifted it downward; the
 * entries below are those same sites, re-keyed, not a re-measurement.
 */
export const BASELINE = new Set([
  "libs/generic/tooldef/src/dispatch-stack.ts:predicate#1:const slug = ctx.harnessSlug?.trim();",
  "libs/papercusp/packages/orchestrator/src/state-pg.ts:fallback#1:AND harness_slug  = ${ctx.harnessSlug ?? ''}",
  "libs/papercusp/packages/orchestrator/src/state-pg.ts:fallback#1:ON hfc.harness_slug = ${ctx.harnessSlug ?? ''}",
  "libs/papercusp/packages/orchestrator/src/state.ts:fallback#1:ctx.harnessSlug ??",
  "packages/operator-core/lib/agent-tools/cell-reader-ctx.ts:fallback#1:harnessSlug: ctx.harnessSlug ?? null,",
  "packages/operator-core/lib/agent-tools/cell-reader-ctx.ts:identity-field#1:...(ctx.harnessSlug ? { harnessSlug: ctx.harnessSlug } : {}),",
  "packages/operator-core/lib/agent-tools/code/run.ts:fallback#1:harness: ctx.harnessSlug ?? null,",
  "packages/operator-core/lib/agent-tools/conventions/governing.ts:fallback#1:const harness = (args.harness ?? ctx.harnessSlug ?? '').trim();",
  "packages/operator-core/lib/agent-tools/coordination/coupled-topics-read.ts:identity-field#1:...(ctx.harnessSlug ? { harnessSlug: ctx.harnessSlug } : {}),",
  "packages/operator-core/lib/agent-tools/coordination/identity.ts:fallback#1:? `${sysRole} · ${ctx.harnessSlug ?? 'system'}`",
  "packages/operator-core/lib/agent-tools/datatypes/declare.ts:fallback#1:potSlug: ctx.harnessSlug ?? null,",
  "packages/operator-core/lib/agent-tools/dev/pg_query.ts:identity-field#1:harnessSlug: ctx.harnessSlug,",
  "packages/operator-core/lib/agent-tools/dev/why.ts:fallback#1:harnessSlug: args.harness ?? ctx.harnessSlug,",
  "packages/operator-core/lib/agent-tools/facts/scope-ctx.ts:identity-field#1:harnessSlug: ctx.harnessSlug,",
  "packages/operator-core/lib/agent-tools/improvements/resolve.ts:fallback#1:harnessSlug: ctx.harnessSlug ?? null,",
  "packages/operator-core/lib/agent-tools/recipes/run.ts:fallback#1:harnessSlug: ctx.harnessSlug ?? null,",
  "packages/operator-core/lib/agent-tools/recipes/run.ts:identity-field#1:...(ctx.harnessSlug ? { harness: ctx.harnessSlug } : {}),",
  "packages/operator-core/lib/agent-tools/recipes/search.ts:identity-field#1:...(ctx.harnessSlug ? { harness: ctx.harnessSlug } : {}),",
  "packages/operator-core/lib/agent-tools/state/read.ts:fallback#1:harnessSlug: ctx.harnessSlug ?? null,",
  "packages/operator-core/lib/agent-tools/state/read.ts:fallback#1:harnessSlug: ctx.harnessSlug ?? undefined,",
  "packages/operator-core/lib/agent-tools/state/subscribe.ts:fallback#1:harnessSlug: ctx.harnessSlug ?? undefined,",
  "packages/operator-core/lib/agent-tools/tools/define.ts:fallback#1:harnessSlug: ctx.harnessSlug ?? null,",
  "packages/operator-core/lib/agent-tools/work_items/_create-core.ts:fallback#1:const planItemStampHarness = harnessForItem ?? ctx.harnessSlug ?? undefined;",
  "packages/operator-core/lib/agent-tools/work_items/_create-core.ts:fallback#1:harness: args.harness ?? ctx.harnessSlug ?? undefined,",
  "packages/operator-core/lib/agent-tools/work_items/_create-core.ts:fallback#1:harnessSlug: args.harness ?? ctx.harnessSlug,",
  "packages/operator-core/lib/agent-tools/work_items/_create-core.ts:fallback#2:harness: args.harness ?? ctx.harnessSlug ?? undefined,",
  "packages/operator-core/lib/agent-tools/work_items/arm-reversible-work-item.ts:fallback#1:harnessSlug: ctx.harnessSlug ?? prior.harness ?? null,",
  "packages/operator-core/lib/agent-tools/work_items/create.ts:fallback#1:harness: s.harness ?? ctx.harnessSlug ?? null,",
  // Same baselined site as before, re-keyed: `createCtx` was reformatted from a one-line
  // object to a multi-line one (6d1f02aebe, which also added `projectDir`), which changes
  // the finding TEXT and therefore the key, while `harnessSlug: ctx.harnessSlug` itself is
  // byte-identical. Not a new exposure — re-keyed, never widened.
  "packages/operator-core/lib/agent-tools/work_items/create.ts:identity-field#1:harnessSlug: ctx.harnessSlug,",
  "packages/operator-core/lib/blueprint-steps/ops/calibration-resolve.ts:fallback#1:const installSlug = ctx.harnessSlug ?? 'op';",
  "packages/operator-core/lib/blueprint-steps/ops/change-ledger-scan.ts:fallback#1:const installSlug = ctx.harnessSlug ?? 'op';",
  "packages/operator-core/lib/blueprint-steps/ops/deferral-interest-refit.ts:fallback#1:const installSlug = ctx.harnessSlug ?? 'op';",
  "packages/operator-core/lib/blueprint-steps/ops/fleet-ekg-scan.ts:fallback#1:const installSlug = ctx.harnessSlug ?? 'op';",
  "packages/operator-core/lib/blueprint-steps/ops/graduation-scan.ts:fallback#1:const installSlug = ctx.harnessSlug ?? 'op';",
  "packages/operator-core/lib/blueprint-steps/ops/hive-eval-gen.ts:fallback#1:const installSlug = ctx.harnessSlug ?? 'op';",
  "packages/operator-core/lib/blueprint-steps/ops/iq-battery-gen.ts:fallback#1:const installSlug = ctx.harnessSlug ?? 'op';",
  "packages/operator-core/lib/blueprint-steps/ops/memory-live-recall-canary.ts:fallback#1:const installSlug = ctx.harnessSlug ?? 'op';",
  "packages/operator-core/lib/blueprint-steps/ops/memory-precision-bench.ts:fallback#1:const installSlug = ctx.harnessSlug ?? 'op';",
  "packages/operator-core/lib/blueprint-steps/ops/negative-space-scan.ts:fallback#1:const installSlug = ctx.harnessSlug ?? 'op';",
  "packages/operator-core/lib/blueprint-steps/ops/neologism-mine.ts:fallback#1:const installSlug = ctx.harnessSlug ?? 'op';",
  "packages/operator-core/lib/blueprint-steps/ops/prompt-ablation.ts:fallback#1:const installSlug = ctx.harnessSlug ?? 'op';",
  "packages/operator-core/lib/blueprint-steps/ops/red-queen-drill.ts:fallback#1:const installSlug = ctx.harnessSlug ?? 'op';",
  "packages/operator-core/lib/blueprint-steps/ops/regret-mine.ts:fallback#1:const installSlug = ctx.harnessSlug ?? 'op';",
  "packages/operator-core/lib/blueprint-steps/ops/scout-cycle.ts:fallback#1:const perHiveInstall = ctx.harnessSlug ?? 'op';",
  "packages/operator-core/lib/blueprint-steps/ops/transfer-distill.ts:fallback#1:const installSlug = ctx.harnessSlug ?? 'op';",
  "packages/operator-core/lib/coord-ops/ops/compose.ts:identity-field#1:harness: ctx.harnessSlug,",
  "packages/operator-core/lib/coord-ops/ops/thread-open.ts:fallback#1:harness: a.harness ?? ctx.harnessSlug,",
  "packages/operator-core/lib/decision-ledger/emit.ts:fallback#1:harnessSlug: ctx.harnessSlug ?? null,",
  "packages/operator-core/lib/deployment/frame-installer.ts:identity-field#1:harnessSlug: ctx.harnessSlug,",
  "packages/operator-core/lib/deployment/headless-peer.ts:identity-field#1:harnessSlug: ctx.harnessSlug,",
  "packages/operator-core/lib/endpoint-route/routes/plugins/catchall.ts:fallback#1:console.log(`[plugin-tool/http][${ctx.harnessSlug ?? '-'}/${ctx.role ?? '-'}/${ctx.spawnId ?? '-'}] ${line}`);",
  "packages/operator-core/lib/endpoint-route/routes/transport/_mcp-host.ts:predicate#1:spawnRes.ctx.harnessSlug === '*' &&",
  "packages/operator-core/lib/endpoint-route/routes/transport/_mcp-slash-prompts.ts:identity-field#1:harness: ctx.harnessSlug,",
  "packages/operator-core/lib/events/reaction-id.ts:identity-field#1:harnessSlug: ctx.harnessSlug,",
  "packages/operator-core/lib/events/rules.ts:fallback#1:harness_slug: e.ctx.harnessSlug ?? undefined,",
  "packages/operator-core/lib/fleet/bee-completion-reconcile.ts:identity-field#1:{ harnessSlug: ctx.harnessSlug, featureId: ctx.featureId, workspaceId: ctx.workspaceId },",
  "packages/operator-core/lib/gym/control-plane.ts:identity-field#1:harnessSlug: ctx.harnessSlug,",
  "packages/operator-core/lib/gym/control-plane.ts:identity-field#2:harnessSlug: ctx.harnessSlug,",
  "packages/operator-core/lib/harness-ops/proxy.ts:identity-field#1:harnessSlug: ctx.harnessSlug,",
  // Same baselined telemetry site, re-keyed after 02228d3eca introduced a named local
  // so the unresolved `$VAR` rejection could inspect it before the INSERT. The raw
  // harness relation and wildcard semantics are unchanged; this is not a new finding
  // and does not widen the shrink-only population.
  "packages/operator-core/lib/projected-tool-deps.ts:fallback#1:const harnessSlug = input.ctx.harnessSlug ?? '';",
]);

/** Vendored/generated/test files are not operator source and are not scanned. */
export const isExcluded = (f) =>
  f.startsWith('_retired/') ||
  f.includes('/_retired/') ||
  f.includes('/node_modules/') ||
  f.includes('/dist/') ||
  f.includes('/.next/') ||
  f.includes('/build/') ||
  f.includes('/storybook-static/') ||
  f.includes('/code-server/') ||
  f.includes('/env-sidecars/') ||
  f.includes('/spa/assets/') ||
  f.includes('/holepunch-spike/') ||
  /\.(test|spec)\.[cm]?tsx?$/.test(f) ||
  !/\.(ts|tsx|mjs|cjs)$/.test(f);

const CTX_HARNESS = /\bctx(?:\?\.)?\.harnessSlug\b/;
const RAW_FALLBACK = /(?:\?\?|\|\|)\s*ctx(?:\?\.)?\.harnessSlug\b|\bctx(?:\?\.)?\.harnessSlug\s*(?:\?\?|\|\|)/;
const IDENTITY_FIELD = /\b(?:harness|harnessSlug|harness_slug|installSlug|potSlug)\s*:\s*(?:[^,\n]*?\s)?ctx(?:\?\.)?\.harnessSlug\b/;
const NON_SENTINEL_PREDICATE =
  /(?:\bctx(?:\?\.)?\.harnessSlug\s*(?:===|!==|==|!=)\s*(?!['"]\s*(?:\*|all)\s*['"])|(?:===|!==|==|!=)\s*ctx(?:\?\.)?\.harnessSlug\b)/;
const TRUTHINESS_PREDICATE =
  /(?:\bif\s*\(\s*ctx(?:\?\.)?\.harnessSlug\s*\)|\bwhile\s*\(\s*ctx(?:\?\.)?\.harnessSlug\s*\)|\bctx(?:\?\.)?\.harnessSlug\s*\?)/;
const SAFE_RESOLVER =
  /\b(?:resolveHarnessScope|resolveConcreteHarnessSlug|resolvePotHomeSlug|harnessScopedCtx|isAllHarnessSentinel)\s*\(/;
const EXPLICIT_SENTINEL_GUARD =
  /\bctx(?:\?\.)?\.harnessSlug\s*!==?\s*['"]\s*(?:\*|all)\s*['"]|['"]\s*(?:\*|all)\s*['"]\s*!==?\s*ctx(?:\?\.)?\.harnessSlug\b/;

/**
 * Stable key for the shrink-only baseline.
 *
 * The key is deliberately LINE-INSENSITIVE. The fingerprint that makes a moved
 * or rewritten site fail closed is the source TEXT, not the line number — and a
 * line number additionally makes every baselined site fail on an UNRELATED edit
 * anywhere above it in the same file. On this tree (~120 commits/hour across the
 * hot agent-tools / orchestrator / endpoint-route files this baseline lives in)
 * that turned a shrink-only guard into a recurring red on the SHARED release
 * gate: on 2026-08-12 two sites shifted by pure line drift
 * (`recipes/run.ts` 303→322, `_mcp-handler.ts` 1890→1891), reddening the gate
 * with no behavioural change at all, and the only available repair was to
 * hand-re-measure the baseline — a mitigation that re-arms the same trap.
 *
 * `occurrence` (1-based, per file+kind+text) keeps two byte-identical sites in
 * one file distinguishable, so deleting one of them still fails closed.
 *
 * Fail-closed behaviour is unchanged: a CHANGED or REMOVED site no longer
 * produces its key and is reported as a stale baseline entry; a NEW site
 * produces a key that is not in the baseline and is reported as an offender.
 */
export function findingKey(file, finding) {
  return `${file}:${finding.kind}#${finding.occurrence ?? 1}:${finding.text.trim()}`;
}

/**
 * Find high-signal raw sentinel uses in one source file.
 *
 * `stripCommentsAndStrings` removes prose and string values while preserving
 * offsets/line numbers. `stripCommentsOnly` is used only for recognizing an
 * explicit `!== '*'`/`!== 'all'` guard; it leaves the string literal needed by
 * that check intact.
 */
export function findRawHarnessSentinelUses(text, fileName = 'source.ts') {
  const code = stripCommentsAndStrings(text, fileName);
  const commentFree = stripCommentsOnly(text, fileName);
  const sourceLines = String(text).split('\n');
  const codeLines = code.split('\n');
  const commentFreeLines = commentFree.split('\n');
  const findings = [];
  /** kind+text -> how many times it has already been seen in THIS file. */
  const seen = new Map();

  for (let i = 0; i < codeLines.length; i += 1) {
    const line = codeLines[i];
    if (!CTX_HARNESS.test(line)) continue;
    if (SAFE_RESOLVER.test(line) || EXPLICIT_SENTINEL_GUARD.test(commentFreeLines[i])) continue;

    let kind = null;
    if (RAW_FALLBACK.test(line)) kind = 'fallback';
    else if (IDENTITY_FIELD.test(line)) kind = 'identity-field';
    else if (NON_SENTINEL_PREDICATE.test(line) || TRUTHINESS_PREDICATE.test(line)) kind = 'predicate';
    if (!kind) continue;

    const text = sourceLines[i] ?? '';
    const dedupe = `${kind}:${text.trim()}`;
    const occurrence = (seen.get(dedupe) ?? 0) + 1;
    seen.set(dedupe, occurrence);

    findings.push({
      line: i + 1,
      kind,
      occurrence,
      text,
    });
  }
  return findings;
}

/**
 * Every possible source candidate, narrowed by Git's native literal search.
 *
 * The detector cannot match a file that does not contain `harnessSlug`, so
 * reading and comment-stripping every tracked source file first is pure waste.
 * On this tree that meant parsing thousands of irrelevant files inside the full
 * pure lane and repeatedly crossing the guard's 120-second timeout. Keep
 * `listTrackedFiles` as the coverage authority, intersect Git's result with it,
 * and fail back to the complete list on any Git error other than the ordinary
 * no-match status. The optimization can disappear; coverage cannot.
 */
export function rawHarnessCandidateFiles(tracked, cwd = ROOT) {
  try {
    const output = execFileSync(
      'git',
      ['grep', '-l', '-z', '--recurse-submodules', '-e', 'harnessSlug', '--'],
      { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    const trackedSet = new Set(tracked);
    return output.split('\0').filter((file) => file && trackedSet.has(file));
  } catch (err) {
    // `git grep` status 1 means the tracked tree contains no match. Returning an
    // empty set remains fail-closed here: every non-empty baseline row becomes
    // stale. Infrastructure/usage failures fall back to the original full scan.
    if (Number(err?.status) === 1) return [];
    return tracked;
  }
}

/**
 * Scan the tracked tree. The result keeps coverage separate from findings so
 * an incomplete submodule enumeration cannot be reported as a repo-wide pass.
 */
export function findOffenders() {
  const { files: tracked, unscanned } = listTrackedFiles(ROOT);
  const candidates = rawHarnessCandidateFiles(tracked);
  const offenders = [];
  const observedBaseline = new Set();
  let scanned = 0;

  for (const f of candidates) {
    if (isExcluded(f) || ALLOWLIST.has(f)) continue;
    let text;
    try {
      text = readFileSync(new URL(f, `file://${ROOT}`), 'utf8');
    } catch {
      continue;
    }
    scanned += 1;
    for (const finding of findRawHarnessSentinelUses(text, f)) {
      const key = findingKey(f, finding);
      if (BASELINE.has(key)) observedBaseline.add(key);
      else offenders.push({ file: f, ...finding, key });
    }
  }

  const staleBaseline = [...BASELINE].filter((key) => !observedBaseline.has(key));
  return { offenders, staleBaseline, scanned, tracked: tracked.length, unscanned };
}

export function formatFinding(finding) {
  return `${finding.file}:${finding.line} [${finding.kind}] ${finding.text.trim()}`;
}

function main() {
  const scan = findOffenders();
  const allCandidates = [...scan.offenders];
  if (process.argv.includes('--list')) {
    console.log(`raw ctx.harnessSlug candidates (${allCandidates.length + BASELINE.size} total):`);
    for (const o of allCandidates) console.log(`  ${formatFinding(o)}`);
    for (const key of BASELINE) {
      if (!scan.staleBaseline.includes(key)) console.log(`  BASELINE ${key}`);
    }
    console.log(describeUnscanned(scan.unscanned));
    process.exit(0);
  }

  if (scan.staleBaseline.length > 0) {
    console.error('✗ BASELINE entries were not observed; remove them or restore the guarded site:');
    for (const key of scan.staleBaseline) console.error(`    ${key}`);
  }
  if (scan.offenders.length > 0) {
    console.error('✗ NEW raw ctx.harnessSlug identity use(s) without a sentinel guard:');
    console.error('  Route concrete-harness operations through resolveConcreteHarnessSlug / resolveHarnessScope.');
    console.error('  Route pot-home operations through resolvePotHomeSlug; compare the sentinel explicitly when that is the intent.');
    console.error('  A raw "*" is truthy but is not a registered harness, so the failure can look like a clean empty result.');
    for (const o of scan.offenders) console.error(`    ${formatFinding(o)}`);
  }
  if (scan.staleBaseline.length > 0 || scan.offenders.length > 0) {
    console.error(`\n  ${scan.offenders.length + scan.staleBaseline.length} finding(s). Use --list for the measured candidate set.`);
    process.exit(1);
  }
  console.log(`✓ no NEW raw ctx.harnessSlug identity uses (${scan.scanned} candidate files scanned from ${scan.tracked} tracked paths; ${BASELINE.size} baseline candidate(s)).${describeUnscanned(scan.unscanned)}`);
  process.exit(0);
}

const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  if (import.meta.url === pathToFileURL(argv1).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
})();
if (isMain) main();
