# @papercupai/firecrawl-bridge

Managed [Firecrawl](https://firecrawl.dev) access for heavy research workloads — PDFs, JS-rendered pages, schema-driven extraction, site mapping. Use `fetch-plus` first; reach for this when fetch-plus's Jina Reader isn't enough.

Three functions, all projected on HTTP + MCP:

| Tool | Endpoint | Purpose |
|---|---|---|
| `firecrawl.scrape` | `/api/plugins/firecrawl-bridge/scrape` | One URL → markdown/html/screenshot/links |
| `firecrawl.extract` | `/api/plugins/firecrawl-bridge/extract` | URL(s) + JSON schema → structured JSON via LLM extraction |
| `firecrawl.map` | `/api/plugins/firecrawl-bridge/map` | Discover URLs reachable from a starting page |

## When to use

- **fetch-plus** (free, anonymous): light HTML→markdown work. Use first.
- **firecrawl scrape**: PDFs, JS-rendered SPAs, screenshots. Use when fetch-plus fails.
- **firecrawl extract**: structured data extraction with a JSON schema (e.g. "give me an array of `{name, price, url}` from this product listing").
- **firecrawl map**: enumerate a doc-site's pages before crawling.

## Setup

Set `FIRECRAWL_API_KEY` in the operator's env (or via `/settings/api-keys` once that ships):

```bash
export FIRECRAWL_API_KEY=fc-xxxxxxxxxxxxxxxx
```

Free tier handles light use; check [firecrawl.dev/pricing](https://firecrawl.dev/pricing) for paid tiers. Self-hosted: set `apiBase` in per-harness config to your instance.

## Per-role quotas

| Tool | worker | scoper | architect | reviewer | debugger |
|---|---|---|---|---|---|
| scrape | 2/chunk | 10/run | 15/run | 5/run | 10/run |
| extract | — | 5/run | 10/run | — | — |
| map | — | 5/run | 5/run | — | — |

`extract` and `map` are planning tools — only scoper/architect/operator have access. `scrape` is broadly available since it's the workhorse.

## Usage

### Scrape

```bash
curl -X POST http://localhost:3070/api/plugins/firecrawl-bridge/scrape \
  -H "content-type: application/json" \
  -H "x-papercusp-workspace: default" \
  -H "x-papercusp-harness: sheets" \
  -H "x-papercusp-role: architect" \
  -H "x-papercusp-run: <runId>" \
  -H "x-papercusp-spawn: <spawnId>" \
  -d '{"url":"https://example.com","formats":["markdown","screenshot"]}'
```

### Extract

```json
{
  "tool": "firecrawl.extract",
  "input": {
    "urls": ["https://news.example.com"],
    "schema": {
      "type": "object",
      "properties": {
        "headlines": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "title": { "type": "string" },
              "url": { "type": "string" }
            }
          }
        }
      }
    }
  }
}
```

## Configuration

Per-harness settings at `<stateDir>/plugins/@papercupai_firecrawl-bridge/config.json`:

```json
{
  "apiBase": "https://api.firecrawl.dev",
  "inlineThresholdChars": 50000
}
```

## License caveat

The Firecrawl OSS edition is AGPL-3.0; the hosted API at firecrawl.dev is a managed service with its own ToS. This plugin connects to either — set `apiBase` to your self-hosted URL if AGPL bothers you. The bridge code itself (this plugin) is MIT.
