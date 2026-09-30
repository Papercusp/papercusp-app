import type { TestProject } from 'vitest/node';
import { getOrBuildTemplate, probePgReachable } from '@papercusp/test-config/pg';
import { orgTemplateKey, provisionOrgTemplate } from './_org-test-db.ts';

/**
 * Pre-warm the org fixture's migration template once per Vitest integration run.
 * The expensive empty→head migration replay must not consume an individual file's
 * beforeAll hook timeout; createOrgTestDb() then takes the near-instant clone path.
 */
export default async function setup(_project: TestProject) {
  const adminUrl = process.env.PAPERCUSP_TEST_PG_ADMIN_URL;
  if (adminUrl) {
    const reachable = await probePgReachable(adminUrl, 15_000).catch(() => ({ ok: false }));
    if (!reachable.ok) {
      process.stderr.write('[org-template-global-setup] skipping: test Postgres is unreachable\n');
      return;
    }
  }

  const key = orgTemplateKey();
  const startedAt = Date.now();
  try {
    const template = await getOrBuildTemplate(key, provisionOrgTemplate);
    process.stderr.write(
      `[org-template-global-setup] template ready key=${key} name=${template} elapsedMs=${Date.now() - startedAt}\n`,
    );
  } catch (error) {
    // A no-Docker/toolless run must still collect tests; the fixture will report
    // the substrate error if a test actually needs Postgres.
    process.stderr.write(
      `[org-template-global-setup] skipping: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}
