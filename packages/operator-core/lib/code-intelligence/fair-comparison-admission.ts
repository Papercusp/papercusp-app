/**
 * P-017 arm ADMISSION — D-011: "each arm admitted only after its LICENSE file is
 * read; licence + telemetry default recorded in the report".
 *
 * This is curated data (rung 4 of the derived-truth ladder): reading a licence
 * and a privacy section is judgment, not something the build can derive. What
 * the build CAN do is refuse to run an arm whose admission is incomplete —
 * {@link admitArm} is that check, and the CLI calls it before any arm starts.
 *
 * Every licence was read from the repository's own LICENSE file on 2026-10-06
 * (copies + sha256 under `~/.papercusp/bench/fair-comparison-2026-10/licenses/`).
 * `licenceSha256Prefix` pins the text that was read; if upstream changes it, the
 * admission must be re-read rather than assumed.
 */
import type { LicenceClass } from './fair-comparison';

export interface ArmAdmission {
  readonly armId: string;
  /** Where the engine comes from (repo, or 'first-party' for our own code). */
  readonly upstream: string;
  readonly spdx: string;
  readonly licence: LicenceClass;
  /** First 16 hex chars of sha256(LICENSE) as read; null for first-party code. */
  readonly licenceSha256Prefix: string | null;
  /** What the engine sends home by default, in one line. */
  readonly telemetryDefault: string;
  /** Environment that disables it; applied to EVERY process the arm spawns. */
  readonly telemetryOffEnv: Readonly<Record<string, string>>;
}

export const ARM_ADMISSIONS: readonly ArmAdmission[] = Object.freeze<ArmAdmission[]>([
  {
    armId: 'rg',
    upstream: 'BurntSushi/ripgrep',
    spdx: 'MIT OR Unlicense',
    licence: 'permissive',
    licenceSha256Prefix: null,
    telemetryDefault: 'none (local CLI)',
    telemetryOffEnv: {},
  },
  {
    armId: 'lsp-query',
    upstream: 'first-party (lsp:query facade over the vendored typescript-language-server)',
    spdx: 'first-party',
    licence: 'first-party',
    licenceSha256Prefix: null,
    telemetryDefault: 'none',
    telemetryOffEnv: {},
  },
  {
    armId: 'no-third-party',
    upstream: 'first-party (static import index + TypeScript call hierarchy)',
    spdx: 'first-party',
    licence: 'first-party',
    licenceSha256Prefix: null,
    telemetryDefault: 'none',
    telemetryOffEnv: {},
  },
  {
    armId: 'gitnexus',
    upstream: 'abhigyanpatwari/GitNexus',
    spdx: 'PolyForm-Noncommercial-1.0.0',
    licence: 'noncommercial',
    licenceSha256Prefix: 'b3e617e5e5eea01b',
    telemetryDefault: 'not verified in this pass; run offline-only like the 2026-10-02 bench',
    telemetryOffEnv: {},
  },
  {
    armId: 'codebase-memory',
    upstream: 'DeusData/codebase-memory-mcp',
    spdx: 'MIT',
    licence: 'permissive',
    licenceSha256Prefix: '1f58f9911dc5e3bc',
    telemetryDefault: 'none (README: "runs 100% locally and collects no telemetry")',
    telemetryOffEnv: {},
  },
  {
    armId: 'codegraph',
    upstream: 'colbymchenry/codegraph (npm @colbymchenry/codegraph)',
    spdx: 'MIT',
    licence: 'permissive',
    licenceSha256Prefix: 'e6d98f98c666bebe',
    telemetryDefault: 'ON: anonymous daily usage aggregates (tools, commands, languages)',
    telemetryOffEnv: { CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1' },
  },
  {
    armId: 'trace-mcp',
    upstream: 'nikolai-vysotskyi/trace-mcp',
    spdx: 'MIT',
    licence: 'permissive',
    licenceSha256Prefix: 'b1fe50b5449d529d',
    telemetryDefault: 'ON: one anonymous GA4 install ping per day',
    telemetryOffEnv: { TRACE_MCP_TELEMETRY: 'off' },
  },
  {
    armId: 'codegraphcontext',
    upstream: 'CodeGraphContext/CodeGraphContext (PyPI codegraphcontext)',
    spdx: 'MIT',
    licence: 'permissive',
    licenceSha256Prefix: 'ae1f0cf9b2694182',
    telemetryDefault: 'none declared; installed source grepped for telemetry clients before running',
    telemetryOffEnv: {},
  },
]);

/** The engine's arm id with any version suffix removed (`gitnexus@1.6.9` -> `gitnexus`). */
const baseId = (armId: string): string => armId.split('@')[0]!;

/**
 * Refuse an arm that has no admission, or whose admission is incomplete. Returns
 * the environment the arm's processes must run under (telemetry off).
 */
export function admitArm(armId: string): { admission: ArmAdmission; env: Readonly<Record<string, string>> } {
  const admission = ARM_ADMISSIONS.find((a) => a.armId === baseId(armId));
  if (!admission) throw new Error(`arm ${armId} has no admission record: read its LICENSE and telemetry defaults first (D-011)`);
  const thirdParty = admission.licence !== 'first-party';
  if (thirdParty && admission.armId !== 'rg' && !admission.licenceSha256Prefix) {
    throw new Error(`arm ${armId}: third-party licence admitted without a pinned LICENSE hash`);
  }
  if (/^ON\b/.test(admission.telemetryDefault) && Object.keys(admission.telemetryOffEnv).length === 0) {
    throw new Error(`arm ${armId}: telemetry is on by default and no opt-out env is recorded`);
  }
  return { admission, env: admission.telemetryOffEnv };
}
