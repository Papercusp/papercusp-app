# The Papercup's voice-out (voice:say) crosses processes — its buffer MUST be shared (PG), not in-memory
URL: /internal/docs/agent-insights/papercup-voice-out-is-cross-process

The dock Papercup's voice:say runs inside the agent-mcp process its role-scoped MCP connects to (an mcp-proxy on :9071 → the green operator :3070), while the webview drains GET /api/operator/papercup-output on a DIFFERENT operator process. A process-local in-memory FIFO therefore never bridges push→poll — the user speaks, gets a correct TUI answer, and HEARS NOTHING. The buffer must be a shared store (PG table harness_shared.sentinel_says). When debugging "voice-out is silent", check the buffer on ALL operator hosts, not just the one the webview talks to.

## The trap

The dock 🛡 Papercup is a `psu --role=papercup` Claude-Code TUI. Its **voice-OUT**
is the `voice:say` MCP tool → `pushSentinelSay()`; the webview polls
`GET /api/operator/papercup-output` → `drainSentinelSays()` → desktop TTS.

The seductive (wrong) implementation is a module-scoped in-memory FIFO:

```ts
const buffer: string[] = [];
export async function pushSentinelSay(t) { buffer.push(t); }
export async function drainSentinelSays() { const o = buffer.slice(); buffer.length = 0; return o; }
```

It passes its unit test, works in a single-process dev harness, and is **silently
broken in the real topology**.

## Why it's broken: push and poll hit different processes

The psu Papercup's role-scoped MCP is configured (in its `.mcp.json`) to an
HTTP MCP endpoint — observed as an **mcp-proxy listening on `127.0.0.1:9071`
that forwards to the green operator `:3070`**. So `voice:say` (and every other
MCP tool the Papercup calls) executes **inside the `:3070` process** and
`pushSentinelSay` fills **that** process's in-memory array.

The webview, meanwhile, drains `/api/operator/papercup-output` on **whatever
operator the desktop is wired to** — a *different* process. Its array is always
empty. Net effect: **the user speaks, the Papercup answers correctly in the TUI,
and the user hears nothing.** Nothing errors; the buffer is just never bridged.

This is the same class as the storage-policy "no module-scoped Maps for shared
state" rule — an in-memory buffer is per-process, and this buffer's producer and
consumer are guaranteed to be in different processes.

## The fix: a shared FIFO in Postgres

`voice:say` and the drain must rendezvous in a store both processes share. Every
operator/agent-mcp process on the box talks to one database (native `:5432` in
dev, embedded in the shipped app), so a single **global** FIFO table is the
bridge (migration `390-papercup-says-pg.sql`):

```sql
CREATE TABLE IF NOT EXISTS harness_shared.sentinel_says (
  id BIGSERIAL PRIMARY KEY, line TEXT NOT NULL, created_at BIGINT NOT NULL
);
```

* push = `INSERT` + trim to the most-recent N (bounded).
* drain = `WITH d AS (DELETE … RETURNING id,line) SELECT line FROM d ORDER BY id` — race-free, no read-modify-write window.
* No `workspace_id`: this is the LOCAL-APP-USER-ONLY desktop TTS channel (owner constraint) — one Papercup, one webview, one machine — NOT the P2P voice-channel system (`voice_relay` / `operator_voice_channels`). A global queue also sidesteps any cross-process `activeWorkspaceId()` mismatch.
* push/drain swallow errors (a relay blip must never fail the Papercup's turn).

## 2026-07-01 update — the drain now has TWO gated consumers

Since `voice-unified-papercup-pipeline-2026-07-01` (P-002), the webview poll is
no longer the only drain. While an operator voice SESSION is live, the
server-side **papercup-says pump** (`voice-node/papercup-says-pump.ts`) owns the
FIFO: it drains, broadcasts a response transcript, synthesizes the line into bus
audio (`broadcastOpVoice`), and persists it — every attached client displays it
and the elected player speaks it. The webview poll stands down while
`micOwnedByFullAgent` and still owns local (no-session) mode. Exactly one
consumer at a time; the atomic PG drain makes a transition race deliver a line
to one of them, never both. Debug rule: know WHICH consumer should own the
drain right now (session live → the pump) before concluding rows are vanishing.

## Debugging checklist when "voice-out is silent"

1. **Did the Papercup actually call `voice:say`?** Dump the pane (`zellij action dump-screen --pane-id <id>`) and look for the tool call. The persona mandates it (`papercup.persona.md` → "How you speak"); a turn that only writes terminal text is silent to the user.
2. **Check the buffer on ALL operator hosts**, not just the webview's. With the old in-memory buffer, `GET /api/operator/papercup-output` on `:3070`, `:3170`, `:3270` each return their OWN array — a false-negative is easy. With the PG fix, any host returns the same shared rows.
3. **Confirm the Papercup's MCP endpoint** in its `.mcp.json` (`~/.papercusp-workspaces/<ws>/.papercusp/.mcp.json`) — the `url` tells you which process `voice:say` runs in (e.g. the `:9071` proxy → `:3070`).

## Full-agent engine mode — server-side pump owns the drain (2026-07-01)

Since **voice-unified-papercup-pipeline** (P-002, 2026-06-30+), a full-agent
voice engine (e.g. ElevenLabs Conversational, OpenAI Realtime) can own the voice
session — it acts as THE BRAIN and the Papercup TUI becomes a viewport. When
`fullAgentEngine` is active (not `'off'`) and `micOwnedByFullAgent` is true, the
**SERVER-side** `papercup-says` pump takes over: it synths the spoken reply AND
fan-outs to every attached client (local TTS, P2P voice relays, etc.).

The LOCAL client-side poll in `VoiceAppBridge` (the interval that drains
`/api/operator/papercup-output`) MUST NOT compete when a full-agent owns the
mic:

```ts
// One-brain voice-OUT: while a full-agent session is live, the SERVER-side
// papercup-says pump owns the FIFO — this local-mode poll must not compete.
if (voiceStateRef.current.micOwnedByFullAgent) return;
void drainSentinelOutput();
```

So the buffer is STILL shared PG (the architecture remains), but the CONSUMER
(local drain vs server-side pump) depends on which engine is driving the session.
When the full-agent pump is active, it reads and processes all rows; the local
drain backs off to avoid double-draining or losing utterances.

## Sibling gotcha — voice-IN is the mirror image

Voice-IN (`POST /api/operator/papercup-input`) does NOT use this buffer: it
writes the transcript into the Papercup pane's stdin via
`packages/operator-core/lib/papercup/papercup-pane-input.ts` (renamed from
`sentinel/sentinel-pane-input.ts` in the 2026-07-09 lexicon rename sweep; the
exported `writeToSentinelPane()` function name has not been renamed yet),
reading the pane
id from `~/.papercusp/papercup-pane` (written by the `psu-papercup` launch
wrapper). Its hazards are different — a boot-window race after a dock relaunch,
and writing into an EXITED pane (where the trailing Enter re-runs the command and
loses the turn). The pane-write mechanics are now SHARED with in-process callers
(the server-side EL-utterance relay, deep-delegation answer injection) — they
all converge on the `writeToSentinelPane()` function so they apply the same
warm-up gate and exited-pane guard.
