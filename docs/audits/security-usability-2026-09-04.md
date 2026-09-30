# Papercusp security and usability audit — 4 September 2026

Audit work item: WI-2144489. Requested outcome: stronger security while retaining application features and everyday usability.

**Assessment.** The app already has useful security building blocks, but several boundaries are inconsistent. The most urgent work is to stop untrusted browser content from acquiring local operator authority and to repair the optional direct-remote authentication path. These are implementation defects that can be fixed without removing terminals, search, local passwordless startup, file editing, previews, agent automation, or integrations.

This was a source audit with focused tests and isolated reproductions. It did not establish that an attacker has exploited the app, that the operator is exposed to the internet, or that every deployed artifact is affected. This audit did not change application behavior or deployment configuration. A concurrent workspace fix to F03 was reviewed and rechecked before this report was finalized.

**Final status update, 21:28 UTC:** WI-2144493 is completed in the working tree. The corrected login writer rejects passwordless remote authentication, and the local passwordless flow still succeeds in an independent isolated recheck. Shipment was not verified. The other listed follow-ups were still open when their ledger states were read for this report.

**Scope and method**

Reviewed the canonical staging tree, including the Hono host and route stack, browser/desktop CORS, local and hosted authentication, session creation, terminal HTTP and WebSocket access, search-result rendering, Tauri capabilities, credentials storage, selected file APIs, agent exec/fetch boundaries, peer admission, and update handling. Read the existing threat-model documentation and prior security work references WI-40505, WI-42220, and WI-42229; checked current implementation instead of treating their completion status as proof.

The selected test files were clean at staging commit f49702d62a before and after both runs. The tooldef submodule test used revision 6136501c52d3163845e215a08fa14c18af546039. This is a moving shared tree; these identifiers describe the tested snapshot, not an assertion about subsequent deployment.

Evidence labels used below:

- **Reproduced:** actual relevant application functions executed with side effects mocked, or an isolated renderer exercised with harmless test content.
- **Source finding:** a concrete implementation property was inspected, but an end-to-end exploit was not attempted.
- **Hardening:** a design improvement or risk amplifier, with remaining exposure questions explicitly stated.

The external browser-to-loopback attack paths depend on the browser's local-network access controls and a reachable operator port. Browser protections should be tested, but should not be the application's only defense. The two direct-remote findings require an explicitly exposed local operator or a proxy path that reaches it. The separate hosted control-plane profile is a different boundary.

**Priority findings**

| Ref | Priority | Finding | Evidence | Follow-up |
| --- | --- | --- | --- | --- |
| F01 | Urgent; critical impact | Cross-site POST can reach local terminal launch | Reproduced | WI-2144494 |
| F02 | Urgent if direct remote access is enabled | Socket identity is dropped; forged Host can bypass the remote gate | Reproduced with synthetic socket bindings | WI-2144497 |
| F03 | Fixed in working tree; shipment unverified | Passwordless account accepted arbitrary supplied password remotely | Reproduced, then correction independently rechecked | WI-2144493 |
| F04 | High | Search views insert untrusted transcript HTML | Reproduced rendering sink | WI-2144495 |
| F05 | High | Opaque-origin CORS exposes private local reads | Reproduced with sentinel file | WI-2144500 |
| F06 | High with malicious repository/file access | Config-file path checks do not contain symlink targets | Source finding | WI-2144518 |
| F07 | High impact amplifier | Broad desktop native grants and no configured CSP | Hardening | WI-2144521 |
| F08 | High for work expected to be confined | Exec and fetch do not share an assured containment boundary | Source finding / hardening | WI-2144522 |
| F09 | Medium | Login rate limiting trusts caller-supplied forwarding headers | Source finding | WI-2144519 |
| F10 | Medium | Caller can choose an excessive session lifetime | Source finding | WI-2144520 |
| F11 | Medium availability risk | Fetch reads the full response before checking its byte cap | Source finding | WI-2144523 |
| F12 | Prioritize by deployed reachability | Production dependency graph contains known advisories | Registry audit; exploitability not established | WI-2144501 |

**F01 — Authenticate browser requests to terminals, without changing terminal functionality**

The local route stack permits a loopback-tier request based on its destination host. It does not centrally reject hostile browser origins. The terminal spawn handler parses JSON even when Content-Type is text/plain and accepts caller-selected command and arguments. The outer CORS middleware omits response headers for a foreign origin but still executes the request.

An isolated execution of the real auth step and real spawn handler accepted a request marked cross-site, with a foreign HTTPS Origin, text/plain body, and no cookie or bearer. It returned 200 and reached the mocked terminal launcher. No real process was spawned. A valid harness identifier and browser reachability to the local service are prerequisites.

Evidence: [route-stack.ts](packages/operator-core/lib/endpoint-route/route-stack.ts:242), [terminal spawn](packages/operator-core/lib/endpoint-route/routes/pty/index.ts:359), [command construction](packages/operator-core/lib/endpoint-route/routes/pty/index.ts:314), [host CORS](apps/operator/bin/host-cors.ts:63).

Recommendation: enforce browser-origin/Fetch Metadata policy centrally for unsafe methods, require a paired app session for privileged browser requests, and retain the existing authenticated native/CLI paths. An absent Origin should be handled according to verified transport identity rather than treated as authentication. JSON content-type validation is an additional guard, not a replacement for authentication.

Usability acceptance: ordinary terminal launch, input, resize, reconnect, prewarm, CLI automation, and SSH-forward access still work without new per-command prompts. A hostile request must be rejected before launch. CORS alone is insufficient for this boundary. [OWASP CSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).

**F02 — Preserve trusted socket identity through HTTP composition**

The Node adapter provides the incoming socket in the fetch environment. The production handler accepts only the request, then calls host.fetch without that environment. The nested API handoff also calls app.fetch without c.env. The auth layer catches the resulting getConnInfo failure and falls back to request authority, which is influenced by the client's Host header.

With direct-remote policy enabled, the same harmless test endpoint returned 403 when called with nonlocal socket bindings intact and 200 through the real production handler composition, where the observed socket peer became null. This was an in-memory composition test, not an attack against a listening service.

Evidence: [outer and inner handoff](apps/operator/bin/host-handler.ts:110), [handler](apps/operator/bin/host-handler.ts:125), [socket lookup](packages/operator-core/lib/endpoint-route/route-stack.ts:138), [remote classification](packages/operator-core/lib/remote-auth-policy.ts:163).

Recommendation: carry the adapter environment through both handoffs, and define trusted-proxy handling explicitly. Authentication must not become weaker when socket provenance is missing. Keep the deliberate local/SSH compatibility path, but base its classification on trustworthy transport context.

Usability acceptance: no user-visible change. Test through the actual production adapter with forged Host and forwarding headers, rather than only testing a Hono router directly. The default loopback bind remains valuable; this finding does not establish off-host exposure of the current installation.

**F03 — Separate passwordless local startup from remote authentication**

At the audited snapshot, the direct login route checked that a remote caller supplied a nonempty password. The underlying login function skipped password verification when the account's stored password hash was null. The route then granted wildcard and remote-operator capabilities.

Running the real route and login function against a mocked passwordless account returned 200, has_password false, and full operator capabilities. The mocked database recorded a session insertion and no password check. Existing route tests mocked login itself, leaving that seam uncovered.

**Correction verified during final review:** another workspace agent completed WI-2144493. The route now forwards remote:true, and the login writer rejects a null stored password hash whenever either that marker or the remote-operator capability is present. I re-executed the actual corrected writer with mocked storage: both remote variants were rejected with zero session insertions; local null-password login still succeeded. The work-item completion separately records 39 passing tests, including a real Postgres-backed regression; those peer-reported tests are not included in this audit's 249-test total. No deployment claim is made.

Evidence: [remote request checks](packages/operator-core/lib/endpoint-route/routes/auth/login.ts:39), [password verification](packages/operator-core/lib/auth.ts:221), [capabilities granted](packages/operator-core/lib/endpoint-route/routes/auth/login.ts:95), [current remote test](packages/operator-core/lib/endpoint-route/__tests__/auth.test.ts:134).

Recommendation now implemented in the working tree: require actual verified authentication for remote login, including rejecting a passwordless account on that path unless a separate verified identity proves authority. Preserve passwordless local startup through native pairing/local trust. The separate hosted profile already excludes the local authentication routes.

Usability acceptance: fresh desktop startup remains effortless; remote users authenticate through a supported login or identity provider. Retain the new test using real login logic for null stored hash plus a nonempty supplied password. Repair F02 as well; fixing this password check alone does not repair the remote perimeter.

**F04 — Preserve highlighting while rendering transcripts as data**

The workspace search page inserts h.highlight as HTML. PlanSessionsTab inserts h.highlight or h.excerpt and labels it trusted server output. The server passes search highlights through from stored text. Server-generated highlighting does not make the underlying transcript trustworthy.

Rendering the actual SearchPage with a harmless hostile highlight produced an active image element; its event handler set an isolated test marker in jsdom. No live transcript was modified. The full ingestion-to-search exploit was not run.

Evidence: [workspace search sink](apps/operator/app/settings/user/search/page.tsx:140), [plan-session sink](apps/operator/app/_components/plans/PlanSessionsTab.tsx:219), [server mapping](packages/operator-core/lib/endpoint-route/routes/user/search.ts:39), [headline producer](packages/operator-core/lib/agent-tools/search/sources.ts:946).

Recommendation: reuse/extract [headlineToSafeHtml](apps/operator-vite/src/components/adv/AgentsPillSessions.tsx:233), which already escapes content while retaining bare mark tags, or render text/mark segments directly. Apply it to every highlight and excerpt fallback.

Usability acceptance: search highlighting and literal HTML/code snippets remain readable. Test both keyword and semantic results, malformed markup, and event-handler attributes through the actual components. PostgreSQL explicitly warns that ts_headline output is not safe HTML. [PostgreSQL text-search documentation](https://www.postgresql.org/docs/17/textsearch-controls.html).

**F05 — Remove ambient trust from opaque origins and unrelated local ports**

The host CORS policy accepts Origin null and arbitrary localhost ports with credentials enabled. A sandboxed browser document can have an opaque/null origin. Separately, the config-file GET route is locally public and can return allowlisted .env, MCP, and harness configuration content.

The actual CORS middleware and file handler, with a mocked registry/manifest and harmless sentinel file, returned 200 plus Access-Control-Allow-Origin null and Access-Control-Allow-Credentials true without authentication. No real credential or file content was read.

Evidence: [origin allowlist](apps/operator/bin/host-cors.ts:42), [credentialed response](apps/operator/bin/host-cors.ts:84), [default editable files](packages/operator-core/lib/endpoint-route/routes/harness/file.ts:38), [public file GET](packages/operator-core/lib/endpoint-route/routes/harness/file.ts:66).

Recommendation: authenticate sensitive reads; bind browser/native access to this app instance. An opaque origin is not proof of a native webview. Replace broad port trust with the exact active app/development origins and authenticated pairing. Keep intentional environment switching as a registered, tested flow.

Usability acceptance: owners retain full configuration editing, including .env. The trusted desktop can bootstrap credentials through its native bridge automatically. Unrelated local sites and sandboxed third-party content do not inherit that access.

**F06 — Contain real file targets, including symlinks**

The config-file route checks a normalized relative path and a manifest allowlist. The subsequent readFile/writeFile calls follow symlinks; no target or descriptor containment check appears in this path. A malicious repository can therefore make an allowlisted path resolve outside its project. This is a source finding; no filesystem escape was executed.

Evidence: [path authorization](packages/operator-core/lib/endpoint-route/routes/harness/file.ts:47), [read](packages/operator-core/lib/endpoint-route/routes/harness/file.ts:80), [write](packages/operator-core/lib/endpoint-route/routes/harness/file.ts:100).

Recommendation: authorize canonical targets against granted roots, use safe file-descriptor operations, and account for intermediate links and link-swap races. A one-time realpath check alone is not a complete race defense.

Usability acceptance: ordinary files and in-project links work unchanged. Intentionally shared configuration outside the project remains possible through an explicit target/root grant. Test outside-root links, parent links, replacement races, and valid shared configuration.

**F07 — Reduce the impact of a compromised renderer**

The desktop configuration sets CSP to null and disables automatic asset CSP modification. Its default capability grants include terminal, endpoint, process, and workspace actions for privileged windows, with remote URL patterns covering all localhost ports. These are confirmed configuration properties, not a demonstrated native-code exploit.

Evidence: [desktop CSP configuration](papercusp-desktop/src-tauri/tauri.conf.json:29), [native grants](papercusp-desktop/src-tauri/capabilities/default.json:5).

Recommendation: keep full capabilities in trusted app chrome, bind them to known app origins, and isolate previews/plugin content in separate webviews without those grants. Deploy a CSP report-only policy for HTTP-served app content, resolve compatibility issues, then enforce a policy tailored to the app. Merely changing the Tauri config should not be assumed to cover every remotely served document.

Usability acceptance: preserve terminal panes, rich previews, editors, diagrams, voice/media, worker-based tools, fullscreen/popups, local environment switching, and updates. Test the native desktop as well as a browser. Tauri capabilities provide the existing mechanism to extend. [Tauri capability documentation](https://v2.tauri.app/security/capabilities/).

**F08 — Make confinement an actual execution property**

The exec sandbox intentionally returns raw execution when disabled or when bubblewrap is unavailable. Its dark/default-off history is already recorded in the flag registry. Meanwhile capability:fetch runs fetch in the operator process; an OS sandbox around a child shell does not automatically confine that host-side request.

Evidence: [raw fallback](packages/operator-core/lib/agent-tools/capability/exec-sandbox.ts:402), [host-side fetch](packages/operator-core/lib/agent-tools/capability/fetch.ts:49), [recorded sandbox debt](libs/flags/src/types.ts:3758).

Recommendation: distinguish intentionally trusted owner automation from work promised confinement. Reuse the existing principal/capability and sandbox systems; identify each agent and apply resource, credential, filesystem, and network limits at every real operation boundary. If a confined profile cannot run locally, automatically use a working container/VM rather than silently changing its trust level. Give ordinary tasks coherent grants at task/workspace level, with automatic renewal.

For server-side fetch, enforce destination/method policy, redirects, resolved addresses, and credential forwarding in the host itself. Permit explicitly configured local models and integrations; do not replace normal internet access with a blanket ban. Protect cloud metadata and private services for profiles not entitled to reach them. [OWASP SSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html).

Usability acceptance: trusted owner automation keeps its capabilities. Confined tasks still build, browse, install dependencies, and use approved services. The UI accurately describes the containment that is actually running. Peer identity alone is not proof that repository content or an agent's next command is safe. This audit did not establish that all production P2P execution is uncontained.

**F09 — Make abuse limits use trusted identity**

The direct login route takes X-Forwarded-For verbatim, defaulting to loopback. The soft limiter exempts loopback, and the hard limiter is keyed by IP plus username. A directly connected caller can vary the forwarding header and change its bucket. Ingress proxy behavior matters; no flooding test was performed.

Evidence: [caller address](packages/operator-core/lib/endpoint-route/routes/auth/login.ts:38), [limiter keys](packages/operator-core/lib/auth-rate-limit.ts:95).

Recommendation: derive addresses from trusted socket/proxy context, add account-level and overall abuse budgets, and monitor failed-attempt patterns. Preserve typo tolerance and ordinary local use; avoid a lockout design that lets one attacker deny access to everyone. Test through the full HTTP composition, including forged and rotating forwarding headers.

**F10 — Bound sessions on the server without shortening normal work**

The login route accepts any numeric ttl_ms and the session writer uses it directly. The default 30-day duration is not a maximum. This is a source finding; no long-lived live session was minted.

Evidence: [input duration](packages/operator-core/lib/endpoint-route/routes/auth/login.ts:36), [expiry writer](packages/operator-core/lib/auth.ts:242).

Recommendation: enforce a finite, positive, server-owned maximum; keep a deliberate remember-this-device choice, transparent renewal, and effective revocation. Consider passkeys/OS-backed authentication where they improve remote login or account recovery, rather than adding repeated password challenges. Test excessive/negative durations, normal remembered sessions, logout, password-change revocation, and membership loss.

**F11 — Bound memory while retaining large downloads**

capability:fetch calls res.text before checking max_bytes. The setting bounds inline output, not response allocation. A large or hostile response can consume operator memory before truncation and spill occur. No resource-exhaustion test was performed.

Evidence: [response buffering](packages/operator-core/lib/agent-tools/capability/fetch.ts:57).

Recommendation: stream through a bounded memory buffer, enforce an explicit total-download policy, and spool permitted large downloads directly to disk. Preserve download size visibility and cancellation. Test chunked/compressed oversized responses and a legitimate large download.

**F12 — Patch dependencies according to real artifact exposure**

npm audit --omit=dev --json --ignore-scripts completed successfully as an audit and returned exit 1 because advisories were found: 110 vulnerable package-name entries, comprising 23 high, 65 moderate, 22 low, and no critical entries. These are dependency-report categories, not an app security score and not 110 independently exploitable flaws.

The count writer was checked in the installed npm Arborist audit-report implementation: it increments once per vulnerability-map entry. The workspace production graph can include packages outside the primary deployed operator.

Selected lockfile versions were Hono 4.12.21, TOON 2.3.0, Astro 6.3.6, and grpc-js 1.14.3. The registry reported, among others, TOON decoder prototype pollution and grpc-js malformed-message crash advisories. TOON decoding is called during the existing encoder's round-trip validation; exploitability was not established.

Evidence: [lockfile](package-lock.json), [TOON round-trip use](libs/generic/result-encoding/src/encode.ts:92), [TOON advisory](https://github.com/advisories/GHSA-p95v-992w-h6c3), [grpc-js advisory](https://github.com/advisories/GHSA-5375-pq7m-f5r2).

Recommendation: inventory shipped JS/Rust artifacts, prioritize reachable high-risk dependencies, upgrade supported compatible versions, and add advisory/SBOM checks to the existing verification pipeline. Do not use a forced bulk upgrade as the repair plan. Retain editor, visualization, voice, integration, and download tests so security patching does not silently remove capabilities. Rust dependency and native-binary advisory scans were not run in this audit.

**Controls already present and worth retaining**

- Loopback is the default listener, and explicit off-loopback startup requires a configured remote-origin policy. [Bind policy](packages/operator-core/lib/resolve-bind-host.ts:18), [startup policy](packages/operator-core/lib/remote-auth-policy.ts:53).
- The hosted profile uses an explicit route allowlist and excludes local authentication routes. Its principal resolver checks current membership, permission version, and workspace/organization relationships. Focused tests passed. [Hosted profile](packages/operator-core/lib/endpoint-route/hosted-profile.ts:70), [membership resolution](packages/operator-core/lib/auth/hosted-principal-resolver.ts:109).
- Credential-class operator-state writes use pgcrypto encryption. The older comment in credentials.ts saying encryption could be added later does not describe the current writer. The key is sourced from an environment override or a local key file. [Encrypted tables and key source](packages/operator-core/lib/db-encryption.ts:55), [encrypted writer](packages/operator-core/lib/operator-state-pg.ts:362).
- Auth audit records HMAC-derived session references instead of raw session tokens. [Audit writer](packages/operator-core/lib/auth-audit.ts:74).
- MCP bearer resolution derives identity from the token index, checks capability identity, and has bounded caching/invalidation. Terminal WebSocket tickets bind scope and origin and enforce expiry/replay checks. These controls do not repair an unauthenticated HTTP launch path. [MCP auth](packages/agent-mcp/src/auth.ts:159), [terminal ticket verification](packages/operator-core/lib/pty-ticket.ts:192).
- Peer admission checks signed announcements, identity binding, and revocation. Those checks authenticate a peer; they do not make every admitted peer's payload authoritative. [Read admission](packages/operator-core/lib/sync/hyperbee/read-admission.ts:100).
- Scratch output handling already treats active HTML/SVG conservatively; reuse that principle for previews. [Scratch MIME policy](packages/operator-core/lib/endpoint-route/routes/misc/scratch.ts:34).
- Desktop update and rollback use the Tauri updater with a baked verification key. The local HTTP download proxy strips GitHub authorization before following the CDN redirect. Do not treat the local HTTP transport setting as proof of unsigned updates. This audit did not execute a tampered-artifact install test. [Updater invocation](papercusp-desktop/src-tauri/src/main.rs:7621), [rollback](papercusp-desktop/src-tauri/src/main.rs:7837), [credential-safe redirect](packages/operator-core/lib/endpoint-route/routes/misc/updates-github.ts:87).

For further credential hardening, extend the existing encrypted store with OS-keychain-backed key custody, safe atomic key creation, and tested key recovery/rotation. Storing the decryption key under the same user's home does not isolate it from an equally privileged process. Hashing opaque session/bearer values at rest can reduce the impact of a database read leak. Preserve one-time integration setup and transparent operation; do not require users to repeatedly reenter provider keys. These are recommendations, not claims of observed key theft or a completed recovery audit.

**Verification performed**

Both exact-file test commands used the repository's scripts/test-files.mjs router. In total, 13 files executed, 249 tests passed, and none were skipped:

| Area | File | Passed tests |
| --- | --- | ---: |
| Remote policy | packages/operator-core/lib/remote-auth-policy.test.ts | 8 |
| Hosted principal | packages/operator-core/lib/auth/hosted-principal-resolver.test.ts | 22 |
| Route CORS | packages/operator-core/lib/endpoint-route/cors.test.ts | 11 |
| Terminal WebSocket | packages/operator-core/lib/pty-ws.test.ts | 8 |
| Hosted route stack | packages/operator-core/lib/endpoint-route/hosted-route-stack.test.ts | 25 |
| Auth routes | packages/operator-core/lib/endpoint-route/__tests__/auth.test.ts | 26 |
| Host CORS | apps/operator/bin/host-cors.test.ts | 11 |
| Safe search renderer | apps/operator-vite/src/components/adv/AgentsPillSessions.test.tsx | 59 |
| Credential key handling | packages/operator-core/lib/db-encryption.test.ts | 3 |
| Exec sandbox decisions | packages/operator-core/lib/agent-tools/capability/exec-sandbox.test.ts | 35 |
| Peer admission | packages/operator-core/lib/sync/hyperbee/read-admission.test.ts | 18 |
| MCP auth | packages/agent-mcp/src/auth.test.ts | 18 |
| Tool authorization | libs/generic/tooldef/src/authz.test.ts | 5 |

The additional isolated checks exercised (1) remote passwordless login, (2) cross-site PTY launch, (3) search HTML execution, (4) lost socket identity through host composition, and (5) null-origin file reads. All used mocked side effects or harmless renderer markers. No live terminal was launched, real secret read, or account modified by those checks.

Passing the existing tests does not contradict these findings: several tests mock the component at the vulnerable seam, and others validate the current permissive policy. The missing guard is integration-level testing of who can reach a privileged effect.

Temporary runner evidence was written to /tmp/pcv/papercusp-test-files-report-b7dlUT and /tmp/pcv/papercusp-test-files-report-fBn8sW. Those paths are disposable; the meaningful results and methods are preserved in this report and WI-2144489.

**Implementation order and usability contract**

1. Repair the remaining F01–F05 findings, retaining F03's new regression coverage. Centralize the reusable transport/origin rules in the existing route stack; fix both unsafe search renderers using the existing safe highlighter. F02 remains necessary even after the passwordless-login correction.
2. Contain file targets, tighten renderer capabilities/CSP, and repair rate/session limits. Prefer invisible validation and native pairing over new dialogs.
3. Prove confined-agent execution and network policy across all actual execution paths, patch reachable dependencies, and exercise credential recovery and signed-update failure cases.

For every security change, acceptance must include both a hostile attempt that fails and the corresponding legitimate workflow that succeeds. Cover first-run setup, remembered sessions, multiple workspaces/windows, local and remote access, environment switching, terminals and long-lived streams, search/code highlights, rich previews, configuration editing including supported symlinks, voice/media, provider integration, agent automation, updates, and rollback. Measure latency and reconnect behavior as well as whether a button works.

Routine actions should not gain approval prompts. Reserve additional verification for an actual increase in authority or a sensitive action whose identity cannot otherwise be established, and remember coherent grants instead of asking on every operation. Stronger defaults should be accompanied by automatic migration/pairing and clear recovery paths.

**Limits and disposition**

This audit does not certify all endpoints, database RLS policies, cloud deployment settings, provider IAM, native binaries, all plugins, actual browser/network combinations, backup restoration, or the full P2P lifecycle. Those require focused deployment and adversarial integration exercises. No production exposure inventory, destructive probe, load attack, or external penetration test was performed.

The report is complete. F03 was fixed concurrently and its correction rechecked; the other follow-ups remained open at final ledger review. This audit made no product-code edits, authentication-setting changes, capability-policy changes, or deployments. The next implementation unit should repair browser-to-operator request authentication and the remaining remote transport-identity seam while preserving the listed workflows.
