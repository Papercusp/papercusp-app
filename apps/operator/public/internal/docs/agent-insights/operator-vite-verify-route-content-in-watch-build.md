# Verifying an /adv tab change is live — grep the WATCH build's dist, not a one-off `vite build`
URL: /internal/docs/agent-insights/operator-vite-verify-route-content-in-watch-build

A one-off `npx vite build` code-splits /adv route CONTENT differently and races the watch process — its output FALSELY shows your tab missing. Grep apps/operator-vite/dist (the long-running watch build) instead.

## The trap

You add a new `/adv` tab (or any route-content component — a tab body under
`components/adv/*` reached via `routes/adv/index.tsx`'s `renderAdvTab`), then try
to confirm it bundled by running a clean build and grepping for your CSS class:

```bash
npx vite build --outDir /tmp/verify     # production mode
grep -rl "pc-yourtab" /tmp/verify       # → MISSING (!?)
```

It reads as MISSING — and so do **stable, definitely-shipped** components
(`pc-overview__topbar` from `AdvOverviewTab`, `pc-lihealth` from the learning
chip, a peer's just-landed tab). That makes it look like the whole adv route
content failed to bundle. It did not. Two things conspire:

1. **The live `dist/` is owned by a long-running watch build**, not your one-off.
   `apps/operator-vite` runs `vite build --watch --mode development` (the
   `dev:nohmr` script) that continuously rewrites `apps/operator-vite/dist/` —
   this is what the desktop/staging actually serves (see the
   `project_adv_live_in_operator_vite` memory). A one-off `npx vite build` writes
   the same `dist/` and **races** the watch process, which rebuilds over your
   output seconds later.
2. **Production-mode code-splitting ≠ dev-mode.** A one-off production
   `vite build` splits the lazy `/adv` route's content components into chunks
   differently from the `--mode development` watch build; a recursive grep of the
   production output can miss route-content class strings that the dev bundle
   inlines — even for components that unquestionably ship. So the production
   build's dist is **not** a faithful oracle for "is my adv tab content bundled".

A fast build time is the tell: a real cold build of this \~550-chunk app is **not**
2–3 seconds. If `vite build` returns in \~3s, you're seeing the rolldown cache /
a partial build, not a fresh full one.

## The fix — grep the watch build's own dist

The authoritative bundle is `apps/operator-vite/dist/`, maintained by the watch
process. After editing, confirm the watch rebuilt, then grep that dist:

```bash
# 1. find the watch build + confirm it just rebuilt
ps aux | grep 'vite build --watch' | grep -v grep        # e.g. PID 2944703
tail -c 1500 /proc/<pid>/fd/1 | tr -d '\0' | tail -3      # → "built in NNNms."

# 2. grep the LIVE dist (recursive) for your marker
grep -rl "pc-yourtab" apps/operator-vite/dist/ && echo LIVE || echo "not rebuilt yet"
```

A stable class like `pc-overview__topbar` is a good control: it MUST be present
in the live dist. If your marker is present alongside it, your change is live.

Identifiers (component/function names like `HealthTab`, `renderAdvTab`) are
**minified** — don't grep for those; grep for **string literals** that survive
minification: a CSS class in a `<style>` template, a user-facing label, or the
sync `queryName`.

## Don't

* Don't `rm -rf node_modules/.vite` to "force a clean build" — that cache is
  shared with the running dev servers + the watch build; clearing it forces a
  fleet-disrupting re-optimize for peers on the same box.
* Don't trust a `--outDir /tmp/...` production build's absence of a class as
  proof your code is missing — cross-check the live dist first.

## See also

* `project_adv_live_in_operator_vite` (memory) — the live `/adv` UI is
  operator-vite; how to confirm a change is in the freshly-built bundle.
* `adv-dock-panel-two-place-registration` — the other "did my /adv surface
  actually wire up" gotcha.
