/**
 * Host policy for Excalidraw web embeds.
 *
 * Excalidraw treats an undefined callback result as "use the default
 * allowlist". Keep that behavior for every host we do not explicitly block,
 * while rejecting providers whose embeds execute third-party scripts/content
 * in the canvas iframe.
 */
const BLOCKED_EMBED_HOSTS = ['twitter.com', 'x.com', 'reddit.com'] as const;

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
}

/**
 * Return false for known third-party content providers and undefined for all
 * other links so Excalidraw's own default validation remains authoritative.
 */
export function validateEmbeddableLink(link: string): boolean | undefined {
  let hostname: string;
  try {
    hostname = new URL(link).hostname;
  } catch {
    return undefined;
  }

  const host = normalizedHostname(hostname);
  return BLOCKED_EMBED_HOSTS.some((blockedHost) => (
    host === blockedHost || host.endsWith(`.${blockedHost}`)
  )) ? false : undefined;
}
