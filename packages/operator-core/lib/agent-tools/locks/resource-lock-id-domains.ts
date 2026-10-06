/**
 * Ordered coordination domains to try when a named-resource lease is addressed by
 * `lock_id` ALONE (locks:heartbeat_resource, locks:release_resource's lock_id path).
 *
 * WI-10004326. The lease's OWN recorded domain comes first: `lock_id` is globally
 * unique, so `readOwnedResourceLockDomain` locates the row directly and nothing has
 * to be inferred. Before this, both paths tried only the domains the SERVING
 * operator could infer (`candidateResourceLockDomains()`: its own checkout, the
 * host-global domain, the workspace domain). A caller-tree lease acquired through a
 * different operator install (staging checkout vs release checkout) lives in a
 * domain the serving operator never names, so its heartbeat silently found nothing
 * and the lease lapsed on schedule however often the holder renewed it.
 *
 * The inferred candidates stay as the fallback, in their previous order, so a failed
 * or empty locator read degrades to exactly the pre-fix behaviour and never to less.
 */
import { candidateResourceLockDomains } from './coordination-domain';
import { getTxPool, readOwnedResourceLockDomain } from './su-lock-store';

export async function resourceLockIdDomains(
  ownerId: string,
  lockId: string,
  callerDomain?: string,
): Promise<string[]> {
  let owned: string | null = null;
  try {
    owned = await readOwnedResourceLockDomain(getTxPool(), lockId, ownerId);
  } catch {
    // Best-effort locator: the inferred candidates below still cover every lease
    // the pre-fix code could reach, so a transient read failure costs no coverage.
  }
  return [
    ...new Set([
      ...(owned ? [owned] : []),
      ...(callerDomain ? [callerDomain] : []),
      ...candidateResourceLockDomains(),
    ]),
  ];
}
