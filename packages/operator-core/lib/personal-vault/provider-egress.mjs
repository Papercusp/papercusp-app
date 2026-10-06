/**
 * Provider credentials and provider egress targets: the pure half of the
 * native-tool label binding (plan personal-data-reader-set-labels-2026-10-01,
 * P-007, BAR R-11).
 *
 * A session that has read a restricted personal document may reach a mail,
 * chat, calendar or social provider only through the gated capability verbs,
 * which check the reader set before anything is sent. Two native routes go
 * around those verbs:
 *
 *   1. a provider credential in the session's environment, and
 *   2. a direct request to a provider host, to the mail/calendar sidecars, to
 *      the sidecars' databases, or to the file that holds the sidecars' secrets.
 *
 * This module names both. Every agent launch seam strips (1) with
 * `scrubProviderCredentials`; the shell and fetch seams recognise (2) with
 * `findProviderEgressTargets` and refuse it for a restricted session
 * (binding-enforcement.ts).
 *
 * The scrub is unconditional, not restricted-only: a process environment is
 * fixed at launch, and a session becomes restricted mid-run when it reads a
 * restricted document. Provider credentials belong to the sidecars only.
 *
 * Measured 2026-10-02: the mail and calendar sidecars read their secrets from
 * ~/.papercusp/app-producer.env (EMAIL_AUTH_SECRET, EMAIL_DATABASE_URL,
 * CALENDAR_AUTH_SECRET, CALENDAR_DATABASE_URL) and listen on 127.0.0.1:8791 /
 * :8792; the operator's own environment carries none of them. The operator's
 * GOOGLE_APPLICATION_CREDENTIALS is the Google Cloud (Vertex / cloud workspace)
 * key, not a mail provider credential, so it is deliberately NOT listed.
 *
 * Limit: target recognition reads the literal command or URL. An agent that
 * builds a host name at run time (string concatenation, base64) is not caught
 * here; closing that needs network-level egress control (tracked on the P-007
 * work-item residue).
 *
 * Plain .mjs with no imports so psu-launcher.mjs can load it without a
 * TypeScript loader. Types: provider-egress.d.mts.
 */

/** The mail/calendar sidecars' own secrets (their systemd EnvironmentFile). */
export const SIDECAR_CREDENTIAL_ENV = Object.freeze([
  'EMAIL_AUTH_SECRET',
  'EMAIL_DATABASE_URL',
  'CALENDAR_AUTH_SECRET',
  'CALENDAR_DATABASE_URL',
]);

/** Ports the mail (8791) and calendar (8792) sidecars listen on. */
export const DEFAULT_SIDECAR_PORTS = Object.freeze([8791, 8792]);

const PROVIDER_PREFIX_RE =
  /^(?:GMAIL|GCAL|GOOGLE_(?:OAUTH|CLIENT|GMAIL|CALENDAR|WORKSPACE|PEOPLE)|SLACK|DISCORD|TELEGRAM|TWITTER|X_API|BLUESKY|BSKY|MASTODON|LINKEDIN|FACEBOOK|INSTAGRAM|META_GRAPH|WHATSAPP|MSGRAPH|MS_GRAPH|MICROSOFT_GRAPH|OUTLOOK|IMAP|SMTP)(?:_|$)/;
const SECRET_PART_RE = /TOKEN|SECRET|PASSWORD|PASSWD|PASS|KEY|CREDENTIAL|COOKIE|WEBHOOK/;

/**
 * Whether an environment variable name holds a mail, chat, calendar or social
 * provider credential. A provider-prefixed name that is not secret-shaped (for
 * example GOOGLE_CLIENT_ID or SLACK_TEAM) is kept.
 * @param {string} name
 * @returns {boolean}
 */
export function isProviderCredentialEnvName(name) {
  const upper = String(name).toUpperCase();
  if (SIDECAR_CREDENTIAL_ENV.includes(upper)) return true;
  return PROVIDER_PREFIX_RE.test(upper) && SECRET_PART_RE.test(upper);
}

/**
 * Copy `env` without any provider credential.
 * @template {Record<string, string | undefined>} T
 * @param {T} env
 * @returns {{ env: T, removed: string[] }}
 */
export function scrubProviderCredentials(env) {
  /** @type {Record<string, string | undefined>} */
  const out = {};
  const removed = [];
  for (const [key, value] of Object.entries(env ?? {})) {
    if (isProviderCredentialEnvName(key)) removed.push(key);
    else out[key] = value;
  }
  return { env: /** @type {T} */ (out), removed: removed.sort() };
}

/**
 * Every recognised egress route. `sample` is a minimal command each rule must
 * match; it pins any coarser copy of this list (the PreToolUse hook's
 * prefilter) to these rules in tests.
 */
export const PROVIDER_EGRESS_RULES = Object.freeze([
  {
    id: 'google-mail-calendar-api',
    kind: 'provider-host',
    re: /\b(?:gmail|people|calendar-json)\.googleapis\.com\b|\bwww\.googleapis\.com\/(?:gmail|calendar|upload\/gmail)\b/i,
    sample: 'curl https://gmail.googleapis.com/gmail/v1/users/me/messages',
  },
  {
    id: 'google-oauth',
    kind: 'provider-host',
    re: /\boauth2\.googleapis\.com\b|\baccounts\.google\.com\/o\/oauth2\b/i,
    sample: 'curl -d refresh_token=x https://oauth2.googleapis.com/token',
  },
  {
    id: 'gmail-mail-protocol',
    kind: 'provider-host',
    re: /\b(?:imap|smtp|pop)\.gmail\.com\b/i,
    sample: 'openssl s_client -connect imap.gmail.com:993',
  },
  {
    id: 'microsoft-graph',
    kind: 'provider-host',
    re: /\bgraph\.microsoft\.com\b|\boutlook\.office(?:365)?\.com\b|\blogin\.microsoftonline\.com\b/i,
    sample: 'curl https://graph.microsoft.com/v1.0/me/sendMail',
  },
  {
    id: 'slack',
    kind: 'provider-host',
    re: /\b(?:[a-z0-9-]+\.)*slack\.com\b/i,
    sample: 'curl -X POST https://slack.com/api/chat.postMessage',
  },
  {
    id: 'discord',
    kind: 'provider-host',
    re: /\bdiscord(?:app)?\.com\b/i,
    sample: 'curl https://discord.com/api/webhooks/1/x',
  },
  {
    id: 'telegram',
    kind: 'provider-host',
    re: /\bapi\.telegram\.org\b/i,
    sample: 'curl https://api.telegram.org/botX/sendMessage',
  },
  {
    id: 'x-twitter',
    kind: 'provider-host',
    re: /\b(?:api|upload)\.(?:twitter|x)\.com\b/i,
    sample: 'curl https://api.x.com/2/tweets',
  },
  {
    id: 'bluesky',
    kind: 'provider-host',
    re: /\bbsky\.(?:social|app|network)\b/i,
    sample: 'curl https://bsky.social/xrpc/com.atproto.repo.createRecord',
  },
  {
    id: 'meta-graph',
    kind: 'provider-host',
    re: /\bgraph\.(?:facebook|instagram|whatsapp)\.com\b/i,
    sample: 'curl https://graph.facebook.com/v19.0/me/feed',
  },
  {
    id: 'linkedin',
    kind: 'provider-host',
    re: /\bapi\.linkedin\.com\b/i,
    sample: 'curl https://api.linkedin.com/v2/ugcPosts',
  },
  {
    id: 'sidecar-secret-file',
    kind: 'sidecar-secret',
    re: /\bapp-producer\.env\b/i,
    sample: 'cat ~/.papercusp/app-producer.env',
  },
  {
    id: 'sidecar-database',
    kind: 'sidecar-database',
    re: /\b(?:email|calendar)_app\b/,
    sample: 'psql -d email_app -c "SELECT 1"',
  },
]);

/**
 * @param {readonly number[]} ports
 */
function sidecarRule(ports) {
  const list = ports.map((port) => String(Math.trunc(port))).filter((port) => /^\d+$/.test(port));
  return {
    id: 'mail-calendar-sidecar',
    kind: 'sidecar',
    re: new RegExp(`(?:\\b127\\.0\\.0\\.1|\\blocalhost|\\b0\\.0\\.0\\.0|\\[::1\\]):(?:${list.join('|')})\\b`, 'i'),
    sample: `curl http://127.0.0.1:${list[0] ?? DEFAULT_SIDECAR_PORTS[0]}/api/messages`,
  };
}

/** The rule set including the sidecar-port rule for `ports`. */
export function providerEgressRules(ports = DEFAULT_SIDECAR_PORTS) {
  return [...PROVIDER_EGRESS_RULES, sidecarRule(ports.length ? ports : DEFAULT_SIDECAR_PORTS)];
}

/**
 * The provider egress routes `texts` (a shell command, a URL) name, one entry
 * per matching rule.
 * @param {string | readonly string[]} texts
 * @param {{ sidecarPorts?: readonly number[] }} [options]
 * @returns {Array<{ rule: string, kind: string, match: string }>}
 */
export function findProviderEgressTargets(texts, options = {}) {
  const list = (Array.isArray(texts) ? texts : [texts]).filter((text) => typeof text === 'string' && text.length > 0);
  if (!list.length) return [];
  const found = [];
  for (const rule of providerEgressRules(options.sidecarPorts ?? DEFAULT_SIDECAR_PORTS)) {
    for (const text of list) {
      const hit = rule.re.exec(text);
      if (hit) {
        found.push({ rule: rule.id, kind: rule.kind, match: hit[0] });
        break;
      }
    }
  }
  return found;
}
