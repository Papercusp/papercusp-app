/**
 * `system:hetzner-orphan-frame-reaper` — WI-1442 fix (c) / WI-1628.
 *
 * Wires the pure decision core (`hetzner-orphan-frame-reaper.ts`) to real Hetzner +
 * real coord-presence liveness. Design + safety model live in that module's header.
 *
 * NOT flag-gated (unlike idle-session-reaper): the single gate is the routine's own
 * `active` column, seeded FALSE by `seed-hetzner-orphan-frame-reaper-routine.ts` —
 * a destructive reaper that deletes real billed cloud VMs is exactly the
 * "owner-authority" carve-out (repo CLAUDE.md's flags section), so it stays fully
 * inert until an owner deliberately flips the routine active (recommended bring-up:
 * `--active --dry-run` first to preview the candidate set, then drop dry_run).
 *
 * trigger_config knobs (all optional):
 *   - dry_run (default false) — classify + log, destroy nothing.
 *   - min_age_hours (default 2) — grace window past a confirmed-ended owner.
 *
 * No HCLOUD_TOKEN reachable (common on the operator's systemd unit — the token
 * usually lives only in an interactive shell / `~/.papercusp/hcloud-token`, per
 * deb-hetzner-rig.sh) → logs and no-ops rather than failing the routine tick.
 *
 * WI (hetzner-orphan-frame-reaper HTTP-401 flap): a genuine, non-network-transient
 * `listServers()` failure (a bad-token 401, an unexpected 5xx) is retried up to
 * `reapOrphanedHetznerFrames`'s `DEFAULT_MAX_LIST_ATTEMPTS` (3, short in-process
 * backoff) before it's allowed to surface and fail this routine tick — a real
 * incident showed Hetzner's own auth path can 401 on a one-off blip that clears on
 * the very next call with the SAME, still-valid, unrotated token. Only a
 * PERSISTENTLY bad token (fails every attempt) still surfaces, so a genuine
 * credential rotation need is never silently swallowed.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { createHetznerApiClient } from '../../deployment/hetzner/hetzner-api';
import {
  reapOrphanedHetznerFrames,
  OWNER_LABEL_KEY,
  type HetznerOrphanReaperDeps,
  type HetznerFrameInfo,
  type OwnerLiveness,
} from './hetzner-orphan-frame-reaper';

/** Same resolution order deb-hetzner-rig.sh's `rig_init` uses (env first, then the
 *  per-user token file), so this action works wherever the bash rigs already do. */
function resolveHcloudToken(): string | undefined {
  const fromEnv = process.env.HCLOUD_TOKEN ?? process.env.HETZNER_API_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(join(homedir(), '.papercusp', 'hcloud-token'), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

registerSystemAction('hetzner-orphan-frame-reaper', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const dryRun = cfg.dry_run === true;
  const minAgeHours = typeof cfg.min_age_hours === 'number' ? cfg.min_age_hours : undefined;

  const token = resolveHcloudToken();
  if (!token) {
    console.log(
      '[hetzner-orphan-frame-reaper] no HCLOUD_TOKEN reachable (env or ~/.papercusp/hcloud-token) — skipping this tick',
    );
    return;
  }

  const client = createHetznerApiClient({ apiToken: token });

  const deps: HetznerOrphanReaperDeps = {
    async listFrames(): Promise<HetznerFrameInfo[]> {
      const servers = await client.listServers();
      return servers.map((s) => ({ id: s.id, name: s.name ?? '', labels: s.labels ?? {}, createdAt: s.createdAt }));
    },
    async resolveOwnerLiveness(ownerIds: readonly string[]): Promise<OwnerLiveness[]> {
      // Lazy import: keeps this module's static import graph light (matches the
      // recipient-liveness.ts precedent this reaper's liveness check reuses).
      const { describeMissedRecipients } = await import(
        '../../agent-tools/coordination/recipient-liveness'
      );
      const rows = await describeMissedRecipients(ownerIds);
      const byOwner = new Map(rows.map((r) => [r.ownerId, r.sessionState]));
      return ownerIds.map((ownerId) => ({ ownerId, sessionState: byOwner.get(ownerId) ?? 'unknown' }));
    },
    async destroy(id: string): Promise<void> {
      await client.deleteServer(id);
    },
    now: () => Date.now(),
  };

  const result = await reapOrphanedHetznerFrames(deps, { dryRun, minAgeHours });
  if (result.listError) {
    // Transient upstream connectivity blip (e.g. "fetch failed") — the reaper skipped
    // this tick cleanly rather than failing the routine (EI-6868). Retries next cadence.
    console.log(
      `[hetzner-orphan-frame-reaper] transient network error listing Hetzner servers (${result.listError}) — skipping this tick, will retry next cadence`,
    );
    return;
  }
  console.log(
    `[hetzner-orphan-frame-reaper] scanned ${result.scanned} server(s), ${result.matchedRigNames} rig-named → ` +
      `${result.dryRun ? 'WOULD destroy' : 'destroyed'} ${result.destroyed.length}` +
      (result.destroyed.length ? ` [ids: ${result.destroyed.slice(0, 20).join(',')}${result.destroyed.length > 20 ? ',…' : ''}]` : '') +
      `; skipped ${result.skippedOwnerAlive.length} (owner not confirmed ended), ` +
      `${result.skippedTooYoung.length} (too young), ${result.skippedNoOwnerLabel.length} (no ${OWNER_LABEL_KEY} label)` +
      (result.errors.length ? `; ${result.errors.length} error(s): ${JSON.stringify(result.errors.slice(0, 5))}` : ''),
  );
});
