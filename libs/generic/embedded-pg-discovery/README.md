# @papercusp/embedded-pg-discovery

Resolve a Postgres connection URL for desktop / local-first apps, where
the DB location isn't known until a host process boots an embedded
instance and writes a discovery file.

```ts
import { resolvePgUrl } from '@papercusp/embedded-pg-discovery';

const { url, source } = resolvePgUrl({
  envVars: ['HARNESS_ADMIN_DATABASE_URL', 'DATABASE_URL'], // first set wins
  discoveryFile: { path: '.papercusp/embedded-pg.json' },  // relative → under $HOME
  fallbackUrl: 'postgres://localhost:5432/app',
});
// source: 'env' | 'discovery-file' | 'fallback'
```

Resolution order: env vars (in order) → discovery file's `url` field →
fallback. An env var set to the **empty string is treated as absent** (a
later env var, then the discovery file, then the fallback still apply).
Pure, no caching (wrap it if you want memoization), zero domain coupling,
zero runtime dependencies. The app-specific config (which env vars, which
file, which fallback) lives in the caller.
