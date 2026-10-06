# External-app quickstart
URL: /internal/docs/harness/external-app-quickstart

Quickstart for an outside app calling a Papercusp workspace: base URLs and what each serves (hosted portal or opt-in relay: HTTP tools, MCP, webhooks; your own tunnel: MCP + OAuth + webhooks only), getting a limited pcapp_ key (Connect an app, OAuth, device-code sign-in, service keys / client credentials), then curl, MCP client config and TypeScript (fetch and MCP SDK) examples, signed webhooks, and refusal codes.

This page gets an app that runs somewhere else (another server, a laptop on another
network, a CI job, a chat product) calling a Papercusp workspace. It covers the three
ways to call one: **curl** (plain HTTP), an **MCP client**, and a **TypeScript client**.
The operations you call are the ones in [Blueprint operations](/internal/docs/harness/blueprint-operations).

## 1. Find the workspace's base URL

| Where the workspace runs                                                        | Base URL (`$BASE`)                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hosted by Papercusp                                                             | `https://<portal>/api/workspaces/<workspaceId>` — the portal forwards the call to the workspace machine.                                                                                                                                      |
| Your own computer, through **your own tunnel** (the default for local installs) | The public URL of your tunnel, e.g. `https://my-box.example.ts.net`. Point the tunnel at the machine's external-ingress port (`PAPERCUSP_EXTERNAL_INGRESS_PORT`), never at `:3070`; the Remote access page's tunnel wizard does this for you. |
| Your own computer, through the **opt-in Papercusp relay**                       | `https://<portal>/api/workspaces/<workspaceId>`, the same shape as hosted. Traffic passes through Papercusp and is readable there; the consent screen says so before you link.                                                                |

What each address serves:

| Address                                                  | Plain HTTP tools                   | MCP                                      | Webhooks               |
| -------------------------------------------------------- | ---------------------------------- | ---------------------------------------- | ---------------------- |
| Portal (`https://<portal>/api/workspaces/<workspaceId>`) | `$BASE/agent-tools/<group>/<verb>` | `$BASE/mcp`                              | `$BASE/hooks/<id>`     |
| Your own tunnel                                          | not served                         | `$BASE/api/mcp` (plus its OAuth sign-in) | `$BASE/api/hooks/<id>` |

A tunnel deliberately exposes only the MCP endpoint, its OAuth sign-in and webhooks; every
other path answers `404 not_served_on_external_ingress`. So over a tunnel, call tools through
MCP (sections 4 and 5).

## 2. Get a key

Outside apps always use a **limited key** (`pcapp_…`). An owner or admin sign-in is
refused on every app route (`401 app_key_required`).

* **Connect an app** (Settings → Remote access, on the machine itself): pick the tools and
  harnesses the key may use. The key is shown **once**, with a ready curl line and MCP config.
* **OAuth** — an MCP client or chat connector given the `/api/mcp` URL signs in through the
  server's own authorization server (section 4); the person at the computer approves it.
* **Device-code sign-in** (RFC 8628), served on the machine's own address and through your
  own tunnel, so it needs no portal account (the portal relay does not carry it; relay apps
  use OAuth instead):
  1. The app calls `POST <machine or tunnel>/api/connected-apps/device/code` (optionally with a
     `clientLabel`) and shows the user the returned `userCode`.
  2. The user approves that code on the computer running Papercusp, under Settings → Remote
     access. The approval page itself is never served through the tunnel.
  3. The app polls `POST <machine or tunnel>/api/connected-apps/device/token` with
     `{"deviceCode": "..."}` every `interval` seconds; once approved, the response carries the key.
* **Service keys** are for unattended apps. They need a spending cap, do not expire unless
  you set an expiry, and keep working after their creator leaves the organization. A service
  key can be switched to OAuth client credentials: the app sends the key only to
  `$BASE/api/connected-apps/oauth/token` and gets a short-lived `pcat_…` access token (one
  hour by default) to use as its bearer.

Keys are **default-deny**: a key reaches only the tools its scope lists (`blueprint:*`, or
exact `group:verb` names). Shell, file, process, credential, admin and agent-spawn tools can
never be granted.

## 3. Call it with curl

Through the portal, every tool is a `POST` of its JSON arguments to
`$BASE/agent-tools/<group>/<verb>`. Submit an operation, then read its status and result:

```bash
export BASE=https://<portal>/api/workspaces/<workspaceId>
export KEY=pcapp_...   # shown once when the key was created

# Submit. requestKey makes the call idempotent: a retry returns the same handle.
curl -sS -X POST "$BASE/agent-tools/blueprint/submit" \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"harness":"my-harness","operationId":"extract","requestKey":"order-1234","input":{"value":"hello"}}'
# -> {"handle":{...}}   keep the whole handle

# Status, then the validated result once it settles.
curl -sS -X POST "$BASE/agent-tools/blueprint/status" \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"handle":{...}}'
curl -sS -X POST "$BASE/agent-tools/blueprint/result" \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"handle":{...}}'
# -> {"state":"pending"} until done, then {"state":"ready","output":{...},"evidenceRef":"..."}
```

A general (non-blueprint) tool works the same way when the key's scope lists it, for
example `POST $BASE/agent-tools/work_items/list`. Over a tunnel, use MCP instead.

## 4. Call it from an MCP client

Any MCP client that speaks streamable HTTP can use the workspace as a server. With a key:

```json
{
  "mcpServers": {
    "papercusp": {
      "type": "http",
      "url": "https://my-box.example.ts.net/api/mcp",
      "headers": { "Authorization": "Bearer pcapp_..." }
    }
  }
}
```

The client then lists and calls exactly the tools the key allows (`blueprint:submit`,
`blueprint:status`, …). Chat products that add a custom connector by URL (for example
Claude.ai or ChatGPT) use **OAuth** instead of a pasted key: give them the `/api/mcp` URL,
and the server's `401` challenge points them at its authorization server, where the person at
the computer approves the connection and chooses its scope.

## 5. Call it from TypeScript

Through the portal, a small typed wrapper over `fetch` is all an app needs:

```ts
type Handle = Record<string, unknown>;

async function callTool<T>(base: string, key: string, tool: string, args: unknown): Promise<T> {
  const [group, verb] = tool.split(':');
  const res = await fetch(`${base}/agent-tools/${group}/${verb}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${tool} refused ${res.status}: ${JSON.stringify(body)}`);
  return body as T;
}

const base = 'https://<portal>/api/workspaces/<workspaceId>';
const key = process.env.PAPERCUSP_KEY!;

const { handle } = await callTool<{ handle: Handle }>(base, key, 'blueprint:submit', {
  harness: 'my-harness', operationId: 'extract', requestKey: 'order-1234', input: { value: 'hello' },
});
let result = await callTool<{ state: string; output?: unknown }>(base, key, 'blueprint:result', { handle });
while (result.state === 'pending') {
  await new Promise((r) => setTimeout(r, 2000));
  result = await callTool(base, key, 'blueprint:result', { handle });
}
console.log(result.output);
```

Over a tunnel (or through the portal's `/mcp`), use the MCP TypeScript SDK with the same key:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'my-app', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('https://my-box.example.ts.net/api/mcp'), {
  requestInit: { headers: { Authorization: `Bearer ${process.env.PAPERCUSP_KEY}` } },
}));
const submitted = await client.callTool({
  name: 'blueprint:submit',
  arguments: { harness: 'my-harness', operationId: 'extract', requestKey: 'order-1234', input: { value: 'hello' } },
});
```

Inside this repository, `BlueprintOperationClient` with
`createProjectedBlueprintOperationPort(invoke)` gives the same calls with per-operation
input and output types; pass it an `invoke` built on `callTool` above.

## 6. Start work from a webhook

A system that cannot hold a key (a Git host, a payment provider) can start a bound
operation with a **signed webhook** instead. Create one with `triggers:create-webhook`; it
returns the addresses a sender can use (your tunnel's host + `/api/hooks/<id>`, and the relay
address when the machine is linked) and a signing secret shown once. Sign each POST:

```
Papercusp-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with the secret>
Papercusp-Event: <event name, default "received">
Papercusp-Delivery: <your delivery id; a repeat is deduplicated>
```

The body must be a JSON object of at most 256 KiB, and `t` must be within 300 seconds of
the server's clock. A good delivery answers `202` and starts whatever the webhook's armed
trigger binding names; a missing, wrong or stale signature answers `401` and starts
nothing. `triggers:rotate-webhook-secret` rotates the secret with an overlap window.

## When a call is refused

| Status | `error`                              | Meaning                                                                    |
| ------ | ------------------------------------ | -------------------------------------------------------------------------- |
| 401    | `app_key_required`                   | The bearer is not an app key (owner and admin sign-ins never work here).   |
| 401    | `connected_app_invalid_key:<reason>` | The key is revoked, paused, expired or rotated out; the reason says which. |
| 403    | `remote_access_off`                  | The workspace's Remote access switch is off. Every key stops at once.      |
| 403    | scope refusal                        | The tool or harness is outside the key's scope, or is never grantable.     |
| 429    | `rate_limited`                       | Over the per-key or per-workspace limit; retry after the window.           |
| 503    | `workspace_offline`                  | The machine is not connected. Nothing is queued: retry later.              |

See also: [Remote access user guide](/internal/docs/harness/remote-access-guide) for turning
access on, the tunnel and relay choices, and revoking keys.
