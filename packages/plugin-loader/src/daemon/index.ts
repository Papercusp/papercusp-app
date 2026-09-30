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

export { startDaemonPlugin } from './supervisor';
export type {
  DaemonPluginHandle,
  StartDaemonOptions,
  DaemonRestartPolicy,
} from './supervisor';
export { buildBwrapArgs } from './bwrap-args';
export { JsonRpcBridge } from './jsonrpc-bridge';
