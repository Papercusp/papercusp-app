#!/usr/bin/env node
/**
 * Rust / native advisory gate — the sibling of scripts/check-reachable-advisories.mjs.
 * Plan security-boundary-remediation-and-usability-2026-09-04, P-007 / WI-2144851.
 *
 * WHY THIS EXISTS
 * docs/audits/security-usability-2026-09-04.md:170 asks to "inventory shipped JS/Rust
 * artifacts ... and add advisory/SBOM checks to the existing verification pipeline", and
 * closes with: "Rust dependency and native-binary advisory scans were not run in this
 * audit." The npm gate covers the JS half well and the Rust half NOT AT ALL — measured
 * 2026-09-05: 0 occurrences of cargo/rust/crate in check-reachable-advisories.mjs, while
 * papercusp-desktop/src-tauri/Cargo.lock pins 615 crates into the SHIPPED desktop app.
 *
 * WHY OSV.dev AND NOT `cargo audit`
 * cargo-audit is not installed here and would add a per-host binary the gate silently
 * depends on (`cargo audit --version` -> "no such command: audit"). OSV.dev aggregates the
 * same RustSec advisory database over plain HTTP, so the gate needs nothing but node —
 * the same reproducibility property that lets the npm gate rely only on `npm`.
 *
 * ────────────────────────────────────────────────────────────────────────────────────
 * THE DESIGN DECISION THAT MATTERS: SEVERITY IS NOT THE DISCRIMINATOR HERE
 *
 * The npm gate keys on high/critical CVSS. Copying that model to Rust produces a gate
 * that reports a confident green while measuring NOTHING. MEASURED against the real
 * shipped lockfile on 2026-09-05 — 22 advisories over 615 crates:
 *
 *     informational=unmaintained  17   severity:[]  cvss:null
 *     informational=unsound        2   severity:[]  cvss:null
 *     (none — a real vulnerability) 3   2 of them CVSS 7.5 HIGH
 *
 * EVERY RustSec advisory carried `severity: []` and `cvss: null`. A high/critical filter
 * over that population selects zero rows and prints "0 gating" — indistinguishable from
 * a clean tree. That is the same class of failure CLAUDE.md catalogues (a suite matching
 * zero tests, `pgrep -q`, a wrong-relation SQL zero-row): an instrument that reports
 * success because it measured nothing.
 *
 * So the discriminator is `affected[].database_specific.informational`:
 *   - present ("unmaintained" / "unsound" / "notice") -> a MAINTENANCE signal. Reported
 *     with a count, never gating. 17 unmaintained gtk-rs/unic crates must not red-pin the
 *     fleet.
 *   - absent -> a real VULNERABILITY -> GATES unless baselined.
 *
 * We gate on a vulnerability at ANY severity rather than high/critical, precisely because
 * RustSec routinely ships no CVSS vector: a severity threshold would silently drop every
 * uncscored vulnerability into the "not gated" bucket. Severity is still derived and
 * printed, because a reviewer needs it — it is context, not the gate condition.
 *
 * ALIAS CLUSTERING, FAIL-CLOSED
 * The same defect can appear twice under different ids AND different classifications.
 * MEASURED: glib@0.18.5 is both GHSA-wrw7-89jp-8q8g (a vulnerability, GHSA "MODERATE")
 * and RUSTSEC-2024-0429 (informational "unsound") — mutual aliases describing one issue.
 * Counting them separately double-reports; trusting whichever arrives first makes the
 * verdict depend on OSV's response order. Advisories are therefore clustered by `aliases`
 * and a cluster is a VULNERABILITY if ANY member is non-informational — the fail-closed
 * direction, matching attributeAdvisories() in the npm gate.
 *
 * Baseline (scripts/rust-advisories-baseline.json) is SHRINK-ONLY, exactly like
 * KNOWN_DARK_FLAGS and the npm gate's: fixing an advisory removes its entry, and a
 * still-listed-but-resolved entry is reported STALE. Re-seed only from `--list`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(ROOT, 'scripts', 'rust-advisories-baseline.json');

/**
 * The lockfiles whose crates actually SHIP, and therefore gate.
 *
 * There are 7 Cargo.lock files in this tree; only the Tauri desktop app is the shipped
 * product artifact. The rest (apps/tui, the pui-* helpers, vendored tao/wry, and the
 * libs/papercusp desktop copy) are dev/vendored surfaces — the direct analog of the npm
 * gate's NON_SHIPPING_WORKSPACES. Scanning them is supported (--lock) and REPORTED, but
 * only a shipped lockfile can produce a gating offender.
 */
export const SHIPPED_LOCKFILES = ['papercusp-desktop/src-tauri/Cargo.lock'];

const OSV_BATCH_URL = 'https://api.osv.dev/v1/querybatch';
const OSV_VULN_URL = 'https://api.osv.dev/v1/vulns/';
/** OSV documents this endpoint's page size at 1000; 200 keeps each request small. */
const BATCH_SIZE = 200;

/**
 * Parse a Cargo.lock into {name, version} records.
 *
 * Cargo.lock is a generated, highly regular TOML document: a flat sequence of
 * [[package]] tables each carrying `name` and `version` as bare top-level keys. Parsing
 * it with two anchored regexes per block avoids adding a TOML dependency to a security
 * gate — but the parser must never SILENTLY return fewer packages than the file holds,
 * because an under-parse is exactly the "measured nothing" failure this gate exists to
 * avoid. The caller checks the count against the [[package]] header count and refuses on
 * a mismatch (see parseCargoLockStrict).
 */
export function parseCargoLock(text) {
  const packages = [];
  for (const block of String(text).split(/^\[\[package\]\]\s*$/m).slice(1)) {
    // Anchored to line start so a `name = ` inside a dependencies list cannot match.
    const name = /^name = "(.+)"$/m.exec(block)?.[1];
    const version = /^version = "(.+)"$/m.exec(block)?.[1];
    if (name && version) packages.push({ name, version });
  }
  return packages;
}

/** Header count of [[package]] tables — the independent control for parseCargoLock. */
export function countPackageHeaders(text) {
  return (String(text).match(/^\[\[package\]\]\s*$/gm) ?? []).length;
}

/**
 * parseCargoLock plus its own falsifier. A lockfile whose [[package]] count and parsed
 * count disagree means the regex missed real packages; refusing is the only safe move,
 * since the alternative is scanning a subset and reporting it as the whole graph.
 */
export function parseCargoLockStrict(text, label = 'Cargo.lock') {
  const packages = parseCargoLock(text);
  const headers = countPackageHeaders(text);
  if (packages.length !== headers) {
    throw new Error(
      `RUST_ADVISORY_GATE_UNDETERMINED: ${label} has ${headers} [[package]] tables but only ` +
        `${packages.length} parsed. Refusing to scan a partial graph.`,
    );
  }
  if (headers === 0) {
    throw new Error(`RUST_ADVISORY_GATE_UNDETERMINED: ${label} contains no [[package]] tables.`);
  }
  return packages;
}

/* ───────────────────────────── CVSS v3.1 base score ─────────────────────────────
 * Implemented rather than imported so the gate keeps its zero-dependency property.
 * This is REPORTING context only — never the gate condition (see the header). It is
 * still worth being exact: a wrong number in a security report is worse than none.
 * Spec: FIRST CVSS v3.1 §7.1.
 */
const AV = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
const AC = { L: 0.77, H: 0.44 };
const PR_U = { N: 0.85, L: 0.62, H: 0.27 };
const PR_C = { N: 0.85, L: 0.68, H: 0.5 };
const UI = { N: 0.85, R: 0.62 };
const CIA = { H: 0.56, L: 0.22, N: 0 };

/** Spec roundup: smallest 1-decimal number >= x, computed integer-wise to dodge FP drift. */
function roundUp1(x) {
  const i = Math.round(x * 100000);
  return i % 10000 === 0 ? i / 100000 : (Math.floor(i / 10000) + 1) / 10;
}

export function cvss31BaseScore(vector) {
  const m = Object.fromEntries(
    String(vector)
      .split('/')
      .map((p) => p.split(':'))
      .filter((p) => p.length === 2),
  );
  if (!m.AV || !m.AC || !m.PR || !m.UI || !m.S || !m.C || !m.I || !m.A) return null;
  const changed = m.S === 'C';
  const av = AV[m.AV];
  const ac = AC[m.AC];
  const pr = (changed ? PR_C : PR_U)[m.PR];
  const ui = UI[m.UI];
  const c = CIA[m.C];
  const i = CIA[m.I];
  const a = CIA[m.A];
  if ([av, ac, pr, ui, c, i, a].some((v) => v === undefined)) return null;

  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = changed
    ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15)
    : 6.42 * iss;
  if (impact <= 0) return 0;
  const exploitability = 8.22 * av * ac * pr * ui;
  const raw = changed
    ? Math.min(1.08 * (impact + exploitability), 10)
    : Math.min(impact + exploitability, 10);
  return roundUp1(raw);
}

export function severityLabelForScore(score) {
  if (score === null || score === undefined) return 'unknown';
  if (score === 0) return 'none';
  if (score < 4) return 'low';
  if (score < 7) return 'moderate';
  if (score < 9) return 'high';
  return 'critical';
}

/**
 * Classify ONE OSV document.
 *
 * `informational` lives on the affected[] entries, not the top level — that is where
 * RustSec puts it in its OSV export, and reading only the top level is how every
 * unmaintained notice would be misread as a vulnerability.
 */
export function classifyVuln(vuln) {
  const informational =
    (vuln?.affected ?? [])
      .map((a) => a?.database_specific?.informational)
      .find((v) => typeof v === 'string' && v) ?? null;

  const vectors = (vuln?.severity ?? [])
    .filter((s) => s && typeof s.score === 'string')
    .map((s) => ({ type: s.type, score: s.score }));
  const v3 = vectors.find((s) => s.type === 'CVSS_V3');
  const cvssScore = v3 ? cvss31BaseScore(v3.score) : null;

  // GHSA states a severity word directly; RustSec does not. Prefer a computed CVSS v3
  // score, fall back to GHSA's word, else unknown (which still GATES — see header).
  const ghsa = String(vuln?.database_specific?.severity ?? '').toLowerCase() || null;
  const severity =
    cvssScore !== null
      ? severityLabelForScore(cvssScore)
      : ghsa === 'moderate' || ghsa === 'medium'
        ? 'moderate'
        : ghsa || 'unknown';

  return {
    id: vuln?.id ?? null,
    informational,
    severity,
    cvssScore,
    cvssVector: v3?.score ?? vectors[0]?.score ?? null,
    withdrawn: vuln?.withdrawn ?? null,
    aliases: Array.isArray(vuln?.aliases) ? vuln.aliases : [],
    summary: String(vuln?.summary ?? '').replace(/\s+/g, ' ').trim(),
    fixedVersions: fixedVersionsOf(vuln),
  };
}

/** The `fixed` events across every range — what a reviewer needs to judge patchability. */
export function fixedVersionsOf(vuln) {
  const fixed = new Set();
  for (const a of vuln?.affected ?? []) {
    for (const r of a?.ranges ?? []) {
      for (const e of r?.events ?? []) if (e?.fixed) fixed.add(String(e.fixed));
    }
  }
  return [...fixed].sort();
}

/**
 * Group advisories that describe ONE defect, via mutual `aliases`.
 *
 * Union-find over the alias graph. The cluster's verdict is fail-closed: informational
 * only if EVERY member is informational, so the glib case (vulnerability + "unsound"
 * describing one issue) resolves to vulnerability regardless of arrival order.
 */
export function clusterAliases(classified) {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const c of classified) {
    find(c.id);
    for (const alias of c.aliases) union(c.id, alias);
  }

  const groups = new Map();
  for (const c of classified) {
    const root = find(c.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(c);
  }

  return [...groups.values()].map((members) => {
    // Deterministic primary id regardless of OSV ordering: RUSTSEC first (the
    // ecosystem-native identifier a Rust reviewer will recognise), else lexicographic.
    const ids = members.map((m) => m.id).sort();
    const primary = ids.find((i) => i.startsWith('RUSTSEC-')) ?? ids[0];
    const nonInformational = members.filter((m) => !m.informational);
    const worst = members
      .map((m) => m.cvssScore)
      .filter((s) => typeof s === 'number')
      .sort((a, b) => b - a)[0];
    const severity =
      worst !== undefined
        ? severityLabelForScore(worst)
        : (nonInformational[0] ?? members[0]).severity;
    return {
      id: primary,
      ids,
      // Fail closed: any member classified as a real vulnerability makes the cluster one.
      informational: nonInformational.length ? null : members[0].informational,
      severity,
      cvssScore: worst ?? null,
      summary: (nonInformational[0] ?? members[0]).summary,
      fixedVersions: [...new Set(members.flatMap((m) => m.fixedVersions))].sort(),
      withdrawn: members.every((m) => m.withdrawn) ? members[0].withdrawn : null,
    };
  });
}

/**
 * The pure analyzer: OSV documents + the crates they were matched against + baseline
 * -> the gate verdict. No network, so every case is testable on inline fixtures.
 *
 * @param {object}  input
 * @param {Array}   input.packages   [{name, version}] actually scanned
 * @param {Array}   input.vulns      raw OSV vulnerability documents
 * @param {Map|object} input.matches id -> ["crate@version", ...]
 * @param {object}  input.baseline   { accepted: string[] }
 * @param {boolean} [input.shipped]  whether the scanned lockfile is a shipped artifact
 *   (default true). Bracketed because it HAS a default: without the brackets the emitted
 *   .d.mts declares it required and every caller that relies on the default fails to
 *   typecheck — invisible to vitest, which never typechecks.
 */
export function analyze({ packages, vulns, matches, baseline, shipped = true }) {
  // Fail closed on a measurement gap. An empty package list with advisories present, or
  // no packages at all, is an instrument failure — never an all-clear.
  if (!Array.isArray(packages) || packages.length === 0) {
    throw new Error(
      'RUST_ADVISORY_GATE_UNDETERMINED: no crates were scanned. Refusing to report all-clear.',
    );
  }

  const matchMap = matches instanceof Map ? matches : new Map(Object.entries(matches ?? {}));
  const classified = (vulns ?? []).map(classifyVuln).filter((c) => c.id && !c.withdrawn);
  const clusters = clusterAliases(classified);

  const accepted = new Set(baseline?.accepted ?? []);
  const withWhere = clusters.map((c) => ({
    ...c,
    // A cluster's crates are the union over every id it absorbed.
    where: [...new Set(c.ids.flatMap((id) => matchMap.get(id) ?? []))].sort(),
  }));

  const vulnerabilities = withWhere.filter((c) => !c.informational);
  const informational = withWhere.filter((c) => c.informational);

  // A cluster is baselined if ANY of its ids is listed — an entry seeded under a GHSA id
  // must keep suppressing the same defect after OSV starts returning its RUSTSEC alias.
  const isAccepted = (c) => c.ids.some((id) => accepted.has(id));

  const gating = shipped ? vulnerabilities : [];
  const offenders = gating.filter((c) => !isAccepted(c));
  const liveIds = new Set(withWhere.flatMap((c) => c.ids));
  const stale = [...accepted].filter((id) => !liveIds.has(id));

  return {
    scanned: packages.length,
    shipped,
    total: withWhere.length,
    vulnerabilities,
    informational,
    informationalCount: informational.length,
    gating,
    offenders,
    baselined: gating.filter(isAccepted).map((c) => c.id),
    stale,
  };
}

/* ───────────────────────────────── network layer ───────────────────────────────── */

async function fetchJson(url, init, label, attempts = 3) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  // Distinct, greppable prefix so a triager can tell "re-run this" from "patch a crate"
  // without reading this source — the same contract as ADVISORY_GATE_UNDETERMINED.
  throw new Error(`RUST_ADVISORY_GATE_UNDETERMINED: ${label} failed after ${attempts} attempts: ${lastErr?.message}`);
}

/** Query OSV for every crate, then hydrate each distinct advisory id. */
export async function fetchAdvisories(packages) {
  const matches = new Map();
  for (let i = 0; i < packages.length; i += BATCH_SIZE) {
    const chunk = packages.slice(i, i + BATCH_SIZE);
    const body = JSON.stringify({
      queries: chunk.map((p) => ({
        package: { name: p.name, ecosystem: 'crates.io' },
        version: p.version,
      })),
    });
    const { results } = await fetchJson(
      OSV_BATCH_URL,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body },
      'OSV querybatch',
    );
    if (!Array.isArray(results) || results.length !== chunk.length) {
      throw new Error(
        `RUST_ADVISORY_GATE_UNDETERMINED: OSV returned ${results?.length} results for ${chunk.length} queries.`,
      );
    }
    results.forEach((r, j) => {
      for (const v of r?.vulns ?? []) {
        if (!matches.has(v.id)) matches.set(v.id, []);
        matches.get(v.id).push(`${chunk[j].name}@${chunk[j].version}`);
      }
    });
  }

  const vulns = [];
  for (const id of matches.keys()) {
    vulns.push(await fetchJson(OSV_VULN_URL + encodeURIComponent(id), {}, `OSV vulns/${id}`));
  }
  return { vulns, matches };
}

function loadBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    return { accepted: [], entries: {} };
  }
}

/* ─────────────────────────────────── self test ─────────────────────────────────── */

function selfTest() {
  const fail = (m) => {
    console.error('SELF-TEST FAIL: ' + m);
    process.exitCode = 1;
  };

  const lock = `# comment\n[[package]]\nname = "a"\nversion = "1.0.0"\ndependencies = [\n "b",\n]\n\n[[package]]\nname = "b"\nversion = "2.0.0"\n`;
  const pkgs = parseCargoLock(lock);
  if (pkgs.length !== 2) fail(`parseCargoLock got ${pkgs.length}, want 2`);
  if (countPackageHeaders(lock) !== 2) fail('countPackageHeaders mismatch');

  // The exact vector measured on RUSTSEC-2026-0194.
  const s = cvss31BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H');
  if (s !== 7.5) fail(`cvss31BaseScore got ${s}, want 7.5`);
  if (severityLabelForScore(s) !== 'high') fail('severity label for 7.5 should be high');

  const vulnDoc = { id: 'RUSTSEC-X', affected: [{ ranges: [{ events: [{ fixed: '0.41.0' }] }] }] };
  if (classifyVuln(vulnDoc).informational !== null) fail('a vulnerability must not read as informational');
  const infoDoc = { id: 'RUSTSEC-Y', affected: [{ database_specific: { informational: 'unmaintained' } }] };
  if (classifyVuln(infoDoc).informational !== 'unmaintained') fail('unmaintained not detected');

  const r = analyze({
    packages: [{ name: 'a', version: '1' }],
    vulns: [vulnDoc, infoDoc],
    matches: { 'RUSTSEC-X': ['a@1'], 'RUSTSEC-Y': ['a@1'] },
    baseline: { accepted: [] },
  });
  if (r.offenders.length !== 1) fail(`want 1 offender, got ${r.offenders.length}`);
  if (r.informationalCount !== 1) fail('unmaintained should be reported, not gated');

  if (process.exitCode) return;
  console.log('check-rust-advisories self-test: OK');
}

/* ─────────────────────────────────────── CLI ─────────────────────────────────────── */

async function main() {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const valueOf = (f) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : null;
  };

  if (has('--self-test')) return selfTest();

  const lockArg = valueOf('--lock');
  const lockPath = lockArg ?? SHIPPED_LOCKFILES[0];
  const shipped = SHIPPED_LOCKFILES.includes(lockPath.replace(/\\/g, '/'));
  const text = readFileSync(join(ROOT, lockPath), 'utf8');
  const packages = parseCargoLockStrict(text, lockPath);

  // Offline fixture input, mirroring the npm gate's --audit-json: makes a full run
  // reproducible from a captured payload with no network. --dump-osv is its other half —
  // without a way to PRODUCE the payload, --osv-json would be a flag nobody can use.
  const osvPath = valueOf('--osv-json');
  const { vulns, matches } = osvPath
    ? JSON.parse(readFileSync(osvPath, 'utf8'))
    : await fetchAdvisories(packages);

  const dumpPath = valueOf('--dump-osv');
  if (dumpPath) {
    writeFileSync(
      dumpPath,
      JSON.stringify({ vulns, matches: Object.fromEntries(matches instanceof Map ? matches : new Map(Object.entries(matches ?? {}))) }, null, 2),
    );
    console.log(`wrote OSV payload for ${vulns.length} advisory document(s) to ${dumpPath}`);
  }

  const baseline = loadBaseline();
  const r = analyze({ packages, vulns, matches, baseline, shipped });

  if (has('--json')) {
    console.log(JSON.stringify(r, null, 2));
    return finish(r, has);
  }

  if (has('--list')) {
    // The re-seed surface for the baseline file — copy a MEASUREMENT, never a hand grep.
    for (const c of [...r.gating].sort((a, b) => a.id.localeCompare(b.id))) {
      console.log(
        `${c.severity.padEnd(9)} ${c.id.padEnd(20)} fixed=${(c.fixedVersions.join(',') || '(none)').padEnd(10)} ${c.where.join(' ')}`,
      );
      console.log(`${''.padEnd(10)}${c.summary}`);
    }
    console.log(`\n${r.gating.length} gating vulnerability(ies) of ${r.total} advisories over ${r.scanned} crates`);
    return finish(r, has);
  }

  console.log(`rust advisories: ${r.total} over ${r.scanned} crates in ${lockPath}${shipped ? '' : ' (NOT a shipped artifact — reported, not gated)'}`);
  console.log(`  vulnerabilities (gating): ${r.vulnerabilities.length}`);
  console.log(`  informational (unmaintained/unsound — reported, never gating): ${r.informationalCount}`);
  console.log(`  baselined: ${r.baselined.length}   NEW offenders: ${r.offenders.length}`);

  if (r.informationalCount) {
    // Printed rather than hidden: an unmaintained shipped crate is real debt, it is just
    // not a reason to fail a build.
    const byKind = {};
    for (const c of r.informational) byKind[c.informational] = (byKind[c.informational] ?? 0) + 1;
    console.log(`    ${Object.entries(byKind).map(([k, n]) => `${k}=${n}`).join(' ')}`);
  }
  if (r.offenders.length) {
    console.log('\nNEW un-baselined vulnerabilities in shipped Rust dependencies:');
    for (const o of r.offenders) {
      console.log(`  ${o.severity.toUpperCase()} ${o.id} ${o.where.join(' ')}`);
      console.log(`      ${o.summary}`);
      console.log(`      fixed in: ${o.fixedVersions.join(', ') || '(no fixed version published)'}`);
    }
  }
  if (r.stale.length) {
    console.log('\nSTALE baseline entries (advisory resolved — remove them, the baseline is shrink-only):');
    for (const s of r.stale) console.log(`  ${s}`);
  }
  return finish(r, has);
}

function finish(r, has) {
  if (has('--strict') && r.offenders.length) {
    console.error(
      `\ncheck-rust-advisories: ${r.offenders.length} NEW vulnerability(ies) in shipped Rust dependencies. ` +
        `Patch it, or — only with a stated reason — add it to ${BASELINE_PATH}.`,
    );
    process.exit(1);
  }
}

// Only run as a CLI; importing for tests must not execute.
if (isCliEntry(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(2);
  });
}
