# @papercupai/fetch-plus

Clean URL→markdown for agents doing web research. Wraps [Jina AI Reader](https://r.jina.ai) so agents get LLM-friendly content instead of raw HTML.

This is a **first-party Papercusp tool plugin** demonstrating the function-as-truth pattern with HTTP-fetch-style implementation (vs Repomix's subprocess style). One function, two transports, zero per-transport code.

## Why this exists

OMP's built-in `fetch` returns raw bytes/headers — fine when you need them, terrible when you want clean content. Jina Reader handles HTML pages, PDFs, and JS-rendered sites and returns clean markdown ready for LLM consumption.

| Use case | Tool |
|---|---|
| Raw bytes / specific headers | OMP `fetch` |
| HTML/PDF/SPA → clean markdown | `fetch_clean` (this plugin) |
| Structured extract / site crawl | `firecrawl-bridge` (planned) |

## Usage

### From an agent (MCP)

```json
{
  "tool": "fetch_plus.fetch_clean",
  "input": {
    "url": "https://docs.example.com/api-reference",
    "format": "markdown"
  }
}
```

### From curl

```bash
curl -X POST http://localhost:3070/api/plugins/fetch-plus/fetch_clean \
  -H "content-type: application/json" \
  -H "x-papercusp-workspace: default" \
  -H "x-papercusp-harness: sheets" \
  -H "x-papercusp-role: architect" \
  -H "x-papercusp-run: <runId>" \
  -H "x-papercusp-spawn: <spawnId>" \
  -d '{"url":"https://example.com","format":"markdown"}'
```

## Per-role quotas

| Role | Quota |
|---|---|
| worker | 5 / chunk |
| scoper | 20 / run |
| architect | 30 / run |
| reviewer | 10 / run |
| debugger | 20 / run |
| validator/operator | unrestricted |

Quotas are higher than Repomix's because individual fetches are cheap and short. Workers reasonably want to read 5 pages of docs per chunk.

## API key (optional)

Set `JINA_API_KEY` in the operator's env to unlock higher rate limits. Free tier (no key) handles light use; paid tier (~$10/mo) for heavy research workloads.

## Configuration

Per-harness settings at `<stateDir>/plugins/@papercupai_fetch-plus/config.json`:

```json
{
  "maxResponseChars": 200000,
  "userAgent": "Papercusp/fetch-plus"
}
```

Output exceeding `maxResponseChars` is truncated with a note.

## Output

Returns a single text content block with the markdown (or plain text if `format=text`). No file handoff — Jina output is bounded enough to inline.
