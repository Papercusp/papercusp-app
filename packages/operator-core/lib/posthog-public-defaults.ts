/**
 * Public PostHog defaults bundled with every Papercusp build. These are
 * the same values that ship in `~/.papercusp/posthog.json` for opt-in
 * users — the `host` and `projectKey` are public client-side credentials
 * (the `phc_*` key is anonymous-capture only; it cannot read events or
 * mutate flag definitions).
 *
 * The flow:
 *   - Public builds get these defaults so a user's opt-in alone is
 *     enough to forward telemetry. No "drop a JSON file" step.
 *   - `~/.papercusp/posthog.json` and `PAPERCUSP_POSTHOG_*` env still
 *     override (admin / dev / CI escape hatch).
 *
 * The admin write-side keys (`personalApiKey`, `webhookSecret`) are NEVER
 * bundled — those live only on maintainer machines / CI secrets.
 */
// ⚠ The projectKey MUST be the api_token of a real project on `host`. PostHog's
// capture endpoints answer {"status":"Ok"} to an UNKNOWN key and drop the event, so a
// stale key here fails silently and forever — which is exactly what happened: this
// shipped a key from a previous incarnation of the instance long after its only
// project was re-provisioned to the token below, so every shipped build's telemetry
// was discarded for months. Maintainer boxes never noticed, because
// ~/.papercusp/posthog.json overrides this before it is ever read.
// Verify with: the token of the target project at <host>/api/organizations/<org>/projects/.
// Keep in sync with BENIGN_ERE in papercusp-desktop/bin/audit-release-bundle.py (the
// release gate accepts this exact literal; a mismatch REDs the release audit). That is
// the ONLY other copy: bin/audit-bundle.sh is now a pure delegate to it (WI-10003577).
export const POSTHOG_PUBLIC_DEFAULTS = {
  host: 'https://flags.papercuspai.com',
  projectKey: 'phc_nm3LSXkJKynGzsGTZfwqUywbrfsryNNNVWrxHy7Kriug',
} as const;
