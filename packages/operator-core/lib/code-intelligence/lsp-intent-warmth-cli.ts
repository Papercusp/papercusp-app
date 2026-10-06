/**
 * lsp-intent-warmth-cli.ts — IS "WARM" A PROPERTY OF THE SERVER, OR OF THE INTENT?
 *
 * Plan `lsp-fleet-scale-all-languages-2026-08-21`, decision D-003.
 *
 * WHY THIS EXISTS. The saturation ladder (`lsp-saturation-bench-cli.ts`) showed
 * a level taking 28.7s for three requests on a server that had just answered a
 * definition in 2ms. By ordering, the cost had to be the first `references`
 * call — but that is an INFERENCE from sample order, and a plan decision should
 * not rest on one. This measures it directly, inside a SINGLE server lifetime,
 * with every request timed and labelled by intent.
 *
 * WHAT IT MEASURED (tsserver, this monorepo, 2026-08-21):
 *   definition (cold server)        5,184ms
 *   definition (repeat)                 4ms
 *   definition (new document)         483ms
 *   references (FIRST anywhere)    27,256ms   ← the finding
 *   references (same, repeated)       721ms
 *   references (DIFFERENT document)    80ms   ← so the build is GLOBAL, not per-doc
 *   definition (after the build)        2ms   ← definition never paid for it
 *
 * CONCLUSION. The first `references` pays a one-time, process-wide reference
 * index build. It is not per-symbol and not per-document. A server that is
 * demonstrably ready for `definition` — 4ms answers — can still be 27 seconds
 * away from answering a `references`, so readiness must be certified per
 * (language, intent), and provisioning should fire one throwaway `references`
 * per server so no agent pays that penalty.
 *
 * Throughout the build the query BLOCKED and then returned the correct 192
 * sites: a LATENCY hazard, not a false-empty one.
 *
 * USAGE
 *   npx tsx packages/operator-core/lib/code-intelligence/lsp-intent-warmth-cli.ts
 */
import { performance } from 'node:perf_hooks';
import { moduleRepoRoot } from '../module-repo-root';

import { lspQuery, shutdownAllLspClients } from './lsp-adapter.ts';
import { BENCH_PROBES, resolveProbeCursor } from './code-intel-bench.ts';
import type { CodeIntelIntent } from './contracts.ts';

/** packages/operator-core/lib/code-intelligence → repo root. */
const REPO_ROOT = moduleRepoRoot(import.meta.url);

interface Step {
  readonly intent: CodeIntelIntent;
  readonly cursorIdx: number;
  readonly why: string;
}

const STEPS: readonly Step[] = [
  { intent: 'definition', cursorIdx: 0, why: 'cold server + cold doc' },
  { intent: 'definition', cursorIdx: 0, why: 'warm server, same doc, same intent' },
  { intent: 'definition', cursorIdx: 1, why: 'warm server, NEW doc, same intent' },
  { intent: 'references', cursorIdx: 2, why: 'FIRST references — the hypothesis under test' },
  { intent: 'references', cursorIdx: 2, why: 'same references repeated — amortized?' },
  { intent: 'references', cursorIdx: 1, why: 'references, DIFFERENT doc — amortized across docs?' },
  { intent: 'definition', cursorIdx: 2, why: 'definition after the references build — still fast?' },
];

async function main(): Promise<void> {
  const tsProbes = BENCH_PROBES.filter((p) => !p.file.endsWith('.rs'));
  const cursors = tsProbes.map((p) => resolveProbeCursor(p, REPO_ROOT));

  console.log('# lsp intent-warmth probe (typescript)');
  for (const [i, step] of STEPS.entries()) {
    const c = cursors[step.cursorIdx];
    const t0 = performance.now();
    const answer = await lspQuery(step.intent, {
      file: c.file,
      line1: c.line1,
      character: c.character,
      rootPath: c.rootPath,
    });
    const ms = Math.round(performance.now() - t0);
    console.log(
      `STEP ${i + 1} ${step.intent.padEnd(11)} cursor=${step.cursorIdx} ` +
        `${String(ms).padStart(7)}ms sites=${String(answer.sites.length).padStart(3)} ` +
        `err=${answer.error ?? 'none'}  # ${step.why}`,
    );
  }
  console.log(`# shut down ${await shutdownAllLspClients()} client(s)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
