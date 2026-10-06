/**
 * locks:list payload-tier shapers (context-trimming-tiers-2026-07-01 P-023).
 * 7d MCP telemetry: avg 89.5KB/call — long registry rule_text/description ×
 * every registered resource, plus holder reasons. A trimmed/standard session
 * gets clipped registry rows + lean holder rows, capped with visible notice
 * rows (D-004: uniform keys per tier, loud cuts, payloadTier:"full" escape).
 */

export const LOCKS_LIST_TIER_CAPS = {
  trimmed: { resources: 60, holders: 40, rule: 100, description: 0, reason: 0, fileLockHolders: 8 },
  standard: {
    resources: 120,
    holders: 80,
    rule: 240,
    description: 160,
    reason: 120,
    fileLockHolders: 20,
  },
} as const;

type LocksTier = keyof typeof LOCKS_LIST_TIER_CAPS;

const clip = (s: unknown, n: number): string | null =>
  typeof s === "string" ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : null;

export function shapeLocksList(data: unknown, tier: LocksTier): unknown {
  const d = data as
    | ({ resources?: unknown[]; holders?: unknown[] } & Record<string, unknown>)
    | null
    | undefined;
  if (!d || !Array.isArray(d.resources) || !Array.isArray(d.holders)) return data;
  const c = LOCKS_LIST_TIER_CAPS[tier];

  const projectHolder = (row: unknown): Record<string, unknown> => {
    const r = (row ?? {}) as Record<string, unknown>;
    return {
      resource: r.resource ?? null,
      owner: r.owner ?? null,
      mode: r.mode ?? null,
      status: r.status ?? null,
      // locks:list sets this only for the current caller's own resource holds;
      // keep the key (null for peers) at every payload tier for stable shape.
      lock_id: r.lock_id ?? null,
      expires_ts: r.expires_ts ?? null,
      // EI-21733256625452096: this projection is an ALLOWLIST, so a field added
      // upstream is silently dropped here. locks:list merges holders across
      // coordination domains, and the domain is what tells a reader which
      // namespace holds the lock — stripping it at the trimmed tier would hide
      // that from exactly the sessions (su) that read this tool most.
      coordination_domain: r.coordination_domain ?? null,
      ...(c.reason > 0 ? { reason: clip(r.reason, c.reason) } : {}),
    };
  };
  const projectResource = (row: unknown): Record<string, unknown> => {
    const r = (row ?? {}) as Record<string, unknown>;
    return {
      resource: r.resource ?? null,
      enforcement: r.enforcement ?? null,
      rule: clip(r.rule_text, c.rule),
      ...(c.description > 0 ? { description: clip(r.description, c.description) } : {}),
      // EI-22073686775053989: this ALLOWLIST used to drop the whole reason a
      // resource row could ever be trusted about its own holders — `holders`
      // and `held` are the fix for the "resources[] carries no owner/holders"
      // bug, so an allowlist that stripped them at the trimmed/standard tiers
      // (the DEFAULT for most sessions) would silently reintroduce the exact
      // false-'free' failure the fix exists to kill. Project every nested
      // holder through the SAME projectHolder used for the flat array, so the
      // two views can never diverge in shape.
      holders: Array.isArray(r.holders) ? r.holders.map(projectHolder) : [],
      held: r.held ?? null,
    };
  };

  const resources = d.resources.slice(0, c.resources).map(projectResource);
  if (d.resources.length > c.resources) {
    resources.push({
      ...projectResource({}),
      resource: "(truncated)",
      rule: `showing ${c.resources} of ${d.resources.length} — pass {resource} for one, or payloadTier:"full"`,
    });
  }
  const holders = d.holders.slice(0, c.holders).map(projectHolder);
  if (d.holders.length > c.holders) {
    holders.push({
      ...projectHolder({}),
      owner: "(truncated)",
      status: `showing ${c.holders} of ${d.holders.length}`,
    });
  }
  return { ...d, resources, holders, ...shapeFileLocksPatch(d.fileLocks, c.fileLockHolders) };
}

/**
 * EI-20192110087737961: bound the `fileLocks` rollup per tier.
 *
 * ⚠ Deliberately NOT an allowlist projection. This file has twice had to be
 * repaired for exactly that (see projectHolder/projectResource above:
 * `coordination_domain` and then `holders`/`held` were each silently dropped by
 * an allowlist added upstream of them), and `fileLocks` is the block whose
 * whole purpose is that its COUNTS reach the reader — an allowlist that lost
 * `activeCount` would restore the false "nothing is locked" the block exists to
 * kill, at the trimmed tier, which is the default for the su sessions that read
 * this tool most. So: spread every key, slice only the holder rows, and stamp
 * the cut.
 *
 * `activeCount`/`waitingCount`/`distinctHolders`/`unreadable` are never clipped
 * at any tier. They are single scalars; there is no payload argument for
 * dropping them and every reason to keep them.
 */
function shapeFileLocksPatch(fileLocks: unknown, cap: number): { fileLocks?: unknown } {
  if (!fileLocks || typeof fileLocks !== "object") return {};
  const fl = fileLocks as Record<string, unknown>;
  if (!Array.isArray(fl.holders)) return { fileLocks };
  const all = fl.holders;
  if (all.length <= cap) return { fileLocks };
  return {
    fileLocks: {
      ...fl,
      holders: all.slice(0, cap),
      truncated: { showingHolders: cap, ofHolders: all.length },
    },
  };
}
