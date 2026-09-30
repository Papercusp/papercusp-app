/**
 * Re-export shim — the IPC frame codec now lives in @papercusp/ipc-framing
 * (extracted per papercusp-systems-abstraction-2026-05-29, P-030). The
 * server + sys:http bridge also moved into @papercusp/ipc-endpoint-server;
 * the lone remaining in-dir consumer of this shim is
 * dev_ipc_echo_e2e.test.ts. Kept so that test resolves unchanged (shim
 * removal is the deferred P-023b-style cleanup); new code should import
 * from '@papercusp/ipc-framing' directly.
 *
 * NOTE: the Rust client in papercusp-desktop mirrors this codec byte-for-byte
 * (see endpoint-ipc/PROTOCOL.md) — the wire contract is unchanged by this move.
 */
export * from '@papercusp/ipc-framing';
