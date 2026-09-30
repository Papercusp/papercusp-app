import {
  OWNER_DIRECTIVE_DEFAULT_OWNER,
  type OwnerDirectiveRow,
} from '@papercusp/operator-core/lib/owner-directives';
import type { MissingArtifactSlot } from './release-completeness';

const PLATFORM_NAME: Record<string, RegExp> = {
  'linux-x86_64': /\blinux\b/u,
  'darwin-universal': /\b(?:mac(?:os)?|darwin)\b/u,
  'windows-x86_64': /\bwindows?\b/u,
};

export function incompleteDesktopScopeRefusal(
  version: string,
  channel: string,
  missing: MissingArtifactSlot[],
  approval: OwnerDirectiveRow | null,
  workspaceId: string,
): string | null {
  if (missing.length === 0) return null;
  const refusal =
    `[record-release] REFUSING TO RECORD ${version} (${channel}) with missing desktop platforms: ` +
    'a captured owner directive with explicit owner approval for this exact partial scope is required.';
  if (
    !approval ||
    approval.ownerId !== OWNER_DIRECTIVE_DEFAULT_OWNER ||
    approval.workspaceId !== workspaceId ||
    approval.capturedByHook !== true ||
    approval.dispositionStatus === 'declined'
  ) {
    return refusal;
  }

  const text = approval.verbatimText.toLowerCase();
  const explicitApproval =
    /\b(?:i|we|the owner)\s+(?:explicitly\s+)?(?:approve|approves|approved|authorize|authorizes|authorized|authorise|authorises|authorised)\b/u.test(text);
  const deniesApproval =
    /\b(?:i|we|the owner)\s+(?:do not|don't|never|cannot|can't)\s+(?:explicitly\s+)?(?:approve|authorize|authorise|allow|permit)\b/u.test(text);
  const partialScope =
    /\b(?:partial|incomplete|reduced|reduction|narrowed|omit|omitted|omitting|exclude|excluded|excluding)\b/u.test(text) ||
    /\blinux[ -]+only\b/u.test(text);
  if (
    deniesApproval ||
    /\b(?:do not|don't|never)\s+(?:omit|exclude|drop)\b/u.test(text) ||
    !explicitApproval ||
    !partialScope ||
    !text.includes(version.toLowerCase()) ||
    !text.includes(channel.toLowerCase())
  ) {
    return `[record-release] REFUSING TO RECORD ${version} (${channel}): owner directive #${approval.id} does not explicitly approve this version, channel, and partial scope.`;
  }

  const omissionClauses = text
    .split(/[.;!?]/u)
    .filter((clause) => /\b(?:omit|omitting|omitted|exclude|excluding|excluded|without|drop|dropping|dropped)\b/u.test(clause));
  const unapproved = [...new Set(missing.map((slot) => slot.platform))].filter((platform) => {
    const platformPattern = PLATFORM_NAME[platform] ?? new RegExp(`\\b${platform}\\b`, 'u');
    return !omissionClauses.some((clause) => platformPattern.test(clause));
  });
  if (unapproved.length > 0) {
    return `[record-release] REFUSING TO RECORD ${version} (${channel}): owner directive #${approval.id} does not approve omission of ${unapproved.join(', ')}.`;
  }
  return null;
}
