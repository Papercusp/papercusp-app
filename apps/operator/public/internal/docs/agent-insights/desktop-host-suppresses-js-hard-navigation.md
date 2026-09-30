# The desktop host suppresses JS hard navigation — use the stashed originals
URL: /internal/docs/agent-insights/desktop-host-suppresses-js-hard-navigation

On :3070/:4173 index.html overrides location.assign/replace to a soft pushState, so a forced-hard nav (a workspace switch) silently no-ops. navigateClient bypasses it via window.__papercuspOriginal{Assign,Replace}.

## Symptom

Switching workspaces in the packaged desktop app (the Mac VM / any `:3070`
webview) does **nothing** — the dropdown closes, no error, but the view stays
in the same workspace. Same for the command-palette / voice `workspace.switch`.

## Root cause

The static desktop host (`apps/operator-vite/index.html`, active when the
origin is `:3070` or `:4173` — what the packaged webview loads) **redefines
`location.assign` / `location.replace` to a same-origin soft `pushState`**, so a
stray JS navigation can't reload the desktop session while `vite build --watch`
rewrites `dist/`. It also overrides `location.reload` to a no-op.

A workspace switch is a *forced-hard* navigation:

```
switchWorkspace(id) → navigateClient('/harness?ws=<id>', { hard: true })
                    → window.location.assign('http://127.0.0.1:3070/harness?ws=<id>')
```

That target is same-origin, so the host's override downgrades the intended hard
nav to a soft `pushState`. The document never reloads → the host
(`serve.mjs`/`host-spa.ts`) never re-injects `window.__PAPERCUSP_WS__` →
`getBrowserWorkspaceId()` (which prefers the injected global over `?ws=`) keeps
returning the OLD workspace. The switch is a silent no-op. This is invisible in
a normal browser, because the override is installed **only** on the desktop host
origins — so it never reproduces at `:3055` or in tests that stub `location`.

## The fix / the rule

There is no un-overridden `assign`/`replace` on the desktop host, but the host
does **not** touch the `href` accessor, and — crucially — it **stashes the
genuine methods before overriding**, mirroring `__papercuspOriginalReload`:

* `window.__papercuspOriginalReload`  (used by `hardReload()`)
* `window.__papercuspOriginalAssign`
* `window.__papercuspOriginalReplace`

`navigateClient`'s hard branch calls `hardNavigate()`, which prefers the stashed
original (bypassing the override) and falls back to the native method
off-desktop. The stash + the override are installed together in one try-block
(stash first), so the only consistent states are *(stash present AND override
present)* or *(neither)* — either way a real document load happens.

**Rule:** never rely on `location.assign`/`replace`/`reload` for a *deliberate*
hard navigation or reload anywhere that can run in the desktop webview. Use
`navigateClient(target, { hard: true })` (or `hardReload()` for a pure reload),
which know about the escape hatches. If you add a NEW `location.*` override to
the host, stash its original the same way or you will silently break hard nav.
