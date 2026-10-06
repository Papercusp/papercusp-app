import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { capabilityHash } from "../../dream/capability-contracts.ts";
import { buildFlatCalibrationBlind } from "./calibration.mts";
import { freezeImmutableArtifacts } from "./freeze-artifacts.mts";

const here = dirname(fileURLToPath(import.meta.url));
const blind = JSON.parse(
  await readFile(resolve(here, "calibration-blind-v2.json"), "utf8"),
);
const key = JSON.parse(
  await readFile(resolve(here, "calibration-key-v2.json"), "utf8"),
);
const sourceBlindHash = capabilityHash(JSON.stringify(blind));
if (sourceBlindHash !== key.blindHash)
  throw new Error("Frozen blind/key hash mismatch");

const { flatBlind } = buildFlatCalibrationBlind(blind);
const target = resolve(here, "calibration-flat-blind-v2.json");
const frozen = await freezeImmutableArtifacts([
  {
    path: target,
    bytes: JSON.stringify(flatBlind, null, 2) + "\n",
    label: "calibration-flat-blind-v2.json",
  },
]);
console.log(
  JSON.stringify({
    sourceBlindHash,
    flatBlindHash: capabilityHash(JSON.stringify(flatBlind)),
    cases: flatBlind.cases.length,
    providerCalls: 0,
    ledgerWrites: 0,
    ...frozen,
  }),
);
