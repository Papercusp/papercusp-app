#!/usr/bin/env node
// acceptance.mjs — the OBJECTIVE known-good-end-state gate for the seed-app, parameterized
// by scenario (hive-run-evaluation P-020 / D-004). Run AFTER a Hive completes a scenario:
//
//     node acceptance.mjs --scenario <id>
//
// Exit 0 == known-good. At the SEEDED commit it FAILS (the planted defect is present and the
// scenario's feature artifacts do not exist yet) — the Hive must do the work correctly,
// INCLUDING fixing the planted defect in the area its work touched, to make this pass. This
// is ground truth: it never consults the Hive's own report. (baseline.test.js is the separate
// regression floor — GREEN at seed because the planted defects are latent.)
import process from 'node:process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--scenario');
const scenario = arg >= 0 ? process.argv[arg + 1] : process.env.SCENARIO;

const fail = (msg) => {
  console.error(`ACCEPTANCE FAIL [${scenario}]: ${msg}`);
  process.exit(1);
};
const ok = () => {
  console.log(`ACCEPTANCE PASS [${scenario}]`);
  process.exit(0);
};

async function tryImport(rel) {
  const abs = path.join(here, rel);
  if (!existsSync(abs)) return null;
  try {
    return await import(abs);
  } catch (err) {
    fail(`module ${rel} failed to import: ${err?.message ?? err}`);
  }
}

// The planted-defect-fixed check shared by scenarios that touch ranking: topN(n) must
// return exactly n items (PLANTED BUG #1 fixed).
async function rankerBugFixed() {
  const m = await tryImport('src/ranker.js');
  if (!m?.topN) fail('src/ranker.js#topN missing');
  const out = m.topN([{ signal: 1 }, { signal: 2 }, { signal: 3 }, { signal: 4 }], 3);
  if (out.length !== 3) fail(`PLANTED BUG #1 not fixed: topN(.,3).length === ${out.length}, want 3`);
}

// PLANTED BUG #2 fixed: parseRecord must SKIP empty segments (no "" key).
async function parserBugFixed() {
  const m = await tryImport('src/parser.js');
  if (!m?.parseRecord) fail('src/parser.js#parseRecord missing');
  const out = m.parseRecord('weight=2;;signal=3');
  if (Object.prototype.hasOwnProperty.call(out, '')) fail('PLANTED BUG #2 not fixed: empty segment leaks a "" key');
}

async function main() {
  switch (scenario) {
    case 'serial-pipeline': {
      const f = await tryImport('src/formatter.js');
      if (!f?.formatTop) fail('src/formatter.js#formatTop not implemented (w1)');
      if (!existsSync(path.join(here, 'dist/result.json'))) fail('dist/result.json not emitted (w4)');
      await rankerBugFixed();
      return ok();
    }
    case 'wide-fanout': {
      const feats = await tryImport('src/features.js');
      if (!feats?.features || Object.keys(feats.features).length < 4) fail('src/features.js must aggregate 4 feats (w5)');
      await parserBugFixed();
      return ok();
    }
    case 'deep-chain': {
      const m = await tryImport('src/chain.js');
      if (!m?.stage5) fail('src/chain.js#stage5 (the deep terminal) not implemented (w5)');
      await rankerBugFixed();
      return ok();
    }
    case 'diamond': {
      const m = await tryImport('src/merge.js');
      if (!m?.merge) fail('src/merge.js#merge (the diamond sink) not implemented (w5)');
      await parserBugFixed();
      return ok();
    }
    default:
      fail(`unknown scenario id (use --scenario serial-pipeline|wide-fanout|deep-chain|diamond)`);
  }
}

main();
