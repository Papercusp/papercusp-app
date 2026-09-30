# Empty-string env vars defeat `??` defaults — docker-compose `${VAR:-}` ships \"\", not unset
URL: /internal/docs/agent-insights/empty-string-env-defeats-nullish-defaults

A compose line like `SCOUT_CONVERSATION_BUDGET_USD: ${SCOUT_CONVERSATION_BUDGET_USD:-}` injects an EMPTY STRING into the container when the host env doesn't define the var. In Node, `'' ?? 'default'` keeps '' (empty string is not nullish), so `Number(process.env.X ?? '1')` becomes Number('') → 0. In the Restart scout-service this made the conversation budget $0 and the gate `cost >= 0` rejected EVERY message ('hit budget: $0.0000 ≥ $0') — a total prod chat outage with a perfectly healthy service. Same class hit OPENAI_BASE_URL earlier (commit 4920dd05). Rule: any env consumed with a default must treat empty/whitespace/garbage/non-positive as unset — parse via a helper (see apps/scout-service/src/scout/budget.ts parseBudgetUsd), or use `:-realdefault` in compose, never `:-`. Diagnostic tell: an error that should depend on accumulated state firing on the FIRST request of a fresh session means the threshold parsed to zero, not that the meter is wrong.

# Empty-string env vars defeat `??` defaults

**Symptom (2026-07-17, WI-5324):** every Scout chat message on shop.buyrestart.com —
including message one of a brand-new session — returned
*"This conversation has reached its usage limit."* The service was healthy; no LLM
call was ever attempted.

**Mechanism, three innocent pieces that compose into an outage:**

1. `docker-compose.prod.yml`: `SCOUT_CONVERSATION_BUDGET_USD: ${SCOUT_CONVERSATION_BUDGET_USD:-}`
   — when the host `.env.production` doesn't define the var, `${VAR:-}` interpolates
   to **empty string**, and the container env var exists as `""` (NOT unset).
2. `scout.service.ts`: `Number(process.env.SCOUT_CONVERSATION_BUDGET_USD ?? '1')`
   — `"" ?? '1'` evaluates to `""` because **empty string is not nullish**.
3. `Number("")` → `0`. Budget = $0, so the gate `costMicroUsd >= budget * 1e6`
   is `0 >= 0` → **true on every request**.

**Proof pattern in logs:** `hit budget: $0.0000 ≥ $0` — a threshold of literal `$0`
is the giveaway that the *parse* failed, not the meter.

**Diagnostic tell (generalizes):** a limit/quota error that should depend on
accumulated state firing on the FIRST request of a fresh session ⇒ suspect the
threshold parsed to zero/empty, before suspecting the accounting.

**Fix + recurrence guard:**

* `apps/scout-service/src/scout/budget.ts` `parseBudgetUsd(raw, fallback)` — since
  deleted along with the rest of `apps/scout-service`, so this is a historical
  reference with nothing left to point at (see the frontmatter note); kept because
  the SHAPE is the reusable part: empty / whitespace / non-numeric / non-finite /
  non-positive all fall back, unit-pinned in `budget.test.ts` (the empty-string case
  was named for this outage). Note `packages/operator-core/lib/scout/budget.ts` is a
  DIFFERENT file and does not carry this helper — do not read it as the successor.
* If you want a compose-level default, write `${VAR:-1}` — a REAL value —
  never bare `${VAR:-}` feeding code that uses `??`.

**Prior art in the same repo, same class:** commit `4920dd05`
*"fix(scout): fall back to default base URL when OPENAI\_BASE\_URL is empty"*.
When you see `?? 'default'` next to `process.env` anywhere a compose file feeds
it, assume the empty-string case WILL eventually arrive.

**Instances stack and MASK each other (same outage, hour two):** fixing the $0
budget gate un-masked a SECOND instance in the same file — `OPENAI_MODEL_ID ?? 'gpt-4o-mini'`
kept `""`, so every request shipped `model: ""` → OpenAI 400 "you must provide a
model parameter". The file even ALREADY had the correct `?.trim() ||` idiom on two
neighboring consts (`OLLAMA_URL`, `OPENAI_BASE_URL`) from prior hits — the lesson is
to sweep the WHOLE file/service for the class when you fix one instance
(`grep -n "process\.env\..* ??" …`), because the first instance's failure hides the
later ones on the same request path.
