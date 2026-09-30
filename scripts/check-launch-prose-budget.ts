/**
 * lint:launch-prose-budget — the IO shell for the launch PROSE ceilings
 * (agent-launch-context-cost-2026-09-18 P-004).
 *
 * Measures every prose surface an agent pays for at launch, from its LIVE source, and
 * compares it against the shrink-only ceilings in `launch-prose-budget-baseline.json`.
 * The comparison itself — including the four ways a byte-budget check can go green
 * without having measured anything — lives in the pure module
 * `packages/operator-core/lib/launch-prose-budget.ts`; read its header for the model.
 *
 *   npm run lint:launch-prose-budget              # gate (exit 1 on any failure)
 *   npm run lint:launch-prose-budget -- --json    # machine-readable report
 *   npm run lint:launch-prose-budget -- --ratchet # lower ceilings to current, never raise
 *
 * DETERMINISM — the one seam that would otherwise make this flaky. `renderSuPlaybook`'s
 * default wire-schema legend is derived from the PROCESS-GLOBAL projected-tool registry,
 * which is empty in a fresh process and populated by whatever loaded a catalog earlier in
 * the same one. Measuring it here would make the number depend on module load order. It is
 * therefore pinned empty (`renderWireSchemas: () => ''`, the same determinism seam the
 * pinned-fixture render in su-render-baseline uses) and the legend is EXCLUDED from these
 * ceilings by design: it is generated from tool definitions, and its cost is already
 * governed by the tool budgets (`tool-guidance-budget`, `claude-seed-wire-budget`). Prose
 * ceilings govern prose; tool budgets govern tools.
 *
 * SCOPE — what these numbers are and are not. This measures the DEFAULT render: the
 * on-disk base playbook, the client overlay, and the default projected project guide. A
 * real launch (`role-launch-spec.ts`) may additionally compose a slot-stack base and
 * splice DB-addressed project-guide parts, so a live
 * `~/.papercusp/launch-context/session-*.md` will not byte-match these figures — measured
 * 2026-09-18, live launch renders ranged 131,987–175,558 B against a 253,315 B default
 * render. That is expected and is exactly why the ceiling is pinned to the default: a
 * DB-composed render is not reproducible at build time, while the authored prose that
 * feeds every variant of it is. Compare in-repo numbers to in-repo numbers.
 */
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkComposition,
  compareProseBudget,
  ratchetCeilings,
  renderProseBudgetReport,
  type CompositionProbe,
  type ProseBudgetBaseline,
  type ProseSurfaceMeasurement,
} from '../packages/operator-core/lib/launch-prose-budget';
import { isCliEntry } from '../packages/operator-core/lib/util/cli-entry';
import {
  renderCompactionStrategy,
  renderSuPlaybook,
} from '../packages/operator-core/lib/desktop-install/papercusp-files';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BASELINE_PATH = path.join(HERE, 'launch-prose-budget-baseline.json');
const PROMPTS_DIR = path.join(ROOT, 'apps/operator/prompts');

/** The per-client tooling overlays, summed into one surface so growth in ANY of them is caught. */
const CLIENT_OVERLAYS = ['papercusp-su.claude.md', 'papercusp-su.codex.md', 'papercusp-su.omp.md'];

/**
 * One literal per spliced component of the engineer/claude render — the positive control
 * for this gate. See `checkComposition` for why a byte floor alone cannot do this job.
 * These are load-bearing HEADINGS, not incidental phrases, so ordinary prose edits inside
 * a section do not disturb them; a genuine rename is a one-line update here and a signal
 * worth seeing.
 */
const ENGINEER_RENDER_COMPOSITION: readonly CompositionProbe[] = [
  { component: 'the base playbook', literal: '## Working in the shared dev environment' },
  { component: 'the Claude client overlay', literal: 'You are running under Claude Code' },
  { component: 'the compaction protocol', literal: '## Managing your own compaction' },
  { component: 'the project guide (CLAUDE.md)', literal: '# Papercup — agent guide' },
  { component: 'the workspace map', literal: 'the canonical shared tree' },
];

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

async function fileBytes(abs: string): Promise<number> {
  return bytes(await readFile(abs, 'utf8'));
}

/**
 * Measure every governed surface from its live source.
 *
 * Deliberately NOT wrapped in per-surface try/catch: a render that throws must fail the
 * run loudly. Swallowing it would produce a missing measurement, which the pure module
 * reports as `unmeasured` — correct, but a raw stack trace names the broken seam better.
 */
export async function measureLaunchProseSurfaces(): Promise<ProseSurfaceMeasurement[]> {
  const pinnedLegend = { renderWireSchemas: () => '' } as const;

  const engineerClaude = await renderSuPlaybook({
    agent: 'claude',
    profile: 'engineer',
    tier: 'full',
    operatorAppRoot: path.join(ROOT, 'apps/operator'),
    ...pinnedLegend,
  });
  const powerClaude = await renderSuPlaybook({
    agent: 'claude',
    profile: 'power',
    tier: 'full',
    operatorAppRoot: path.join(ROOT, 'apps/operator'),
    ...pinnedLegend,
  });

  // The positive control. A missing component makes the byte total DROP, which is
  // indistinguishable from a successful reduction — so this runs before any number from
  // this render is reported, and hard-fails rather than downgrading to a warning.
  const composition = checkComposition(engineerClaude.text, ENGINEER_RENDER_COMPOSITION);
  if (!composition.ok) {
    throw new Error(`engineer/full/claude ${composition.message}`);
  }

  const overlayTotal = (
    await Promise.all(CLIENT_OVERLAYS.map((f) => fileBytes(path.join(PROMPTS_DIR, f))))
  ).reduce((a, b) => a + b, 0);

  return [
    {
      surface: 'su-playbook-render:engineer:full:claude',
      bytes: bytes(engineerClaude.text),
      source: `renderSuPlaybook(engineer/full/claude) over ${path.relative(ROOT, engineerClaude.baseSource)}`,
    },
    {
      surface: 'su-playbook-render:power:full:claude',
      bytes: bytes(powerClaude.text),
      source: `renderSuPlaybook(power/full/claude) over ${path.relative(ROOT, powerClaude.baseSource)}`,
    },
    {
      surface: 'project-guide:claude-md',
      bytes: await fileBytes(path.join(ROOT, 'CLAUDE.md')),
      source: 'CLAUDE.md (the projected harness_doc_parts output, client=claude)',
    },
    {
      // The SECOND projection of the same parts. Easy to miss precisely because it is a
      // sibling output of the same generator: reducing CLAUDE.md moves it too, and growing
      // a part grows BOTH. It is governed separately because the client that reads it has a
      // different, much tighter reader threshold — the projector itself reports AGENTS.md as
      // over an 80,000-char warn threshold that CLAUDE.md is not measured against.
      surface: 'project-guide:agents-md',
      bytes: await fileBytes(path.join(ROOT, 'AGENTS.md')),
      source: 'AGENTS.md (the projected harness_doc_parts output, client=codex)',
    },
    {
      surface: 'compaction-strategy',
      bytes: bytes(await renderCompactionStrategy(PROMPTS_DIR)),
      source: 'renderCompactionStrategy(apps/operator/prompts)',
    },
    {
      surface: 'su-base:engineer',
      bytes: await fileBytes(path.join(PROMPTS_DIR, 'papercusp-su-engineer.tools.md')),
      source: 'apps/operator/prompts/papercusp-su-engineer.tools.md',
    },
    {
      surface: 'su-base:power',
      bytes: await fileBytes(path.join(PROMPTS_DIR, 'papercusp-su-power.tools.md')),
      source: 'apps/operator/prompts/papercusp-su-power.tools.md',
    },
    {
      surface: 'su-client-overlays:all',
      bytes: overlayTotal,
      source: `sum of ${CLIENT_OVERLAYS.join(', ')}`,
    },
  ];
}

/**
 * The baseline in force. `PAPERCUSP_LAUNCH_PROSE_BASELINE` points it at a COPY, which is
 * what makes this gate falsifiable without mutating a tracked file: the repo's
 * mutation-probe discipline (CLAUDE.md, "Proving a guard is falsifiable") forbids the
 * copy-mutate-restore shape on this shared tree, because git-sync sweeps the whole tree
 * every few minutes and can commit the mutant even when nothing goes wrong. An overridable
 * subject path is the prescribed tier for a file artifact, and this one line is what makes
 * that tier available at all. Read-only and never written by `--ratchet`, which always
 * targets the tracked baseline.
 */
export async function readBaseline(
  file = process.env.PAPERCUSP_LAUNCH_PROSE_BASELINE || BASELINE_PATH,
): Promise<ProseBudgetBaseline> {
  return JSON.parse(await readFile(file, 'utf8')) as ProseBudgetBaseline;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const doRatchet = argv.includes('--ratchet');

  const baseline = await readBaseline();
  const measurements = await measureLaunchProseSurfaces();

  if (doRatchet) {
    // The override exists for falsifiability runs against a COPY; ratcheting would read
    // that copy and write the TRACKED baseline, silently importing a synthetic ceiling
    // into the repo. Refuse rather than do something surprising.
    if (process.env.PAPERCUSP_LAUNCH_PROSE_BASELINE) {
      console.error(
        '[lint:launch-prose-budget] REFUSED: --ratchet writes the TRACKED baseline, but ' +
          'PAPERCUSP_LAUNCH_PROSE_BASELINE points the read at a different file. Unset it to ratchet.',
      );
      process.exit(2);
    }
    const result = ratchetCeilings(baseline, measurements);
    if (result.skippedImplausible.length > 0) {
      console.error(
        `[lint:launch-prose-budget] REFUSED to ratchet ${result.skippedImplausible.join(', ')} — ` +
          `measured below the plausibility floor. Ratcheting to a collapsed measurement would bake ` +
          `the broken reading in as the new ceiling and pass forever after.`,
      );
      process.exit(2);
    }
    if (result.lowered.length === 0) {
      console.log('[lint:launch-prose-budget] nothing to ratchet — no surface is under its ceiling.');
    } else {
      await writeFile(BASELINE_PATH, `${JSON.stringify(result.baseline, null, 2)}\n`, 'utf8');
      for (const l of result.lowered) {
        console.log(
          `[lint:launch-prose-budget] ratcheted ${l.surface}: ${l.from.toLocaleString('en-US')} → ` +
            `${l.to.toLocaleString('en-US')} B (−${l.savedBytes.toLocaleString('en-US')})`,
        );
      }
    }
    return;
  }

  const report = compareProseBudget(measurements, baseline);

  if (asJson) {
    // EI-20055889379250637: this payload is an unbounded, data-derived JSON dump and
    // machine-readable output gets piped. `process.exit()` does NOT drain an async pipe
    // write, so it truncated the report. Set the code and let the program end naturally.
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  console.log('[lint:launch-prose-budget] launch prose surfaces:');
  console.log(renderProseBudgetReport(report));
  if (report.ok) {
    console.log('[lint:launch-prose-budget] OK — every launch prose surface is within its ceiling.');
    return;
  }
  console.error('');
  for (const f of report.failures) console.error(`[lint:launch-prose-budget] ${f.status.toUpperCase()}: ${f.message}`);
  console.error('');
  console.error(
    '[lint:launch-prose-budget] FAILED. Reduce the prose (relocate long-form to /internal/docs behind a ' +
      'pointer), or — if the growth is genuinely load-bearing — raise that surface\'s ceiling in ' +
      'scripts/launch-prose-budget-baseline.json WITH a stated reason in its `note`. `--ratchet` only lowers.',
  );
  process.exit(1);
}

if (isCliEntry(import.meta.url)) {
  main().catch((e) => {
    console.error('[lint:launch-prose-budget]', e instanceof Error ? (e.stack ?? e.message) : e);
    process.exit(2);
  });
}
