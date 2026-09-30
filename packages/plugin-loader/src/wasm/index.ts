/**
 * @papercusp/plugin-loader/wasm — WASM plugin runtime for the JS host.
 *
 * Public surface consumed by the loader's dispatch layer (G3) +
 * downstream operator code:
 *   - loadWasmPlugin() — instantiate a plugin from a .wasm path
 *   - WasmPlugin       — the live handle (init/shutdown/callAction)
 *   - realJcoTranspiler — production wiring of @bytecodealliance/jco
 *   - host-impls types — WasmHostCtx, EventSink, AuditSink, AuditRow,
 *                        TokenBucket, ComputeRuntime
 *   - transpileWasm()  — content-hashed cache (re-exported)
 */

export { loadWasmPlugin, WasmPlugin } from './wasm-plugin-host';
export type { WasmPluginConfig, PluginInfo, ActionInvokeResult } from './wasm-plugin-host';

export { realJcoTranspiler } from './jco-transpiler';

export {
  TokenBucket,
  makeImports,
  makeLoggingHost,
  makeHttpHost,
  makeSecretsHost,
  makeEventsHost,
  makeComputeHost,
} from './host-impls';
export type {
  AuditRow,
  AuditSink,
  ComputeRuntime,
  EventSink,
  WasmHostCtx,
} from './host-impls';

export { transpileWasm } from './transpile';
export type { Transpiler, TranspileOptions, TranspileResult } from './transpile';
