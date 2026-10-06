/**
 * P-005 — pure argument + evidence rendering for the four-arm engine comparison CLI.
 *
 * Kept free of I/O so the exact bytes that become the plan's evidence are unit-tested:
 * the CLI (`engine-comparison-cli.ts`) only wires real processes to these functions.
 */
import { createHash } from 'node:crypto';
import {
  buildEngineFairnessAudit,
  decideDisposition,
  DISPOSITION_BARS,
  formatComparisonMarkdown,
  sourceParity,
  toTaskRunRows,
  type ArmReport,
  type EngineRunMeta,
} from './engine-comparison';

/** Canonical arm order: the report, the disposition input and the evidence table all use it. */
export const ARM_ORDER = Object.freeze(['baseline-lsp-rg', 'gitnexus-installed', 'gitnexus-candidate', 'codebase-memory'] as const);
export type CliArmId = (typeof ARM_ORDER)[number];

export interface CliOptions {
  readonly mode: 'run' | 'aggregate';
  readonly arms: readonly CliArmId[];
  readonly warmSamples: number;
  /** Null ⇒ the CLI default evidence directory. */
  readonly outDir: string | null;
}

const isArm = (s: string): s is CliArmId => (ARM_ORDER as readonly string[]).includes(s);

/** `--arm a,b` · `--warm N` (1..20) · `--out DIR` · `--aggregate`. Unknown input THROWS — never a silent default. */
export function parseCliArgs(argv: readonly string[]): CliOptions {
  let mode: CliOptions['mode'] = 'run';
  let arms: CliArmId[] = [...ARM_ORDER];
  let warmSamples = 3;
  let outDir: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    const value = (): string => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
      i += 1;
      return v;
    };
    if (flag === '--aggregate') mode = 'aggregate';
    else if (flag === '--arm') {
      const picked = value().split(',').map((s) => s.trim()).filter(Boolean);
      const bad = picked.filter((a) => !isArm(a));
      if (bad.length > 0) throw new Error(`unknown arm(s): ${bad.join(', ')} (known: ${ARM_ORDER.join(', ')})`);
      if (picked.length === 0) throw new Error('--arm needs at least one arm id');
      arms = picked.filter(isArm);
    } else if (flag === '--warm') {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error('--warm must be an integer in 1..20');
      warmSamples = n;
    } else if (flag === '--out') outDir = value();
    else throw new Error(`unknown argument: ${flag}`);
  }
  return { mode, arms, warmSamples, outDir };
}

/** Hash of everything fixed BEFORE the run: case ids, warm sample count and the disposition bars. */
export function preregHash(caseIds: readonly string[], warmSamples: number): string {
  return createHash('sha256').update(JSON.stringify({ caseIds: [...caseIds], warmSamples, bars: DISPOSITION_BARS })).digest('hex').slice(0, 16);
}

/**
 * Run identity derived from the INPUT evidence, never from the clock (EI-24858052475884275).
 *
 * `aggregate` used to stamp `runId`/`createdAt` from `new Date()`, so re-aggregating the very same
 * `report-*.json` files on another day rewrote every evidence file that embeds them (the markdown
 * header, task-runs.json, fairness-audit.json) while verdict.json — which does not — stayed identical.
 * The first fix read each report's FILE MTIME — wrong: an mtime is a filesystem property, so a `cp`, a fresh
 * clone or the gate's checkpoint checkout all reset it and the bytes then depended on checkout time, not
 * content (measured by su-d51b5df2: re-aggregating a copied evidence dir moved createdAt 16:37Z → 18:18Z in
 * two files). The newest `measuredAt` — written INTO each report when its arm run finishes — travels with the
 * file, so it is stable across copy/clone/re-aggregation and moves only when an arm run rewrites a report,
 * which is exactly when the output SHOULD change. No usable `measuredAt` → a fixed epoch, never "now".
 */
export function deriveRunMeta(measuredAts: readonly (string | undefined)[], prereg: string): EngineRunMeta {
  const usable = measuredAts.map((s) => (s === undefined ? Number.NaN : Date.parse(s))).filter((t) => Number.isFinite(t) && t > 0);
  const createdAt = new Date(usable.length === 0 ? 0 : Math.max(...usable)).toISOString();
  return { runId: `engine-comparison-${createdAt.slice(0, 10)}`, seed: 0, createdAt, preregHash: prereg };
}

/** Canonical arm order; an unknown id sorts last (never dropped). */
export function orderReports(reports: readonly ArmReport[]): ArmReport[] {
  const rank = (id: string): number => {
    const i = (ARM_ORDER as readonly string[]).indexOf(id);
    return i === -1 ? ARM_ORDER.length : i;
  };
  return [...reports].sort((a, b) => rank(a.armId) - rank(b.armId));
}

export interface EvidenceBundle {
  readonly markdown: string;
  readonly verdictJson: string;
  readonly taskRowsJson: string;
  readonly fairnessJson: string;
}

const cell = (v: string | number | null | undefined): string => (v === null || v === undefined ? 'n/a' : String(v).replace(/\|/g, '\\|').replace(/\s+/g, ' '));

function caseTable(reports: readonly ArmReport[]): string {
  const rows: string[] = ['| arm | case | intent | correct | recall | cold ms | warm ms | resp bytes | error |', '|---|---|---|---|---|---|---|---|---|'];
  for (const r of reports) {
    for (const c of r.cases) {
      rows.push(`| ${r.armId} | ${cell(c.caseId)} | ${cell(c.intent)} | ${c.correct ? 'yes' : 'NO'} | ${c.recall.toFixed(2)} | ${Math.round(c.coldQueryMs)} | ${c.warmQueryMs === null ? 'n/a' : Math.round(c.warmQueryMs)} | ${c.responseBytes} | ${cell(c.error)} |`);
    }
  }
  return rows.join('\n');
}

function fixtureTable(reports: readonly ArmReport[]): string {
  const rows: string[] = ['| arm | fixture | pass | fault surfaced | refresh s | detail |', '|---|---|---|---|---|---|'];
  for (const r of reports) {
    for (const f of r.fixtures) {
      const refreshS = f.refreshCost === null ? null : (f.refreshCost.wallMs / 1000).toFixed(1);
      rows.push(`| ${r.armId} | ${f.name} | ${f.pass ? 'yes' : 'NO'} | ${f.faultSurfaced === null ? 'n/a' : f.faultSurfaced ? 'yes' : 'NO'} | ${cell(refreshS)} | ${cell(f.detail)} |`);
    }
  }
  return rows.join('\n');
}

/** Everything the plan's evidence needs, from the arm reports alone. Deterministic for fixed input. */
export function renderEvidence(reports: readonly ArmReport[], meta: EngineRunMeta, notes: readonly string[]): EvidenceBundle {
  const ordered = orderReports(reports);
  const verdict = decideDisposition(ordered);
  const parity = sourceParity(ordered);
  const audit = buildEngineFairnessAudit(ordered, meta);
  const rows = toTaskRunRows(ordered, meta);
  const md = [
    `# Engine comparison — run ${meta.runId}`,
    '',
    `created ${meta.createdAt} · seed ${meta.seed} · prereg ${meta.preregHash}`,
    '',
    '## Summary (one row per arm)',
    '',
    formatComparisonMarkdown(ordered),
    '',
    '## Per-case measurements',
    '',
    caseTable(ordered),
    '',
    '## Update fixtures (edit · delete · refresh-failure)',
    '',
    fixtureTable(ordered),
    '',
    '## Source parity',
    '',
    `identical tree fingerprint across arms: **${parity.same ? 'YES' : 'NO'}**`,
    '',
    '```json',
    JSON.stringify(parity.fingerprints, null, 2),
    '```',
    '',
    '## Disposition (decideDisposition — measured, never self-graded)',
    '',
    `decision: **${verdict.decision}**`,
    '',
    ...verdict.reasons.map((r) => `- ${r}`),
    ...(verdict.residue.length > 0 ? ['', '### Residue (nonpassing, never waived)', '', ...verdict.residue.map((r) => `- ${r}`)] : []),
    '',
    '## Disclosures',
    '',
    ...(notes.length > 0 ? notes.map((n) => `- ${n}`) : ['- none']),
    '',
  ].join('\n');
  return {
    markdown: md,
    verdictJson: JSON.stringify({ ...verdict, sourceParity: parity }, null, 2),
    taskRowsJson: JSON.stringify(rows, null, 2),
    fairnessJson: JSON.stringify(audit, null, 2),
  };
}
