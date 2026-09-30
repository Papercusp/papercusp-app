/**
 * Adapter: Action Registry (`lib/commands`) → `Capability[]` (P-003, browser half).
 *
 * Read-only projection — no Action-Registry definitions move. The caller
 * passes `list(...)` output so this stays pure/testable (no registry
 * side-effect import here).
 */
import type { Capability } from './types';
import { schemaRequiresArgs } from './introspection';
import { humanizeCapabilityId, shorten } from './format';
import type { Definition, CommandDef } from '../commands/types';

// Action-Registry commands are reflexive UI; none today are destructive, but
// guard the mapping by id so a future `*.delete`-style command maps correctly.
const DESTRUCTIVE_RE = /(?:^|[._:-])(delete|remove|kill|destroy|reset|rollback|cancel|dismiss|purge|drop)(?:$|[._:-])/i;

export function actionDefToCapability(def: Definition): Capability {
  const cmd = def.kind === 'command' ? (def as CommandDef) : null;

  // `CommandDef.browser` (required|optional|none) maps losslessly to runsIn;
  // queries have no browser field and are server-side reads.
  const runsIn = !cmd
    ? 'server'
    : cmd.browser === 'required'
      ? 'browser'
      : cmd.browser === 'optional'
        ? 'hybrid'
        : 'server';

  const pe = cmd?.paletteEntry;

  return {
    id: def.id,
    title: pe?.title ?? humanizeCapabilityId(def.id),
    description: shorten(def.description),
    agentDescription: def.promptDescription,
    runsIn,
    requiresArgs: schemaRequiresArgs(def.schema),
    concurrent: cmd?.concurrent,
    destructive: DESTRUCTIVE_RE.test(def.id),
    // CommandDef.tier is the reflexive|delegation axis, NOT a risk tier — these
    // user-initiated UI commands are low risk.
    tier: 'low',
    gating: { agentRoles: [...def.agents] },
    surfaces: pe
      ? { palette: { section: pe.section, icon: pe.icon, keywords: pe.keywords } }
      : undefined,
  };
}

export function actionRegistryToCapabilities(defs: readonly Definition[]): Capability[] {
  return defs.map(actionDefToCapability);
}
