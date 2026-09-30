# Hosted workspace reverse connector gateway
URL: /internal/docs/security/hosted-workspace-reverse-connector

D-143 topology, identity, transport, rotation, and exposure boundary for outbound-only hosted workspace access.

## Topology

Hosted workspace access extends the existing hosted control-plane composition. The VM initiates the only long-lived connection: outbound HTTPS to `app.papercusp.com:443`. The gateway terminates TLS for `app.papercusp.com` and `*.workspaces.papercusp.com`; the wildcard hostname is a routing hint and is cross-checked against the authenticated route label. No inbound operator, Postgres, MCP, file, process, agent, or PTY port is mounted on the VM.

## Authority binding

Every connector generation is bound to the control-plane workspace, organization, customer workspace, `harness_shared.workspace_hosts` host id, route label, transport, and monotonically increasing generation. Browser enrollment, session-ticket issuance, rotation, and revocation require a current hosted cookie principal with `workspace:operate` and an exact selected-workspace match. Registration, heartbeat, SSE, and native WebSocket upgrade authenticate inside the connector handler; they never enter the browser-principal chain.

Migration 1009 stores only SHA-256 credential and ticket hashes in hosted-owner-owned, hosted-service-only FORCE-RLS relations. Enrollment and session tickets are short-lived and atomically single-use. Session tickets additionally bind the user, hosted session, audience, transport, issue time, and expiry.

## Lifecycle

Enrollment returns a one-time ticket. Registration redeems it for a bearer shown once, activates the generation, and starts heartbeat/transport accounting. Rotation increments the generation, invalidates the previous bearer and unconsumed tickets through generation checks, and closes active streams from the previous generation. Revocation clears the current credential, marks the binding revoked, and closes its streams. SSE emits an explicit bound event; WebSocket uses the native HTTP upgrade path on the same hosted server and emits the same authenticated binding before application traffic.
