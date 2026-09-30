#!/usr/bin/env tsx
/**
 * adjudicate-publish-refusal — WI-10000598.
 *
 * "own_head_publish.refused === 'secrets'. WHAT did it find, and is it real?"
 *
 * Answers the question `pot_git:secrets_exemptions` requires you to answer
 * before adding a path exemption, and which nothing else in the system will
 * answer for you: the refusal record persists only a refusalCode, and the
 * findings go to a console warning that is not in the journal on this box.
 *
 * Usage:
 *   npx tsx scripts/adjudicate-publish-refusal.mts --commit <sha> [--repo <path>] [--exemptions]
 *
 *   --commit      the refused commit (own_head_publish.blockedAtCommit)
 *   --repo        repo to resolve against (default: cwd)
 *   --exemptions  also load this workspace's runtime path exemptions from
 *                 Postgres and partition against them, so you can see which
 *                 findings are ALREADY covered and avoid writing a duplicate
 *                 row. Requires DB access; omit for a pure offline replay.
 *
 * Exit codes — chosen so a caller cannot mistake a broken run for a clean one:
 *   0  scanned, no blocking findings
 *   1  blocking findings present (adjudicate each before exempting anything)
 *   2  the positive control DID NOT FIRE, or the commit could not be resolved —
 *      the run measured nothing. Never write an exemption from a 2.
 */
import { adjudicateRefusal, formatAdjudication } from '../packages/operator-core/lib/sync/pot-git/adjudicate-refusal.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const commit = arg('commit');
if (!commit) {
  console.error('usage: adjudicate-publish-refusal.mts --commit <sha> [--repo <path>] [--exemptions]');
  process.exit(2);
}

const repoPath = arg('repo') ?? process.cwd();

let exemptions: ReadonlySet<string> | undefined;
if (process.argv.includes('--exemptions')) {
  try {
    const { activeWorkspaceId } = await import('../packages/operator-core/lib/workspace-registry.ts');
    const { loadSecretsGuardPathExemptions } = await import(
      '../packages/operator-core/lib/sync/pot-git/secrets-guard-exemptions.ts'
    );
    exemptions = await loadSecretsGuardPathExemptions(await activeWorkspaceId());
  } catch (e) {
    // Fail LOUD: silently continuing with no exemptions would report already-
    // covered findings as blocking, which is the wrong direction for a tool
    // whose output justifies writing an exemption.
    console.error(`--exemptions requested but could not load them: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
}

try {
  const result = await adjudicateRefusal({ commit, repoPath, exemptions });
  console.log(formatAdjudication(result));
  if (!result.control.fired) process.exit(2);
  process.exit(result.blocking.length > 0 ? 1 : 0);
} catch (e) {
  console.error(`adjudication failed: ${e instanceof Error ? e.message : e}`);
  process.exit(2);
}
