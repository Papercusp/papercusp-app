/**
 * @papercusp/plugin-loader/daemon — subprocess daemon runtime
 * (Batch I, rev 3 plan).
 *
 * v1 surface:
 *   - startDaemonPlugin(opts) — spawn the daemon under bwrap (Linux),
 *     attach a JSON-RPC bridge over stdio, return a DaemonPluginHandle.
 *
 * The handle exposes the same `callAction` shape as the WASM runtime so
 * downstream code (operator's plugin-host-runtime, agent-mcp tool
 * registration) can treat WASM and daemon plugins uniformly.
 */

export { startDaemonPlugin, providerSandboxWorks, DaemonSandboxUnavailableError } from './supervisor';
export type {
  DaemonPluginHandle,
  StartDaemonOptions,
  DaemonRestartPolicy,
} from './supervisor';
export { buildBwrapArgs, buildProviderBwrapArgs, PROVIDER_SYSTEM_RO_DIRS } from './bwrap-args';
export type { ProviderBwrapOptions } from './bwrap-args';
export { JsonRpcBridge, JsonRpcHandlerError } from './jsonrpc-bridge';
export type { JsonRpcRequestHandler } from './jsonrpc-bridge';
