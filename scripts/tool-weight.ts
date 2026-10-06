/**
 * Measure the prompt weight of the runtime-projected tool catalog.
 *
 * Usage:
 *   npm run tool-weight -- <tool-name>
 *   npm run tool-weight -- --all
 *   npm run tool-weight -- --json <tool-name>
 *
 * The agent-tools barrel is imported from this checkout so the measurement
 * uses the same live registration path as the operator and the budget gate.
 */
// Defaults-only flag resolution is intentional for this offline measurement;
// set the documented opt-out before the barrel's side effects load.
async function main(): Promise<void> {
  process.env.PAPERCUSP_SILENCE_FLAG_OVERRIDE_WARN = '1';
  await import('../packages/operator-core/lib/agent-tools/index.ts');
  const { namedToolWeights } = await import(
    '../packages/operator-core/lib/agent-tools/tool-guidance-budget.ts'
  );
  const { runToolWeightCli } = await import('../packages/operator-core/lib/agent-tools/tool-weight-cli.ts');
  // WI-10004590: the OTHER byte budget a tool edit can break — the tool-delivery
  // floor budget, asserted only at gate time by psu-launcher.test.ts. Resolved by the
  // generator's own catalog measurement (no second pricing of a tool), claude kind: the
  // three kinds share one budget (D-005) and one floor set per kind.
  const { measureDeliverySummary } = await import('./gen-tool-delivery.ts');
  const delivery = await measureDeliverySummary('claude');

  // The operator barrel installs a few long-lived invalidation listeners as
  // part of normal boot. This is a one-shot measurement command, so do not
  // leave the shell hanging after the report has been written.
  const exitCode = runToolWeightCli(
    process.argv.slice(2),
    namedToolWeights(),
    undefined,
    undefined,
    delivery,
  );
  process.exit(exitCode);
}

void main();
