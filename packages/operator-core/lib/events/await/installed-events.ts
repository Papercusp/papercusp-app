/**
 * installed-events — read the `provides.events` declarations off the units that are
 * actually INSTALLED on this host (cupboard-public-release-2026-07-12 P-006, D-003).
 *
 * This is the I/O half of the installed catalog tier. The MERGE itself
 * (`mergeInstalledEventCatalog` in ./catalog) is pure and stays that way: ./catalog is
 * imported by the sugar verbs and the poll-site hints, and must not drag a plugin-host
 * warm-up into those paths. Same pure-assembler / derive-wrapper split that
 * `assemblePackCatalog` / `derivePackCatalog` already use for the tool axis — this is
 * the event axis's `derive`.
 *
 * TWO SOURCES, deliberately in this order (mirroring derivePackCatalog):
 *   1. the warmed plugin host's `loaded` list — the truthful installed set. It includes
 *      the BUNDLED units (libs/papercusp/plugins) that the on-disk manifest scan does
 *      not walk, so a bundled pack's event families would be invisible without it.
 *   2. the on-disk manifest scan — adds units that are installed but NOT loaded (a pack
 *      is pure data and has no runtime to load, so for PACKS this is the only source).
 * Dedup is by unit name, first-wins, so a unit present in both is read once from the
 * richer host entry.
 *
 * FAIL-SOFT, ALWAYS. A missing host, an unreadable plugins dir, or a malformed manifest
 * must never break `events:catalog` — the whole point of that tool is that an agent can
 * discover an awaitable key INSTEAD of polling. Degrading to the builtin-only catalog is
 * a bad day; throwing turns a discoverability tool into a dead end and pushes the agent
 * straight back to the polling this subsystem exists to kill.
 */

import type { InstalledUnitEvents, ManifestEventDeclaration } from './catalog';

/** The shape we read off a manifest — `provides.events` is P-005's unit-level surface. */
interface UnitManifestLike {
  name?: unknown;
  provides?: { events?: unknown } | null;
}

/** Pull `provides.events` off one manifest, or null when the unit declares none. */
function unitEvents(m: UnitManifestLike | null | undefined): InstalledUnitEvents | null {
  if (m == null || typeof m !== 'object') return null;
  const name = typeof m.name === 'string' ? m.name.trim() : '';
  if (!name) return null;
  const raw = m.provides?.events;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return { unit: name, events: raw as ManifestEventDeclaration[] };
}

/**
 * Every installed unit that declares at least one event family, ready for
 * `mergeInstalledEventCatalog`. Units declaring no events are omitted entirely (they
 * would merge to nothing anyway, and an empty row is noise in the catalog).
 *
 * `warmHost:false` skips the plugin-host warm-up — for tests and pure-ish contexts, at
 * the cost of missing bundled units. Matches derivePackCatalog's flag of the same name.
 */
export async function readInstalledUnitEvents(
  opts: { harnessSlug?: string; warmHost?: boolean } = {},
): Promise<InstalledUnitEvents[]> {
  const out: InstalledUnitEvents[] = [];
  const seen = new Set<string>();

  const push = (m: UnitManifestLike | null | undefined) => {
    const u = unitEvents(m);
    if (!u || seen.has(u.unit)) return;
    seen.add(u.unit);
    out.push(u);
  };

  // 1. the warmed host (bundled + loaded units — the ones the disk scan misses)
  if (opts.warmHost !== false) {
    try {
      const { getPluginHost } = await import('../../plugin-host-runtime');
      const host = await getPluginHost();
      for (const lp of host.loaded) push(lp.plugin as UnitManifestLike);
    } catch {
      /* headless/test context without a host — the disk scan below still applies */
    }
  }

  // 2. the on-disk scan (installed-but-not-loaded units; the ONLY source for pure packs)
  try {
    const { listAllInstalledPlugins } = await import('../../cupboard/plugin-listings');
    for (const m of await listAllInstalledPlugins(opts.harnessSlug)) push(m as UnitManifestLike);
  } catch {
    /* unreadable plugins dir — degrade to whatever the host gave us */
  }

  return out;
}
