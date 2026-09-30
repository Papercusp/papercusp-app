# CLAUDE_CONFIG_DIR isolates GLOBAL memory only — PROJECT memory still loads from cwd ($HOME = leak)
URL: /internal/docs/agent-insights/claude-cwd-project-memory-leak

Claude Code has TWO memory-discovery paths. The per-session CLAUDE_CONFIG_DIR skip-link (psu P-002 / EI-155) governs only GLOBAL memory; PROJECT memory loads <cwd>/CLAUDE.md + <cwd>/.claude/CLAUDE.md from the cwd regardless. A session whose cwd is the owner's $HOME re-imports ~/CLAUDE.md + ~/.claude/CLAUDE.md as project files — the exact personal config the config-dir isolation thinks it removed. Fix — never launch an isolated agent in $HOME.

import { Aside } from '@astrojs/starlight/components';

## Two discovery paths, not one

Claude Code loads instruction/memory files from **two independent places**, and
only one of them follows `CLAUDE_CONFIG_DIR`:

1. **GLOBAL (user) memory** — `$CLAUDE_CONFIG_DIR/CLAUDE.md` (default
   `~/.claude/CLAUDE.md`). A psu session points `CLAUDE_CONFIG_DIR` at a
   per-session symlink mirror that **skip-links the personal memory files**
   (`CLAUDE.md`/`AGENTS.md`/`CLAUDE.local.md`) — so the session loads no
   personal global memory. This is psu-isolation **P-002** /
   `interactive-claude-config.ts` (EI-155 builds the dir).
2. **PROJECT memory** — `<cwd>/CLAUDE.md` and `<cwd>/.claude/CLAUDE.md`, loaded
   from the **working directory**, *not* from `CLAUDE_CONFIG_DIR`. Nothing about
   the config-dir mirror touches this path.

When a session's **cwd is the owner's `$HOME`**, the cwd-level project files
**are** the owner's personal config: `<cwd>/CLAUDE.md` = `~/CLAUDE.md` and
`<cwd>/.claude/CLAUDE.md` = `~/.claude/CLAUDE.md` (on this box the personal
`@AGENTS.md` memory rules). The session re-imports exactly the personal
instructions P-002 skip-linked out of GLOBAL memory — via the PROJECT path the
config-dir isolation never governed. Observed live (EI-202): a psu session at
cwd `/home/dev` carried both personal files despite a correct
skip-linked config dir.

## Why this fooled three implement attempts

The `interactive-claude-config.ts` header documents a **"RESIDUAL: the
cwd-discovered PROJECT CLAUDE.md still auto-loads… that's benign (it's the repo
guide)"**. That is only true when cwd is the **repo** (a real project dir, ≥1
level below `$HOME`): the cwd-level file is the intended repo guide, and Claude's
upward walk does **not** reach `~/CLAUDE.md` from there. The `$HOME` case is the
exception the "benign" note silently excludes — only at exactly `$HOME` do the
personal `CLAUDE.md` / `.claude/CLAUDE.md` sit at cwd level. A fix that only
hardens the config dir, or that relocates cwd to the repo root "to be safe,"
misses it: the leak is the **cwd === $HOME** identity, nothing else.

## The fix: never launch an isolated agent in $HOME

A psu superuser session must not run with `cwd === $HOME`. The single
server-side choke point is `bootstrap-su.ts` (plain `psu`, `--brain`,
`--no-picker` all funnel through it). A no-harness launch *prefers* the
launcher's own `process.cwd()` (resume-friendliness), so it can be `$HOME`;
`resolveSuLaunchCwd` (`packages/operator-core/lib/su-launch-cwd.ts`) relocates a
`$HOME` cwd to `envelope.cwd` (the internal `~/.papercusp/…` workspace root,
which carries no personal memory). Harness launches use the harness repo;
`bootstrap-role` uses `spec.cwd` and never inherits the launcher cwd — so neither
has the vector.

```ts
// no-harness $HOME → relocate; everything else (repo / sub-$HOME / internal) kept
resolveSuLaunchCwd({ harnessSlug: null, callerCwd: home, envelopeCwd, home }) === envelopeCwd
```

The deterministic guard is **"the chosen launch cwd is never `$HOME`"**
(`su-launch-cwd.test.ts` + the cwd-vector cases in `psu-prompt-isolation.test.ts`,
P-005). A live "is the personal AGENTS.md absent from the loaded context?"
assertion would need a real Claude launch; the cwd-never-`$HOME` proxy is what's
verifiable in unit tests.

## What to remember

* **Config-dir isolation ≠ full isolation.** It removes GLOBAL personal memory,
  not cwd PROJECT memory. Any "isolate the agent's instructions" work must also
  control the **cwd**.
* **`$HOME` is a poisoned cwd** for any isolated agent — its dotfiles and
  top-level `CLAUDE.md` become project context. Launch in a dedicated dir.

## See also

* [`claude-file-memory-index-cap`](/internal/docs/agent-insights/claude-file-memory-index-cap/) — the other half of the claude-file memory model (the index projection + its cap).
