/**
 * Anthropic auth policy for PUBLIC (ELv2) builds — open-source-release-2026-09-29 D-005 / P-019.
 *
 * Anthropic's consumer terms (code.claude.com/docs/en/legal-and-compliance) forbid a
 * third-party product from pooling, relaying, storing or re-injecting Claude.ai
 * subscription (Free/Pro/Max) credentials on a user's behalf. The dogfood/dev build does
 * exactly that for the owner's own fleet (multi-account gateway pooling, OAuth bundle
 * sync across CLAUDE_CONFIG_DIR forks, cross-device account honoring). A build carrying
 * `PAPERCUSP_DISTRIBUTION_PROFILE=public` therefore switches those three relays OFF, and
 * the supported paths are the user's own API key or the UNMODIFIED `claude` binary signed
 * in through Anthropic's own flow.
 *
 * `PAPERCUSP_ALLOW_OWN_SUBSCRIPTION_RELAY=1` is the explicit, per-machine opt-in for a user
 * who runs a public build against accounts that are all their own. It is read at call time
 * and is never set by any build.
 */

export const PUBLIC_DISTRIBUTION_PROFILE = 'public';
export const OWN_SUBSCRIPTION_RELAY_OPT_IN_ENV = 'PAPERCUSP_ALLOW_OWN_SUBSCRIPTION_RELAY';

/**
 * The relays D-005 covers, named so a refusal says which one was withheld.
 * `gateway-reinjection` is the single-account case: even with pooling off, routing a
 * `claude` spawn through the local inference gateway means the gateway holds the user's
 * Claude.ai OAuth and re-injects it upstream — intermediating the credential (P-019).
 */
export type SubscriptionRelay = 'account-pool' | 'credential-sync' | 'honor-account' | 'gateway-reinjection';

export function isPublicDistribution(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAPERCUSP_DISTRIBUTION_PROFILE?.trim() === PUBLIC_DISTRIBUTION_PROFILE;
}

/**
 * May this process relay a Claude.ai subscription credential for `relay`? Always true
 * outside a public build; inside one, only with the explicit own-accounts opt-in.
 */
export function subscriptionRelayAllowed(
  _relay: SubscriptionRelay,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isPublicDistribution(env)) return true;
  return env[OWN_SUBSCRIPTION_RELAY_OPT_IN_ENV]?.trim() === '1';
}
