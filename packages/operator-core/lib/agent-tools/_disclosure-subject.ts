/**
 * The agent identity Personal Vault disclosures are recorded against and
 * checked for (plan personal-data-reader-set-labels-2026-10-01 D-003).
 *
 * It is the coordination ownerId, so a label follows the agent across
 * compaction and carry-respawn. Unresolvable ⇒ null, and that is safe in both
 * directions: `discloseDocuments` withholds restricted content from a null
 * identity, so `assertDisclosurePermits` has nothing to check for one.
 */
import { resolveAgentIdentity } from './coordination/identity';

export function disclosureSubject(ctx: unknown): string | null {
  try {
    return resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]).ownerId?.trim() || null;
  } catch {
    return null;
  }
}
