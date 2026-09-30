# OAuth substrate

Generic OAuth helper so plugins declare a credential field as
`oauth: { provider, scopes }` instead of asking users to paste tokens.

Spec: [/docs/snapshots/oauth-integration](../../content/internal-docs/snapshots/oauth-integration.mdx).

## Modules

| Module | Responsibility |
|---|---|
| `state.ts` | HMAC-signed URL state + single-use server-side nonce table |
| `providers.ts` | Provider registry, GitHub provider impl, scope comparator |
| `token.ts` | `getOAuthToken` with Promise-cache (concurrent-refresh dedup) + `withRetry` (401 retry-once) |
| `storage-fs.ts` | `TokenStorage` adapter that writes to plugin-config JSON + PG mirror |

## Endpoints

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/api/oauth/start?provider=…&plugin=…&harness=…&field=…&scopes=…` | 302 → provider authorize URL, with HMAC-signed state in `state` query param |
| `GET` | `/api/oauth/callback?code=…&state=…` | Verifies + consumes state nonce, exchanges code, writes token to plugin config, redirects to `/settings/plugins?connected=…` |
| `POST` | `/api/oauth/verify-paste` | Hybrid mode: paste a PAT, substrate hits provider introspection, accepts (warn on superset, reject on subset) |

## Trust model

State is **always a URL parameter, never a cookie**. Each concurrent flow
has independent state. The HMAC prevents forgery; the server-side nonce
table prevents replay (each state token is single-use).

The callback reads `(plugin, harness, field, provider)` from the verified
state claims, NOT from URL params — a leaked code with a tampered URL
cannot route the token to a different plugin.

## ctx.oauth.token() refresh model

Plugin authors call `await ctx.oauth.token('github_token')`. The helper:

1. Reads stored token + expiry from plugin config.
2. If expired or within 5 minutes of expiring, calls `provider.refresh()`.
3. Returns a fresh access token.

Concurrent callers share an in-flight `Promise<token>` keyed by
`(plugin, harness, field)`. If 10 actions fire in parallel against an
expired token, the substrate sends ONE refresh request to the provider,
not ten.

A 401 from the provider after a fresh token signals revocation. The
helper invalidates the cached expiry, refreshes once, retries — second
401 propagates with `oauth_expired: true` flagged on the config so the
operator UI surfaces a "reconnect" button.

## Provider registration

Platform-owners configure providers in `~/.papercusp/oauth-apps.json`:

```json
{
  "github": {
    "clientId": "Iv1.abc",
    "clientSecretFile": "/etc/papercusp/oauth/github-secret",
    "redirectUri": "http://localhost:3055/api/oauth/callback?provider=github"
  }
}
```

`clientSecret` lives in a separate file with `0600` permissions and
never appears in audit output.

V1 ships GitHub. V2 adds Slack, Linear, Notion, Jira (the latter needs
an `audience` param for Atlassian's 3LO flow).

## Paste-PAT scope verification

When a user opts to paste a token instead of clicking Connect, the
substrate hits the provider's introspection endpoint:

| Outcome | Granted vs required | Behavior |
|---|---|---|
| `exact` | exactly the requested set | accept silently |
| `superset` | more permissions than needed | accept with warning |
| `subset` | missing required scopes | **reject** (toast names missing scopes) |

GitHub uses `GET /user` + `X-OAuth-Scopes` header (works for OAuth-app
tokens, classic PATs, and fine-grained PATs).

## Test coverage

```
state.test.ts          6 tests
providers.test.ts      6
token.test.ts          9
```

Plus route-level coverage:

```
api/oauth/start/route.test.ts     3
api/oauth/callback/route.test.ts  4
```

Total: **28 unit + integration tests**.
