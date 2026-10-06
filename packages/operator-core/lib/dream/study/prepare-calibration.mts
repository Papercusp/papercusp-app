import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getOrgPg } from "@papercusp/db-org";
import { mapDreamRun } from "../../dream/dream-run-store.ts";
import { STUDY_BLOCKS, validateStudyBlocks } from "./accounting.mts";
import { buildCalibrationBundle } from "./calibration.mts";
import { freezeImmutableArtifacts } from "./freeze-artifacts.mts";

const here = dirname(fileURLToPath(import.meta.url));
const workspaceId = "papercusp-workspace";
process.env.PAPERCUSP_WORKSPACE_ID = workspaceId;
const blocks = await Promise.all(
  Object.values(STUDY_BLOCKS).map(async (b) =>
    JSON.parse(await readFile(resolve(here, b.file), "utf8")),
  ),
);
validateStudyBlocks(blocks);
const pins = blocks.map((b) => b.pin);
const { sql } = getOrgPg();
try {
  // An uncapped census over exactly the frozen study identities; no live/global backlog.
  const rows = await sql`
    SELECT * FROM harness_shared.dream_runs
    WHERE workspace_id = ${workspaceId} AND pot_slug = 'papercusp'
      AND outcome->'capabilityRun'->'evaluation'->>'protocolPin' = ANY(${pins}::text[])
    ORDER BY started_at, run_id`;
  const { blind, key } = buildCalibrationBundle(rows.map(mapDreamRun));
  // Validate the whole set before creating anything; re-running may verify,
  // never silently replace or partially extend a frozen batch.
  await freezeImmutableArtifacts(
    [
      ["calibration-blind-v2.json", blind],
      ["calibration-key-v2.json", key],
    ].map(([file, value]) => ({
      path: resolve(here, file as string),
      bytes: JSON.stringify(value, null, 2) + "\n",
      label: file as string,
    })),
  );
  console.log(
    JSON.stringify({
      blindHash: key.blindHash,
      population: key.population,
      eligibleCandidates: key.eligibleCandidates,
      selected: blind.cases.length,
      excluded: key.excluded.length,
      strata: [...new Set(key.selected.map((c) => c.stratum))].length,
      independentLabels: key.independentLabels,
      providerCalls: 0,
      ledgerWrites: 0,
      source: "existing frozen dream_runs; original review unchanged",
    }),
  );
} finally {
  await sql.end({ timeout: 5 });
}
