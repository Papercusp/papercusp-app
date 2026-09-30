/**
 * The shipped brand packs.
 *
 * `classic` reproduces today's user-facing terminology (flag off = no visual
 * change). `the-hive` is the approved bee lexicon (plan
 * the-hive-lexicon-2026-06-06 D-002, as revised by D-007: Fleet→Colony,
 * Swarm = the deployment-to-instance unit). Term *keys* are brand-neutral; only the
 * labels here change. Internal identifiers (code, DB columns, MCP tool names,
 * repos) are NEVER driven by this map — it is presentation only (D-001).
 *
 * NOTE: `classic` labels are the baseline that must match the live UI at each
 * callsite that gets routed through the resolver. When a routed callsite shows
 * a different word today, fix the label here — never the callsite — so flag-off
 * stays identical.
 */
import type { BrandPack, BrandPackId, BuiltInTermKey } from './types';

const CLASSIC_TERMS: Record<BuiltInTermKey, { one: string; other: string }> = {
  // Owner directive 2026-07-04: public release ships the POT (Papercup) lexicon.
  // This REVERTS the 2026-06-16 "Pots are now Hives" baseline override — the
  // top-level grouping is a POT again in the classic/public pack (the full bee
  // theme, incl. Hive, stays flag-gated behind `the-hive` for internal/testing
  // use only). restore-pot-lexicon-public-release-2026-07-04 P-001 (keystone).
  pot: { one: 'Pot', other: 'Pots' },
  fleet: { one: 'Fleet', other: 'Fleets' },
  // Owner FINAL cast (2026-07-04, restore-pot-lexicon D-006): the Papercup
  // cup-character role names for the public/classic release. The always-on
  // front-door agent (`operator` key, = the-hive "Sentinel") is **Papercup**;
  // the high-judgment orchestrator (`brain` key, = the-hive "Queen") is **Mug**;
  // the system-health supervisor (`overwatch`) is **Kettle** (whistles when it
  // overheats); the idea-forager (`scout`) is **Blender**. the-hive keeps the
  // bee-theme names. (These are display labels only — backend ids unchanged, D-001.)
  operator: { one: 'Papercup', other: 'Papercups' },
  brain: { one: 'Mug', other: 'Mugs' },
  overwatch: { one: 'Kettle', other: 'Kettles' },
  scout: { one: 'Blender', other: 'Blenders' },
  // Pot/Cup/Cupboard theme (owner 2026-07-04, D-006): the worker/contributor is a
  // CUP (the backend id bee→cup mirrors this display label). A Pot holds Cups,
  // stored in the Cupboard.
  contributor: { one: 'Cup', other: 'Cups' },
  human: { one: 'Human', other: 'Humans' },
  chunk: { one: 'Chunk', other: 'Chunks' },
  cupboard: { one: 'Cupboard', other: 'Cupboards' },
  node: { one: 'Node', other: 'Nodes' },
  substrate: { one: 'Coordination', other: 'Coordination' },
  blueprint: { one: 'Blueprint', other: 'Blueprints' },
  harness: { one: 'Harness', other: 'Harnesses' },
  signal: { one: 'Signal', other: 'Signals' },
};

const THE_HIVE_TERMS: Record<BuiltInTermKey, { one: string; other: string }> = {
  pot: { one: 'Hive', other: 'Hives' },
  // Canon (owner revision 2026-06-08, the-hive-lexicon D-007 supersedes the
  // D-002 Fleet→Swarm row): the live collective of working agents is the
  // **Colony**. "Swarm" is reassigned to the deployment-to-instance unit (a
  // Hive runs 1..N Swarms) — see the `node` term below.
  fleet: { one: 'Colony', other: 'Colonies' },
  // Canon (owner revision 2026-06-07, supersedes the-hive-lexicon D-002 row):
  // the BRAIN — the persistent engineer session that places + supervises bees —
  // IS the Queen (matches the fleet's own Queen-dispatcher concept, e.g.
  // QUEEN_BRIEF / "the Queen reads for placement"). The operator chat — the
  // hive's conversational front door, always watching — is the Sentinel
  // (renamed from "Sentinel Bee", owner directive 2026-06-09 / hive-agent-tabs P-003).
  operator: { one: 'Sentinel', other: 'Sentinels' },
  brain: { one: 'Queen', other: 'Queens' },
  // The bee-theme keeps its role names; classic renames these to Kettle/Blender.
  overwatch: { one: 'Overwatch', other: 'Overwatches' },
  scout: { one: 'Scout', other: 'Scouts' },
  contributor: { one: 'Bee', other: 'Bees' },
  human: { one: 'Keeper', other: 'Keepers' },
  chunk: { one: 'Cell', other: 'Cells' },
  cupboard: { one: 'Comb', other: 'Combs' },
  // Canon (the-hive-lexicon D-007): a **Swarm** is a deployment of a Hive to a
  // single machine/instance — the machine-bound unit. The earlier
  // machine/region-node → "Frame" mapping collapses into Swarm. No UI surface
  // yet (the cloud-deployment Swarm work owns that); reserved here so the term
  // has a home and is never confused with the live-agent Colony (fleet).
  node: { one: 'Swarm', other: 'Swarms' },
  substrate: { one: 'Hive Mind', other: 'Hive Minds' },
  // Kept names (D-002): blueprint + harness stay as-is across packs.
  blueprint: { one: 'Blueprint', other: 'Blueprints' },
  harness: { one: 'Harness', other: 'Harnesses' },
  // Optional flavor — the waggle dance.
  signal: { one: 'Waggle', other: 'Waggles' },
};

export const CLASSIC_PACK: BrandPack = {
  id: 'classic',
  label: 'Classic (Papercusp)',
  terms: CLASSIC_TERMS,
};

export const THE_HIVE_PACK: BrandPack = {
  id: 'the-hive',
  // Admin/debug display name = the flag-on product brand. Kept as "The Swarm"
  // (P-008 "Product name decision" + the committed theswarm.dev domain / site /
  // CF project). The brand name is an OPEN owner decision — D-005 recorded "The
  // Hive" and D-007 reassigns "swarm" to a deployment unit, but the external
  // domain/email commitments make this the owner's call (the-hive-lexicon D-008).
  // Do NOT rename without it. (Independent of the Fleet→Colony term, which shipped.)
  label: 'The Swarm',
  terms: THE_HIVE_TERMS,
};

/** Registry of every shipped pack, keyed by id. */
export const BRAND_PACKS: Record<BrandPackId, BrandPack> = {
  classic: CLASSIC_PACK,
  'the-hive': THE_HIVE_PACK,
};

/** The default pack — the no-rebrand baseline (flag off). */
export const DEFAULT_PACK_ID: BrandPackId = 'classic';

/** Every shipped pack id. */
export const BRAND_PACK_IDS: readonly BrandPackId[] = Object.keys(
  BRAND_PACKS,
) as BrandPackId[];
