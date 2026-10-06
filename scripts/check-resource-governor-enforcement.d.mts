export interface ResourceGovernorInventoryRow {
  id: string;
  migration: string;
  disposition: "govern" | "bypass" | "semantic" | "upstream" | "false-positive";
  enforcement: string;
  paths: readonly string[];
  resourceDimensions: readonly string[];
  fanOut: string;
  durableSource: string;
  telemetry: string;
  contextAndRelease: string;
  currentCaps: string;
  writerEvidence: string;
  sites: readonly { path: string; start: string }[];
}
export const RESOURCE_GOVERNOR_INVENTORY: readonly ResourceGovernorInventoryRow[];
export const RESOURCE_GOVERNOR_SCANNER_PATH: string;
export const P016_REVIEWED_DISPOSITIONS: readonly {
  path: string;
  code: string;
  disposition: ResourceGovernorInventoryRow["disposition"];
  reason: string;
  matchesSource?: (source: string) => boolean;
}[];
export const P016_DISPOSITION_REGISTRY: ReadonlyMap<
  string,
  { disposition: ResourceGovernorInventoryRow["disposition"]; reason: string; matchesSource?: (source: string) => boolean }
>;
export const BYPASS_REGISTRY: ReadonlyMap<
  string,
  {
    disposition: ResourceGovernorInventoryRow["disposition"];
    reason: string;
    matchesSource?: (source: string) => boolean;
  }
>;
export function inspectGovernorSource(source: string): string[];
export function validateInventory(
  rows?: readonly Partial<ResourceGovernorInventoryRow>[],
): string[];
export function scanActiveInventory(
  files: readonly (readonly [string, string])[],
  options?: { validateRegistry?: boolean | "strict" },
): string[];
export function scanInventory(
  files: readonly (readonly [string, string])[],
  options?: {
    migrations?: readonly string[];
    validateRegistry?: boolean | "strict";
  },
): string[];
