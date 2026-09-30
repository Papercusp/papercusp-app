/**
 * Self-heal sweep for orphaned gym-cycle ephemeral PG testcontainers (WI-4332).
 *
 * ROOT CAUSE: packages/operator-core/lib/gym/{ab-run,autoloop-cycle,blueprint-cycle,
 * smoke,wake-mode}.ts each provision a DEDICATED (non-`.withReuse()`) PostgreSqlContainer
 * whose only cleanup is a `finally { pgContainer.stop() }` block — which only runs on
 * graceful process exit. Crash-safety otherwise relies entirely on testcontainers'
 * Ryuk reaper sidecar, but Ryuk is a single long-lived container: if IT is
 * killed/restarted (host OOM, `docker system prune`, a host reboot — all plausible on
 * this heavily-loaded shared fleet box), it loses all memory of containers it was
 * tracking before the restart, and any gym container whose owning process died before
 * (or is still running across) that restart becomes permanently unreachable by any
 * reaper. Evidence: 28 running + 38 exited orphaned pgvector containers found aged
 * 18h-44h on 2026-07-12.
 *
 * FIX: each gym-cycle entry point calls `sweepOrphanedGymPgContainers()` at the START
 * of its run, BEFORE creating its own new ephemeral container — self-healing (every
 * new gym run cleans up its predecessors' crash debris), no new scheduled
 * routine/DBOS workflow needed.
 *
 * Never touches the SHARED reused container (libs/test-config's getTestPg): that one
 * always carries the `org.testcontainers.container-hash` label (set only by
 * `.withReuse()`), which this sweep treats as an absolute skip — see
 * node_modules testcontainers' `utils/labels.js` (LABEL_TESTCONTAINERS_CONTAINER_HASH).
 * Best-effort throughout: docker being unreachable, or any individual `docker rm`
 * failing, never throws — a failed sweep must never block gym boot.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Generously beyond any real gym cycle's runtime (ab-run/autoloop/blueprint/smoke/wake-mode). */
export const DEFAULT_ORPHAN_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2h

export interface OrphanSweepResult {
  /** Container ids force-removed. */
  swept: string[];
  /** Non-fatal problems encountered (docker unreachable, one rm failing, …). */
  errors: Array<{ id: string; error: string }>;
}

interface DockerInspectEntry {
  Id: string;
  Created: string;
  Config?: { Labels?: Record<string, string> };
}

export interface SweepOrphanedGymPgContainersOpts {
  /** The gym provisioning image to scope the sweep to (GYM_PROVISION_PG_IMAGE). */
  image: string;
  /** Age threshold; a container younger than this may be a live in-flight run — never touched. */
  maxAgeMs?: number;
}

/**
 * Force-remove docker containers of `image` that: (a) are testcontainers-managed
 * (`org.testcontainers=true`), (b) are NOT the shared `.withReuse()` container (no
 * `org.testcontainers.container-hash` label), and (c) are older than `maxAgeMs`.
 * Best-effort — never throws; check `errors` if you care why something wasn't swept.
 */
export async function sweepOrphanedGymPgContainers(
  opts: SweepOrphanedGymPgContainersOpts,
): Promise<OrphanSweepResult> {
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_ORPHAN_MAX_AGE_MS;
  const result: OrphanSweepResult = { swept: [], errors: [] };

  let ids: string[];
  try {
    const { stdout } = await execFileAsync('docker', [
      'ps', '-a',
      '--filter', `ancestor=${opts.image}`,
      '--filter', 'label=org.testcontainers=true',
      '--format', '{{.ID}}',
    ]);
    ids = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (err) {
    // docker not installed / daemon unreachable — never block gym boot on this.
    result.errors.push({ id: '(docker ps)', error: String(err) });
    return result;
  }
  if (!ids.length) return result;

  let inspected: DockerInspectEntry[];
  try {
    const { stdout } = await execFileAsync('docker', ['inspect', ...ids]);
    inspected = JSON.parse(stdout) as DockerInspectEntry[];
  } catch (err) {
    result.errors.push({ id: '(docker inspect)', error: String(err) });
    return result;
  }

  const now = Date.now();
  for (const c of inspected) {
    const labels = c.Config?.Labels ?? {};
    // The shared reuse container (libs/test-config getTestPg) always carries this
    // label — an absolute skip, never force-removed by this sweep.
    if (labels['org.testcontainers.container-hash']) continue;
    const createdMs = Date.parse(c.Created);
    if (!Number.isFinite(createdMs)) continue;
    if (now - createdMs < maxAgeMs) continue; // too young — could be a live in-flight run
    try {
      await execFileAsync('docker', ['rm', '-f', c.Id]);
      result.swept.push(c.Id);
    } catch (err) {
      result.errors.push({ id: c.Id, error: String(err) });
    }
  }
  return result;
}
