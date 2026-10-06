#!/usr/bin/env node
/**
 * check-reachable-advisories.mjs — the going-forward gate for production dependency
 * advisories (plan security-boundary-remediation-and-usability-2026-09-04, P-007;
 * spec SEC-P007-deps-keys-recovery: "an invalid dependency ... state is refused
 * before it becomes active").
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT `npm audit`
 * ---------------------------------------------
 * A bare `npm audit --omit=dev` over this monorepo reports the union of every
 * workspace's production deps — including workspaces that never ship in the Tauri
 * desktop product (the Astro docs sites, the testing shell, the test-config package).
 * Measured 2026-09-05: 99 advisories, of which 26 entered through @papercusp/testing-shell,
 * 11 through @papercupai/operator-docs and 7 through @papercusp/test-config. Reporting
 * that 99 as "production advisories" overstates the shipped attack surface by roughly
 * half, and — worse — buries the handful that genuinely ship.
 *
 * P-007 asks for *reachable* production advisories. So this gate does what audit cannot:
 * it attributes every advisory to the top-level workspace(s) that actually pull it in,
 * classifies those workspaces as shipping vs non-shipping, and gates only on the
 * shipping set.
 *
 * FAIL-CLOSED
 * -----------
 * An advisory the walker cannot attribute to any workspace is treated as SHIPPING, not
 * skipped. npm dedupes/hoists, so an unattributed package is a measurement gap, and a
 * measurement gap must never read as "safe" (repo doctrine: an empty result from a
 * bounded instrument is not a negative finding). These are reported under
 * `unattributed` so the gap stays visible instead of silently passing.
 *
 *   node scripts/check-reachable-advisories.mjs             # report (informational)
 *   node scripts/check-reachable-advisories.mjs --strict    # exit 1 on un-baselined shipping high/critical
 *   node scripts/check-reachable-advisories.mjs --list      # print the measured population (re-seeds the baseline)
 *   node scripts/check-reachable-advisories.mjs --json      # machine-readable
 *   node scripts/check-reachable-advisories.mjs --self-test # prove the analyzer is falsifiable
 *
 * The baseline (scripts/reachable-advisories-baseline.json) is SHRINK-ONLY, exactly like
 * KNOWN_DARK_FLAGS: fixing an advisory removes its entry; a NEW shipping high/critical
 * advisory fails the gate rather than being quietly appended. Re-seed it only from a real
 * `--list` run, never from a hand-run grep.
 *
 * The audit/ls inputs are overridable (`--audit-json`, `--ls-json`) so the analyzer can be
 * exercised on fixtures without mutating the shared tree — see
 * packages/operator-core/lib/reachable-advisories-guard.test.ts.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

/**
 * `semver` is loaded through createRequire, NOT a static import, on purpose.
 *
 * It is not declared by any package.json in this repo — it is present only as a hoisted
 * transitive. A static import would therefore turn a future hoist reshuffle into a hard
 * crash of the whole gate, and the reflex fix for a crashing gate is to disable it. With
 * the require guarded, a missing semver instead degrades every feasibility verdict to
 * UNDETERMINED, which is loud, fails closed, and names its own repair — the same doctrine
 * measureJson() applies to an unreachable registry.
 *
 * The durable fix is to declare semver as a root devDependency; that needs an install, so
 * it is batched with the lodash-es override (see the baseline's lodash-es entry).
 */
const requireFromHere = createRequire(import.meta.url);
/** @type {any} */
let semver = null;
/** @type {string|null} */
let semverLoadError = null;
try {
  semver = requireFromHere('semver');
} catch (err) {
  semverLoadError = err && err.message ? String(err.message) : String(err);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(ROOT, 'scripts', 'reachable-advisories-baseline.json');

/** Severities that GATE. Moderate/low are reported but do not fail. */
const GATING_SEVERITIES = new Set(['high', 'critical']);

/**
 * Workspaces that do NOT ship in the desktop product. An advisory reachable ONLY through
 * these is real debt but not shipped attack surface, so it is reported and not gated.
 * Each entry states WHY it does not ship — this is the judgment the derivation cannot make.
 */
const NON_SHIPPING_WORKSPACES = new Map([
  ['@papercupai/operator-docs', 'Astro docs site; built to static HTML, never bundled into the desktop app'],
  ['@papercupai/papercusp-docs', 'Astro docs site; static output only'],
  ['@papercusp/docs-engine', 'docs build tooling; not part of the operator sidecar or host bundle'],
  ['@papercusp/testing-shell', 'test harness package; dev/test only'],
  ['@papercusp/test-config', 'shared vitest/test configuration; dev/test only'],
]);

export function isNonShipping(workspace) {
  return NON_SHIPPING_WORKSPACES.has(workspace);
}

/**
 * Attribute each advisory package to the top-level workspace(s) whose production
 * dependency subtree reaches it.
 *
 * `npm ls --omit=dev --all --json` nests workspaces as direct children of the root, each
 * carrying `resolved: "file:..."`. Everything below a workspace is attributed to it; a
 * nested workspace re-roots attribution to itself.
 */
export function attributeAdvisories(lsTree, advisoryNames) {
  const advisory = advisoryNames instanceof Set ? advisoryNames : new Set(advisoryNames);
  const reach = new Map(); // pkg -> Set(workspace)
  const seen = new Set();

  const walk = (node, owner, depth) => {
    if (!node || depth > 64) return;
    for (const [name, child] of Object.entries(node.dependencies || {})) {
      if (!child || typeof child !== 'object') continue;
      const isWorkspace = typeof child.resolved === 'string' && child.resolved.startsWith('file:');
      const nextOwner = isWorkspace ? name : owner;
      if (advisory.has(name) && nextOwner) {
        if (!reach.has(name)) reach.set(name, new Set());
        reach.get(name).add(nextOwner);
      }
      // Guard against pathological cycles while still allowing the same package to be
      // revisited under a DIFFERENT workspace owner (that is the attribution we want).
      // '::' is a safe delimiter: npm names cannot contain a colon.
      const key = `${nextOwner ?? '~root'}::${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      walk(child, nextOwner, depth + 1);
    }
  };
  walk(lsTree, null, 0);
  return reach;
}

/**
 * Collect EVERY installed version of each advisory package from the `npm ls` tree.
 *
 * A package is often installed more than once, and the vulnerable copy is not always the
 * hoisted one. Measured 2026-09-05: langsmith is 0.8.7 at `node_modules/langsmith` (clean)
 * and 0.3.87 nested under `@browserbasehq/stagehand` (vulnerable); lodash-es is installed
 * at both 4.17.21 (vulnerable) and 4.18.1 (clean). Deriving fix feasibility from a single
 * copy therefore answers about the wrong object, in whichever direction that copy happens
 * to sit — so collect them all and let the advisory range select the relevant ones.
 *
 * @param {any} lsTree parsed `npm ls --omit=dev --all --json`
 * @param {Iterable<string>|Set<string>} advisoryNames packages to collect versions for
 * @returns {Map<string, string[]>} package name -> every installed version, ascending
 */
export function collectInstalledVersions(lsTree, advisoryNames) {
  const advisory = advisoryNames instanceof Set ? advisoryNames : new Set(advisoryNames);
  /** @type {Map<string, Set<string>>} */
  const versions = new Map();
  const seen = new Set();

  // Cycle guard keyed on NODE IDENTITY, never on name@version.
  //
  // This guard used to key on `${name}@${version}`, on the stated assumption that "the
  // same name+version subtree cannot contribute a version we have not already taken".
  // MEASURED FALSE 2026-09-05: `npm ls --omit=dev --all --json` emits a workspace in two
  // forms — a bare dedupe STUB ({ version } only, no `resolved`, no `dependencies`) under
  // every workspace depending on it, and ONCE in full. Meeting a stub first marked the
  // name@version seen, and the POPULATED occurrence was then skipped, dropping that
  // workspace's entire production subtree. `@papercusp/testing-shell@0.0.1` appeared as 4
  // stubs and 1 real node with 8 direct deps; langsmith 0.3.87 (vulnerable, nested under
  // stagehand) lived in the dropped subtree, so the gate saw only the hoisted 0.8.7 and
  // reported "no installed copy satisfies the vulnerable range" — a fail-OPEN under-report
  // that reads as reassurance. That is the ordinary shape of a monorepo whose workspaces
  // depend on each other, not a pathological graph.
  //
  // Identity is the right key because it guards the only thing that can actually loop: a
  // genuinely shared object reference. Two distinct subtrees are two distinct objects, so
  // they are both walked; a true cycle revisits the SAME object and terminates. Post-
  // JSON.parse input has no shared references at all, so this degrades to a full walk,
  // which is what correctness requires here; `depth > 64` remains the backstop.
  const walk = (node, depth) => {
    if (!node || depth > 64) return;
    if (seen.has(node)) return;
    seen.add(node);
    for (const [name, child] of Object.entries(node.dependencies || {})) {
      if (!child || typeof child !== 'object') continue;
      if (advisory.has(name) && typeof child.version === 'string' && child.version) {
        if (!versions.has(name)) versions.set(name, new Set());
        versions.get(name).add(child.version);
      }
      walk(child, depth + 1);
    }
  };
  walk(lsTree, 0);

  const ascending = (a, b) => {
    if (!semver) return a.localeCompare(b);
    try {
      return semver.compare(a, b, { loose: true });
    } catch {
      return a.localeCompare(b);
    }
  };
  return new Map([...versions].map(([name, set]) => [name, [...set].sort(ascending)]));
}

/**
 * Derive fix feasibility from the ADVISORY RANGE — the derived-truth-ladder replacement
 * for reading npm's `fixAvailable` field (CLAUDE.md: derive, pin, or attest).
 *
 * WHY THIS EXISTS. `fixAvailable` is a second copy of a truth the range already owns, and
 * it drifts. The two-lens reconciliation above only bites when npm returns `fixAvailable`
 * as an OBJECT carrying `isSemVerMajor`; when npm returns the BARE BOOLEAN `true` there is
 * no version to compare and BOTH lenses read "patch-compatible". Observed live on
 * 2026-09-05: style-dictionary's npm record moved from `{version:5.5.2, isSemVerMajor:true}`
 * to the range `>=4.3.0 <5.4.4` plus a bare `true` within hours, so an entry that had just
 * been CORRECTED silently reverted to reading patch-compatible with nothing failing. Keying
 * on the shape of a third party's payload gives a fix an expiry date; key on the invariant.
 *
 * THE INVARIANT, AND ITS ASYMMETRY. If `^<installed>` is a semver SUBSET of the vulnerable
 * range, then every version reachable without a breaking bump is still vulnerable — no
 * compatible version escapes, so the fix is necessarily semver-major. That direction is a
 * PROOF, computable from the audit payload plus the installed versions alone: no manifest
 * read, no registry call.
 *
 * The other direction is NOT the mirror image. `escapable` means only that the range fails
 * to trap every compatible version — the range algebra leaves room for an escape, which is
 * not the same as one being PUBLISHED. Measured 2026-09-05: `^6.7.0` is not a subset of
 * d3's `4.4.0 - 5.0.0-rc.4 || 6.0.0-rc.1 - 6.7.0`, yet the only real fix is d3 7.x. So
 * `escapable` never yields patch-eligible on its own; analyze() conjoins it with a lens
 * reporting an actual available fix, which is the half that knows the registry.
 *
 * Verified against published-registry ground truth on all four of this tree's bare-boolean
 * rows (2026-09-05): lodash-es 4.17.21 / `<=4.17.23` -> escapable (4.18.1 exists);
 * style-dictionary 4.4.0 / `4.3.0 - 5.4.3`, stagehand 3.4.0 / `3.0.0 - 4.0.0-alpha-...`,
 * and langsmith 0.3.87 / `<=0.5.26` -> requires-major. Under 0.x semver a minor bump is
 * breaking, which is why `^0.3.87` collapses to `>=0.3.87 <0.4.0` and is trapped.
 *
 * THE THIRD VERDICT. Anything unmeasurable returns `undetermined` rather than falling back
 * to the optimistic reading — an unparseable range, a package absent from the ls tree, an
 * advisory whose range no installed copy satisfies, or a missing semver. A guard that
 * cannot measure must say so; silently keeping the optimistic answer is the exact failure
 * this function replaces.
 *
 * @param {string} vulnerableRange the advisory's vulnerable range (npm audit `range`)
 * @param {string[]} installedVersions every installed version of the package
 * @returns {{verdict:'escapable'|'requires-major'|'undetermined', reason:string, vulnerableCopies:string[]}}
 */
export function deriveFixFeasibility(vulnerableRange, installedVersions) {
  const undetermined = (reason, vulnerableCopies = []) => ({ verdict: 'undetermined', reason, vulnerableCopies });

  if (!semver) {
    return undetermined(`semver is unavailable (${semverLoadError ?? 'not installed'}), so no range subset can be computed`);
  }

  const range = typeof vulnerableRange === 'string' ? vulnerableRange.trim() : '';
  if (!range) return undetermined('the advisory carries no vulnerable range');
  if (!semver.validRange(range, { loose: true })) {
    return undetermined(`advisory range "${range}" is not parseable as semver`);
  }

  const versions = (installedVersions || []).filter((v) => typeof v === 'string' && semver.valid(v, { loose: true }));
  if (!versions.length) {
    return undetermined('no installed copy of this package was found in the npm ls tree, so no caret range can be tested');
  }

  // Only copies actually IN the range need a fix; a clean sibling copy must not vote.
  const vulnerableCopies = versions.filter((v) => {
    try {
      return semver.satisfies(v, range, { includePrerelease: true, loose: true });
    } catch {
      return false;
    }
  });
  if (!vulnerableCopies.length) {
    return undetermined(
      `npm reports this package vulnerable over "${range}" but no installed copy (${versions.join(', ')}) satisfies that range`,
    );
  }

  const trapped = [];
  for (const v of vulnerableCopies) {
    let isSubset;
    try {
      isSubset = semver.subset(`^${v}`, range, { includePrerelease: true });
    } catch (err) {
      return undetermined(
        `semver.subset("^${v}", "${range}") could not be evaluated: ${err && err.message ? err.message : err}`,
        vulnerableCopies,
      );
    }
    if (isSubset) trapped.push(v);
  }

  if (trapped.length) {
    return {
      verdict: 'requires-major',
      reason:
        `${trapped.map((v) => `^${v}`).join(' and ')} ` +
        `${trapped.length > 1 ? 'are semver SUBSETS' : 'is a semver SUBSET'} of the vulnerable range "${range}" — ` +
        'no version reachable without a breaking bump escapes the advisory',
      vulnerableCopies,
    };
  }
  // NOTE THE ASYMMETRY, and do not strengthen this wording. `requires-major` is a PROOF:
  // if `^v` is contained in the vulnerable range then no compatible version escapes, full
  // stop. `escapable` is the mere ABSENCE of that proof — the range algebra leaves room
  // for a compatible escape, but says nothing about whether one is PUBLISHED. d3 measured
  // 2026-09-05 is the live example: `^6.7.0` is not a subset of `4.4.0 - 5.0.0-rc.4 ||
  // 6.0.0-rc.1 - 6.7.0`, yet the only real fix is d3 7.x. That is why `escapable` alone
  // never yields patch-eligible — it must be conjoined with a lens reporting an actual
  // available fix, which is the half that knows what the registry published.
  return {
    verdict: 'escapable',
    reason:
      `${vulnerableCopies.map((v) => `^${v}`).join(' and ')} ` +
      `${vulnerableCopies.length > 1 ? 'are' : 'is'} NOT a subset of the vulnerable range "${range}" — ` +
      'the advisory does not trap every semver-compatible version, so a reported fix may be reachable without a breaking bump',
    vulnerableCopies,
  };
}

/** Severity ordering, for fail-closed reconciliation between the two audit lenses. */
const SEVERITY_RANK = { unknown: 0, info: 1, low: 2, moderate: 3, high: 4, critical: 5 };
const worseSeverity = (a, b) => ((SEVERITY_RANK[b] ?? 0) > (SEVERITY_RANK[a] ?? 0) ? b : a);

/**
 * Core analysis. Pure: takes parsed audit + ls JSON, returns the classified population.
 *
 * `fullAuditJson` is the OPTIONAL second lens — `npm audit --json` over the tree as it is
 * actually installed (dev deps included). It exists because the two lenses disagree, and
 * the prod-only one is OPTIMISTIC about fixes:
 *
 *   style-dictionary, measured 2026-09-05 — installed 4.4.0, root declares "^4.4.0":
 *     npm audit --omit=dev  ->  fixAvailable: true          ("patch-compatible")
 *     npm audit             ->  fixAvailable: 5.5.2, isSemVerMajor: true
 *
 *   4.4.0 -> 5.5.2 is unambiguously major and "^4.4.0" cannot reach it, so the prod-only
 *   lens is simply WRONG here. It answers "what would fix this if the tree had no dev
 *   deps" — a tree we never install. (Note --omit=dev is not even a subset: it reported
 *   99 advisories against the full tree's 91.)
 *
 * So reachability/shipping is judged on the prod graph (the correct lens for what ships),
 * while FIX FEASIBILITY is judged against the tree we really install, and any disagreement
 * resolves to the PESSIMISTIC reading — the same fail-closed doctrine as unattributed
 * advisories above. A guard that under-reports a major upgrade as "patch-compatible" sends
 * you to attempt a fix that cannot work.
 *
 * @param {any} auditJson  parsed `npm audit --omit=dev --json` (reachability + severity)
 * @param {any} lsJson     parsed `npm ls --omit=dev --all --json` (workspace attribution)
 * @param {any} baseline   the shrink-only accepted-advisory baseline
 * @param {any} [fullAuditJson]  parsed `npm audit --json` over the tree as installed.
 *   Optional: omitted/null degrades to the single-lens reading, which still gates on the
 *   same population but is optimistic about fix feasibility. Typed explicitly because a
 *   bare `= null` default makes tsc infer the parameter type AS `null`, which then rejects
 *   every real audit object at the call site.
 */
export function analyze(auditJson, lsJson, baseline, fullAuditJson = null) {
  const vulns = auditJson?.vulnerabilities || {};
  const names = Object.keys(vulns);
  const reach = attributeAdvisories(lsJson || {}, names);
  const installed = collectInstalledVersions(lsJson || {}, names);
  const fullVulns = fullAuditJson?.vulnerabilities || null;

  const findings = [];
  for (const name of names) {
    const v = vulns[name] || {};
    const owners = [...(reach.get(name) || [])].sort();
    const attributed = owners.length > 0;
    // Fail closed: an unattributed advisory counts as shipping.
    const shippingOwners = owners.filter((w) => !isNonShipping(w));
    const shipping = !attributed || shippingOwners.length > 0;

    // Reconcile the two lenses pessimistically. `full` is absent when the second audit
    // was not supplied, or when that lens does not see this package at all.
    const full = fullVulns ? fullVulns[name] : undefined;
    const severity = full
      ? worseSeverity(String(v.severity || 'unknown'), String(full.severity || 'unknown'))
      : String(v.severity || 'unknown');

    const fa = v.fixAvailable;
    const faFull = full ? full.fixAvailable : undefined;
    // A fix is only "patch-compatible" if EVERY lens that can see it agrees.
    const majorOf = (x) => x && typeof x === 'object' && x.isSemVerMajor === true;
    const authoritative = majorOf(faFull) ? faFull : majorOf(fa) ? fa : (faFull ?? fa);
    const fix =
      authoritative === true
        ? 'patch-compatible'
        : authoritative && typeof authoritative === 'object'
          ? `${authoritative.name}@${authoritative.version}${authoritative.isSemVerMajor ? ' [SEMVER-MAJOR]' : ''}`
          : 'none';
    // DERIVED fix feasibility — authoritative over `fixAvailable`, which is a second copy
    // of a truth the advisory range already owns and which drifts (see
    // deriveFixFeasibility). Prefer the prod-lens range; fall back to the full-tree lens.
    const vulnerableRange =
      typeof v.range === 'string' && v.range.trim()
        ? v.range
        : full && typeof full.range === 'string'
          ? full.range
          : '';
    const fixFeasibility = {
      ...deriveFixFeasibility(vulnerableRange, installed.get(name) || []),
      vulnerableRange,
    };

    // Fail closed on BOTH inputs: a fix is patch-compatible only when the lenses agree it
    // is AND the range derivation proves a compatible version actually escapes. `undetermined`
    // therefore reads as not-patch-compatible — never as the optimistic answer.
    const lensSaysCompatible = authoritative === true;
    const patchCompatible = lensSaysCompatible && fixFeasibility.verdict === 'escapable';

    // Visible when a lens claimed a compatible fix that a stricter reading contradicts.
    // The two-lens disagreement is reported first because it names a concrete version; the
    // derivation catches the case that reconciliation structurally cannot see (bare `true`).
    const fixDisagreement =
      fa === true && majorOf(faFull)
        ? `--omit=dev said patch-compatible; installed tree requires ${faFull.name}@${faFull.version} (MAJOR)`
        : lensSaysCompatible && fixFeasibility.verdict !== 'escapable'
          ? `npm reported fixAvailable:true, but the advisory range says otherwise — ${fixFeasibility.reason}`
          : null;

    findings.push({
      name,
      severity,
      owners,
      attributed,
      shipping,
      shippingOwners,
      gating: shipping && GATING_SEVERITIES.has(severity),
      fix,
      patchCompatible,
      fixFeasibility,
      disposition:
        fixFeasibility.verdict === 'undetermined'
          ? 'undetermined'
          : patchCompatible
            ? 'patch-eligible'
            : 'deferred-semver-major',
      ...(fixDisagreement ? { fixDisagreement } : {}),
    });
  }

  const accepted = new Set(baseline?.accepted || []);
  const gating = findings.filter((f) => f.gating);
  const offenders = gating.filter((f) => !accepted.has(f.name));
  // Shrink-only bookkeeping: a baseline entry that no longer gates is now fixed.
  const stale = [...accepted].filter((n) => !gating.some((f) => f.name === n));

  /**
   * PIN the curated dispositions against the derivation — rung 2 of CLAUDE.md's
   * derived-truth ladder, with a stated reason why rung 1 does not apply here.
   *
   * A baseline entry's `disposition` describes measurable reality, so it drifts; the
   * obvious repair is to DERIVE it outright and delete the stored copy. That would be
   * wrong, and the langsmith row measured 2026-09-05 shows why: `npm audit --omit=dev`
   * reports it vulnerable over `<=0.5.26` while the prod `npm ls` tree contains only the
   * clean 0.8.7, so the derivation is honestly UNDETERMINED where a human has real
   * evidence about a dev-reachable copy. Deriving would silently DOWNGRADE a correct
   * judgment to "unknown".
   *
   * So the stored disposition stays curated and the derivation POLICES it. The two
   * outcomes are deliberately different: `contradicted` means the derivation measured
   * something and it disagrees — the case that silently reverted twice on 2026-09-05, and
   * the one worth a reviewer's attention. `uncorroborated` means the derivation could not
   * measure at all, which is a gap in the instrument, never evidence against the entry.
   */
  const dispositionDrift = gating
    .filter((f) => {
      const stored = baseline?.entries?.[f.name]?.disposition;
      return typeof stored === 'string' && stored !== f.disposition;
    })
    .map((f) => ({
      name: f.name,
      stored: baseline.entries[f.name].disposition,
      derived: f.disposition,
      kind: f.disposition === 'undetermined' ? 'uncorroborated' : 'contradicted',
      reason: f.fixFeasibility.reason,
    }));

  return {
    total: findings.length,
    findings,
    gating,
    offenders,
    stale,
    dispositionDrift,
    unattributed: findings.filter((f) => !f.attributed).map((f) => f.name),
    nonShippingOnly: findings.filter((f) => f.attributed && !f.shipping).length,
  };
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return { accepted: [], note: 'no baseline file' };
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch (err) {
    throw new Error(`baseline at ${BASELINE_PATH} is unreadable: ${err.message}`);
  }
}

/** Synchronous sleep — this whole gate is sync, so a promise-based delay is unusable here. */
function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * UNDETERMINED, NOT CLEAN, AND NOT RED — the third verdict this gate has to be able to say.
 *
 * `npm audit` is the one input here that needs the network. A registry timeout produces no
 * parseable payload, and there are exactly two wrong ways to handle that:
 *
 *   - treat it as "no advisories" — an empty result from a bounded instrument read as a
 *     negative finding, the failure this repo names everywhere; or
 *   - treat it as an ordinary red — which, once this gate is wired into the fleet
 *     green-checkpoint, red-pins `main` for ~100 agents over a network blip, and reads to
 *     the triager exactly like "a new shipping high/critical advisory landed". Those two
 *     need OPPOSITE responses (re-run vs. patch a dependency), so they must not look alike.
 *
 * So: retry the transient case a bounded number of times, and if it still cannot be
 * measured, fail CLOSED but say so in a way nobody can misread — the thrown message leads
 * with ADVISORY_GATE_UNDETERMINED and names the re-run as the fix.
 *
 * @param {string} label                     human name of the measurement, for the message
 * @param {() => string | undefined} attempt  performs one measurement, returning raw stdout
 * @param {{ attempts?: number, delaysMs?: number[], sleep?: (ms: number) => void }} [opts]
 * @returns {any} the parsed payload
 */
export function measureJson(label, attempt, opts = {}) {
  const attempts = opts.attempts ?? 3;
  const delaysMs = opts.delaysMs ?? [1000, 3000];
  const sleep = opts.sleep ?? sleepSync;
  let last = 'no attempt was made';
  for (let i = 0; i < attempts; i++) {
    if (i > 0) sleep(delaysMs[Math.min(i - 1, delaysMs.length - 1)]);
    let out;
    try {
      out = attempt();
    } catch (err) {
      // npm exits non-zero for advisory findings and dependency-tree problems. Keep valid
      // JSON stdout so the caller can inspect it; npm ls validates its problems before any
      // audit or advisory analysis runs.
      out = err && err.stdout;
    }
    if (!out || !String(out).trim()) {
      last = 'produced no output';
      continue;
    }
    try {
      return JSON.parse(String(out));
    } catch (err) {
      last = `output was not JSON (${err.message})`;
    }
  }
  throw new Error(
    `ADVISORY_GATE_UNDETERMINED: ${label} could not be measured after ${attempts} attempt(s) — ${last}. ` +
      'This is a MEASUREMENT failure, not an advisory finding: nothing about the dependency tree ' +
      'changed and no new advisory was detected. Re-run the gate; if it keeps failing, npm cannot ' +
      'reach the registry from this host.',
  );
}

function runJson(args, label) {
  return measureJson(label, () =>
    execFileSync('npm', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }),
  );
}

function assertNpmTreeIntegrity(lsTree) {
  if (!lsTree || typeof lsTree !== 'object' || Array.isArray(lsTree)) {
    throw new Error(
      'ADVISORY_GATE_UNDETERMINED: npm ls did not return a dependency-tree object. ' +
        'This is a measurement failure; no STALE or disposition-drift conclusion is trustworthy.',
    );
  }

  const problems = lsTree.problems;
  if (problems === undefined) return;
  if (!Array.isArray(problems)) {
    throw new Error(
      'ADVISORY_GATE_UNDETERMINED: npm ls returned malformed dependency-tree problems metadata. ' +
        'This is a measurement failure; no STALE or disposition-drift conclusion is trustworthy.',
    );
  }
  if (problems.length === 0) return;

  const shown = problems.slice(0, 5).map((problem) => String(problem)).join('; ');
  const omitted = problems.length > 5 ? '; and ' + (problems.length - 5) + ' more' : '';
  throw new Error(
    'ADVISORY_GATE_UNDETERMINED: npm ls reported ' +
      problems.length +
      ' dependency-tree problem(s): ' +
      shown +
      omitted +
      '. The graph may be incomplete; reconcile manifests, lockfile, and install state before trusting STALE or disposition-drift results.',
  );
}

// ── self-test: prove the analyzer discriminates, on inline fixtures ──────────────
// A guard that has never failed is a guard nobody has tested. These controls stay in the
// file permanently and mutate nothing on disk.
function selfTest() {
  const results = [];
  const check = (label, cond) => {
    results.push({ label, pass: !!cond });
  };

  const ls = {
    dependencies: {
      '@papercusp/web': {
        resolved: 'file:apps/web',
        dependencies: { 'evil-shipped': { version: '1.0.0' } },
      },
      '@papercusp/testing-shell': {
        resolved: 'file:libs/testing-shell',
        dependencies: { 'evil-testonly': { version: '1.0.0' } },
      },
    },
  };
  const audit = {
    vulnerabilities: {
      'evil-shipped': { severity: 'high', fixAvailable: true },
      'evil-testonly': { severity: 'high', fixAvailable: true },
      'evil-orphan': { severity: 'critical', fixAvailable: false },
      'noisy-moderate': { severity: 'moderate', fixAvailable: true },
    },
  };

  const r = analyze(audit, ls, { accepted: [] });
  const byName = Object.fromEntries(r.findings.map((f) => [f.name, f]));

  // POSITIVE control — a shipping high advisory must be caught.
  check('catches a shipping high advisory', r.offenders.some((o) => o.name === 'evil-shipped'));
  check('attributes it to its workspace', byName['evil-shipped'].owners.includes('@papercusp/web'));

  // NEGATIVE control — a non-shipping one must NOT gate (else the gate is noise).
  check('does not gate a non-shipping advisory', !r.offenders.some((o) => o.name === 'evil-testonly'));
  check('still records the non-shipping one', byName['evil-testonly'].attributed === true);

  // FAIL-CLOSED control — an unattributable advisory must gate, not vanish.
  check('fails closed on an unattributed advisory', r.offenders.some((o) => o.name === 'evil-orphan'));
  check('reports the measurement gap', r.unattributed.includes('evil-orphan'));

  // SEVERITY control — moderate must not gate.
  check('does not gate a moderate advisory', !r.offenders.some((o) => o.name === 'noisy-moderate'));

  // BASELINE control — an accepted entry stops gating, and a fixed one is reported stale.
  const r2 = analyze(audit, ls, { accepted: ['evil-shipped', 'evil-orphan', 'already-fixed'] });
  check('baseline suppresses an accepted offender', !r2.offenders.some((o) => o.name === 'evil-shipped'));
  check('reports a stale baseline entry', r2.stale.includes('already-fixed'));

  // TWO-LENS controls — regression guard for the style-dictionary miss (2026-09-05).
  // The prod-only lens called it patch-compatible; the installed tree required a MAJOR
  // bump. Reporting the optimistic reading sends an agent to attempt an impossible fix.
  const fullAudit = {
    vulnerabilities: {
      // Same package, the two lenses disagreeing exactly as npm really did.
      'evil-shipped': {
        severity: 'high',
        fixAvailable: { name: 'evil-shipped', version: '5.5.2', isSemVerMajor: true },
      },
      // Severity understated by the prod-only lens.
      'noisy-moderate': { severity: 'critical', fixAvailable: true },
    },
  };
  const r3 = analyze(audit, ls, { accepted: [] }, fullAudit);
  const by3 = Object.fromEntries(r3.findings.map((f) => [f.name, f]));

  check('a major fix in the installed tree overrides a compatible prod-only fix', by3['evil-shipped'].patchCompatible === false);
  check('reports the overriding fix version', by3['evil-shipped'].fix.includes('5.5.2') && by3['evil-shipped'].fix.includes('SEMVER-MAJOR'));
  check('surfaces the lens disagreement', typeof by3['evil-shipped'].fixDisagreement === 'string');
  check('takes the worse severity of the two lenses', by3['noisy-moderate'].severity === 'critical');
  check('worse severity can promote a finding into the gate', r3.offenders.some((o) => o.name === 'noisy-moderate'));
  // A package only the prod-only lens sees keeps its own reading rather than vanishing.
  check('keeps a finding absent from the full-tree lens', by3['evil-orphan'].fix === 'none');
  // CALIBRATION for the two-lens controls — without the second lens these MUST differ,
  // or the controls above would pass no matter what analyze() did.
  check('single-lens reading really is the optimistic one', byName['evil-shipped'].patchCompatible === true && byName['noisy-moderate'].severity === 'moderate');

  // CALIBRATION — the controls above must not all pass vacuously.
  check('analyzer actually produced findings', r.total === 4);

  const failed = results.filter((x) => !x.pass);
  for (const x of results) console.log(`${x.pass ? 'ok  ' : 'FAIL'} ${x.label}`);
  if (failed.length) {
    console.error(`\nself-test FAILED: ${failed.length}/${results.length}`);
    process.exit(1);
  }
  console.log(`\nself-test passed: ${results.length}/${results.length} controls`);
}

function main() {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const valueOf = (f) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : null;
  };

  if (has('--self-test')) return selfTest();

  const auditPath = valueOf('--audit-json');
  const lsPath = valueOf('--ls-json');
  const fullAuditPath = valueOf('--full-audit-json');
  const ls = lsPath
    ? JSON.parse(readFileSync(lsPath, 'utf8'))
    : runJson(['ls', '--omit=dev', '--all', '--json'], 'npm ls');
  // A parseable npm ls response can still be incomplete: npm emits JSON with exit status 1
  // and a problems[] list for invalid/missing/extraneous dependency edges. Refuse that graph
  // before running either audit lens or allowing it to produce STALE/drift conclusions.
  assertNpmTreeIntegrity(ls);

  const audit = auditPath
    ? JSON.parse(readFileSync(auditPath, 'utf8'))
    : runJson(['audit', '--omit=dev', '--json'], 'npm audit');
  // Second lens: the tree as actually installed. Fix feasibility is judged here (see
  // analyze()). Never fatal — if it cannot be read we fall back to the single-lens
  // reading, which is optimistic about fixes but still gates on the same population.
  let fullAudit = null;
  try {
    fullAudit = fullAuditPath
      ? JSON.parse(readFileSync(fullAuditPath, 'utf8'))
      : runJson(['audit', '--json'], 'npm audit (full tree)');
  } catch {
    fullAudit = null;
  }

  const baseline = loadBaseline();
  const r = analyze(audit, ls, baseline, fullAudit);
  if (!fullAudit) {
    console.warn('warn: full-tree audit unavailable — fix feasibility is the optimistic --omit=dev reading');
  }

  if (has('--json')) {
    console.log(JSON.stringify(r, null, 2));
  } else if (has('--list')) {
    // The re-seed surface: the measured gating population, for the baseline file. The
    // DERIVED disposition is printed here so a re-seed copies a measurement rather than
    // re-deriving one by hand — the exact hand-maintenance that drifted twice on
    // 2026-09-05. An `undetermined` row is the one a human must still adjudicate.
    for (const f of r.gating.sort((a, b) => a.name.localeCompare(b.name))) {
      console.log(
        `${f.severity.padEnd(9)} ${f.name.padEnd(34)} ${f.disposition.padEnd(22)} fix=${f.fix} owners=${f.owners.join(',') || 'UNATTRIBUTED'}`,
      );
      console.log(`${''.padEnd(10)}range=${f.fixFeasibility.vulnerableRange || '(none)'} — ${f.fixFeasibility.reason}`);
    }
    console.log(`\n${r.gating.length} gating (shipping high/critical) of ${r.total} total advisories`);
  } else {
    console.log(`advisories: ${r.total} total`);
    console.log(`  gating (shipping high/critical): ${r.gating.length}`);
    console.log(`  non-shipping only (reported, not gated): ${r.nonShippingOnly}`);
    console.log(`  unattributed (failed closed as shipping): ${r.unattributed.length}`);
    console.log(`  baselined: ${(baseline.accepted || []).length}   NEW offenders: ${r.offenders.length}`);
    if (r.offenders.length) {
      console.log('\nNEW un-baselined shipping high/critical advisories:');
      for (const o of r.offenders) {
        console.log(`  ${o.severity.toUpperCase()} ${o.name} fix=${o.fix} owners=${o.owners.join(',') || 'UNATTRIBUTED'}`);
      }
    }
    if (r.stale.length) {
      console.log(`\nSTALE baseline entries (advisory resolved — remove them, the baseline is shrink-only):`);
      for (const s of r.stale) console.log(`  ${s}`);
    }
    const contradicted = r.dispositionDrift.filter((d) => d.kind === 'contradicted');
    const uncorroborated = r.dispositionDrift.filter((d) => d.kind === 'uncorroborated');
    if (contradicted.length) {
      // Greppable on purpose: this is the signal that a curated disposition has gone
      // stale under third-party data movement, which is silent by construction.
      console.log(`\nADVISORY_DISPOSITION_DRIFT: ${contradicted.length} baseline entry(ies) the range derivation contradicts:`);
      for (const d of contradicted) {
        console.log(`  ${d.name}: baseline says ${d.stored}, derived ${d.derived} — ${d.reason}`);
      }
      console.log('  Re-adjudicate the entry (or its reason) — do not edit the derivation to agree with it.');
    }
    if (uncorroborated.length) {
      // NOT drift: the instrument could not measure. Reported separately so it can never
      // be mistaken for evidence against a curated entry.
      console.log(`\nUNCORROBORATED dispositions (derivation could not measure — the entry stands):`);
      for (const d of uncorroborated) console.log(`  ${d.name}: ${d.reason}`);
    }
  }

  if (has('--strict') && r.offenders.length) {
    console.error(
      `\ncheck-reachable-advisories: ${r.offenders.length} NEW shipping high/critical advisory(ies). ` +
        `Patch it, or — only with a stated reason — add it to ${BASELINE_PATH}.`,
    );
    process.exit(1);
  }
}

// Only run as a CLI; importing for tests must not execute.
if (isCliEntry(import.meta.url)) main();
