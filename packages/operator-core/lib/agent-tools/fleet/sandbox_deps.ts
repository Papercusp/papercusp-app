/**
 * fleet:sandbox_deps — host-dependency diagnostic for the fleet OS sandbox
 * (fleet-spawn-sandbox-2026-06-01 P-011).
 *
 * The sandbox is default-on with `failIfUnavailable:true`, so a host missing
 * bubblewrap/socat (or hit by the Ubuntu 24.04+ AppArmor userns restriction)
 * fails every claude-code fleet spawn loudly. This read-only tool runs
 * `checkFleetSandboxHostDeps()` and returns the per-check verdicts + remedies
 * so "why are my spawns failing?" is one call, not a bwrap archaeology dig.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { checkFleetSandboxHostDeps } from '@papercusp/orchestrator';

export default defineTool({
  name: 'fleet:sandbox_deps',
  profile: 'engineer',
  description:
    'Check the host dependencies of the fleet spawn sandbox (bubblewrap/socat/srt, the Ubuntu 24.04+ AppArmor userns profile, container nesting, platform support). Read-only; returns per-check verdicts with remedies.',
  guidance: {
    when: 'Fleet spawns fail at sandbox startup, before enabling the sandbox on a new host/deployment, or when auditing a frame/VM before placing work on it.',
    notWhen:
      'Diagnosing a running service being down (use dev:service_health) or a spawn failing for non-sandbox reasons (read its run log first).',
    chaining:
      'fleet:sandbox_deps {} → fix the failed checks via their remedy lines (or opt the host out with PAPERCUSP_FLEET_SANDBOX=0) → retry the spawn.',
  },
  capability: 'intel:read',
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'cup', 'papercup'],
  args: z.object({}),
  async handler() {
    const report = checkFleetSandboxHostDeps();
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, report }) }],
    };
  },
});
