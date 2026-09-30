# @papercusp/tauri-verify

Stable, target-explicit assertions for Papercusp’s Tauri shell. The library uses
the same authenticated dev-bridge protocol as `tauri-agent-tools`, but gives
tests and agents semantic operations instead of one-off JavaScript snippets:

- `appReady()` — authenticated bridge, mounted webview, target API, route, and
  explicit rejection of the mounted route-error boundary (no false green)
- `route()` — exact or regular-expression pathname assertion
- `scope()` — active harness and workspace assertion
- `screen()` — semantic route, query, and live selector assertion
- `navigateToScreen()` — navigate to a registered screen and wait until ready

## Targeting is mandatory

Papercusp routinely has multiple desktop instances running. Never rely on the
first token file found in `/tmp`; name the process you intend to drive:

```ts
import { createVerifier } from '@papercusp/tauri-verify';

const verify = createVerifier({ tauriPID: 12345 });
const ready = await verify.appReady();
if (!ready.ok) throw new Error(`${ready.code}: ${ready.error}`);

await verify.scope({ workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' });
await verify.screen('learning');
```

Find the PID with `tauri-agent-tools probe --json`. For an already-resolved
bridge, pass `bridgePort` and `bridgeToken` together. Omitting a target returns
`target_required`; the library never chooses an arbitrary live desktop.

By default, `appReady()` checks `/api/health` on the origin the target webview
is actually rendering. `apiBaseUrl` is only needed when a test deliberately
splits its webview and API origins.

## Semantic screens

`SCREENS` uses routes and CSS selectors that exist in the live operator SPA.
Current stable IDs include `onboarding`, `setup`, `advanced`, `working`,
`learning`, `settings`, and `admin`. Query-specific screens are matched before
their generic parent, so `/adv?tab=learning` resolves to `learning`, not merely
`advanced`.

```ts
const current = await verify.currentScreen();
const settings = await verify.navigateToScreen('settings');
```

Run the contract suite from the monorepo root:

```bash
npm run test:file -- libs/generic/tauri-verify/src/index.test.ts
```
