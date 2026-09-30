# Your UI edit "isn't showing up" in the desktop — suspect a stale/duplicated operator-vite watcher (and don't trust grep on the bundle)
URL: /internal/docs/agent-insights/ui-edit-not-showing-stale-vite-watcher

A correct, tested UI change appeared to make ZERO difference in the Tauri app. Root cause was the operator-vite `vite build --watch`, not the code — a 4-day-old degraded watcher plus a second one racing into the same dist/. How to diagnose it reliably (python, not grep) and fix it (kill all, clean build, restart ONE singleton).

## What

You edit `apps/operator/app/**` (the SPA's source, imported by operator-vite),
the unit tests pass, `tsc` is clean — and the running desktop shows **zero
change** after a reload. The instinct is "my code is wrong." Usually it isn't:
the served `apps/operator-vite/dist` bundle simply doesn't contain your code,
because the **`vite build --watch` that feeds dist is broken**, not your edit.

Two failure modes seen together (2026-06-17, the Queue redesign):

1. **A long-lived, degraded watcher.** The `vite build --watch` had been up \~4
   days (≈5.9 GB RSS). Its in-memory module graph went stale: it kept emitting
   new `index-*.js` + rewriting `index.html` (so mtimes looked fresh) **without
   re-reading the changed source** — your new string literals never landed.
2. **Two watchers racing into one `dist/`.** A second watcher got spawned
   (the `bin/vite-watch-singleton` `VITE_WATCH_REPLACE=1` path could NOT kill
   the original, because that original was started outside the singleton lock —
   `sh -c vite build --watch …` from a `beforeDevCommand`, so it never held the
   lock fd). Both wrote `dist/` → **hundreds of orphan `index-*.js` chunks** and
   an `index.html` whose lazy-chunk hashes pointed at a *different* build than
   the one with your code.

## The trap that wastes the most time

**`grep` silently false-negatives on the bundle.** A production `index-*.js` is
one \~2.5 MB single line; GNU grep's line handling makes `grep -l "myString"
dist/assets/*.js` report **nothing even when the string is present**. We
concluded "my code isn't built" off a lying grep. Verify bundle contents with
**python** (`'needle' in open(f).read()`), never `grep`, on minified single-line
files.

## Fix (and the steady state to leave behind)

```bash
cd apps/operator-vite
# 1. kill ALL build watchers — self-exclude regex so you don't kill your own shell
pkill -f 'vite build --[w]atch'
# 2. clean + one-shot build (this app builds in ~3s); confirms a CONSISTENT dist
rm -rf dist && npx vite build
# 3. python-verify index.html's referenced chunk actually contains your code
python3 - <<'PY'
import glob, re, os
html = open('dist/index.html').read()
refs = re.findall(r'assets/(index-[A-Za-z0-9_-]+\.js)', html)
print([r for r in refs if 'YOUR_NEW_STRING' in open(f'dist/assets/{r}').read()])
PY
# 4. restart exactly ONE watcher for ongoing dev
VITE_WATCH_REPLACE=1 setsid nohup npm run dev:nohmr >/tmp/vite.log 2>&1 &
# 5. pgrep -af 'vite build --[w]atch'  → expect ONE node process
```

Then the owner does a **hard reload** (Ctrl-R) in the Tauri window — the desktop
serves a static dist and only changes on rebuild + reload (no HMR on the nohmr
path). See \[\[reference-desktop-dev-nohmr-3070-dist]].

## Why "I see 0 changes" specifically

The user's URL also carried a lingering `?plan=…` alongside `?view=queue`. The
*old* served code honored `?plan=` and rendered a full-width `PlanDetail` — so
they weren't even looking at the Queue. (The redesign's nav-fix gates the full
editor on `view==='plans'`, but that fix was in the un-served bundle.) When a
UI change "does nothing," check **what the served bundle actually contains** and
**what URL state the user is in** before doubting the diff. Related:
\[\[queue-waiting-on-you-derive-dont-store]].
