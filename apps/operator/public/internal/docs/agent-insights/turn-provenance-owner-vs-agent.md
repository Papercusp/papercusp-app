# Turn provenance — verified owner-vs-agent labeling
URL: /internal/docs/agent-insights/turn-provenance-owner-vs-agent

Why every PTY-injected turn is byte-identical to the owner typing, and the two-layer envelope+ledger protocol (plus the UserPromptSubmit hook) that stamps every prompt VERIFIED agent-origin / UNVERIFIED claim / affirmative OWNER.

## What this page covers

* the ⟦turn-origin⟧ envelope + nonce-ledger protocol and its D-001/D-002 decisions
* which injectors are enrolled (and why enrollment is MANDATORY)
* per-backend coverage (Claude verified / Codex Layer-1-only / OMP via the wake pump)
* how compaction directive-provenance verification uses the stamps

## The problem: every injected turn impersonates the owner

The model API has only `user`/`assistant` roles. Every papercusp injector —
the wake pump (`events:await` deliveries, coord `wake:` re-invokes), loop
fires, `session:request-compaction` continuations, the compaction-compliance
watchdog's force-compacts, fleet auto-kickoffs — delivers by **typing into
the PTY**, byte-identical to the owner typing. Agents then mis-attribute
machine turns to the owner. Seven compactions later, an agent's own
note-to-self renders as "the owner set an explicit gate" (WI-3532 — the
manufactured-directive class; the same bug pointed at permission instead of
a block manufactures false owner APPROVAL, which is worse). Live evidence:
during the 2026-07-11 wake-pump starve, 12 batched machine wakes all rendered
as user turns.

Ad-hoc labels existed (`[await-event]`, `🔁 Monitor wake`) but are per-site,
unverifiable, and absent for the worst case. **Absence of a label proves
nothing; presence is spoofable.**

## The protocol: envelope (Layer 1) + trust ledger (Layer 2)

Core module: `packages/operator-core/lib/turn-provenance/turn-provenance.ts`.
Bash mirror: `apps/operator/scripts/hooks/cc/userpromptsubmit-provenance.sh`
(**lockstep — change them together**). Launcher mirror: `tagKickoffProvenance`
in `apps/operator/scripts/psu-launcher.mjs`.

1. **Envelope** — every enrolled injector prefixes
   `⟦turn-origin:<origin> nonce:<16-hex>⟧` (origins: `wake-pump`,
   `loop-fire`, `self-compaction`, `fleet-kickoff`, `watchdog`,
   `coord-inject:<sender>`).
2. **Ledger** — BEFORE typing, the injector appends
   `{sid, nonce, origin, sha256(normalized payload), ts}` to
   `~/.papercusp/turn-provenance/<sid>.jsonl` (TTL 10 min; env overrides
   `PAPERCUSP_TURN_PROVENANCE_DIR` / `_TTL_MS`, clamp ≥30s).
3. **Classification** — a Claude `UserPromptSubmit` hook classifies every
   submitted prompt and stamps `additionalContext`:
   * envelope + **live nonce row** → `VERIFIED AGENT-ORIGIN (origin: …)` —
     the LEDGER's origin wins over the envelope's claim; a payload-hash miss
     is flagged as PTY mangling, not a demotion (nonce is the primary key);
   * envelope + expired/absent row → `UNVERIFIED ORIGIN CLAIM` (spoof/replay
     — quoted text carrying an envelope mid-prompt does NOT classify: the
     envelope must open the turn);
   * no envelope + live **hash** match → verified (envelope lost in transit);
   * no envelope + no match + a known **machine-surface banner** (a
     CLI-internal notification that self-labels `[SYSTEM NOTIFICATION - NOT
     USER INPUT]`, e.g. a background-task completion) → `MACHINE-GENERATED
     SURFACE` — unenrollable (no envelope, no ledger row) but definitely NOT
     the owner (EI-9904);
   * no envelope + no match → **affirmative `OWNER (interactive)`**.

**D-002 — the ledger decides, never the text.** Corollary: injector
enrollment is MANDATORY. An unenrolled injector's turns stamp as OWNER —
the exact bug class this exists to kill. Adding a new injection path? Call
`tagTurnForInjection({ sid, origin, text })` before delivery, or your turns
lie.

**D-001 — file, not PG.** The hook hot path runs on every prompt and must
classify in milliseconds, operator-down included (classification matters
MOST mid-incident). Documented acceptable file use (ephemeral same-host
coordination cache, like `~/.papercusp/psu-pty/`). The durable audit is the
transcript itself — the stamp lands in it, searchable via `sessions:search`.

## Enrolled injectors (P-002)

| Injector                                                                                                       | Origin                                                                            | Where                                                         |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| wake pump — warm psu-socket inject, managed-pty write, resume prompt, plan-run resume, hive fresh-wake kickoff | `wake-pump` (or `loop-fire` when the delivery payload carries a cold-loop marker) | `wake-executor.ts` `tagWakeText` (+ `deps.tagTurn` test seam) |
| cold loop RESET/RECYCLE injection                                                                              | `loop-fire`                                                                       | `injectPsuHostWake` cold branch                               |
| `session:request-compaction` continuation note                                                                 | `self-compaction`                                                                 | `request-compaction.ts`                                       |
| compaction-compliance watchdog force-compact continuation                                                      | `watchdog`                                                                        | `compaction-compliance-watchdog.ts`                           |
| scripted launch kickoff (fleet members, plans:launch, `--kickoff`)                                             | `fleet-kickoff`                                                                   | `psu-launcher.mjs` `tagKickoffProvenance`                     |

NOT tagged, deliberately: coord **inbox** bodies (native `from` provenance);
bare `/compact <focus>` fallbacks (a slash COMMAND — an envelope would break
it). Everything is fail-soft end to end: a tagger error still delivers the
untagged turn (it then stamps owner/unverified — visible, never a dropped
wake), and a ledger-write failure still returns deliverable tagged text.

## Per-backend coverage (P-004)

* **Claude** — full: envelope + hook verification. Installed by
  `install-standalone-mcp.sh` (`merge_provenance_hook`) and the desktop
  installer (`papercusp-files.ts` `mergeClaudeHookSettings`, `CC_HOOK_FILES`).
* **Codex** — Layer-1 only: its `hooks.json` fires only Pre/PostToolUse (no
  prompt-submit event), so injected turns carry the visible envelope but no
  ledger-verified stamp. Revisit if codex adds the event.
* **OMP** — deliveries ride the same enrolled wake-executor paths, so the
  envelope is present in the injected text; no prompt-submit hook leg.
* **Native auto-compaction continuations** — cannot be pre-tagged (Claude
  generates them internally); the `SessionStart[source=compact]` anchor
  (`interactive-claude-config.ts`) stamps them `MACHINE-GENERATED
  CONTINUATION` instead.

## What this buys compaction discipline

`~/.papercusp/compaction-strategy.md` § directive-provenance now has a
mechanical leg: a claimed `[owner:…]` directive must trace to a turn stamped
`OWNER (interactive)` (via `sessions:search` on the verbatim transcript). A
directive found only in VERIFIED-agent turns is `[self-imposed]`/`[peer:…]`.

## Threat model honesty

Same-UID is the boundary (as with the psu-pty control sockets): any process
that can write the ledger can mint "verified" rows. The protocol defends
against *confusion* (the dominant real failure) and casual spoofing (quoted
envelopes, replays past TTL), not against a hostile same-user process. Nonce
rows are not consumed on match — replay inside the 10-min TTL of the exact
bytes re-classifies as verified; acceptable because the typing path is
system-owned.
