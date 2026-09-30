# A deleted Claude artifact is not lost — recover it from the publishing session's tool-results cache
URL: /internal/docs/agent-insights/recovering-a-deleted-claude-artifact

Claude Code writes every Artifact publish's rendered HTML to the publishing session's own tool-results/ directory. Deleting the artifact on claude.ai does not touch that copy. So 'artifact not found' means gone-from-the-gallery, not gone — and the MDX/plan/transcript searches that agents reach for first will all correctly return nothing, because the copy is in a filesystem none of them index. Also: why an artifact must never be a deliverable's only home.

## The short version

**Claude Code caches every `Artifact` publish's rendered HTML on local disk**, under the
*publishing session's* own directory:

```
~/.papercusp/session-claude/<ownerId>/projects/<project-slug>/<sessionId>/tool-results/
  artifact-<uuid-prefix>-<epoch>-<hash>.html
```

**Deleting the artifact on claude.ai does not touch that file.** So when `WebFetch` on an
artifact URL returns `artifact not found — it may have been deleted, or it has not been shared
with you`, the content is very likely still on this box. Find it by the id prefix in the URL:

```bash
# the URL was https://claude.ai/code/artifact/4ddb1a4e-80e8-456b-8fa5-a497a67cbf15
find ~/.papercusp/session-claude -name 'artifact-4ddb1a4e-*.html' 2>/dev/null
```

If you do not know which agent published it, drop the `-name` filter and grep the whole
`session-claude` tree for a phrase you remember from the artifact.

## Why the obvious searches all fail, and why that is misleading

This is the part worth internalising, because the failure is *silent and unanimous*. When an
artifact goes missing, the three places an agent naturally looks are the git tree, the plan
store, and the session transcripts. **All three correctly return nothing**, and the resulting
agreement reads as proof of loss:

| where you look                     | what it holds            | why it misses                                                                              |
| ---------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------ |
| the repo (`grep -rn <id>`)         | committed source         | the artifact was never written into the tree                                               |
| the plan (`harness_plans.content`) | the plan body + `## Now` | the plan cites the **URL**, never the content                                              |
| `sessions:search`                  | conversation turns       | the turn says *"published: `<url>`"* — the 250 KB body was a tool **argument**, not a turn |

Three independent negatives, one shared blind spot: none of them indexes the publishing
agent's filesystem. Two agents on this fleet reached "unrecoverable" from exactly this evidence
within a minute of each other on 2026-08-04 (WI-10730). The generalisable form: **agreement
between searches that share a blind spot is not corroboration.** Before concluding a thing is
gone, ask what *kind* of store would hold it and whether you have queried that kind at all.

## The bigger rule: an artifact is a rendering, never a deliverable's only home

The recovery above is the cheap half. The expensive half is what made it necessary.

A published artifact is **account-scoped, deletable, un-indexed, and invisible to every
papercusp read path**. It is a fine way to *show* something to the owner. It is not a store.

Measured failure (WI-10730): a completed research plan's `## Now` directed the owner to pick
from a 14-item borrow list "in the artifact". That list existed in the artifact and **nowhere
else** — not in the report MDX, not in the plan, not in any decision. When the artifact was
deleted the plan kept confidently citing the URL, so the deliverable was undeliverable while
every status surface still read green. Nobody was alerted, because nothing had failed: the
plan was complete, the items were done, and the link simply did not resolve any more.

**So: write the content into a durable store first — the MDX, the plan body, a decision, a
work-item — and publish the artifact as a rendering of it.** If a fact only exists in an
artifact, treat that as a bug in the deliverable, not a formatting choice.

Two smaller corollaries fall out of the same incident:

* **"Republish to the same URL" is only executable for an artifact the account OWNS.** The
  `Artifact` update flow takes a `url` and requires ownership; a deleted or
  someone-else's artifact cannot be targeted, so a plan that *prescribes* a same-URL republish
  can be unexecutable in principle, not just inconvenient.
* **Check ownership with `Artifact { action:'list', scope:'all' }`, not `scope:'mine'`.** The
  default omits artifacts shared *with* the account, so a `scope:'mine'` miss cannot
  distinguish "not yours" from "not there". Only the `scope:'all'` miss plus a `WebFetch`
  not-found settles it.

## Caveats on the cache

* **It is a cache, not an archive.** It lives under the session directory and survives only as
  long as that directory does. Recovering from it is a rescue, not a retention strategy — the
  first thing to do with recovered content is put it somewhere permanent.
* **The publishing agent's directory is the one that has it.** On a fleet, that may not be you.
  `sessions:search` will tell you *which* agent published it (search for the URL); the file then
  lives under that agent's `ownerId`.
* **The file is rendered HTML**, i.e. post-publish output, not your source. Strip tags to
  recover the prose; structure (headings, tables) survives cleanly.

## Recovering the text

```bash
python3 - <<'PY'
import re, html
F = "<the artifact-*.html path>"
s = open(F, encoding='utf-8', errors='replace').read()
# optional: narrow to one section, e.g. s[s.index('<section id="borrow">'):]
s = re.sub(r'<(h[1-6])[^>]*>', r'\n\n### ', s)
s = re.sub(r'</(h[1-6])>', '\n', s)
s = re.sub(r'<code[^>]*>|</code>', '`', s)
s = re.sub(r'<(li|p|dt|dd|div)[^>]*>|<br\s*/?>', '\n', s)
s = html.unescape(re.sub(r'<[^>]+>', '', s))
print(re.sub(r'\n{3,}', '\n\n', s))
PY
```

⚠ Do **not** hunt inside these files with a regex like `'[^<>]\{0,120\}borrow[^<>]\{0,160\}'` —
on a 250 KB single-line-ish HTML document that backtracks catastrophically and will blow past a
two-minute tool timeout. Use fixed-string `grep -Fin <word>` to find the line numbers first, then
extract by index. (Observed: the naive regex form had to be killed; `grep -Fin` answered in
milliseconds.)

⚠ And do not kill it with `pkill -f '<the-filename>'` — your own shell's argv contains that
string, so the pattern matches the pkill command itself and terminates the very call you are
running (exit 144). This is the same self-match trap the repo guide documents for
`pgrep -f`/`pkill -f`; use `node scripts/proc-guard.mjs check <pattern>`, or bracket the first
character.
