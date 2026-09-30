# Testing @papercusp/tauri-verify

The unit contract mocks the authenticated bridge and covers explicit target
enforcement, the real `{ js, token }` wire shape, webview-origin API health,
false-green rejection, query-specific screen matching, and live selector
checks:

```bash
npm run test:file -- libs/generic/tauri-verify/src/index.test.ts
```

For a live smoke, launch a dedicated staging desktop as documented in
`/internal/docs/agent-insights/verify-ui-via-staging-3170-dedicated-webview`,
obtain its PID with `tauri-agent-tools probe --json`, then run the verifier with
that exact `tauriPID`. Do not use a bare bridge port or an unqualified
`tauri-agent-tools` driving command when multiple bridges exist.
