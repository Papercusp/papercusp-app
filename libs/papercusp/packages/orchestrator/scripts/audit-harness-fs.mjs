#!/usr/bin/env node
/**
 * Audit a harness directory for unexpected filesystem state.
 *
 * After Phases 1-7 land + the operator wires ctx.pg, the harness's
 * .papercusp/ directory should contain ONLY:
 *   - config.json                   (read-only orchestrator config)
 *   - SPEC.md, summary.md           (text-artifacts; PG-canonical, FS mirror)
 *   - notes/<feature>.md            (operator-notes; PG-canonical, FS mirror)
 *   - prompts/                      (read-only role prompts, may be edited)
 *   - hooks/                        (user-authored shell, code not state)
 *   - identity/                     (cross-mission persona, code not state)
 *   - logs/                         (operational streams; not state)
 *   - memory/                       (curator output, mirror of PG)
 *
 * Files that **should not exist** when PG path is active:
 *   - features.json                 (→ harness_features)
 *   - lanes.json                    (→ harness_mission_state.lanes)
 *   - escalation.md                 (→ harness_mission_state.escalation_md)
 *   - .cost-warn-fired              (→ harness_mission_state.cost_warn_fired)
 *   - ready-for-prod.flag           (→ harness_mission_state.ready_for_prod_at)
 *   - checkpoint-*.md               (→ harness_checkpoints)
 *   - *.md.granted                  (→ harness_checkpoints.status='granted')
 *   - .checkpoint-*.fired           (→ implicit "any row exists" predicate)
 *   - <runId>.prompt.md             (→ ramTmpRoot tmpdir + run_output.prompt_body)
 *   - snapshots/<ts>-iter-NNN/      (→ harness_snapshots rows)
 *   - logs/nexth-*.json             (→ harness_dispatches)
 *   - experts/<EXP>/identity.json   (→ harness_experts)
 *   - experts/<EXP>/SPEC.md         (→ harness_experts.spec_content)
 *   - experts/<EXP>/feedback/<FB>/persona.txt   (→ harness_expert_feedback)
 *   - experts/<EXP>/feedback/<FB>/verdict.json  (→ harness_expert_feedback.verdict)
 *   - experts/<EXP>/feedback/<FB>/turn-NNN-*.md (→ harness_expert_turns)
 *
 * Usage:
 *   node audit-harness-fs.mjs <path/to/.harness>
 *   exit 0 = clean, 1 = unexpected state files found
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const STALE_FILE_PATTERNS = [
  { match: (n) => n === 'features.json', key: 'features.json' },
  { match: (n) => n === 'lanes.json', key: 'lanes.json' },
  { match: (n) => n === 'escalation.md', key: 'escalation.md' },
  { match: (n) => n === '.cost-warn-fired', key: '.cost-warn-fired' },
  { match: (n) => n === 'ready-for-prod.flag', key: 'ready-for-prod.flag' },
  { match: (n) => /^checkpoint-.+\.md$/.test(n), key: 'checkpoint-*.md' },
  { match: (n) => /^checkpoint-.+\.md\.granted$/.test(n), key: '*.md.granted' },
  { match: (n) => /^\.checkpoint-.+\.fired$/.test(n), key: '.checkpoint-*.fired' },
  { match: (n) => /\.prompt\.md$/.test(n), key: '<runId>.prompt.md (move to ramTmpRoot)' },
];

const STALE_DIR_PATTERNS = [
  { match: (n) => n === 'snapshots', key: 'snapshots/' },
];

function audit(harnessDir) {
  if (!existsSync(harnessDir)) {
    process.stderr.write(`audit: directory not found: ${harnessDir}\n`);
    return 1;
  }
  const findings = [];
  let entries;
  try { entries = readdirSync(harnessDir); } catch (e) {
    process.stderr.write(`audit: readdir failed: ${e.message}\n`);
    return 1;
  }
  for (const entry of entries) {
    const full = join(harnessDir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      for (const p of STALE_DIR_PATTERNS) {
        if (p.match(entry)) findings.push({ kind: 'dir', key: p.key, path: full });
      }
    } else if (st.isFile()) {
      for (const p of STALE_FILE_PATTERNS) {
        if (p.match(entry)) findings.push({ kind: 'file', key: p.key, path: full });
      }
    }
  }
  // Walk logs/ for nexth-*.json
  const logsDir = join(harnessDir, 'logs');
  if (existsSync(logsDir)) {
    try {
      for (const e of readdirSync(logsDir)) {
        if (/^nexth-.+\.json$/.test(e)) {
          findings.push({ kind: 'file', key: 'logs/nexth-*.json', path: join(logsDir, e) });
        }
      }
    } catch { /* skip */ }
  }
  // Walk experts/<EXP-NNN>/ for files migrated to harness_experts +
  // harness_expert_feedback + harness_expert_turns. Round audit snapshots
  // (rounds/round-NNN.md) and chat/ are intentionally allowed.
  const expertsDir = join(harnessDir, 'experts');
  if (existsSync(expertsDir)) {
    try {
      for (const expId of readdirSync(expertsDir)) {
        if (!/^EXP-\d{3,}$/.test(expId)) continue;
        const expRoot = join(expertsDir, expId);
        let expEntries;
        try { expEntries = readdirSync(expRoot); } catch { continue; }
        for (const e of expEntries) {
          if (e === 'identity.json') {
            findings.push({ kind: 'file', key: 'experts/<id>/identity.json (→ harness_experts)', path: join(expRoot, e) });
          } else if (e === 'SPEC.md') {
            findings.push({ kind: 'file', key: 'experts/<id>/SPEC.md (→ harness_experts.spec_content)', path: join(expRoot, e) });
          }
        }
        const fbRoot = join(expRoot, 'feedback');
        if (existsSync(fbRoot)) {
          let fbs;
          try { fbs = readdirSync(fbRoot); } catch { continue; }
          for (const fb of fbs) {
            if (!/^FB-\d{3,}$/.test(fb)) continue;
            const fbDir = join(fbRoot, fb);
            let fbEntries;
            try { fbEntries = readdirSync(fbDir); } catch { continue; }
            for (const e of fbEntries) {
              if (e === 'persona.txt') {
                findings.push({ kind: 'file', key: 'experts/<id>/feedback/<fb>/persona.txt (→ harness_expert_feedback)', path: join(fbDir, e) });
              } else if (e === 'verdict.json') {
                findings.push({ kind: 'file', key: 'experts/<id>/feedback/<fb>/verdict.json (→ harness_expert_feedback.verdict)', path: join(fbDir, e) });
              } else if (/^turn-\d{3}-(expert|feedback)\.md$/.test(e)) {
                findings.push({ kind: 'file', key: 'experts/<id>/feedback/<fb>/turn-NNN-*.md (→ harness_expert_turns)', path: join(fbDir, e) });
              }
            }
          }
        }
      }
    } catch { /* skip */ }
  }
  if (findings.length === 0) {
    console.log(`✓ ${harnessDir} — clean (0 state files)`);
    return 0;
  }
  console.log(`✗ ${harnessDir} — ${findings.length} stale state ${findings.length === 1 ? 'item' : 'items'}:`);
  const grouped = new Map();
  for (const f of findings) {
    if (!grouped.has(f.key)) grouped.set(f.key, []);
    grouped.get(f.key).push(f.path);
  }
  for (const [key, paths] of grouped) {
    console.log(`  ${key} (${paths.length})`);
    for (const p of paths.slice(0, 3)) console.log(`    ${p}`);
    if (paths.length > 3) console.log(`    ... and ${paths.length - 3} more`);
  }
  return 1;
}

const target = process.argv[2];
if (!target) {
  process.stderr.write('usage: audit-harness-fs.mjs <path/to/.harness>\n');
  process.exit(2);
}
process.exit(audit(target));
