/**
 * Ecosystem Adapter Contract — the plugin shape every per-ecosystem
 * design adapter implements. Plan §14 + §17 (testing strategy).
 *
 * One adapter per ecosystem (react-tailwind, qt-widgets, egui, …).
 * Each adapter declares which capabilities it implements; the design
 * runtime dispatches by capability + ecosystem, not by hardcoded
 * adapter ID.
 *
 * Adapters are papercusp plugins. Loading lives elsewhere; this file
 * only defines the contract types + a small set of shared payload
 * shapes.
 */
import type { UiIr } from '../design-ir';

// ─── Capability tags ───────────────────────────────────────────────

export type AdapterCapability =
  | 'registry'
  | 'preview'
  | 'tokens'
  | 'mockInput'
  | 'codeEmit'
  | 'exportTarget';

// ─── Shared payload shapes ─────────────────────────────────────────

export interface SourcePointer {
  /** Workspace-relative path of the file backing the entry. */
  path: string;
  /** Optional 1-based line + column for jump-to-source. */
  line?: number;
  column?: number;
  /** Symbol name, when the entry corresponds to a specific export. */
  symbol?: string;
}

export interface FileEmit {
  /** Workspace-relative path; adapter does not write files itself. */
  path: string;
  contents: string;
  /** When `path` already exists, true means overwrite, false means
   *  refuse (the design tab surfaces conflicts). */
  overwrite?: boolean;
}

export interface ImageAsset {
  /** PNG bytes. */
  data: Uint8Array;
  width: number;
  height: number;
  /** When set, a stable URL the image lives at; otherwise the design
   *  tab uploads `data` as an artifact and uses that URL. */
  url?: string;
}

export interface RegistryEntry {
  /** Semantic, ecosystem-free id (e.g. "action.primary"). */
  id: string;
  kind: 'component' | 'icon';
  summary: string;
  /** Product/surface vocabulary that should find this reusable primitive. */
  searchTerms?: readonly string[];
  inputs?: ReadonlyArray<{
    name: string;
    type: string;
    required?: boolean;
  }>;
  variants?: readonly string[];
  states?: readonly string[];
  examples?: ReadonlyArray<{
    inputs?: Record<string, unknown>;
    /** When set, an asset URL or `asset:` reference. */
    preview?: string;
  }>;
  /** Per-ecosystem source pointer for the implementer to import from. */
  ecosystems: Record<
    string,
    {
      sourcePointer: SourcePointer;
      importHint?: string;
      propMap?: Record<string, string>;
    }
  >;
}

export interface DtcgToken {
  id: string;
  type: 'color' | 'dimension' | 'duration' | 'fontFamily' | 'fontWeight' | 'number' | 'shadow' | 'cubicBezier';
  value: unknown;
  /** Optional grouping for the token-inventory pane. */
  group?: string;
  description?: string;
}

export interface DtcgDoc {
  /** All tokens, flat. The DTCG file format allows nested groups; the
   *  loader flattens for adapter consumption. */
  tokens: ReadonlyArray<DtcgToken>;
  /** Active theme name when DTCG `$themes` is in play. */
  activeTheme?: string;
}

export interface PreviewSpec {
  componentId: string;
  variant?: string;
  state?: string;
  /** Optional viewport hint when the preview surface is responsive. */
  viewport?: string;
}

export interface CodeEmitTarget {
  /** Workspace-relative output directory. */
  outDir: string;
  /** Scaffold = create new files; patch = surgical edit; preview =
   *  return what would change without writing. */
  mode: 'scaffold' | 'patch' | 'preview';
}

// ─── Capability surfaces ───────────────────────────────────────────

export interface RegistrySurface {
  /** Roots the adapter scans for primitives. Workspace-relative. */
  sourcePaths: string[];
  /** Enumerate every primitive the adapter knows about. */
  listPrimitives(): Promise<RegistryEntry[]>;
  /** Resolve a single id to its source pointer in this ecosystem. */
  sourceFor(id: string): Promise<SourcePointer | null>;
}

export interface PreviewSurface {
  capture(spec: PreviewSpec): Promise<ImageAsset>;
  /** Optional live URL — only meaningful for web-style adapters. */
  livePreviewUrl?(spec: PreviewSpec): string | null;
}

export interface TokensSurface {
  emit(dtcg: DtcgDoc): Promise<FileEmit[]>;
}

export interface MockInputSurface {
  /** JSON Schema describing what `parse` accepts. The design tab uses
   *  this to render an input form per adapter. */
  inputShape: object;
  parse(input: unknown): Promise<UiIr>;
}

export interface CodeEmitSurface {
  fromIR(ir: UiIr, target: CodeEmitTarget): Promise<FileEmit[]>;
}

export interface ExportTargetSurface {
  /** Stable id of the external surface (e.g. "adaptive-cards"). */
  targetId: string;
  fromIR(ir: UiIr): Promise<unknown>;
}

// ─── The adapter ───────────────────────────────────────────────────

export interface DesignEcosystemAdapter {
  /** Stable plugin id, e.g. "papercusp-design-react-tailwind". */
  id: string;
  /** Human-readable, e.g. "React + Tailwind". */
  displayName: string;
  /** Ecosystem the adapter claims (matches IR `ecosystem` field). */
  ecosystem: string;
  /** Capabilities this adapter implements. Each must have its
   *  matching surface set on this object. */
  capabilities: readonly AdapterCapability[];
  /** IR versions this adapter understands. Semver ranges; e.g.
   *  ["0.x"] or ["0.x", "1.x"]. The runtime refuses to dispatch a
   *  spec into an adapter that doesn't claim its irVersion. */
  irVersionsSupported: readonly string[];
  /** Globs the heuristic unions when computing `needsDesign`. */
  uiPaths: readonly string[];

  registry?: RegistrySurface;
  preview?: PreviewSurface;
  tokens?: TokensSurface;
  mockInput?: MockInputSurface;
  codeEmit?: CodeEmitSurface;
  exportTarget?: ExportTargetSurface;
}
