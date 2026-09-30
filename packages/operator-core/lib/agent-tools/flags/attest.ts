/**
 * flags:attest — ask each reachable long-lived process what it actually
 * resolves for one flag, including process-cache provenance and TTL state.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import type { FlagKey } from '@papercusp/flags';
import { resolveDistinctId } from '../../flag-distinct-id';
import { assertKnownFlagKey, buildProcessFlagAttestation, type ProcessFlagAttestation } from '../../flag-attestation';
import { collectRemoteFlagAttestations } from '../../flag-attestation-federation';
import { describeProcessRole, ownHonoPort } from '../../schedule-federation';
import './_register-backend';

export interface FlagAttestationReport {
  ok: true;
  key: FlagKey;
  status: 'consistent' | 'divergent' | 'partial';
  consistent: boolean;
  completeCoverage: boolean;
  reference: ProcessFlagAttestation;
  processes: ProcessFlagAttestation[];
  mismatches: Array<{
    process: string;
    resolvedValue: boolean;
    compiledDefault: boolean;
    source: string;
  }>;
  defaultMismatches: Array<{
    process: string;
    resolvedValue: boolean;
    compiledDefault: boolean;
    source: string;
  }>;
  cacheWindowProcesses: Array<{
    process: string;
    cacheGeneration: number | null;
    ttlRemainingMs: number;
    source: string;
    readKind: string;
  }>;
  unknownProcesses: Array<{ target: string; error: string }>;
}

export async function buildFlagAttestationReport(
  key: FlagKey,
  distinctId: string,
  deps: {
    local?: () => Promise<ProcessFlagAttestation>;
    remote?: typeof collectRemoteFlagAttestations;
  } = {},
): Promise<FlagAttestationReport> {
  const port = ownHonoPort();
  const role = describeProcessRole();
  const local = await (
    deps.local ??
    (() =>
      buildProcessFlagAttestation(key, distinctId, {
        role,
        label: `${role}:${port}`,
        port,
      }))
  )();
  const remoteResults = await (deps.remote ?? collectRemoteFlagAttestations)(key, distinctId);
  const processes = [
    local,
    ...remoteResults.flatMap((result) => (result.ok && result.attestation ? [result.attestation] : [])),
  ];
  const unknownProcesses = remoteResults.flatMap((result) =>
    result.ok ? [] : [{ target: result.target.label, error: result.error ?? 'unknown probe failure' }],
  );
  const mismatches = processes
    .filter((row) => row.resolvedValue !== local.resolvedValue || row.compiledDefault !== local.compiledDefault)
    .map((row) => ({
      process: row.process.label,
      resolvedValue: row.resolvedValue,
      compiledDefault: row.compiledDefault,
      source: row.source,
    }));
  const defaultMismatches = processes
    .filter((row) => row.resolvedValue !== row.compiledDefault)
    .map((row) => ({
      process: row.process.label,
      resolvedValue: row.resolvedValue,
      compiledDefault: row.compiledDefault,
      source: row.source,
    }));
  const cacheWindowProcesses = processes
    .filter((row) => row.overrideRead.cacheGeneration !== null && row.overrideRead.ttlRemainingMs > 0)
    .map((row) => ({
      process: row.process.label,
      cacheGeneration: row.overrideRead.cacheGeneration,
      ttlRemainingMs: row.overrideRead.ttlRemainingMs,
      source: row.source,
      readKind: row.overrideRead.kind,
    }));
  const consistent = mismatches.length === 0;
  const completeCoverage = unknownProcesses.length === 0;
  return {
    ok: true,
    key,
    status: !consistent ? 'divergent' : completeCoverage ? 'consistent' : 'partial',
    consistent,
    completeCoverage,
    reference: local,
    processes,
    mismatches,
    defaultMismatches,
    cacheWindowProcesses,
    unknownProcesses,
  };
}

export default defineTool({
  name: 'flags:attest',
  profile: 'engineer',
  description:
    'Ask the calling operator, every discovered operator-shaped sibling, and the inference gateway what they ACTUALLY resolve for one feature flag. Returns per-process value, compiled default, resolution source, cache generation/age/TTL, process identity/build SHA, cross-process mismatches, and explicit unknown targets. This diagnoses runtime flag divergence without inferring live state from source files.',
  capability: 'intel:read',
  guidance: {
    when: 'A flag appears to ignore flags:set, two services behave as though a flag differs, or you need runtime proof before attributing behavior to a flag/default/TTL cache.',
    notWhen:
      'To discover flag keys use flags:list. To change a value use flags:set. A partial report has UNKNOWN coverage; do not read it as agreement from an unreachable process.',
    seeAlso: [
      'flags:get (single-host boolean without provenance)',
      'flags:list (discover live flag keys)',
      'deploys:vintage (which build each runtime loaded)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'worker', 'validator', 'reviewer', 'debugger'],
  args: z.object({ key: z.string().min(1) }).strict(),
  async handler(args) {
    assertKnownFlagKey(args.key);
    const distinctId = resolveDistinctId(new Request('http://localhost/agent-tool'));
    return { data: await buildFlagAttestationReport(args.key, distinctId) };
  },
});
