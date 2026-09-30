/**
 * Seed the `corpus-term-df` routine — the refresh cadence for the corpus
 * document-frequency table behind BANDED term selection in `corpusQueryText`
 * (context-injection-retrieval-reach-and-visibility-2026-08-03 P-018 / D-064;
 * handler in `corpus-term-df-action.ts`, upsert in
 * `memory/corpus-term-df-routine.ts`).
 *
 *   - `corpus-term-df` (every 6h): re-fold a corpus sample through `corpusTerms`
 *     and REPLACE the workspace's DF table. Pure local tokenisation — spawns no
 *     agent, makes no LLM call, and is idempotent (a re-run over an unchanged
 *     corpus produces the same table).
 *
 * SEEDED ACTIVE by default. The table is ADDITIVE: until it is first populated
 * the lookup returns null and the leg keeps its original length ordering, so
 * there is no dark-launch step to gate and nothing to verify before arming.
 * Leaving it inactive would be the failure mode the flag rules name — finished
 * work that does nothing.
 *
 *   tsx seed-corpus-term-df-routine.ts              # seed ACTIVE (the default)
 *   tsx seed-corpus-term-df-routine.ts --inactive   # seed disabled
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import { upsertCorpusTermDfRoutine } from '../../memory/corpus-term-df-routine';

const SLUG = process.env.CORPUS_TERM_DF_ROUTINE_SLUG ?? operatorHomeHarnessSlug();

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();

  const { id } = await upsertCorpusTermDfRoutine(sql, {
    workspaceId: ws,
    installSlug: SLUG,
    active,
  });

  console.log(
    `[seed-corpus-term-df-routine] seeded "corpus-term-df" (${id}) for "${SLUG}" (ws=${ws}, active=${active}) — ` +
      `6-hourly rebuild of the corpus term document-frequency table used by banded query-term selection. ` +
      (active ? 'Cadence LIVE.' : 'Inactive — enable with the routines admin.'),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-corpus-term-df-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
