#!/usr/bin/env -S npx tsx
/**
 * Fetch the plan-context section for a feature from the operator HTTP API.
 *
 * Used by `bash run.sh:invoke()` for the bash inline-prompt path. Prints
 * the plan context markdown to stdout. Exit 0 on success (including "no
 * plan origin" — prints nothing), exit 1 on hard error.
 *
 * Usage:
 *   npx tsx bin/get-plan-context.ts --slug <slug> --feature-id F-XXX
 *
 * run.sh usage:
 *   _plan_ctx_file="$(mktemp)"
 *   npx tsx .../get-plan-context.ts --slug "$_slug" --feature-id "$feature_id" \
 *     > "$_plan_ctx_file" 2>/dev/null || true
 *   # pass --plan-context-file "$_plan_ctx_file" to assemble-prompt.ts, or
 *   # cat the file into the inline bash prompt directly.
 */

interface ParsedArgs { slug: string; featureId: string }

function parseArgs(argv: readonly string[]): ParsedArgs {
  const out = { slug: '', featureId: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = argv[i + 1];
    switch (a) {
      case '--slug': out.slug = next ?? ''; i++; break;
      case '--feature-id': out.featureId = next ?? ''; i++; break;
      default: if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    }
  }
  if (!out.slug) throw new Error('--slug is required');
  if (!out.featureId) throw new Error('--feature-id is required');
  return out;
}

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`get-plan-context: ${(err as Error).message}\n`);
    process.exit(1);
  }

  const base = process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3055';
  const url = `${base}/api/harness/${args.slug}/features/${args.featureId}/plan-context`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      // 404 = no plan origin — exit 0 with empty output, not an error.
      if (res.status === 404) process.exit(0);
      process.stderr.write(`get-plan-context: HTTP ${res.status} from operator\n`);
      process.exit(0); // best-effort; don't block invocation on context failure
    }
    const data = await res.json() as { section?: string };
    const section = data.section ?? '';
    if (section.trim()) {
      process.stdout.write(section);
      if (!section.endsWith('\n')) process.stdout.write('\n');
    }
  } catch {
    // Operator unreachable — exit 0 silently; feature has no plan context.
    process.exit(0);
  }
}

main();
