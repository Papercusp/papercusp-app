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

  // The operator barrel installs a few long-lived invalidation listeners as
  // part of normal boot. This is a one-shot measurement command, so do not
  // leave the shell hanging after the report has been written.
  const exitCode = runToolWeightCli(process.argv.slice(2), namedToolWeights());
  process.exit(exitCode);
}

void main();
