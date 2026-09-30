/**
 * Instance manifest: the complete snapshot of a papercusp instance for Apiary runs.
 * (D-006: Lineage manifests — attributable, statistically re-runnable)
 */

export interface InstanceManifest {
  /** Unique instance identifier. */
  instanceId: string;
  /** The workspace this instance belongs to (for sealing/isolation). */
  workspaceId: string;
  /** Code SHA at boot time (for reproducibility). */
  codeSha: string;
  /** Genome (mutable config) ID — if this is a variant run. Optional for baseline. */
  genomeId?: string;
  /** Memory snapshot ID — if this instance seeded from a prior snapshot. */
  memorySnapshotId?: string;
  /** Battery slice ID — which task pool rotation this instance uses. */
  batterySliceId?: string;
  /** Window constraint (in ms from creation). */
  windowMs?: number;
  /** Creation timestamp. */
  createdAt: Date;
}

export interface InstanceBootSpec {
  manifest: InstanceManifest;
  /** How to reach this instance (localhost:3055, remote URL, etc). */
  instanceUrl: string;
  /**
   * Spawn-time per-role model overrides (`model.<role>` → model id) — the model-per-role
   * axis the experiment knob space varies (experiment-registry-invocation-api D-003/P-063).
   * The live `runInstance` applies these as the boot's AGENT_MODELS-style override. Kept OFF
   * the manifest deliberately, so it never changes the genome/content-address fairness key.
   */
  modelOverrides?: Record<string, string>;
}

export interface InstanceRunHandle {
  instanceId: string;
  instanceUrl: string;
  /** The harness or workspace being tested. */
  targetSlug?: string;
  /** Cost of this run against the instance (LLM + API calls). */
  costUsd: number;
}
