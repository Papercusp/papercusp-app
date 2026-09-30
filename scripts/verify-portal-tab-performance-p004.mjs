#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [portalArg] = process.argv.slice(2);
if (!portalArg) {
  console.error('usage: node scripts/verify-portal-tab-performance-p004.mjs <portal-root>');
  process.exit(2);
}

const portalRoot = resolve(portalArg);
const readText = (path) => readFileSync(resolve(portalRoot, path), 'utf8');
const readJson = (path) => JSON.parse(readText(path));
const sha256 = (body) => createHash('sha256').update(body).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));

const currentPath = 'perf/p004-current-generation-2026-09-09.json';
const steadyPath = 'perf/steady-fullcycle-34tab-5cyc.json';
const projectionPath = 'perf/control-projection.json';
const contractsPath = 'packages/contracts/src/index.ts';
const probePath = 'scripts/perf-probe.mts';
const projectionScriptPath = 'scripts/measure-control-projection.mts';

const currentText = readText(currentPath);
const steadyText = readText(steadyPath);
const projectionText = readText(projectionPath);
const contractsText = readText(contractsPath);
const probeText = readText(probePath);
const projectionScriptText = readText(projectionScriptPath);
const current = JSON.parse(currentText);
const steady = JSON.parse(steadyText);
const projection = JSON.parse(projectionText);

const kindsBlock = /export const PORTAL_APP_KINDS = \[([\s\S]*?)\] as const;/.exec(contractsText)?.[1];
if (!kindsBlock) throw new Error('PORTAL_APP_KINDS block was not found');
// Count only literal array-entry lines. A quoted owner request in the comment
// above `overview` is explanatory prose, not a destination; scanning every
// quoted string in the block would turn that sentence into a phantom 35th app.
const contractKinds = [...kindsBlock.matchAll(/^\s*"([^"]+)",?\s*$/gm)].map((match) => match[1]);

const sameArray = (left, right) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const coverageOk = (artifact) => {
  const tabs = artifact.tabs.map((tab) => tab.kind);
  return (
    sameArray(tabs, contractKinds) &&
    new Set(tabs).size === tabs.length &&
    Array.isArray(artifact.skipped) &&
    artifact.skipped.length === 0 &&
    /import \{ PORTAL_APP_KINDS, DEFAULT_PORTAL_APPS \} from "@portal\/contracts"/.test(probeText) &&
    /: \[\.\.\.PORTAL_APP_KINDS\]/.test(probeText)
  );
};

const projectionOk = (artifact) => {
  const before = artifact.before?.bytes;
  const after = artifact.after?.bytes;
  const removed = artifact.removedBytes;
  const pct = artifact.removedPct;
  return (
    Number.isInteger(artifact.rowCount) &&
    artifact.rowCount > 0 &&
    Number.isInteger(before) &&
    Number.isInteger(after) &&
    before > after &&
    removed === before - after &&
    Math.abs(pct - (removed / before) * 100) < 0.1 &&
    /projectControlRows/.test(projectionScriptText) &&
    /workspace-hosts/.test(projectionScriptText)
  );
};

const journeysOk = (artifact) =>
  artifact.mode === 'both' &&
  artifact.repeats >= 3 &&
  artifact.tabs.every(
    (tab) =>
      tab.cold &&
      tab.warm &&
      tab.coldState &&
      tab.warmState &&
      tab.coldState !== tab.warmState &&
      !Object.hasOwn(tab.warm, 'firstContentfulPaint') &&
      !Object.hasOwn(tab.warm, 'largestContentfulPaint'),
  );

const coldMetrics = [
  'firstContentfulPaint',
  'largestContentfulPaint',
  'timeToContent',
  'totalBlockingTime',
  'longTaskCount',
  'longestTask',
  'scriptDuration',
  'transferredBytes',
  'jsHeapUsedMb',
];
const warmMetrics = coldMetrics.filter(
  (key) => key !== 'firstContentfulPaint' && key !== 'largestContentfulPaint',
);
const metricSetOk = (artifact, series) =>
  artifact.tabs.every(
    (tab) => coldMetrics.every((key) => Object.hasOwn(tab.cold, key)) &&
      warmMetrics.every((key) => Object.hasOwn(tab.warm, key)),
  ) &&
  series.VOID === false &&
  series.voidReason === null &&
  series.tabs.length === contractKinds.length &&
  series.cycles >= 3 &&
  series.snapshots.filter((snapshot) => /^cycle-\d+$/.test(snapshot.label)).length >= 3 &&
  series.controls?.timerControlPasses === true &&
  series.controls?.esControlPasses === true &&
  series.controls?.instrumentPresent === true;

const missingTab = clone(current);
missingTab.tabs.pop();
const invertedProjection = clone(projection);
invertedProjection.after.bytes = invertedProjection.before.bytes + 1;
const missingWarm = clone(current);
missingWarm.tabs[0].warm = null;
const missingMetric = clone(current);
delete missingMetric.tabs[0].cold.firstContentfulPaint;
const badControls = clone(steady);
badControls.controls.instrumentPresent = false;

const assertions = [
  {
    id: 'r1-contract-derived-complete-population',
    passed: coverageOk(current),
    evidence: `${current.tabs.length} artifact tabs match ${contractKinds.length} PORTAL_APP_KINDS in order, are unique, skipped is empty, and the probe imports/spreads the contract.`,
  },
  {
    id: 'r1-missing-destination-negative-control',
    passed: !coverageOk(missingTab),
    evidence: 'Removing one tab from an in-memory artifact copy makes the coverage predicate fail.',
  },
  {
    id: 'r2-measured-control-projection-delta',
    passed: projectionOk(projection),
    evidence: `${projection.rowCount} rows measure ${projection.before.bytes} -> ${projection.after.bytes} bytes (${projection.removedPct}% removed) through the shipped projectControlRows implementation.`,
  },
  {
    id: 'r2-inverted-delta-negative-control',
    passed: !projectionOk(invertedProjection),
    evidence: 'Making the after payload one byte larger than before in an in-memory copy makes the improvement predicate fail.',
  },
  {
    id: 'r3-cold-warm-journeys-separated',
    passed: journeysOk(current),
    evidence: `mode=${current.mode}, repeats=${current.repeats}; all ${current.tabs.length} tabs have separate cold/warm metrics and state, and warm correctly omits navigation-only FCP/LCP.`,
  },
  {
    id: 'r3-missing-warm-negative-control',
    passed: !journeysOk(missingWarm),
    evidence: 'Removing one warm journey from an in-memory copy makes the journey predicate fail.',
  },
  {
    id: 'r4-metric-set-and-full-cycle-controls',
    passed: metricSetOk(current, steady),
    evidence: `Every tab carries the required cold/warm metric keys; the ${steady.tabs.length}-tab, ${steady.cycles}-cycle series has ${steady.snapshots.length} snapshots, VOID=false, and all timer/EventSource/instrument controls pass.`,
  },
  {
    id: 'r4-missing-metric-negative-control',
    passed: !metricSetOk(missingMetric, steady),
    evidence: 'Removing firstContentfulPaint from one cold result makes the metric-set predicate fail.',
  },
  {
    id: 'r4-control-failure-negative-control',
    passed: !metricSetOk(current, badControls),
    evidence: 'Turning instrumentPresent false in an in-memory series copy makes the full-cycle predicate fail.',
  },
];

const result = {
  ok: assertions.every((assertion) => assertion.passed),
  portalRoot,
  assertions,
  artifacts: {
    [currentPath]: sha256(currentText),
    [steadyPath]: sha256(steadyText),
    [projectionPath]: sha256(projectionText),
    [contractsPath]: sha256(contractsText),
    [probePath]: sha256(probeText),
    [projectionScriptPath]: sha256(projectionScriptText),
  },
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
