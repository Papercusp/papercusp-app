# A trust-gated GET 403ing on first paint (or after an env switch) is usually a client-side auth-bootstrap RACE, not policy drift
URL: /internal/docs/agent-insights/host-check-403-is-a-client-side-auth-bootstrap-race

HostCheckBanner's /api/provision/host-check 403'd on staging :3170 — looked like a stale auth-policy docstring, was actually UserPicker/AutoLoginWelcomeToast's /api/auth/me session-mint racing an unordered sibling effect, and the session being per-BACKEND-process anyway. Fix: prime auth/me first; don't relax the route's trust tier.

## What

A component that fires a plain `fetch()` to a `{trust:['verified','trusted']}`
route on mount can 403 even though the caller (the desktop webview) is
genuinely a trusted single-user session — because **the passwordless
auto-session cookie that satisfies that trust tier is minted by a SIBLING
component's own `/api/auth/me` call, with no ordering guarantee between
React effects.** `HostCheckBanner`, `UserPicker`, and `AutoLoginWelcomeToast`
all mount together under `ChromeShell` and each fires its own independent
`useEffect(() => { fetch(...) }, [])` — nothing sequences them.

`auth/me.ts`'s GET handler auto-mints a session (`Set-Cookie`) for
passwordless users **only when the request carries no `Authorization`
header** (a plain in-page `fetch()` — not the desktop webview's `sys:http`
bridge calls, which DO inject a bearer). So the very first paint after a
fresh mount — or after the Tauri env-switcher (`env_switch.rs`) repoints
the SAME webview origin's `/api/*` proxy at a **different physical operator
process** (dev `:3270` / prod `:3070` / staging `:3170`, each with its own
session store) — is exactly when a trust-gated GET can lose the race: no
valid cookie exists yet *for that specific backend*, `requirePrincipal`
falls through to `principalFromLoopback` (`trust: 'unverified-loopback'`),
and a route requiring `['verified','trusted']` 403s.

**Fix:** in the client, explicitly `await fetch('/api/auth/me')` (ignore the
body) immediately before the trust-gated fetch, inside the SAME effect —
this is order-independent of what any sibling component does, and correctly
re-primes the session against whichever backend is currently active. See
`HostCheckBanner.tsx`'s effect.

## Why it's a trap

The 403 *looks* like an auth-policy bug, and the route's own docstring can
make that worse. `host-check.ts` said `` `auth: 'public'` — faithful to the
route's prior posture `` — true when it was ported, **false** since the D3
auth-tightening pass (`621bdb713`, 2026-05-20) deliberately moved the whole
`provision/*` family to `{trust:['verified','trusted']}` specifically to
stop an unauthenticated page (DNS-rebinding) from reading `signals`
(OS usernames) or POSTing an acknowledgement. Reading a stale docstring
next to a real 403 strongly suggests "revert the tightening" — **don't**:
that would reopen the exact leak D3 closed. The fix is entirely
client-side; the route's trust tier was correct all along. (Docstring now
updated to say so explicitly.)

The second trap: assuming the fix must be per-callsite. It doesn't need to
touch `packages/operator-core/lib/endpoint-route/routes/auth/me.ts`'s cookie
logic or `require-principal.ts` at all — those are correct. The only thing
missing was *ordering*, at the one call site that actually needed the cookie
without also being the thing that mints it.

## The adjacent, easy-to-miss gap: "the flood is already handled" is sometimes only PARTLY true

Chasing a wall of `Failed to load resource: … Connection refused` console
spam during the same outage (`papercup-bg-host` DBOS ticker freeze →
`:3170` down), it's tempting to conclude "nothing to build, `@papercusp/sync`
already has an offline banner" — `libs/generic/sync/src/connectivity.ts` +
`apps/operator-vite/src/components/OfflineIndicator.tsx` is a real,
live-wired, well-designed "operator connection lost" toast. **But it only
hears from `@papercusp/sync`'s own SSE + REST-batch transports.** Several
OTHER always-on, app-wide streams built on the generic, sync-agnostic
`createResilientEventSource` (`libs/generic/sse`) — `flags/stream`
(`libs/flags/src/client.ts`), `ui/intents/stream`
(`apps/operator/lib/ui/intent-dispatcher.tsx`), and `state-snapshot`
(`apps/operator/lib/use-state-snapshots.ts`) — reconnect-loop entirely on
their own, invisible to that shared connectivity store, so an outage that
hits (or outlasts) THEM specifically produces raw console noise with no
consolidated user-facing signal at all.

The fix extends the *existing* store rather than building a new banner:
each of those three now calls `reportSyncReachable()` / `reportSyncUnreachable()`
(from `@papercusp/sync`) via `onOpen` / `onStatusChange('failing')` —
the exact same pattern `SSEAdapter.tsx` already uses. Two more per-panel /
per-job consumers of `createResilientEventSource` (`agent-mcp/run-command/sse`
via `CommandCard`/`TerminalTab`/`PiPanel`/etc., and the voice
`papercup-output` poll) were deliberately left OUT of scope — they're
scoped to a specific panel/job, not indicative of "the operator itself is
down," and wiring them in would risk false-positive banners from an
unrelated per-command failure.

## The generalizable lesson

When a `{trust:[...]}` (or any auth-gated) client fetch intermittently
fails on FIRST PAINT or right after a config/env switch, check for a
missing session-priming step before reaching for the route's auth policy.
And when "there's already a banner/signal for this" is the first
conclusion during an outage investigation, verify which TRANSPORTS
actually feed that signal — a shared connectivity store is only as
complete as its wired-in reporters, and a generic (framework-agnostic)
lib deliberately won't import an app-specific one, so the wiring has to
happen at each app-level call site.
