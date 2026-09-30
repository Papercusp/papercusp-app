/**
 * derive-hive-topic — the well-known Hyperswarm topic(s) for the P2P HIVE
 * DIRECTORY (p2p-hive-directory-2026-06-06 P-002).
 *
 * Distinct from `derive-swarm-topic.ts` (which derives a PER-HARNESS topic from
 * a harness's identity so a harness's peers find each other): the directory is a
 * ONE well-known topic every participating peer joins to announce + listen for
 * hives to browse. Two derivations, per the owner-ratified D-004:
 *
 *   - `deriveDirectoryTopic()` — the single GLOBAL directory topic
 *     `sha256("papercusp-hive-v1:directory")`. The default: a hive that opts in
 *     to public discovery announces here, and every peer joins it to browse.
 *
 *   - `deriveInviteTopic(inviteSecret)` — a per-invite topic
 *     `sha256("papercusp-hive-v1:invite:" + inviteSecret)`. The invite-scoped
 *     path: only holders of the shared secret join it, so an `invite`-visibility
 *     hive is discoverable to invitees WITHOUT public listing (and never
 *     announces to the global topic). Restores "share via a link" without losing
 *     the global-browse default.
 *
 * The `papercusp-hive-v1:` prefix is independent of substrate-v1 so the
 * directory scheme can rotate separately. 32 bytes = Hyperswarm's topic length.
 *
 * Pure: no I/O, no random, fully deterministic — same input → same topic.
 */

import { createHash } from 'node:crypto';

/** Directory topic namespace prefix — rotate to migrate the whole directory scheme. */
export const HIVE_TOPIC_PREFIX = 'papercusp-hive-v1:';

/** The canonical key the global directory topic hashes (exported for tests/diagnostics). */
export const GLOBAL_DIRECTORY_KEY = `${HIVE_TOPIC_PREFIX}directory`;

/**
 * The single global, well-known hive-directory topic. Every peer that
 * participates in public discovery joins THIS topic to announce its public
 * hives and to listen for others' (D-001/D-004).
 */
export function deriveDirectoryTopic(): Buffer {
  return createHash('sha256').update(GLOBAL_DIRECTORY_KEY, 'utf8').digest();
}

/**
 * An invite-scoped directory topic — derived from a shared invite secret so only
 * its holders join it. An `invite`-visibility hive announces here instead of the
 * global topic (D-004). The secret is treated opaquely (any non-empty string);
 * callers generate it however they mint invite links.
 */
export function deriveInviteTopic(inviteSecret: string): Buffer {
  if (!inviteSecret) {
    throw new Error('deriveInviteTopic: inviteSecret must be a non-empty string');
  }
  return createHash('sha256').update(`${HIVE_TOPIC_PREFIX}invite:${inviteSecret}`, 'utf8').digest();
}

/** Diagnostic: hex-render a topic (logs + the substrate dashboard). */
export function hiveTopicAsHex(topic: Buffer): string {
  return topic.toString('hex');
}
