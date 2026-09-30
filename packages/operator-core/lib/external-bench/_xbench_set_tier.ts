#!/usr/bin/env -S npx tsx
/** Throwaway: ADD an additive 'opus46' model tier (spec claude-opus-4-6:xhigh) to the operator's
 *  AgentConfig so the su-independent bench launcher can pin its bee to Opus 4.6 (XBENCH_TIER=opus46)
 *  WITHOUT touching the fleet's existing tiers (quick/standard/deep/luna/max stay as-is). Reversible:
 *  re-run with REMOVE=1 to drop it. Persists to operator_state('operator_agent_config'); restart
 *  :3170 after so its readAgentConfig picks up the new tier. */
import { readAgentConfig, writeAgentConfig } from '../agent-config';
import { DEFAULT_MODEL_TIERS } from '../agent-config-constants';

async function main(): Promise<void> {
  const cfg = await readAgentConfig();
  const base = cfg.tiers && cfg.tiers.length ? cfg.tiers : [...DEFAULT_MODEL_TIERS];
  let tiers = base.filter((t) => t.name !== 'opus46');
  if (!process.env.REMOVE) {
    tiers = [...tiers, { name: 'opus46', spec: 'claude-opus-4-6:xhigh', when: 'bench: pin Opus 4.6 for the fair harness comparison' }];
  }
  await writeAgentConfig({ ...cfg, tiers });
  console.log('[set-tier] tiers now:', tiers.map((t) => `${t.name}=${t.spec}`).join(', '));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
