# Per-user REST routes must use getSessionUserOrDefault, not a strict 401
URL: /internal/docs/agent-insights/user-routes-default-user-fallback

The desktop webview usually carries NO session cookie, so a /user/* route gating on getSessionUser + 401 silently blanks its UI (the settings memory page showed "No memories stored yet." over a 1,700-row store). Per-user data routes fall back to the seeded default user.

## The symptom

The settings memory page (`/settings/user/memory`) rendered **"No memories
stored yet."** while the canonical store held \~1,700 memories. Every server
piece checked out individually: the `userMemory.list` sync resolver returned
all rows, `listUserMemories()` worked when invoked directly, the SPA bundle
contained the current page code, and replaying the page's requests with a
session cookie pulled from `harness_shared.user_sessions` succeeded.

## The root cause

The page bootstraps from `GET /api/user/memory/backend` to learn the session
`userId`, and only enables its `useSyncQuery` once it has one
(`apps/operator/app/settings/user/memory/page.tsx` — `enabled: !!userId`).
That route — and the whole ported `routes/user/*` family — gated on the
**strict** `getSessionUser(req.headers)` and returned
`401 {error: 'unauthenticated'}` when no cookie was present.

But **the desktop webview typically sends no session cookie at all.** The
tell, in PG: thousands of `Mozilla/*` rows in `harness_shared.user_sessions`
whose `last_seen_at ≈ created_at` (each used once at login, never again), and
none touched during hours of active app use. The rest of the app never
notices because the sync transports (`/api/zero-harness/rest-query[-batch]`)
don't use session auth — only per-user surfaces break, and they break as
*silent emptiness*, not as an error: the page's one-shot `refreshMeta()` got a
401, left `userId` null, and rendered the empty state over a full store.

The platform's documented semantics for these routes is the
seeded-`default`-user fallback — `getSessionUserOrDefault`'s own docstring
says it exists for "routes that always need a user\_id for per-user data
(memory, preferences)", `/api/auth/me` documents "the getSessionUserOrDefault
semantics every memory tool relies on", and all `memory:*` MCP tools use it.
The endpoint-system port (auth-tier Wave 1) replaced that with the strict 401
gate and even pinned it in `__tests__/user.test.ts` as "the shared
invariant" — codifying the regression.

## The fix (2026-06-11)

`packages/operator-core/lib/endpoint-route/routes/user/{memory,
memory-feedback, memory-audit, memory-reembed, search, preferences}.ts` now
resolve `getSessionUserOrDefault(req.headers)` — a real session cookie still
wins; no cookie falls back to the `default` user instead of 401. The
route-level `auth:` tier (`public`/`loopback`) remains the actual exposure
gate. `__tests__/user.test.ts` asserts the fallback semantics.

## The rules

* **A `/user/*` data route that 401s on a missing session is almost certainly
  wrong on this platform** — the desktop webview is effectively cookie-less.
  Use `getSessionUserOrDefault(req.headers)`; reserve strict `getSessionUser`
  for flows that genuinely need a *real* logged-in identity (e.g. PATCH
  /auth/me display-name).
* **When porting a route, port its auth semantics, not just its handler.**
  The legacy Next routes had the fallback; the port's "shared 401 invariant"
  looked like discipline but was a behavior change.
* **Diagnosing "UI shows empty but the store is full":** check whether the
  page gates its data query on a session-auth'd bootstrap fetch, then check
  `harness_shared.user_sessions` for the used-once-then-never pattern before
  suspecting the resolver, the sync transport, or the bundle.

## Loosening a trust-gated route removes a CSRF backstop — restore it

When the broken route is gated `auth: { trust: ['verified', 'trusted'] }` (the
D3 sensitive tier — credentials, deploy-accounts, publish-credentials), the fix
is **not** just to add `unverified-loopback` to the allowlist. That tier was
doing double duty: it also blocked **cross-origin CSRF**. A foreign web page the
user visits can `fetch('http://127.0.0.1:<port>/api/credentials', {method:'POST',
headers:{'content-type':'text/plain'}})` — `text/plain` is CORS-safelisted, so
there's **no preflight**, the request executes server-side (the response is
unreadable cross-origin, but the *write* lands), and the session cookie is
`SameSite=Strict` so the request arrives unauthenticated → `unverified-loopback`.
The trust tier used to 403 that; admitting `unverified-loopback` opens an
unauthenticated credential-write / password-change vector.

The Host-based loopback check (`isLoopbackRequest`) does **not** save you here —
a browser page hitting `127.0.0.1` directly sends a real `Host: 127.0.0.1`, which
passes. The control that works is the **Origin allowlist**: reuse
`defaultCorsOrigin` via `requireAllowedOriginOr403(req)` (in
`endpoint-route/cors.ts`) at the top of each mutating handler. A foreign Origin
→ 403; an absent Origin (curl / SU bearer / same-origin) or an allowlisted one
(the webview is tauri.localhost / 127.0.0.1) → through. Pair the trust loosening
with this guard on every mutating handler, and flip `auth: 'public'` mutating
routes that take the default-user fallback to `auth: 'loopback'` (off-box block
that doesn't lean on the bind-host env). EI-338 tracks the real cookie fix; the
guard stays as defense-in-depth even after it lands.
