/**
 * lint:harness-arg-coverage — fail when a registered tool declares a
 * harness-naming argument the hive-confinement clamp does not guard.
 *
 * WHY (EI-21910110662818467 / EI-21909041314898402): the clamp in
 * `_mcp-handler.ts` decides "does this call name a harness outside my hive?"
 * from a hand-maintained list of argument SPELLINGS, and every entry in that
 * list was added reactively after a bypass was found in production
 * (harness -> harness_slug -> hive -> coord:presence.scope -> scope:'harness:<slug>').
 * Any tool may add a new spelling; the clamp cannot know. The failure is
 * SILENT and security-relevant — confinement simply stops applying.
 *
 * This is rung 2 of the derived-truth ladder (PIN). Pure derivation is not
 * available: "which argument names a harness" is semantic, not structural.
 *
 * Usage:
 *   npm run lint:harness-arg-coverage            # check; exit 1 on a hole
 *   npm run lint:harness-arg-coverage -- --list  # MEASURE the live population
 *
 * `--list` is how `HIVE_CLAMP_ARG_EXEMPTIONS` is (re-)seeded — from a run that
 * actually walks the registry, never from a hand grep.
 *
 * Registration is a side-effect import, exactly as scripts/gen-tool-catalog.ts
 * does it; `listAllProjectedTools()` then reads the populated registry.
 */
import '../packages/operator-core/lib/agent-tools/index.ts';
import { listAllProjectedTools } from '@papercusp/agent-mcp';
import {
  HIVE_CLAMP_ARG_EXEMPTIONS,
  HIVE_CLAMP_LITERAL_ARGS,
  designatesHarness,
  findUnguardedHarnessArgs,
  schemaMayCarrySlug,
  suspectsHarness,
  topLevelArgEntries,
  type HarnessArgCoverageTool,
} from '../packages/operator-core/lib/endpoint-route/hive-harness-arg-coverage.ts';

const listMode = process.argv.includes('--list');

const tools: HarnessArgCoverageTool[] = listAllProjectedTools().map((t) => ({
  name: t.expose?.mcp?.name ?? t.pluginName ?? '<unnamed>',
  inputSchema: t.inputSchema,
}));

if (listMode) {
  // MEASUREMENT: every harness-naming arg in the live registry, with its
  // current disposition. This is the output you seed the exemption map from.
  // EXACT match, never normalized: the clamp reads properties literally, so
  // `harnessSlug` and `harness_slug` are different keys to it. Normalizing here
  // is what made a live hole read as GUARDED on the first run.
  const guarded = new Set(HIVE_CLAMP_LITERAL_ARGS);
  const exempt = new Set(Object.keys(HIVE_CLAMP_ARG_EXEMPTIONS));
  const byArg = new Map<string, { tools: string[]; disposition: string }>();
  let scanned = 0;
  for (const tool of tools) {
    for (const [arg, propSchema] of topLevelArgEntries(tool.inputSchema)) {
      scanned++;
      if (!suspectsHarness(arg, propSchema)) continue;
      const disposition = guarded.has(arg)
        ? 'LITERAL-BRANCH'
        : designatesHarness(arg)
          ? 'SWEPT'
          : exempt.has(arg)
            ? 'EXEMPT'
            : !schemaMayCarrySlug(propSchema)
              ? 'NOT-A-SLUG'
              : 'NEEDS-DISPOSITION';
      const row = byArg.get(arg) ?? { tools: [], disposition };
      row.tools.push(tool.name);
      byArg.set(arg, row);
    }
  }
  console.log(`TOOLS\t${tools.length}\tTOP_LEVEL_ARGS_SCANNED\t${scanned}`);
  console.log(`DISTINCT_HARNESS_NAMING_ARGS\t${byArg.size}`);
  for (const [arg, row] of [...byArg.entries()].sort(
    (a, b) => b[1].tools.length - a[1].tools.length || a[0].localeCompare(b[0]),
  )) {
    console.log(`ARG\t${row.disposition}\t${arg}\t${row.tools.length}\t${row.tools.slice(0, 8).join(',')}`);
  }
  process.exit(0);
}

const findings = findUnguardedHarnessArgs(tools);
if (findings.length === 0) {
  console.log(
    `✓ harness-arg coverage: every harness-naming tool argument is guarded by the hive clamp or explicitly exempt (${tools.length} tools).`,
  );
  process.exit(0);
}

console.error(
  `✗ harness-arg coverage: ${findings.length} tool argument(s) name a harness but are NOT guarded by the hive clamp.\n` +
    `  A hive-confined session could use one of these to reach another hive, silently.\n`,
);
for (const f of findings) console.error(`  ${f.tool}\t${f.arg}`);
console.error(
  `\nFIX — pick the one that is true, do not just add an exemption:\n` +
    `  • The arg CAN name another harness -> it should be swept by the clamp's generic\n` +
    `    harness-arg pass (collectHarnessSlugArgs) in\n` +
    `    packages/operator-core/lib/endpoint-route/routes/transport/_mcp-handler.ts.\n` +
    `    If designatesHarness() does not yet recognise the spelling, widen THAT predicate.\n` +
    `  • The arg CANNOT route anywhere (a boolean, a filter, an unrelated word that\n` +
    `    merely contains "harness") -> add it to HIVE_CLAMP_ARG_EXEMPTIONS **with the\n` +
    `    reason it is safe**. An exemption without a reason is a parking lot.\n` +
    `  Both live in packages/operator-core/lib/endpoint-route/hive-harness-arg-coverage.ts`,
);
process.exit(1);
