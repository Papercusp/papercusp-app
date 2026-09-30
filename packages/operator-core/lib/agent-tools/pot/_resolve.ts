/**
 * resolvePot — the single canonical read path for a local pot
 * (hive-tool-namespace-2026-06-08 P-001, D-001/D-003; P-012 landed).
 *
 * A pot is the registry-enumerated unit — a registered project whose
 * `harness_kind === 'hive'` (the built-in `hive` blueprint, POT_BLUEPRINT_ID),
 * plus its per-home-slug `pot-wake` routine + (workspace-scoped) event
 * subscriptions, plus a live Mug woken via the parentless system path —
 * keyed to the FIRST-CLASS Pot entity for identity. That entity shipped:
 * `harness_shared.pots` holds each pot's stable Ed25519 keypair
 * (shared-hive-federation-2026-06-08 P-002, owner-ratified multiplicity D-008 =
 * many hives per workspace), and this descriptor composes the two — the registry
 * is the enumeration source (D-008: hives ARE the `kind:'hive'` projects), the
 * `hives` table is identity. So `resolvePot` enumerates via the registry and
 * layers the first-class identity on each (the `pubkey`, pubkey-addressability),
 * lazy-backfilling the keypair on first resolve. This is the P-012 re-point:
 * every `pot:*` read goes through this one descriptor and the tool signatures
 * stay fixed.
 *
 * This is identity + deployment + wake ONLY — the live aggregate view (cups,
 * frontier depth, harness health) is layered on top by `pot:get`, which joins
 * fleet:assignments / work_items / harness:status. Keeping that out of here
 * keeps `pot:list` cheap (no per-pot fleet fan-out).
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import type { DeploymentConfig, Frame } from '@papercusp/deployment-driver';
import { loadHarnessRegistry, type ProjectEntry } from '../../harness-registry';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  getPotTimeWake,
  readPotWakeState,
  type PotEventSubscription,
} from '../../pot/wake';
import { resolveHivePubkey } from '../../hive-identity';
import { getHiveByPubkey } from '../../hive-store';

/** The `harness_kind` marker a pot's home harness carries in the registry. */
export const POT_KIND = 'hive';

/** The Mug's declared next/last wake for a pot. The time wake is per-home-slug
 *  (a `pot-wake` routine row); the event subscriptions + lastWakeAt are
 *  workspace-scoped today (`hive_wake` state is one row per workspace) — a known
 *  limitation the first-class Pot entity fixes (then they become per-pot). */
export interface PotWakeView {
  active: boolean;
  nextFireAt: string | null;
  lastFiredAt: string | null;
  subscriptions: PotEventSubscription[];
  lastWakeAt: string | null;
}

export interface PotDescriptor {
  /** The home-harness slug — the local pot identity TODAY (D-003). */
  slug: string;
  path: string;
  kind: typeof POT_KIND;
  /**
   * The deployment-frame federated id, when this pot has been deployed/published
   * and its control/deployment frame carries a `hive_id`. Undefined for a purely
   * -local pot. Distinct from the first-class `pubkey` identity below: this is the
   * frame-derived deployment handle; `pubkey` is the canonical dial-able Pot id.
   */
  potId?: string;
  /**
   * The Pot's first-class identity: its raw-32 base64 Ed25519 PUBLIC key
   * (shared-hive-federation-2026-06-08 P-002). This is the dial-able id and the
   * federation topic key (P-003, derivePotFederationTopic). Minted on
   * pot:create and lazy-backfilled on first resolve; undefined only when identity
   * backfill failed (e.g. the keychain is unavailable). The secret never leaves
   * the owning Swarm's keychain.
   */
  pubkey?: string;
  /**
   * P-007 (pot-from-repo-hardening D-007): a joiner-side VIEW of someone
   * else's pot — local grouping only; no identity, no listing, never
   * announces. Absent for owned hives.
   */
  remote?: true;
  deployment: DeploymentConfig;
  deployed: boolean;
  wake: PotWakeView;
}

/** Is this registry project a pot (its home harness)? */
export function isPotProject(p: ProjectEntry): boolean {
  return p.harness_kind === POT_KIND;
}

/** Best-effort federated id for a deployed pot (its frame's hive_id). */
function framePotId(p: ProjectEntry): string | undefined {
  const frame = p.deploymentFrame as (Frame & { hive_id?: string }) | undefined;
  return frame?.hive_id;
}

async function buildWakeView(
  sql: Sql,
  homeSlug: string,
  workspaceId: string,
): Promise<PotWakeView> {
  // K1 (workspace-scoped-coordination P-003): read the workspace-papercup wake
  // routine when the flag is ON (OFF ⇒ per-pot, unchanged).
  const time = await getPotTimeWake(sql, homeSlug, { workspaceId });
  const state = await readPotWakeState(workspaceId);
  return {
    active: time?.active ?? false,
    nextFireAt: time?.nextFireAt ? new Date(time.nextFireAt).toISOString() : null,
    lastFiredAt: time?.lastFiredAt ? new Date(time.lastFiredAt).toISOString() : null,
    subscriptions: state.subscriptions,
    lastWakeAt: state.lastWakeAt ? new Date(state.lastWakeAt).toISOString() : null,
  };
}

/** Pure: project a registry entry + its wake view into the descriptor. Exported
 *  so the shaping is unit-testable without PG (mirrors fleet/assignments' pure
 *  selectors). */
export function describePot(
  p: ProjectEntry,
  wake: PotWakeView,
  pubkey?: string,
): PotDescriptor {
  const potId = framePotId(p);
  return {
    slug: p.slug,
    path: p.path,
    kind: POT_KIND,
    ...(potId ? { potId } : {}),
    ...(pubkey ? { pubkey } : {}),
    ...(p.remote_hive ? { remote: true as const } : {}),
    deployment: p.deployment ?? { target: 'local' },
    deployed: Boolean(p.deploymentFrame),
    wake,
  };
}

/** Pure: distinct live agents per harness slug, from raw fleet-assignment rows —
 *  the per-pot count `pot:list` shows, extracted so it unit-tests without PG. */
export function liveAgentCountByHarness(
  rows: ReadonlyArray<{ holderAlive: boolean; harnessSlug: string | null; agentId: string | null }>,
): Map<string, number> {
  const byHarness = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.holderAlive && r.harnessSlug && r.agentId) {
      let s = byHarness.get(r.harnessSlug);
      if (!s) {
        s = new Set<string>();
        byHarness.set(r.harnessSlug, s);
      }
      s.add(r.agentId);
    }
  }
  const out = new Map<string, number>();
  for (const [h, s] of byHarness) out.set(h, s.size);
  return out;
}

/**
 * Resolve one pot by its home-slug (or, forward-compat, its potId). Returns
 * null when no `kind:'hive'` project matches — callers surface a clean
 * `hive_not_found` rather than guessing.
 */
export async function resolvePot(
  idOrSlug: string,
  workspaceId?: string,
): Promise<PotDescriptor | null> {
  const ws = workspaceId ?? activeWorkspaceId();
  const reg = await loadHarnessRegistry(ws);
  let p = reg.projects.find(
    (x) => isPotProject(x) && (x.slug === idOrSlug || framePotId(x) === idOrSlug),
  );
  // Forward-compat: a Pot is addressable by its pubkey identity, not just its
  // home-slug (D-002). When the id is neither a slug nor a frame id, resolve the
  // pubkey -> home-slug via the entity table.
  if (!p) {
    const byKey = await getHiveByPubkey(ws, idOrSlug);
    if (byKey) p = reg.projects.find((x) => isPotProject(x) && x.slug === byKey.homeSlug);
  }
  if (!p) return null;
  const { sql } = getOrgPg();
  const wake = await buildWakeView(sql, p.slug, ws);
  const pubkey = await resolveHivePubkey(ws, p.slug);
  return describePot(p, wake, pubkey);
}

/** Every pot (kind:'hive' project) in the workspace, resolved. */
export async function listPots(workspaceId?: string): Promise<PotDescriptor[]> {
  const ws = workspaceId ?? activeWorkspaceId();
  const reg = await loadHarnessRegistry(ws);
  const hives = reg.projects.filter(isPotProject);
  if (hives.length === 0) return [];
  const { sql } = getOrgPg();
  const out: PotDescriptor[] = [];
  for (const p of hives) {
    const pubkey = await resolveHivePubkey(ws, p.slug);
    out.push(describePot(p, await buildWakeView(sql, p.slug, ws), pubkey));
  }
  return out;
}

/**
 * The workspace's HOME pot slug — `PAPERCUSP_POT_HOME_SLUG` when set, else the
 * FIRST formal pot in the registry (the same slug the 👑-tab UI writes steering
 * to via `resolveHomePot`). The env var is unset on the dev/green operators, so
 * the env-only `resolvePotHomeSlug()` returns null there — which silently skipped
 * the owner-steering MODEL-TIER override read at the spawn chokepoint (the override
 * was written to the formal pot but never read). This registry fallback makes the
 * read resolve the SAME slug the UI wrote to, so the override actually applies.
 * (mug-steering-panel GAP 1, 2026-06-17.) Async (registry); fail-soft.
 */
export async function resolveHomePotSlug(workspaceId?: string): Promise<string | null> {
  const env = process.env.PAPERCUSP_POT_HOME_SLUG?.trim();
  if (env) return env;
  const hives = await listPots(workspaceId).catch(() => []);
  return hives[0]?.slug ?? null;
}
