/**
 * Re-export shim — the desktop IPC bootstrap polyfills now live in
 * @papercusp/desktop-ipc (extracted per
 * papercusp-systems-abstraction-2026-05-29, P-030). Kept at this path so the
 * `@/lib/transport-adapters/desktop-bootstrap` consumers (RootSyncProvider)
 * resolve unchanged; new code should import from
 * '@papercusp/desktop-ipc/desktop-bootstrap' directly.
 */
import './configure';
export * from '@papercusp/desktop-ipc/desktop-bootstrap';
