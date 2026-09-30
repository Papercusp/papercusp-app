/**
 * hive-git-mode — the per-hive GitHub-bridge mode seam
 * (github-bridge-hive-egress-2026-07-02 P-003 / S-5, decisions D-001/D-002).
 *
 * One hive-wide switch decides WHO pushes the GitHub remote:
 *
 *   - `legacy`   (DEFAULT, and the value for every hive with no setting):
 *     today's behavior byte-for-byte — each member's git-sync routine pushes
 *     origin per `decideGitSyncPush`'s existing five rules. Non-bridged hives
 *     never change behavior.
 *   - `bridged`  : the hive code plane is P2P (`lib/sync/hive-git/`) AND the
 *     GitHub bridge egresses canonical refs (plan P-001, S-2). Member git-sync
 *     goes COMMIT-ONLY — the bridge writer (the integrator lock-authority
 *     lease holder, D-002) is the SOLE origin pusher, so a member routine
 *     pushing origin alongside it would double-push / race the canonical refs.
 *   - `p2p-only` : the hive syncs exclusively on the P2P plane; no GitHub
 *     remote is pushed by anyone (no bridge either). Member git-sync is
 *     commit-only.
 *
 * The mode lives in the FEDERATED `hive_settings` store (key `hiveGit.mode`,
 * same idiom as `release.greenCmd`) so one owner-side flip reaches every
 * member machine's seed AND run paths — a member must never need a re-seed to
 * stop double-pushing (the run-time gate in git-sync-action re-consults this
 * every tick).
 *
 * Pure coercion + a thin read/write accessor pair over `hive-settings-store`;
 * junk-safe like `coerceHivePolicyInput` — an unknown/malformed value reads as
 * `legacy` (fail-open to today's behavior, never to a silent push-stop).
 *
 * ACCEPTED RISK (review 2026-07-02): fail-open means a PG blip on a BRIDGED
 * hive briefly re-enables member push → a possible double-push window against
 * the bridge writer. Safe by construction: both pushers are FF-only + CAS, so
 * one wins and the other rejects noisily — divergence surfaces, refs never
 * corrupt. Do not "fix" this by failing closed; a blip silencing a healthy
 * legacy hive's pushes is the worse failure.
 *
 * ⚠ THAT RISK NOTE IS ABOUT THE **PUSH** DECISION ONLY — and "fail-open" INVERTS
 * between this function's two consumers (WI-6815):
 *
 *   - `git-sync-action.ts` (PUSH): `legacy` ⇒ the member keeps pushing origin,
 *     i.e. today's behavior. Reading `legacy` on a blip is genuinely OPEN, and
 *     the paragraph above is the correct analysis for it.
 *   - `sync/pot-git/serve-wiring.ts` (SERVE GATE): `legacy` ⇒ **REFUSE every
 *     pot-git serve**. Reading `legacy` on a blip fails CLOSED — it silently
 *     disables the whole P2P serve plane — which the analysis above never
 *     considered. A gate whose "safe default" is derived from a different
 *     consumer's failure direction is not a safe default at all.
 *
 * `getPotGitMode` therefore collapses four very different states into one
 * `legacy`: an OWNER-CHOSEN legacy, a never-configured hive, a malformed value,
 * and a store read that THREW. For the push path that collapse is harmless; for
 * the serve gate it is the difference between "correctly not serving" and
 * "silently broken", and it is indistinguishable from the DIALING side — which
 * is precisely why WI-6815 could not tell "the setting never replicated to the
 * peer" from "the peer's read is throwing" without peer-side DB access.
 *
 * So: `getPotGitMode` keeps its collapsing fail-open contract (the push path is
 * unchanged, byte for byte), and {@link readPotGitMode} exposes the DISTINCTION
 * for callers that need to fail in their own direction — or, at minimum, to name
 * which of the four states they refused on. Refusal reasons travel back over the
 * wire, so naming the state makes a peer's misconfiguration diagnosable from the
 * DIALER's log alone.
 */
import type { Sql } from 'postgres';
// `getOrgPg` is imported LAZILY at its one call site, not statically. Plan
// harden-shared-hive-to-256-peers-2026-06-29 / D-024: this module sits on the
// substrate boot path (boot.ts -> swarm.ts -> pot-git/serve-wiring -> here), so
// a static edge to `@papercusp/db-org` charges EVERY peer process ~125MB of
// drizzle module graph (~80MB shared drizzle core + ~35-40MB generated schema)
// that a peer which never queries Postgres does not use. At 256 peers that is
// ~32GB of pure import cost and it is what made a >64-peer mesh unmeasurable on
// this host. Do not re-staticize this import; `peer-child-import-graph.test.ts`
// fails if the perf peer graph reaches db-org again.
import { getHiveSetting, setHiveSetting, deleteHiveSetting } from '../../hive-settings-store';
import { upsertPotGitGcRoutine, setPotGitGcRoutineActive } from './hive-git-gc-routine';

/** Who pushes the GitHub remote for this hive (S-5 decision table input). */
export type PotGitMode = 'legacy' | 'bridged' | 'p2p-only';

/** The federated hive_settings key carrying the mode. */
export const POT_GIT_MODE_SETTING_KEY = 'hiveGit.mode';

export const POT_GIT_MODES: readonly PotGitMode[] = ['legacy', 'bridged', 'p2p-only'] as const;

/** Junk-safe coercion: anything that is not exactly a known mode is `legacy`. */
export function coercePotGitMode(v: unknown): PotGitMode {
  return v === 'bridged' || v === 'p2p-only' ? v : 'legacy';
}

/**
 * WHY this hive read as the mode it did — the distinction `getPotGitMode`'s
 * fail-open deliberately collapses (see the module header, WI-6815).
 *
 *  - `set`       an explicit, well-formed value the owner chose.
 *  - `absent`    no row: this hive never configured a mode. Legitimately legacy.
 *  - `malformed` a row whose value is not a known mode — a real misconfiguration.
 *  - `error`     the settings-store read THREW. The mode is **UNKNOWN**; `legacy`
 *                here is a fallback, NOT a statement about the hive.
 *
 * Only `set` licenses a caller to say "this hive is legacy". The other three are
 * "I could not establish the mode", which a serve gate must be able to say out
 * loud rather than silently rendering as an owner decision.
 */
export type PotGitModeSource = 'set' | 'absent' | 'malformed' | 'error';

export interface PotGitModeRead {
  /** Always a usable mode — `legacy` whenever the source is not `set`. */
  mode: PotGitMode;
  source: PotGitModeSource;
}

/**
 * Read a hive's git mode AND why it reads that way. Never throws — a store
 * failure surfaces as `{ mode: 'legacy', source: 'error' }` rather than
 * propagating, so a caller that only wants the mode keeps the fail-open
 * contract while a caller that needs to distinguish can.
 */
export async function readPotGitMode(
  workspaceId: string,
  potHomeSlug: string,
  sql?: Sql,
): Promise<PotGitModeRead> {
  let rec: Awaited<ReturnType<typeof getHiveSetting>>;
  try {
    rec = await getHiveSetting(workspaceId, potHomeSlug, POT_GIT_MODE_SETTING_KEY, sql);
  } catch {
    return { mode: 'legacy', source: 'error' };
  }
  if (!rec || rec.value == null) return { mode: 'legacy', source: 'absent' };
  const mode = coercePotGitMode(rec.value);
  // `coercePotGitMode` maps BOTH a literal 'legacy' and any junk to 'legacy', so
  // the stored value — not the coerced one — is what separates an owner's
  // explicit legacy from a corrupt row.
  if (mode === 'legacy' && rec.value !== 'legacy') return { mode: 'legacy', source: 'malformed' };
  return { mode, source: 'set' };
}

/**
 * Read a hive's git mode from the federated settings store. Absent / unset /
 * malformed → `legacy`. NEVER throws: a settings-store failure also reads as
 * `legacy` (fail-open to today's behavior — a PG blip must not flip a healthy
 * legacy hive into silent commit-only mode).
 *
 * ⚠ This collapses four states into one (see {@link PotGitModeSource}). That is
 * correct for the PUSH decision and WRONG for a serve gate — use
 * {@link readPotGitMode} anywhere `legacy` means "deny" rather than "carry on".
 */
export async function getPotGitMode(
  workspaceId: string,
  potHomeSlug: string,
  sql?: Sql,
): Promise<PotGitMode> {
  return (await readPotGitMode(workspaceId, potHomeSlug, sql)).mode;
}

/**
 * Set (or clear, with `mode: null`) a hive's git mode. `legacy` is stored
 * explicitly when passed (an explicit choice is auditable); clearing removes
 * the row so the hive reads as default-legacy again. Validates the mode —
 * unlike the read path, a WRITE with a junk value must throw, not coerce.
 */
export async function setPotGitMode(
  workspaceId: string,
  potHomeSlug: string,
  mode: PotGitMode | null,
  sql?: Sql,
): Promise<void> {
  if (mode === null) {
    await deleteHiveSetting(workspaceId, potHomeSlug, POT_GIT_MODE_SETTING_KEY, sql);
    await syncPotGitGcRoutine(workspaceId, potHomeSlug, 'legacy', sql);
    return;
  }
  if (!POT_GIT_MODES.includes(mode)) {
    throw new Error(`setPotGitMode: unknown mode '${String(mode)}' (expected ${POT_GIT_MODES.join(' | ')})`);
  }
  await setHiveSetting({ workspaceId, potHomeSlug, settingKey: POT_GIT_MODE_SETTING_KEY, value: mode }, sql);
  await syncPotGitGcRoutine(workspaceId, potHomeSlug, mode, sql);
}

/**
 * G-9 (P-205): THE mode-flip call site hive-git-gc-routine.ts names as the
 * owner of gc activation — off-legacy arms the pot-home's `system:pot-git-gc`
 * ephemeral routine; back-to-legacy (or a cleared setting) disarms it in place
 * (row + cadence config kept for re-activation; the action's own mode
 * self-gate stays as defense-in-depth, not the primary gate). Arms against the
 * hive-home's PRIMARY bare store — `repoKey = canonicalRepoKey(entry)`, the
 * SAME federated key `hiveGitRepoPath(potHomeSlug, repoKey)` resolves to for
 * every other leg (git-sync-action.ts), NOT the bare `potHomeSlug` (EI-19342015342118497):
 * once an entry re-keys off its local slug onto `gh-<github_repository_id>`
 * (WI-5168), a routine armed on the pre-rekey slug keeps `git gc`'ing the now-
 * abandoned slug-named store forever — its mtimes look "actively written"
 * (repack touches the pack/ref files every tick) even though nothing publishes
 * into it, which is exactly the false "still wedged at the incident sha"
 * symptom that store can reproduce on demand. Registry-unreadable / no entry
 * found falls back to `potHomeSlug` (the pre-WI-5168 behavior) rather than
 * failing the mode flip — the mode setting itself has already committed, and a
 * missing registry entry means the derivation was never possible anyway. A
 * hive binding additional repos edits the routine's trigger_config rather than
 * growing this seam.
 */
async function syncPotGitGcRoutine(
  workspaceId: string,
  potHomeSlug: string,
  mode: PotGitMode,
  sql?: Sql,
): Promise<void> {
  const s = sql ?? (await import('@papercusp/db-org')).getOrgPg().sql;
  if (mode === 'legacy') {
    await setPotGitGcRoutineActive(s, potHomeSlug, false);
    return;
  }
  // Lazy, like the `@papercusp/db-org` import above (D-024): this module sits
  // on the substrate boot path and must not statically pull in the harness
  // registry's module graph for every peer process.
  let repoKey = potHomeSlug;
  try {
    const [{ loadHarnessRegistry }, { canonicalRepoKey }] = await Promise.all([
      import('../../harness-registry'),
      import('../../sync/pot-git/repo-identity'),
    ]);
    const entry = (await loadHarnessRegistry(workspaceId)).projects.find((p) => p.slug === potHomeSlug);
    if (entry) repoKey = canonicalRepoKey(entry);
  } catch {
    // registry unreadable — fall back to the pre-WI-5168 slug-keyed guess
    // rather than failing the mode-flip write, which has already committed.
  }
  await upsertPotGitGcRoutine(s, { workspaceId, potHomeSlug, repoKey, active: true });
}
