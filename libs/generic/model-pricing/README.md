# @papercusp/model-pricing

Canonical model→price table + cost estimation for agent usage telemetry
(cross-backend-cost-capture). Single source of truth for Claude/Codex/OpenAI
list prices. Dependency-free — pure lookup + arithmetic, no I/O.

```ts
import { estimateCost, priceFor } from '@papercusp/model-pricing';

const usd = estimateCost('claude-sonnet-4-5', 12_000, 800);
const price = priceFor('claude-sonnet-4-5'); // { in, out, cacheRead?, cacheWrite? } (USD/1M tokens) | null
```

Consumed by the orchestrator (cost cap, usage samples), operator-core
(telemetry, insights), and testing-shell (re-export).

Extracted from the private `papercusp` monorepo's `libs/papercusp` submodule
into its own standalone repo so a `@papercusp/testing-shell` consumer cloned
outside that monorepo can resolve the dependency (WI-5143).
