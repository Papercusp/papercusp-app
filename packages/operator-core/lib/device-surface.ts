/**
 * Detects which mobile surface a request came from. Two output domains:
 *
 *   - `Surface`: our internal audit value, stored in command_audit
 *     alongside 'browser' (desktop) so we can attribute every command
 *     to its origin.
 *
 *   - `ElSource`: the value EL expects in its `source` field at
 *     conversation creation time. Their API rejects arbitrary strings;
 *     known-good values are 'android_sdk', 'swift_sdk'. We send
 *     'unknown' for everything else.
 *
 * Detection order:
 *   1. Explicit `?surface=` query param (Android passes
 *      'mobile-android', iOS passes 'mobile-ios').
 *   2. User-Agent header sniffing (the EL SDKs set headers we can
 *      recognize: Android UA contains 'Android'; iOS sets Darwin or
 *      iPhone).
 *   3. Fall back to 'mobile-unknown'.
 */

export type Surface = 'mobile-android' | 'mobile-ios' | 'mobile-unknown';
export type ElSource = 'android_sdk' | 'swift_sdk' | 'unknown';

const VALID_SURFACES: readonly Surface[] = ['mobile-android', 'mobile-ios', 'mobile-unknown'];

export function detectSurface(opts: {
  query?: string;
  userAgent?: string;
}): Surface {
  if (opts.query && (VALID_SURFACES as readonly string[]).includes(opts.query)) {
    return opts.query as Surface;
  }
  const ua = opts.userAgent ?? '';
  if (ua.includes('Android')) return 'mobile-android';
  if (ua.includes('Darwin') || ua.includes('iPhone')) return 'mobile-ios';
  return 'mobile-unknown';
}

export function surfaceToElSource(s: Surface): ElSource {
  switch (s) {
    case 'mobile-android': return 'android_sdk';
    case 'mobile-ios': return 'swift_sdk';
    default: return 'unknown';
  }
}
