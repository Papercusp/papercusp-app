/**
 * work_items:set_live_verified — mark a (feature-family) work-item LIVE-VERIFIED
 * (release-pipeline-resilience-2026-06-09 P-013).
 *
 * "done" on a pipeline/operator work-item means code-on-staging; its value only exists once
 * DEPLOYED + exercised (the plan's own incident: the release-fixer was "done" yet had never fired on
 * a real red). This records an ADDITIVE payload marker with the exact tested, deployed, and green
 * SHAs after independently verifying their parity. It is
 * DISTINCT from the lifecycle state (the core state enum is deliberately untouched) so "shipped to
 * staging" is visibly separated from "confirmed live". Read release:trace first, then provide its
 * exact testedSha and deployedSha plus what you exercised as evidence. The handler re-reads live
 * deployment and green-pin authority and refuses the write if any SHA differs. clear:true retracts
 * it (e.g. after a rollback). Read it back via work_items:get
 * (payload.live_verified).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { devDeployState } from '../../dev-deploy-state';
import { classifyReleaseParity } from '../../release-parity';
import { getWorkItem, setWorkItemLiveVerified, type WorkItemLiveVerified } from '../../work-items';

const json = (o: unknown) => ({ data: o });

export default defineTool({
  name: 'work_items:set_live_verified',
  profile: 'engineer',
  description:
    'Mark a feature-family work-item LIVE-VERIFIED only when exact tested-SHA = claimed-deployed-SHA = actual-live-SHA = green-pin-SHA. Re-reads release authority and refuses mismatched or abbreviated SHAs; does not change lifecycle state. Read release:trace first, pass its testedSha + deployedSha and exercise evidence. clear:true retracts it. Non-feature items return applicable:false.',
  guidance: {
    when: 'A feature-family work-item is done on staging and you have exercised it live. Pass the exact testedSha and deployedSha from one fresh release:trace snapshot; this tool independently re-reads actual live + green-pin SHAs before writing.',
    notWhen:
      'Not for the lifecycle state (work_items:set_state) — this is an additive live-confirmation marker, not a state. Issue-family items return applicable:false.',
    chaining:
      'release:trace { sha, work_item } → exercise live behavior → work_items:set_live_verified { id, testedSha, deployedSha, evidence }. A refused response returns the parity state + release:trace as the recovery verb. clear:true retracts on rollback.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1).max(120).describe('The work-item id to mark (F-/WI-).'),
    harness: z.string().max(80).optional().describe('Harness the work-item lives in.'),
    testedSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/i)
      .optional()
      .describe('Exact 40-hex SHA whose green/test verdict is being relied upon; required when setting.'),
    deployedSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/i)
      .optional()
      .describe('Exact 40-hex deployed SHA reported by the same release:trace snapshot; required when setting.'),
    evidence: z.string().max(2000).optional().describe('What was exercised to confirm it live (the proof).'),
    clear: z.boolean().optional().describe('Retract the live_verified marker (e.g. after a rollback).'),
  }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const item = await getWorkItem(args.id, args.harness);
    if (!item) return json({ ok: false, error: `work_item '${args.id}' not found` });
    if (item.family !== 'feature') {
      return json({
        ok: true,
        applicable: false,
        id: item.id,
        note: 'live_verified applies to feature-family work-items only',
      });
    }

    let parity = null;
    let marker: WorkItemLiveVerified | null = null;
    if (!args.clear) {
      const release = await devDeployState();
      parity = classifyReleaseParity({
        testedSha: args.testedSha ?? null,
        claimedDeployedSha: args.deployedSha ?? null,
        actualDeployedSha: release.deployed?.sha ?? null,
        greenPinSha: release.greenPin?.sha ?? null,
      });
      if (!parity.ok) {
        return json({
          ok: false,
          refused: true,
          id: item.id,
          parity,
          nextVerb: parity.nextVerb,
        });
      }
      marker = {
        at: Date.now(),
        by: ident.ownerId,
        testedSha: parity.testedSha,
        deployedSha: parity.actualDeployedSha,
        greenPinSha: parity.greenPinSha,
        parity: 'matched',
        evidence: args.evidence ?? null,
      };
    }
    const res = await setWorkItemLiveVerified(args.id, marker, { harness: args.harness });
    if (!res) return json({ ok: false, error: `work_item '${args.id}' not found` });
    if (!res.applicable) {
      return json({
        ok: true,
        applicable: false,
        id: res.id,
        note: 'live_verified applies to feature-family work-items only',
      });
    }
    return json({
      ok: true,
      applicable: true,
      id: res.id,
      action: args.clear ? 'clear' : 'set',
      parity,
      liveVerified: res.liveVerified,
    });
  },
});
