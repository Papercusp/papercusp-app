# A raw NUL-byte separator reads as a printable space in your file-reading tool — verify bytes, not toString()
URL: /internal/docs/agent-insights/nul-byte-separator-reads-as-space-in-file-viewer

WI-5450: an on-disk NUL byte (a deliberate composite-key separator used in 15+ repo files) silently displays as a printable space through the Read tool (and generically through cat/most text viewers), which made a perfectly correct tsx-loaded module look 'stale' relative to disk and burned three agents ~1.5h chasing a nonexistent compile-cache bug.

## What actually happened

WI-5450 was opened as "tsx compile cache serves STALE compiled modules to freshly-started processes": a fresh `npx tsx` process loading `packages/operator-core/lib/scout/src-hash.ts` printed a `computeCombinedSourceHash` function using `hash.update("\0")` (a NUL-character separator), while the file *appeared*, via a text-reading tool, to contain `hash.update(' ')` (a plain space). Three agents spent about 1.5h treating this as tsx cache staleness — recomputing the trio content-hash from "what the file shows" and getting a value that matched no running process.

**There was no cache bug.** Direct byte-level verification (`python3 -c "open(path,'rb').read()"`, `git log -p` on the file, and a controlled repro file) all confirm: the file has always contained a literal `\x00` byte at that position — `git log -p` even reports the file as `Binary files /dev/null and b/... differ` from its very first commit. tsx's on-disk cache is keyed by a **sha1 of the actual source bytes** (`node_modules/tsx/dist/index-*.mjs`: `Ne(s)=sha1(s)`, folded into the cache key alongside the esbuild options/version), so a genuine content change always busts the cache — there is nothing to fix there, and `TSX_DISABLE_CACHE=1` would not have changed the outcome.

The illusion came from the **reading tool**, not the file or the loader: a raw NUL byte (`\x00`) rendered as an ordinary printable space with no visual indication it wasn't one. Confirmed directly — write a file containing `before\x00after` and read it back through the Read tool: it renders as `before after`, indistinguishable from a real space.

## Why the file legitimately contains a NUL byte at all

This is **not corruption**. Using a literal NUL byte as a composite-key / path-join separator (so `["ab","c"]` can never collide with `["a","bc"]`) is an established convention in this codebase — at least 15 files do it, e.g. `work-items-events.ts` (`` `${r.kind}\0${r.ref}` ``), `runtime-vintage.ts`, `agent-tools/coordination/read-cursors.ts`, `harness/docs/drift.ts`, `memory/claude-import.ts`, `pot/session-audit.ts`, `libs/generic/cache/src/cache.ts` (`const SEP = '\0'`), and `scout/src-hash.ts` itself. A NUL byte never occurs in real path/id strings, so it's a safe, deliberate separator choice — it just happens to also make the file **binary** from git's and most CLI tools' point of view.

## The gotcha for future you

If you are comparing a **loaded/runtime** value (e.g. `someFn.toString()`, a computed hash) against what a file **"looks like" on disk** via a text-oriented tool (the Read tool, `cat`, most editors, even `grep` without `-a`) — and the file might contain a NUL-separator idiom — **do not trust the visual diff**. The tool may be silently substituting invisible/control bytes with something printable. Verify the actual bytes instead:

```bash
python3 -c "print(repr(open('path/to/file.ts','rb').read()))"
# or
od -c path/to/file.ts | grep -C2 <context>
# or, to confirm git's own view:
git log -p -- path/to/file.ts   # "Binary files ... differ" is your tell
```

`grep` (without `-a`/`-P` quirks) is *also* not reliable here: it prints a generic `binary file matches` instead of the matching line when it detects a NUL byte, and `grep -oP '\x00'` can produce false negatives on GNU grep because of internal NUL-terminated-string handling — don't use grep's silence as proof a NUL byte is absent; use a byte-level read (python/od) as the source of truth.

## Recurrence guard

* This doc, discoverable via `docs:search` on "tsx cache stale" / "NUL byte" / "binary file matches" before anyone re-opens this investigation.
* A standing fact (`wi-5450-tsx-cache-is-not-stale-nul-byte-illusion`) is asserted workspace-scoped so it folds into any near-term orient/dossier that touches scout code identity / soak hash verification.
* No source-code change was made — `src-hash.ts` and its 14 siblings are working exactly as designed; renaming their separator away from NUL would be inconsistent with the rest of the codebase and was not attempted.

## See also

* \[scoutcodehash-runtime-uses-nul-separator-never-recompute-from-source] (workspace fact) — the adjacent, narrower guidance ("ask the runtime, don't recompute") this doc explains the mechanism behind.
* `packages/operator-core/lib/scout/src-hash.ts`, `scout-code-identity.ts` — the real content-hash mechanism this incident was mistakenly distrusted in favor of.
