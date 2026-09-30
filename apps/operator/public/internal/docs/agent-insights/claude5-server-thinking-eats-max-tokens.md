# Claude-5-family server-side thinking counts against max_tokens — tight-budget JSON calls silently return zero items
URL: /internal/docs/agent-insights/claude5-server-thinking-eats-max-tokens

outputTokens == maxTokens exactly + empty/truncated text = thinking ate the budget. The scout zero-ideation outage (2026-07-16) root cause, the diagnostic rule, and why llm-client's thinkingBudgetTokens is fiction.

# The failure shape

A stateless `llmCall` with `responseFormat: 'json'` succeeds (`ok: true`), reports `outputTokens` **exactly equal to the request's `maxTokens`**, and returns text that is either **empty** or **valid-looking JSON cut off mid-payload**. The caller's parse fails, a `?? []` fallback swallows it, and the pipeline reports "ran, zero items" forever — no error tick, no alert.

This killed all organic scout ideation for days (EI-13119, 2026-07-16): every ideator slot logged `ok:true, raw:0, outputTokens:4096, textLen:0`.

# Root cause

**Claude-5-family models (claude-sonnet-5, …) emit adaptive SERVER-SIDE thinking tokens that count against `max_tokens` even when the client never requests thinking.** On a large prompt (the scout digest is \~64KB), thinking alone ran 2,500–6,000 tokens. With `maxTokens: 4096`:

* big prompt → thinking eats the whole budget → **zero text** (production ticks), or
* moderate prompt → thinking eats most → text starts, then **truncates mid-JSON** (repro: head `{"ideas":[{…`, tail cut inside a string).

Proof pair (same prompt, same model, same gateway path): at `maxTokens: 4096` both calls returned outTok exactly 4096 with broken tails; at `16384` both completed (outTok 6215 / 7863 — **past the old cap**, so the old budget could never fit) and produced ideas.

# Two traps that misdirect the diagnosis

1. **`thinkingBudgetTokens` is fiction on this path.** `llm-client` accepts it and forwards it to `runAgentChat`, but `agent-chat-stream.ts` never implements thinking — the option is silently dropped. Budget math like `maxTokens: thinkingBudgetTokens + 1024` (the old critics.ts) reserves room for a client-side thinking that never happens, while the *server-side* thinking it actually gets is unbudgeted.
2. **The codex CLI bridge drops `max_output_tokens` and defaults reasoning effort to `medium`** (`serveCodexCliBridge` reads only model/input/instructions/stream). A reasoning model on a big prompt can burn the backend's own output cap before emitting any `agent_message`, and the bridge returns 200 with empty text. Fallback models should pin low effort via the model-suffix (`chatgpt:5.5:low` — `parseBridgeModel` parses `:effort`).

# The diagnostic rule

> `outputTokens === maxTokens` **exactly**, and `textLen` far below `outputTokens × ~4 chars` ⇒ thinking/reasoning ate the budget. A cap, not a coincidence — especially when the value is byte-identical across calls.

Capture-on-anomaly makes this self-diagnosing: scout's tick ledger now records `textHead/textLen/outputTokens` on any ok-but-zero-parse slot (`detail.ideators[]` in `harness_shared.scout_ticks`).

# The fix pattern

Give every JSON-emission call on a claude-5 model **thinking headroom**: scout stages now use 16384 (ideators, revise) or `+8192` (critics, recombine, experiment). Only generated tokens are billed — a high cap on a completing call costs nothing extra.

# Related

* `models.ts`: scout defaults must stay ANTHROPIC ids — the ChatGPT-subscription codex credential rejects `gpt-5.6` outright (P-020 cannot apply to scout yet).
* EI-13118 (fleet-spec model strings 404 on the raw API path) — the adjacent silent-outage class.
