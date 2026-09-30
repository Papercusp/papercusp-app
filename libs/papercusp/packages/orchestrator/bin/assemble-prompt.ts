#!/usr/bin/env -S npx tsx
/**
 * CLI wrapper around `assembleRolePrompt`.
 *
 * Used by `bash run.sh:invoke()` to assemble role prompts via the same
 * code path the chat endpoint and PM dispatch already use — eliminating
 * drift between bash-orchestrator prompts and TS-assembled prompts.
 *
 * Usage:
 *   npx tsx bin/assemble-prompt.ts \
 *     --slug <harness-slug> \
 *     --role <role> \
 *     [--feature-id F-XXX] \
 *     [--run-id <id>] \
 *     [--extra LINE]...           repeatable; runtime-context bullets
 *     [--plan-context-file PATH]  path to file containing plan context text
 *                                  (produced by get-plan-context.ts; only
 *                                  relevant for worker/validator/reviewer)
 *
 * Output: assembled prompt text on stdout. Exit 0 on success, 1 on any
 * resolution error (unknown slug, missing prompt file, etc.).
 *
 * Bash callers should pipe the stdout directly to the agent CLI (the
 * $CLAUDE / $AGENT_CMD env, defaulting to `omp -p`):
 *
 *   prompt="$(npx tsx ...assemble-prompt.ts --slug X --role worker --feature-id F-001)"
 *   echo "$prompt" | $CLAUDE ...
 */
import { readFileSync, existsSync } from 'node:fs';
import { assembleRolePrompt } from '../src/role-prompt-from-slug.js';

interface ParsedArgs {
  slug: string;
  role: string;
  featureId?: string;
  runId?: string;
  extras: string[];
  planContextFile?: string;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { slug: '', role: '', extras: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case '--slug': out.slug = next ?? ''; i++; break;
      case '--role': out.role = next ?? ''; i++; break;
      case '--feature-id': out.featureId = next ?? ''; i++; break;
      case '--run-id': out.runId = next ?? ''; i++; break;
      case '--plan-context-file': out.planContextFile = next ?? ''; i++; break;
      case '--extra':
        if (next) out.extras.push(next);
        i++;
        break;
      default:
        if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    }
  }
  if (!out.slug) throw new Error('--slug is required');
  if (!out.role) throw new Error('--role is required');
  return out;
}

function main(): void {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`assemble-prompt: ${(err as Error).message}\n`);
    process.exit(2);
  }

  let planContext: string | undefined;
  if (args.planContextFile && existsSync(args.planContextFile)) {
    try {
      planContext = readFileSync(args.planContextFile, 'utf8').trim() || undefined;
    } catch { /* best-effort */ }
  }

  try {
    const { text } = assembleRolePrompt({
      slug: args.slug,
      role: args.role,
      featureId: args.featureId || undefined,
      runId: args.runId || undefined,
      mode: 'autonomous',
      extras: args.extras,
      planContext,
    });
    process.stdout.write(text);
    if (!text.endsWith('\n')) process.stdout.write('\n');
  } catch (err) {
    process.stderr.write(`assemble-prompt: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

main();
