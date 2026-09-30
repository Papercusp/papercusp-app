# Embed sidecar runbook — one warm embedding model per host (:3384)
URL: /internal/docs/agent-insights/embed-sidecar-runbook

Ops guide for the shared local-embedding sidecar: activation envs (PAPERCUSP_EMBED_SIDECAR / _URL / _MODE / _PORT), the D-004 /embed + /healthz wire, spawn/adopt/respawn supervision, and the D-003 in-process fallback that makes it always safe to kill.

## Why it exists

Every embedding consumer used to load its own in-process copy of the model — the
staging host, each of \~7 release-cluster workers, desktop hosts, green-checkpoint
vitest runs, bench CLIs. Cost per process: \~2.2GB duplicated model RSS, a model
warm-load from \~2.8s (page-cached) to \~35s (cold on a loaded box, surfacing as
`memory_timeout` on `memory:remember`), and a per-process ONNX thread pool (the
WI-3792 spin-storm surface). The sidecar owns **one warm pipeline per host** and
serves loopback HTTP.

Measured on adoption (P-005, 2026-07-10): **+\~5ms per embed** over the wire (p50
47.3ms sidecar vs 42.5ms in-process) against a **2817ms cold-load avoided** per
fresh process; consolidated server RSS 2.23GB total.

## Space safety (D-002) — using the sidecar is never a re-embed

The server wraps the **same** `@papercusp/memory` builders the in-process path
uses (`buildGemmaEmbedder` / `buildLocalEmbedder` / `buildHarrierEmbedder` —
task prompts, MRL truncate+renormalize, WI-3792 ORT thread caps included), so
sidecar vectors are **bit-identical** to in-process vectors. Live-pinned: 10/10
bit-identical for gemma; exact-equal for harrier, both kinds. Adopting or
dropping the sidecar mid-stream can never mix embedding spaces (see
`agent-insights/embedding-space-vs-dimension` for why that matters).

## Activation — dark by default

| env                              | effect                                                                                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAPERCUSP_EMBED_SIDECAR_URL`    | Explicit sidecar base URL — **wins over everything**. This process embeds through it (e.g. fleet workers pointed at one host-owned sidecar).                    |
| `PAPERCUSP_EMBED_SIDECAR=1`      | Per-host opt-in: the first process that needs an embed lazily *ensures* the host-local sidecar (adopt-or-spawn, below).                                         |
| `PAPERCUSP_EMBED_SIDECAR_MODE=1` | This process **is** the sidecar (the packaged divert in `serve.ts` / `hono-host.ts`). Also disables the opt-in inside the sidecar itself — the recursion guard. |
| `PAPERCUSP_EMBED_SIDECAR_PORT`   | Port override. Default **3384** (mnemonic: the 384-dim space it serves).                                                                                        |

With neither URL nor opt-in set, `resolveProcessSidecarUrl()` returns null and
`buildSidecarFirstEmbedder` degenerates to the plain in-process embedder with
zero per-call overhead — byte-for-byte the pre-sidecar behavior. Since
EI-19418496145469907, `ensureEmbedSidecar()` logs this fallback **once per
process at WARN** (`[embed-sidecar] no sidecar configured for this process …`)
instead of silently — see the next section for why that matters.

Resolution order (`embed-sidecar-wiring.ts`): explicit URL → `ensureEmbedSidecar()`
(when opted in) → null. All four production seams (memory configure cascade,
agent-tools query embedder, embed-backfill, reembed) route through this one seam
via `buildSidecarAwareEmbedder(model, kind)`.

### ⚠ A standalone verification driver does NOT inherit the production env — it silently runs a different code path

`PAPERCUSP_EMBED_SIDECAR_URL` lives **only in the systemd units**
(`papercup-bg-host.service` / `papercup-dev-api.service`), not in your
interactive shell or an agent session. So a standalone driver — e.g.
`npx tsx` importing `runBackfillSweep` or any other embedding call directly —
runs with neither env var set, falls through to the pure in-process ONNX
embedder, and every observable signal (mode name, dims, vector values,
error count) is **identical** to a genuine sidecar-served run. The only tell
without the WARN log above was a subtler per-call latency difference — not
something you'd notice unless you already had a sidecar baseline to compare
against (EI-19418496145469907).

If you need to verify the actual production (sidecar-served) code path from a
standalone driver, export the same value the systemd unit uses:

```bash
export PAPERCUSP_EMBED_SIDECAR_URL="$(systemctl --user show papercup-bg-host.service -p Environment \
  | tr ' ' '\n' | grep '^PAPERCUSP_EMBED_SIDECAR_URL=' | cut -d= -f2-)"
```

Then confirm you're actually on that path: `buildSidecarAwareEmbedder`'s
resolution should NOT print the "no sidecar configured" WARN, and (in
embed-backfill specifically) the `sweep starting` / `embedder resolved` heartbeat
lines should be followed by sidecar-side timing, not the bare in-process numbers.

## The wire (D-004)

```
POST /embed   { model?: 'gemma'|'local'|'harrier',   // default 'gemma'
                kind: 'query'|'document',
                texts: string[] }
           →  { vectors: number[][], dims, runtime: 'node-onnx-worker', modelRev }

GET  /healthz → { ok, pid, uptimeMs, runtime,
                  models: { '<model>:<kind>': 'cold'|'warming'|'warm'|'failed' } }
```

* The **server owns the space-defining knobs** — callers pass `kind`, never
  prompt text. `gemma` and `harrier` are asymmetric dual-encoders (`kind` picks
  the task prompt; harrier prefixes queries only, documents go raw); `local`
  (BGE-small) is symmetric — `kind` accepted and ignored.
* Caps: ≤256 texts/call, ≤32k chars/text, 16MB body — violations get a specific
  400, never an OOM.
* **Single-flight FIFO**: concurrent requests serialize through one chain (the
  ONNX worker is one-at-a-time anyway) — fair ordering, bounded memory.
* Binds **127.0.0.1 only** — vectors of private text cross this wire.
* Boot: prints the `PAPERCUSP_EMBED_SIDECAR_READY port=N` handshake line **at
  listen**; gemma (document + query) warms in the background *after* listen, so
  the handshake never waits out a model load. A failed embedder build is **not
  memoized** — the next request for that `model:kind` retries the slot.

Quick checks:

```sh
curl -s http://127.0.0.1:3384/healthz | jq .models
curl -s -X POST http://127.0.0.1:3384/embed \
  -H 'content-type: application/json' \
  -d '{"model":"gemma","kind":"query","texts":["hello"]}' | jq '.dims, .modelRev'
```

Manual dev run (staging tree):

```sh
PAPERCUSP_EMBED_SIDECAR_PORT=3384 npx tsx apps/operator/bin/embed-sidecar.ts
```

## Spawn / adopt / respawn (`embed-sidecar-spawn.ts`)

`ensureEmbedSidecar()` — the lazy front door consumers hit on first embed:

1. Opt-in env not set → null (caller stays in-process). Never throws.
2. Our own child already running → its URL.
3. **`/healthz` answers on the fixed port → adopt the sibling.** The port is one
   per host; the first process to need the sidecar spawns it, everyone else
   rides along. This is what prevents doomed-EADDRINUSE spawn loops.
4. Otherwise spawn: DEV runs `apps/operator/bin/embed-sidecar.ts` via tsx;
   PACKAGED re-execs the bundle with `PAPERCUSP_EMBED_SIDECAR_MODE=1`. Spawn env
   belts (EI-8810): `PAPERCUSP_HONO_PORT=0`, `PORT=0`,
   `PAPERCUSP_BACKGROUND_WORKERS=0` — a mode-divert miss must not boot a full
   host on the parent's port or double-run single-writer background machinery.
   10s startup timeout waiting for the READY line.

Crash handling: exponential-backoff auto-respawn with a sliding-window circuit
breaker — **5 crashes in 5 minutes → gives up** (embedding stays on the
in-process fallback until an explicit `spawnEmbedSidecar()` or process restart).
A respawn attempt also healthz-probes first and adopts a sibling instead of
spawning. Benign client-disconnect errors (EPIPE) never tear down a healthy
sidecar. Supervision state is surfaced in `dev:service_health`
(`embedSidecarSupervisionStatus`: running / attempts-in-window / gaveUp).

## Client fallback (D-003, `sidecar-embedder.ts`)

Embedding is **never 'disabled' by a sidecar outage** — worst case is exactly
the pre-sidecar in-process behavior.

* `buildSidecarFirstEmbedder`: tries the sidecar; **any** failure (connect
  refused, timeout, non-200, bad shape) marks it down for 30s
  (`DEFAULT_REPROBE_AFTER_MS`) — embeds in that window go straight to the
  fallback with zero sidecar round-trips. After the cooldown, the next **embed
  is the probe** — no separate healthz ping.
* Per-embed budget 15s (`DEFAULT_SIDECAR_TIMEOUT_MS`) — deliberately generous: a
  freshly-spawned sidecar may still be warm-loading on its first request; a
  budget trip costs one cooldown on the fallback path, nothing more.
* **Transition-only logging**: one line on down, one on up — never per-embed spam.
* The fallback embedder is lazy-built at most once (a failed build is not
  memoized), so the sidecar-served happy path loads no local model.
* Live-verified failover: `kill -9` the sidecar mid-traffic → zero failed memory
  ops, and (D-002) the exact same vectors from the fallback.
* Batch consumers (embed-backfill) call `sidecarEmbedBatch` directly for the
  `texts[]` amortization the single-text `EmbedFn` seam can't express.

## Troubleshooting

| symptom                                            | read                                                                                                                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Port already answers when you expected to spawn    | A sibling process owns it — that is the design. Adopt (automatic); don't kill it.                                                                                |
| `gave up auto-respawn` in logs                     | Circuit breaker tripped (5 crashes / 5 min). Embedding still works in-process (D-003). Fix the crash cause, then explicit respawn or restart the owning process. |
| `/healthz` slot shows `failed`                     | That `model:kind` build failed once; it retries on the next request — transient disk/download faults don't brick the slot.                                       |
| Sidecar killed / down                              | Clients log one down-transition and continue in-process; expect \~30s cooldowns between reprobes. Safe by design.                                                |
| Packaged build boots a full host / EADDRINUSE loop | The `PAPERCUSP_EMBED_SIDECAR_MODE=1` divert was missed — see the EI-8810 spawn belts above and `agent-insights/esbuild-cli-self-exec-guard-kills-sidecar`.       |
| `memory_timeout` on fresh workers under load       | The exact symptom the sidecar removes — check the worker actually has `PAPERCUSP_EMBED_SIDECAR_URL` or the opt-in env.                                           |

## Verifying parity (the live proof recipe)

Embed the same text through the wire and in-process; assert **exact** float
equality (not cosine ≈ 1): `POST /embed {model, kind, texts:[t]}` vs
`build<Model>Embedder({kind})(t)`. The P-005 and P-014 live verifications did
exactly this — 10/10 bit-identical (gemma), exact-equal both kinds (harrier,
dims 1024).
