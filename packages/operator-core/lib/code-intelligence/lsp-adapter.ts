/**
 * The thin Papercusp-owned in-operator LSP adapter (plan
 * `code-intelligence-routing-lsp-gitnexus-2026-08-20`, D-002 / D-006, P-008).
 *
 * We own the CLIENT; we do not own or fork the servers. This speaks JSON-RPC
 * over stdio to the PINNED official language servers provisioned under
 * `~/.papercusp/vendor/lsp` (typescript-language-server + rust-analyzer),
 * normalizes their answers into the `CodeIntelAnswer` shape from
 * `./contracts.ts`, and exposes strictly READ-ONLY operations.
 *
 * Four rails, each load-bearing here rather than decorative:
 *
 *  1. READ-ONLY BY CONSTRUCTION. Only definition / references / implementations
 *     are ever sent. There is no `workspace/applyEdit` handler and no rename
 *     execution: a write that bypassed the PreToolUse lock arbitration would
 *     silently clobber a peer on this shared checkout.
 *  2. managedSpawn-ENROLLED. A language server is a long-lived child meant to
 *     outlive the call that made it, so it is spawned through the task ledger
 *     (`lint:no-unenrolled-spawn`) and is therefore visible in
 *     `processes:list` and killable by taskId — never by name.
 *  3. pinModuleState FOR THE REGISTRY. The client registry is module-scoped
 *     mutable state in a shared package; pinned so a duplicate module record
 *     cannot produce two registries and orphan a server child.
 *  4. HEALTH IS REPORTED, NEVER ASSUMED. If a server dies, every subsequent
 *     answer carries health!=healthy so `isTrustworthyEmpty()` refuses it. A
 *     confident empty list from a dead server is the disqualifying failure this
 *     whole design is built to prevent.
 */

import { existsSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';

import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node';

import { pinModuleState } from '@papercusp/module-singleton';
import { managedSpawn } from '../task-manager/managed-spawn.ts';

import {
  toOneIndexed,
  type BackendHealth,
  type CodeIntelAnswer,
  type CodeIntelIntent,
  type SymbolSite,
} from './contracts.ts';

/**
 * The languages this adapter can drive.
 *
 * WI-40250: widening this union is NOT sufficient on its own — every
 * language-varying behaviour is declared in `LANGUAGE_SPECS` below, which is a
 * `Record` over this union and therefore exhaustive by construction. Adding a
 * member here without adding its spec is a COMPILE error, which is exactly the
 * point: it used to be a silent runtime mislabel.
 */
export type LspLanguage = 'typescript' | 'rust';

/** Where the pinned pilot environment lives (P-007). */
export const LSP_VENDOR_DIR = join(homedir(), '.papercusp', 'vendor', 'lsp');

/**
 * Resolve the tsserver entrypoint — D-009, and the single most confusing
 * failure in this whole subsystem.
 *
 * The repo pins `typescript` to `npm:@typescript/typescript6`, which ships NO
 * `lib/tsserver.js`; `typescript-language-server` is a tsserver WRAPPER, so it
 * exits at `initialize` with "provides no tsserver.js". The stock TypeScript
 * that DOES ship one arrives transitively as `@typescript/old`
 * (itself `npm:typescript@^6`).
 *
 * `@typescript/old` is NOT installable by name — `npm view` 404s it, because it
 * is an alias onto stock typescript, not a published package. So we RESOLVE it
 * rather than hardcode a path (npm can rehoist it), and we fail LOUDLY with the
 * full explanation rather than letting the server exit with a message nobody
 * can act on.
 */
export function resolveTsserverPath(vendorDir: string = LSP_VENDOR_DIR): string {
  const req = createRequire(join(vendorDir, 'noop.js'));
  const candidates = ['@typescript/old/lib/tsserver.js', 'typescript/lib/tsserver.js'];
  for (const spec of candidates) {
    try {
      const resolved = req.resolve(spec);
      if (existsSync(resolved)) return resolved;
    } catch {
      /* try the next candidate */
    }
  }
  // Direct path fallback before giving up, so a resolution quirk does not mask
  // an install that is actually fine.
  const direct = join(vendorDir, 'node_modules', '@typescript', 'old', 'lib', 'tsserver.js');
  if (existsSync(direct)) return direct;

  throw new Error(
    `No tsserver.js found under ${vendorDir}. This is the D-009 failure: the repo's ` +
      `pinned typescript (@typescript/typescript6) ships tsc.js/typescript.js/` +
      `tsserverlibrary.js but NO tsserver.js, and typescript-language-server is a ` +
      `tsserver wrapper. The stock TypeScript that does ship one arrives transitively ` +
      `as @typescript/old (npm:typescript@^6) — it is NOT installable by name. ` +
      `Re-provision with: npm install --prefix ${vendorDir} typescript-language-server@6.0.0 ` +
      `'typescript@npm:@typescript/typescript6@6.0.2'`,
  );
}

/**
 * Everything that varies BY LANGUAGE, declared in ONE place.
 *
 * WI-40250. This used to be three separate `if (language === 'typescript') …`
 * branches whose ELSE ARM WAS RUST — in `resolveServerBin` and in two
 * `languageId` ternaries. Widening `LspLanguage` therefore compiled cleanly and
 * then silently resolved the new language to the rust-analyzer binary while
 * labelling its documents `rust`: a confident wrong answer from the one module
 * whose entire purpose is refusing to produce them. No `switch` existed, so
 * TypeScript's exhaustiveness checking could not see it.
 *
 * `Record<LspLanguage, LanguageSpec>` is the structural fix and the `Record` is
 * load-bearing: it is exhaustive BY CONSTRUCTION, so adding a member to the
 * union without adding its spec here fails the typecheck. Do not relax this to
 * `Partial<Record<…>>` or an index signature — either one silently restores the
 * original failure mode.
 */
export type LspReadinessIntent = Extract<
  CodeIntelIntent,
  | 'definition'
  | 'references'
  | 'implementations'
  | 'rename-preview'
  | 'diagnostics'
  | 'symbol-search'
>;

/**
 * How one `(language, intent)` earns a readiness proof (WI-41090 / D-003).
 *
 * The `intent` field is deliberately repeated in the value even though the
 * strategy is stored under that intent's key. It makes a strategy portable to
 * provisioning/telemetry without losing the exact claim it is allowed to
 * make: a `definition` canary must never certify `references`.
 */
export type LspReadinessStrategy =
  | { readonly kind: 'progress-signal'; readonly intent: LspReadinessIntent }
  | {
      readonly kind: 'settle-window';
      readonly intent: LspReadinessIntent;
      readonly settleMs: number;
    }
  | {
      readonly kind: 'canary-query';
      readonly intent: LspReadinessIntent;
      readonly minimumSites: number;
    };

/**
 * Evidence retained while a positive canary is still unproven.
 *
 * A single positive response proves only that the server can answer the
 * request. It does not prove that the answer is complete: tsserver returned
 * the two sites in the open file while its cross-file reference index was
 * still being built. The answer must therefore survive a progress boundary
 * and remain stable before it can certify this intent.
 */
export interface LspCanaryReadinessSample {
  readonly siteCount: number;
  /** Stable representation of the returned sites, when the caller has one. */
  readonly answerFingerprint?: string;
  readonly progressGeneration: number;
  /** A completed progress cycle occurred after the first candidate sample. */
  readonly sawProgressBoundary: boolean;
  /** The candidate answer changed after the first sample. */
  readonly sawAnswerChange: boolean;
}

/**
 * Whether a canary answer is stable enough to become an intent proof.
 *
 * The answer must be the same as the previous sample, but only after we have
 * observed both a server progress boundary and an answer transition. This
 * deliberately rejects the cold-open shape `2, 2, 2, ...`: a partial answer
 * that is stable only because indexing has not started is not readiness.
 */
export function canaryReadinessIsStable(
  previous: LspCanaryReadinessSample | undefined,
  current: LspCanaryReadinessSample,
): boolean {
  const previousFingerprint = previous?.answerFingerprint ?? String(previous?.siteCount);
  const currentFingerprint = current.answerFingerprint ?? String(current.siteCount);
  return Boolean(
    previous &&
      current.siteCount === previous.siteCount &&
      currentFingerprint === previousFingerprint &&
      current.sawProgressBoundary &&
      current.sawAnswerChange,
  );
}

const LSP_READINESS_INTENTS: readonly LspReadinessIntent[] = [
  'definition',
  'references',
  'implementations',
  'rename-preview',
  'diagnostics',
  'symbol-search',
];

const settleWindow = (intent: LspReadinessIntent): LspReadinessStrategy => ({
  kind: 'settle-window',
  intent,
  // D-003 measured a ~4.7s false-positive window for a cold tsserver. This is
  // intentionally a proof threshold, not a latency target.
  settleMs: 5_000,
});

const canaryQuery = (intent: LspReadinessIntent): LspReadinessStrategy => ({
  kind: 'canary-query',
  intent,
  // A positive site is only a candidate: the same intent must produce a
  // stable post-progress answer before it earns a proof. An empty is never
  // allowed to prove itself.
  minimumSites: 1,
});

const progressSignalStrategies = (): Readonly<Record<LspReadinessIntent, LspReadinessStrategy>> =>
  Object.fromEntries(
    LSP_READINESS_INTENTS.map((intent) => [intent, { kind: 'progress-signal', intent }]),
  ) as Readonly<Record<LspReadinessIntent, LspReadinessStrategy>>;

interface LanguageSpec {
  /** The `textDocument.languageId` this server expects. */
  readonly languageId: string;
  /** Absolute path to the pinned server binary, or null when not provisioned. */
  readonly resolveBin: () => string | null;
  /**
   * Readiness is per intent, never per server. Missing entries use the
   * conservative canary-query default; they can answer positively, but cannot
   * certify an empty until that exact intent has produced positive evidence.
   */
  readonly readinessStrategy: Readonly<
    Partial<Record<LspReadinessIntent, LspReadinessStrategy>>
  >;
}

const LANGUAGE_SPECS: Readonly<Record<LspLanguage, LanguageSpec>> = {
  typescript: {
    languageId: 'typescript',
    resolveBin: () => {
      const bin = join(LSP_VENDOR_DIR, 'node_modules', '.bin', 'typescript-language-server');
      return existsSync(bin) ? bin : null;
    },
    readinessStrategy: {
      // The only tsserver intents with measured readiness mechanisms so far.
      definition: settleWindow('definition'),
      references: canaryQuery('references'),
    },
  },
  rust: {
    languageId: 'rust',
    // rust-analyzer is a rustup COMPONENT, so its version is pinned by the
    // repo's toolchain rather than floating.
    resolveBin: () => {
      const raBin = join(
        homedir(),
        '.rustup',
        'toolchains',
        'stable-x86_64-unknown-linux-gnu',
        'bin',
        'rust-analyzer',
      );
      return existsSync(raBin) ? raBin : null;
    },
    // rust-analyzer exposes its own authoritative quiescence signal. Each
    // intent consumes that signal independently so one query never certifies
    // another merely because they share a process.
    readinessStrategy: progressSignalStrategies(),
  },
};

/**
 * The spec for a language, or a LOUD refusal.
 *
 * The runtime guard is NOT redundant with the compile-time `Record`: this
 * module is reachable from plain-JS callers, from persisted values, and from
 * request payloads, where an unrecognised id would otherwise fall through to
 * whichever branch happened to be last — which is precisely the WI-40250 bug.
 */
export function specForLanguage(language: LspLanguage): LanguageSpec {
  const spec = LANGUAGE_SPECS[language];
  if (!spec) {
    throw new Error(
      `Unknown LSP language ${JSON.stringify(language)}. Known: ` +
        `${Object.keys(LANGUAGE_SPECS).join(', ')}. Add a LANGUAGE_SPECS entry — never ` +
        `let an unknown language fall through to another language's server (WI-40250).`,
    );
  }
  return spec;
}

/**
 * The configured strategy for one intent, conservatively defaulting to a
 * positive canary. The default is load-bearing: absence means UNPROVEN, never
 * "ready enough" (R-5).
 */
export function readinessStrategyFor(
  language: LspLanguage,
  intent: LspReadinessIntent,
): LspReadinessStrategy {
  return specForLanguage(language).readinessStrategy[intent] ?? canaryQuery(intent);
}

/** Absolute path to a pinned server binary, or null when not provisioned. */
export function resolveServerBin(language: LspLanguage): string | null {
  return specForLanguage(language).resolveBin();
}

interface LspClient {
  connection: MessageConnection;
  child: ChildProcess;
  taskId: string;
  language: LspLanguage;
  rootUri: string;
  /** The project root this client is keyed under — see `clientKey`. */
  rootPath: string;
  /**
   * WI-2142693. Have we ever OBSERVED this wrapper owning a child process?
   *
   * `child` is the typescript-language-server WRAPPER; the process that
   * actually answers queries is `tsserver`, its child. The wrapper outlives its
   * tsserver silently, so "no children" only means DEATH for a server we have
   * previously seen alive — before the first spawn it means "not yet". This
   * flag is what separates those two, and it is the whole reason the liveness
   * verdict cannot be read from a single sample.
   */
  tsserverSeen?: boolean;
  /**
   * Bounded tail of the server's stderr, kept so a death can explain itself.
   * Not a health signal — measured, this stream stays EMPTY when tsserver dies.
   */
  stderrTail?: string;
  /**
   * Bounded tail of the server's `window/logMessage` stream (WI-2142840).
   *
   * This — not `stderrTail` — is where a tsserver death is actually announced.
   * See the notification registration for why the stderr stream cannot carry
   * it, and what this one says when the semantic server goes.
   */
  logTail?: string;
  /**
   * URIs the server currently holds open, each stamped with the disk state we
   * opened them AT (WI-40251). The stamp is what makes staleness detectable:
   * an open document ignores disk per the LSP spec, so without it a peer's
   * write is invisible and the server answers about text that is gone.
   */
  openDocs: Map<
    string,
    {
      mtimeMs: number;
      size: number;
      /** The configured/inferred TypeScript project retaining this URI. */
      typescriptProjectKey?: string;
    }
  >;
  /**
   * One foreground TypeScript project may use this client at a time.
   *
   * Same-project queries share the lease, preserving saturation throughput.
   * A different project waits until those queries finish, then closes every
   * URI retaining the old project before it opens its own. Optional fields
   * keep pinned pre-WI-2142895 clients compatible until process restart.
   */
  typescriptProjectLease?: {
    activeKey: string | null;
    users: number;
    waiters: Set<() => void>;
  };
  health: BackendHealth;
  lastError: string | null;
  startedAt: number;
  coldStartMs: number;
  /**
   * Outstanding `window/workDoneProgress` tokens. While ANY is open the server
   * is still loading the project and its answers are not yet trustworthy —
   * see `prepareIntentReadiness`.
   */
  pendingProgress: Set<string | number>;
  /**
   * When `pendingProgress` last became — and has CONTINUOUSLY remained — empty;
   * `null` while the server is loading.
   *
   * ⚠ THIS MUST LIVE ON THE CLIENT, NOT IN A QUERY'S STACK FRAME (WI-2142532).
   * The settle-window strategy asks "has the server been quiet for `settleMs`?"
   * A per-call variable can only answer that by re-measuring from zero, so a
   * server idle for ten minutes still costs a full settle window on EVERY
   * query. That is exactly what shipped with the `answerable` verdict: warm
   * `definition` went from ~1ms to 5036ms (5000ms window + poll overhead),
   * measured across five queries with a max of 5037ms — a fixed toll, not a
   * distribution. It stayed invisible before that because the window minted a
   * CACHED proof, so only the first query ever paid it; removing the false
   * proof also removed the memo that was hiding the re-measurement.
   */
  idleSince: number | null;
  /**
   * True once at least one progress cycle has completed.
   *
   * ⚠ "HAS SETTLED ONCE" IS STRICTLY WEAKER THAN "IS DONE" (WI-40224). A server
   * that loads in several phases — rust-analyzer does cargo metadata, then
   * proc-macro build, then indexing — has a legitimately EMPTY pending set
   * between phases, with this flag already true. Gating readiness on it alone
   * answered from a half-loaded server for ~8-10s. Use `quiescent` for any
   * language in REQUIRES_PROGRESS_SIGNAL.
   */
  everSettled: boolean;
  /**
   * The server's OWN readiness verdict, from rust-analyzer's
   * `experimental/serverStatus` notification. `null` means the server has not
   * reported (or does not implement it).
   *
   * This is the difference between asking "is the server idle right now?" —
   * which our progress bookkeeping answers, and which is true between loading
   * phases — and "does the server consider itself ready?", which only it can
   * answer. Everything else is an inference from a signal designed for
   * progress bars.
   */
  quiescent: boolean | null;
  /** Intents that have independently earned a readiness proof (WI-41090). */
  certifiedReadiness: Set<LspReadinessIntent>;
  /** Latest positive canary evidence, kept independently for each intent. */
  canaryReadiness: Map<LspReadinessIntent, LspCanaryReadinessSample>;
  /** Intents with positive evidence that has not earned a stable proof yet. */
  unprovenReadiness: Set<LspReadinessIntent>;
  /** Monotonic count of completed progress cycles observed from this server. */
  progressGeneration: number;
  /**
   * Latest `textDocument/publishDiagnostics` payload per document URI.
   *
   * Diagnostics are PUSHED, not requested, which creates a false-empty trap
   * the definition path does not have: a document the server has never
   * published for is indistinguishable from a clean one unless we track
   * whether a publish was ever OBSERVED. We therefore record receipt, and the
   * diagnostics reader refuses to report "clean" for a URI with no entry.
   */
  diagnostics: Map<string, { diags: LspDiagnostic[]; receivedAt: number }>;
}

/** The subset of the LSP `Diagnostic` shape this adapter reads. */
export interface LspDiagnostic {
  range?: { start?: { line?: number; character?: number } };
  severity?: number;
  code?: string | number;
  source?: string;
  message?: string;
}

/**
 * How long to wait for the project to finish loading before answering.
 * Measured 2026-08-21 on this repo: the TypeScript server needed ~4.7s after
 * didOpen before `textDocument/definition` stopped returning the WRONG answer.
 * 60s is a generous ceiling for a cold monorepo load, not an expected wait.
 */
const PROJECT_READY_TIMEOUT_MS = 60_000;

/**
 * tsserver's V8 old-space ceiling in MB, or null to leave node's default
 * (WI-2142840).
 *
 * `typescript-language-server` turns this into `--max-old-space-size=<N>` on
 * the tsserver fork (`getExecArgv`). Unset, tsserver runs at node's DEFAULT
 * old-space — measured 2240MB on this box — and self-aborts with SIGABRT when
 * a second large program is added to a server that already holds one. That
 * abort is what took every TypeScript answer down.
 *
 * MEASURED both ways, same probe, one variable changed:
 *   default ceiling  -> peak RSS 4314MB, `Signal: SIGABRT`, query answers
 *                       `[nothing]`, and every later TypeScript answer is empty
 *   6144             -> peak RSS 4981MB, server ALIVE, and the operator-core
 *                       query returns the correct site
 *
 * 6144 is chosen as measured-sufficient with headroom, not guessed. The
 * apparent cost — "up to 6GB per agent on a box running ~100 of them" — is
 * mostly illusory, and that is the non-obvious part: this is a CAP, not an
 * allocation. A small project still sits at ~200MB. It binds only on programs
 * that were ALREADY consuming 4.3GB immediately before aborting, so the real
 * marginal cost over the status quo is the ~700MB between crashing and
 * working.
 *
 * It is a ceiling, not a cure: it does not stop ONE tsserver accumulating
 * every project an agent touches (see `resolveProjectRoot`, which returns
 * `fallbackRoot` unconditionally and so leaves the `clientKey(language,
 * rootPath)` registry key inert). A big enough working set will still reach
 * any ceiling; defect A's liveness eviction is what makes that survivable.
 */
const MAX_TSSERVER_MEMORY_MB: number | null =
  Number(process.env.PAPERCUSP_LSP_MAX_TSSERVER_MEMORY_MB ?? '') || 6144;

/**
 * A workspace-wide tsserver may retain one foreground configured/inferred
 * project (plus that project's own references) at a time (WI-2142895).
 *
 * This is intentionally one, not an unmeasured larger guess. The failure that
 * prompted the bound was a second large program added to an already-loaded
 * client: semantic tsserver reached 4314MB and aborted under node's default
 * old-space ceiling. The 6144MB cap above makes that observed case survive,
 * but only closing the previous project's documents prevents every project a
 * long-lived agent touches from accumulating forever.
 */
const MAX_FOREGROUND_TYPESCRIPT_PROJECTS = 1;

/**
 * How long the progress set must stay CONTINUOUSLY empty before a
 * progress-signal server may issue an UNPROVEN canary when it never sends
 * `experimental/serverStatus` (WI-40224).
 *
 * An instantaneous "nothing pending" reading cannot distinguish the gap
 * between two of rust-analyzer's loading phases from the end of the last one.
 * A sustained one can. This is strictly weaker evidence than the server's own
 * `quiescent` verdict, which is why it is the fallback and not the primary
 * gate — and why an empty answer produced under it is NOT blessed as
 * trustworthy (see `lspQuery`'s freshness handling).
 */
const PROGRESS_SETTLE_WINDOW_MS = 2_000;

/**
 * How long a language may take to load its project before we call it degraded.
 * Per-language because the honest numbers differ by an order of magnitude:
 * MEASURED 2026-08-21 on this repo, tsserver was ready in ~5s while
 * rust-analyzer needed ~89s (cargo metadata + proc-macro build for the Tauri
 * crate). A single 60s ceiling would mark every cold Rust query degraded.
 */
function readyTimeoutFor(language: LspLanguage): number {
  return language === 'rust' ? 300_000 : PROJECT_READY_TIMEOUT_MS;
}

interface AdapterState {
  /** Keyed by `${language}::${rootPath}`. */
  clients: Map<string, LspClient>;
  /**
   * In-flight `startClient` promises, same key.
   *
   * MEASURED DEFECT, not a theoretical one: without this, two concurrent
   * first-calls both miss the `clients` cache (nothing is written to it until
   * `initialize` returns, ~3.5s later) and each spawns its own language
   * server. The task ledger recorded exactly that — two `lsp:typescript`
   * sidecars 18ms apart from one test run — doubling RSS and breaking the
   * `childProcMax: 1` budget while every individual answer still looked
   * perfectly correct. Caching the PROMISE, not just the result, is what makes
   * the cache cover the window it was meant to cover.
   */
  starting: Map<string, Promise<LspClient>>;
}

/**
 * Pinned via @papercusp/module-singleton: a duplicate module record would
 * otherwise produce a second registry whose servers nobody can shut down, and
 * the split is invisible until you go looking for the orphaned children.
 */
const state = pinModuleState<AdapterState>(
  '@papercusp/operator-core.code-intelligence.lsp-adapter',
  () => ({
    clients: new Map<string, LspClient>(),
    starting: new Map<string, Promise<LspClient>>(),
  }),
);

function clientKey(language: LspLanguage, rootPath: string): string {
  return `${language}::${rootPath}`;
}

/**
 * Direct children of `pid`, read from /proc without spawning anything.
 *
 * A subprocess per check would be absurd on a path that runs whenever an answer
 * comes back empty; this is one small file read. Linux-only by construction —
 * anywhere else the file is absent and the caller gets `null`, which it must
 * treat as UNKNOWN rather than as "no children".
 */
function childPidsOf(pid: number): number[] | null {
  try {
    const raw = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim();
    return raw ? raw.split(/\s+/).filter(Boolean).map(Number) : [];
  } catch {
    return null;
  }
}

/**
 * Is the process that actually ANSWERS still alive? (WI-2142693)
 *
 * `client.child` is the typescript-language-server WRAPPER. The program, the
 * type checker — everything that can answer a `definition` — lives in
 * `tsserver`, a CHILD of that wrapper. When tsserver dies the wrapper does not:
 * measured, it stays alive, exits nothing, sends no notification, writes ZERO
 * bytes to stderr, and answers `null` to a query that returned a real site
 * seconds earlier. It does not respawn tsserver either — a killed one was still
 * dead 30s later, and a wrapper found on this box had sat childless for over
 * three hours while its siblings ran normally.
 *
 * So `child.on('exit')` — the only liveness contract this adapter had, and one
 * whose own comment reads "a dead server must never answer emptily and
 * confidently again" — cannot fire for the failure it was written to catch. It
 * watches the wrong process. `experimental/serverStatus` does not close the gap
 * either: that notification is rust-analyzer's, and rust-analyzer is not what
 * dies here.
 *
 * Two traps are deliberately encoded below, because each produces a confident
 * wrong answer rather than an error:
 *
 *  - **Only TypeScript has the wrapper/child split.** rust-analyzer is a single
 *    process with no children, so a naive "no children ⇒ dead" would condemn
 *    every healthy rust client on its first empty answer.
 *  - **"No children" is ambiguous before the first spawn.** It means "not yet"
 *    just as readily as "died". Only a wrapper we have SEEN owning a child can
 *    be pronounced dead by its absence — which is why `tsserverSeen` exists and
 *    why this returns `unknown`, not `alive`, when it has never been set.
 *
 * A tempting alternative was measured and REJECTED: `documentSymbol` on an
 * already-open document still returns all 37 symbols with tsserver dead (the
 * wrapper answers it from its own syntactic parse). A canary built on it would
 * have reported "alive" forever.
 */
export function probeLanguageServiceLiveness(
  client: Pick<LspClient, 'language' | 'tsserverSeen'> & {
    child: Pick<LspClient['child'], 'pid' | 'exitCode' | 'killed'>;
  },
  readChildPids: (pid: number) => number[] | null = childPidsOf,
): 'alive' | 'dead' | 'unknown' {
  // The wrapper itself dying is still a real death, and still worth catching.
  if (client.child.exitCode !== null || client.child.killed) return 'dead';
  if (client.language !== 'typescript') return 'unknown';
  const pid = client.child.pid;
  if (typeof pid !== 'number') return 'unknown';

  const kids = readChildPids(pid);
  if (kids === null) return 'unknown';
  if (kids.length > 0) {
    client.tsserverSeen = true;
    return 'alive';
  }
  return client.tsserverSeen ? 'dead' : 'unknown';
}

/**
 * Mark a client dead and UNREGISTER it, so the next query starts a fresh server.
 *
 * Eviction is the half that turns a crash back into something recoverable.
 * Detection alone would only make the outage honest: `getClient` reuses any
 * client whose health is not 'unhealthy', so without the `delete` a dead server
 * is handed to every future caller for the life of the process. Returns the
 * reason when it evicted, else null.
 */
export function evictIfLanguageServiceDead(
  client: LspClient,
  clients: Map<string, LspClient>,
  readChildPids: (pid: number) => number[] | null = childPidsOf,
): string | null {
  if (probeLanguageServiceLiveness(client, readChildPids) !== 'dead') return null;
  const reason =
    `the ${client.language} language service died while its wrapper process survived; ` +
    `every answer since has been an empty one. The client has been discarded and the ` +
    `next query will start a fresh server` +
    (client.stderrTail?.trim() ? `. Server stderr tail: ${client.stderrTail.trim().slice(-600)}` : '') +
    // The wrapper's log is where the death is actually described (WI-2142840);
    // stderr above is the wrapper's own and stays empty through a child death.
    (client.logTail?.trim() ? `. Server log tail: ${client.logTail.trim().slice(-600)}` : '');
  client.health = 'unhealthy';
  client.lastError = reason;
  clients.delete(clientKey(client.language, client.rootPath));
  return reason;
}

/**
 * The `initializationOptions` a TypeScript client starts with (WI-2142840).
 *
 * Extracted so the memory ceiling is REACHABLE BY A TEST. It was a literal
 * inside the spawn path, where nothing could assert it and deleting it would
 * have silently restored the crash — the failure would not reappear in any
 * unit run, only as an empty `definition` answer against a large package hours
 * later, which is precisely how this bug stayed unexplained for so long.
 *
 * `maxTsServerMemory` is the wrapper's own option name; it becomes
 * `--max-old-space-size=<N>` on the tsserver fork (`getExecArgv`). Passing null
 * omits the key entirely, so an explicit opt-out really does restore node's
 * default rather than pinning it to some other number.
 */
export function typescriptInitializationOptions(
  tsserverPath: string,
  maxTsServerMemoryMb: number | null = MAX_TSSERVER_MEMORY_MB,
): { tsserver: { path: string }; maxTsServerMemory?: number } {
  return {
    tsserver: { path: tsserverPath },
    ...(maxTsServerMemoryMb ? { maxTsServerMemory: maxTsServerMemoryMb } : {}),
  };
}

/**
 * The directory a language server must be ROOTED at to answer about `file`.
 *
 * This is NOT the same as the repo root, and getting it wrong is silent.
 * rust-analyzer derives its entire crate graph from the `Cargo.toml` at its
 * root; point it somewhere without one and it loads NOTHING, then answers
 * every query with an empty result while reporting itself healthy. That empty
 * passes `isTrustworthyEmpty` — so an agent asking "who implements this
 * trait?" is told, authoritatively, "nobody".
 *
 * MEASURED 2026-08-21 (P-010): this repo has NO Cargo.toml at its root — the
 * crates live at papercusp-desktop/src-tauri, apps/tui, apps/pui-companion-proto
 * and apps/pui-zellij-plugin — so every Rust query returned a false-empty.
 * Confirmed not a loading race: 179 polls over 90s never filled.
 *
 * Returning an `error` rather than a silent fallback is the durable half. A
 * caller that cannot find a project root MUST refuse to answer, because a loud
 * failure is honest (`isTrustworthyEmpty` treats `error !== null` as such) and
 * a healthy-looking empty is not.
 */
export function resolveProjectRoot(
  language: LspLanguage,
  file: string,
  fallbackRoot: string,
): { root: string; error: string | null } {
  // TypeScript: tsserver finds a file's own tsconfig by walking UP from the
  // document it is asked to open, so the client root only has to CONTAIN the
  // file — it does not have to hold a tsconfig itself.
  //
  // It does not hold one: this repository has NO root tsconfig.json (only
  // tsconfig.base.json) and ~100 per-project ones. An earlier comment here
  // asserted "the monorepo root carries the tsconfig"; that was never true.
  // It stays harmless for position-addressed ops precisely because they open a
  // document and let tsserver do the walking.
  //
  // ⚠ The symbol search does NOT get to reuse that reasoning, and must not be
  // "simplified" to call this function for TypeScript. navto searches the
  // server's LOADED PROJECTS rather than the open document, so it needs a root
  // that actually holds a tsconfig.json — see nearestTsProjectRoot, used by
  // resolveSymbolSearchScope below.
  if (language !== 'rust') return { root: fallbackRoot, error: null };

  let dir = dirname(file);
  while (dir.startsWith(fallbackRoot)) {
    if (existsSync(join(dir, 'Cargo.toml'))) return { root: dir, error: null };
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return {
    root: fallbackRoot,
    error:
      `no Cargo.toml found between ${file} and ${fallbackRoot}, so rust-analyzer ` +
      `would have no crate graph and would answer EMPTY for every query while ` +
      `reporting itself healthy. Refusing to answer rather than returning a ` +
      `false-empty that reads as "nothing implements this".`,
  };
}

/**
 * The project a `workspace_symbols` search will ACTUALLY cover — or a refusal.
 *
 * Every other server-querying op in this adapter is position-addressed: it is
 * handed a `file`, which resolves a crate root (rust) and opens a document
 * (both languages). `workspace_symbols` takes only a NAME, so before this
 * existed it queried whatever root the caller's workspace happened to be, with
 * no document open. On this repository that cannot work for either language:
 *
 *   - rust-analyzer rooted where there is no Cargo.toml has no crate graph, so
 *     its index is permanently empty (the repo root has none).
 *   - tsserver's `getFullNavigateToItems` iterates the session's PROJECTS and
 *     throws `No Project.` when there are none — and a project comes into
 *     existence only when a document is opened, never from the root URI.
 *
 * ⚠ THE REPAIR IS NOT "PICK A ROOT AUTOMATICALLY", AND THAT IS THE WHOLE POINT.
 * A symbol search answers for ONE project. This repository has five
 * first-party cargo workspaces and ~100 tsconfig projects, so any auto-picked
 * root is right for one of them and wrong for the rest. Silently choosing one
 * would turn today's honest, loud failure into a server that certifies itself
 * healthy and returns `sites: []` for a symbol that plainly exists elsewhere —
 * which `isTrustworthyEmpty()` reads as PROVEN ABSENCE. Measured before this
 * function existed: `account_options` (a `pub fn` in apps/tui) asked at the
 * papercusp-desktop/src-tauri root returned `sites: []`, `health: 'healthy'`,
 * `error: null`. That is a worse bug than the one being fixed, so the scope is
 * required from the caller and refused when it is absent.
 */
export function resolveSymbolSearchScope(
  language: LspLanguage,
  anchor: string | undefined,
  rootPath: string,
): { root: string; anchor: string | null; error: string | null } {
  if (language === 'rust') {
    // An anchor names its own crate; otherwise the root must itself be one.
    if (anchor) {
      const resolved = resolveProjectRoot('rust', anchor, rootPath);
      if (resolved.error) return { root: rootPath, anchor: null, error: resolved.error };
      return { root: resolved.root, anchor, error: null };
    }
    if (existsSync(join(rootPath, 'Cargo.toml'))) {
      return { root: rootPath, anchor: null, error: null };
    }
    return {
      root: rootPath,
      anchor: null,
      error:
        `no Cargo.toml at ${rootPath}, so rust-analyzer rooted there has no crate graph and ` +
        `would answer EMPTY for every symbol while reporting itself healthy. Pass 'file' (any ` +
        `.rs file in the crate you mean) or 'rootPath' (a directory containing Cargo.toml). ` +
        `This repository has no root Cargo.toml and several independent cargo workspaces, so ` +
        `there is no single correct default to pick — choosing one silently would certify ` +
        `absence for every other workspace.`,
    };
  }

  // TypeScript. rootPath cannot rescue this: a project is created by opening a
  // document, so without an anchor there is nothing for navto to search.
  if (!anchor) {
    return {
      root: rootPath,
      anchor: null,
      error:
        `tsserver has no project until a document is opened, so workspace_symbols cannot run ` +
        `unanchored — it fails with "No Project." Pass 'file' (any .ts file in the project you ` +
        `mean) to establish which project this search covers. This repository has no root ` +
        `tsconfig.json (only tsconfig.base.json) and ~100 project tsconfigs, so there is no ` +
        `single default project — and loading just one silently would certify absence for the ` +
        `other ninety-nine.`,
    };
  }

  // Opening the anchor is necessary but NOT sufficient. navto
  // (getFullNavigateToItems) iterates the session's LOADED PROJECTS, and
  // tsserver loads a project from its own root URI — not from the document it
  // is handed. Rooted at a directory holding no tsconfig.json it files the
  // anchor under an inferred project that navto does not search, so every
  // symbol comes back empty. That empty is honest here (the caveat below marks
  // it degraded), but it is still useless, and it is why repairing the rust
  // leg made this one newly visible rather than newly broken.
  //
  // MEASURED 2026-08-31 (EI-21929741479590036) on one host, one symbol:
  //   root = <repo root>            -> sites: [] — 6/6, three symbols, two anchors
  //   root = packages/operator-core -> found on the first call (591ms), again at 2ms
  // So root the search at the anchor's OWN tsconfig project, exactly as the
  // rust branch above roots at the anchor's own Cargo.toml.
  const tsRoot = nearestTsProjectRoot(anchor, rootPath);
  if (!tsRoot) {
    return {
      root: rootPath,
      anchor: null,
      error:
        `no tsconfig.json found between ${anchor} and ${rootPath}, so tsserver would file that ` +
        `anchor under an inferred project that navto does not search and would answer EMPTY for ` +
        `every symbol. Pass a 'file' inside a directory covered by a tsconfig.json. Refusing ` +
        `rather than returning a false-empty that reads as "no such symbol".`,
    };
  }
  return { root: tsRoot, anchor, error: null };
}

/**
 * The nearest ancestor of `file` holding a `tsconfig.json`, or null.
 *
 * The TypeScript analogue of the `Cargo.toml` walk in resolveProjectRoot, and
 * deliberately NOT folded into it: position-addressed ops must keep rooting at
 * the caller's workspace, because they open a document and let tsserver do the
 * walking, and re-rooting them per file would spawn one server per package
 * (clients are cached by `${language}::${rootPath}`). Only the symbol search
 * needs the project actually LOADED at the server root.
 */
function nearestTsProjectRoot(file: string, fallbackRoot: string): string | null {
  let dir = dirname(file);
  while (dir.startsWith(fallbackRoot)) {
    if (existsSync(join(dir, 'tsconfig.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** The configured project retaining `file`, or a conservative inferred-project key. */
function typescriptProjectKey(file: string, fallbackRoot: string): string {
  return nearestTsProjectRoot(file, fallbackRoot) ?? dirname(file);
}

function projectKeyForOpenUri(
  client: LspClient,
  uri: string,
  stamp: { typescriptProjectKey?: string },
): string | null {
  if (stamp.typescriptProjectKey) return stamp.typescriptProjectKey;
  try {
    return typescriptProjectKey(fileURLToPath(uri), client.rootPath);
  } catch {
    // A non-file URI cannot have come from ensureOpen, but pinned module state
    // predates this field. Keep it rather than closing an unclassified document.
    return null;
  }
}

/**
 * Close documents that keep any TypeScript project other than `keepKey` alive.
 *
 * TypeScript's ProjectService removes orphan configured projects when the next
 * open-file update runs. The adapter previously sent no didClose at all during
 * normal reads, so that cleanup could never collect an old project. This sends
 * the missing half of the protocol before the new project's didOpen.
 */
function closeTypeScriptProjectsExcept(client: LspClient, keepKey: string): number {
  if (client.language !== 'typescript') return 0;

  const open = [...client.openDocs.entries()].map(([uri, stamp]) => ({
    uri,
    projectKey: projectKeyForOpenUri(client, uri, stamp),
  }));
  const projectKeys = new Set(
    open
      .map((entry) => entry.projectKey)
      .filter((projectKey): projectKey is string => projectKey !== null),
  );
  if (
    (projectKeys.has(keepKey) && projectKeys.size <= MAX_FOREGROUND_TYPESCRIPT_PROJECTS) ||
    (!projectKeys.has(keepKey) && projectKeys.size < MAX_FOREGROUND_TYPESCRIPT_PROJECTS)
  ) {
    return 0;
  }

  // Keep the requested project first, then the most recently opened projects
  // if the budget is ever raised from one. Map insertion order gives us the
  // stable LRU tie-break without another mutable index.
  const retained = new Set<string>([keepKey]);
  for (const entry of [...open].reverse()) {
    if (retained.size >= MAX_FOREGROUND_TYPESCRIPT_PROJECTS) break;
    if (entry.projectKey) retained.add(entry.projectKey);
  }
  const toClose = open.filter(
    (entry) => entry.projectKey !== null && !retained.has(entry.projectKey),
  );
  if (toClose.length === 0) return 0;

  // Closing projects invalidates every cached readiness claim just as opening
  // one does. Mark busy before the first notification so no concurrent reader
  // can reuse the pre-transition idle observation.
  invalidateClientReadiness(client);
  for (const { uri } of toClose) {
    client.connection.sendNotification('textDocument/didClose', {
      textDocument: { uri },
    });
    client.openDocs.delete(uri);
    client.diagnostics.delete(uri);
  }
  return toClose.length;
}

function typeScriptProjectLeaseState(client: LspClient): NonNullable<LspClient['typescriptProjectLease']> {
  return (client.typescriptProjectLease ??= {
    activeKey: null,
    users: 0,
    waiters: new Set(),
  });
}

/**
 * Acquire the foreground-project lease for one LSP operation.
 *
 * Queries inside the same project remain concurrent. A cross-project query
 * waits for the previous project's in-flight operations, closes the documents
 * retaining that project, and only then proceeds. That makes the one-project
 * bound safe under the saturation runner's Promise.all traffic: eviction never
 * closes a document beneath a request that is still using it.
 */
export async function acquireLspProjectLease(
  client: LspClient,
  file: string,
): Promise<() => void> {
  if (client.language !== 'typescript') return () => undefined;

  const key = typescriptProjectKey(file, client.rootPath);
  const lease = typeScriptProjectLeaseState(client);
  while (lease.activeKey !== null && lease.activeKey !== key) {
    await new Promise<void>((resolve) => lease.waiters.add(resolve));
  }

  if (lease.activeKey === null) lease.activeKey = key;
  lease.users += 1;
  closeTypeScriptProjectsExcept(client, key);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    lease.users = Math.max(0, lease.users - 1);
    if (lease.users !== 0) return;

    lease.activeKey = null;
    const waiters = [...lease.waiters];
    lease.waiters.clear();
    for (const wake of waiters) wake();
  };
}

/**
 * Why an empty symbol search is never absence.
 *
 * `isTrustworthyEmpty()` believes an empty answer when the backend claims
 * health. That is right for position-addressed ops, whose scope is the whole
 * program the cursor sits in. It is wrong here: a symbol search covers ONE
 * project, so "not in this project" and "not in the repository" are different
 * claims and only the first is supported. Attaching this caveat puts the
 * answer on `isTrustworthyEmpty`'s honest-loud-failure branch instead of its
 * believe-the-healthy-empty branch.
 */
export function symbolSearchEmptyCaveat(
  name: string,
  language: LspLanguage,
  scope: { root: string; anchor: string | null },
): string {
  return (
    `no ${language} symbol named '${name}' in the project rooted at ${scope.root}` +
    (scope.anchor ? ` (anchored at ${scope.anchor})` : '') +
    `. This is NOT evidence that the symbol does not exist: a symbol search covers ONE ` +
    `project, and this repository has several cargo workspaces and ~100 tsconfig projects. ` +
    `To ask about a different project, re-run with a 'file' anchor inside it; to ask a ` +
    `repository-wide question, use gitnexus (graph) or ast-grep instead.`
  );
}

/** Language for a file, or null when we have no pinned server for it. */
export function languageForFile(path: string): LspLanguage | null {
  if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(path)) return 'typescript';
  if (/\.rs$/.test(path)) return 'rust';
  return null;
}

async function startClient(language: LspLanguage, rootPath: string): Promise<LspClient> {
  const bin = resolveServerBin(language);
  if (!bin) {
    throw new Error(
      `Pinned ${language} language server is not provisioned. Expected it under ` +
        `${language === 'typescript' ? LSP_VENDOR_DIR : '~/.rustup/toolchains/stable-*/bin'}. ` +
        `Provision it (P-007) rather than falling back to an unpinned server — a floating ` +
        `version silently changes answers between runs.`,
    );
  }

  const args = language === 'typescript' ? ['--stdio'] : [];
  const spawned = await managedSpawn(
    bin,
    args,
    {
      class: 'sidecar',
      title: `lsp:${language}`,
      argv: [bin, ...args],
      cwd: rootPath,
      // Provenance is the whole reason the task ledger exists — `ps` cannot say
      // who launched a server or why. Without it a stray language server looks
      // anonymous in processes:list.
      launchedBy: 'code-intelligence:lsp-adapter',
      planSlug: 'code-intelligence-routing-lsp-gitnexus-2026-08-20',
      detail: { subsystem: 'code-intelligence', language, rootPath },
    },
    { spawnOptions: { cwd: rootPath, stdio: ['pipe', 'pipe', 'pipe'] } },
  );

  const child = spawned.child;
  if (!child.stdout || !child.stdin) {
    throw new Error(`managedSpawn returned a ${language} server child without piped stdio`);
  }

  // WI-2142693. stderr is PIPED (see spawnOptions) and was never read. Two
  // costs, one of them silent: an undrained pipe blocks the writer once its
  // ~64KB buffer fills, and — measured across five probes — an abort message
  // written here is the only place a server death would explain ITSELF. Every
  // investigation of this outage found a corpse and no cause because this
  // stream was discarded. Keep a bounded tail; it is diagnosis, not a signal.
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    const next = `${client.stderrTail ?? ''}${chunk}`;
    client.stderrTail = next.length > 8000 ? next.slice(next.length - 8000) : next;
  });

  const connection = createMessageConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  );
  connection.listen();

  const client: LspClient = {
    connection,
    child,
    taskId: spawned.taskId,
    language,
    rootUri: pathToFileURL(rootPath).href,
    rootPath,
    openDocs: new Map(),
    typescriptProjectLease: { activeKey: null, users: 0, waiters: new Set() },
    health: 'unknown',
    lastError: null,
    startedAt: Date.now(),
    coldStartMs: 0,
    pendingProgress: new Set(),
    // The set starts empty, so the idle period starts now.
    idleSince: Date.now(),
    everSettled: false,
    quiescent: null,
    certifiedReadiness: new Set(),
    canaryReadiness: new Map(),
    unprovenReadiness: new Set(),
    progressGeneration: 0,
    diagnostics: new Map(),
  };

  // ── Project-load readiness ────────────────────────────────────────────────
  // MEASURED, and the reason this machinery exists: for ~4.7s after didOpen the
  // TypeScript server answers `textDocument/definition` with the IMPORT SITE
  // rather than the real cross-package declaration. That is a false POSITIVE —
  // a well-formed, plausible, wrong location — which is strictly more dangerous
  // than an empty result, because nothing about it looks like a failure. The
  // server tells us when it is done via workDoneProgress; we wait for that
  // instead of sleeping a magic number.
  connection.onRequest('window/workDoneProgress/create', (params: { token: string | number }) => {
    client.pendingProgress.add(params.token);
    // The server is loading again: the idle period and any cached per-intent
    // proof are broken, not merely unread.
    invalidateClientReadiness(client);
    return null;
  });
  connection.onNotification(
    '$/progress',
    (params: { token: string | number; value?: { kind?: string } }) => {
      if (params?.value?.kind === 'end') {
        const ended = client.pendingProgress.delete(params.token);
        if (client.pendingProgress.size === 0) {
          client.everSettled = true;
          // Stamp the idle period from the PROGRESS BOUNDARY, not from whenever
          // a later query happens to look.
          markIdle(client);
          // A progress boundary is stronger evidence than an instantaneous
          // idle read. Keep this counter for canary answers too; older pinned
          // clients may not have the field, so initialize defensively.
          if (ended) client.progressGeneration = (client.progressGeneration ?? 0) + 1;
        }
      }
    },
  );

  // WI-40224: rust-analyzer's own readiness verdict. `quiescent` means the
  // server has finished its work — as distinct from our progress bookkeeping,
  // which can only observe that nothing is in flight AT THIS INSTANT, and is
  // therefore true between two loading phases as well as after the last one.
  //
  // `health` here is the SERVER's self-report and is deliberately NOT mapped
  // onto our BackendHealth: a rust-analyzer 'warning' (e.g. a build-script it
  // declined to run) still answers correctly, so treating it as unhealthy
  // would suppress good answers. Only 'error' is escalated.
  connection.onNotification(
    'experimental/serverStatus',
    (params: { health?: string; quiescent?: boolean; message?: string }) => {
      if (typeof params?.quiescent === 'boolean') client.quiescent = params.quiescent;
      if (params?.health === 'error') {
        client.health = 'degraded';
        client.lastError = params.message ?? 'server reported health=error';
      }
    },
  );

  // Diagnostics arrive as a PUSH notification, never as a reply to a request.
  // Recording receipt (not just content) is what lets the reader below tell
  // "this file is clean" from "the server has not spoken about this file yet".
  connection.onNotification(
    'textDocument/publishDiagnostics',
    (params: { uri?: string; diagnostics?: LspDiagnostic[] }) => {
      if (!params?.uri) return;
      client.diagnostics.set(params.uri, {
        diags: Array.isArray(params.diagnostics) ? params.diagnostics : [],
        receivedAt: Date.now(),
      });
    },
  );

  // WI-2142840: the wrapper ANNOUNCES tsserver's death here, and nothing was
  // listening — which is why five investigations found a corpse and no cause.
  //
  // Why `stderrTail` above cannot carry it: `typescript-language-server` forks
  // tsserver with `silent: true`, so the child's stderr is a private pipe to
  // the WRAPPER, never to us. And in syntax-routing mode — the mode we run in,
  // which is why the wrapper owns TWO children — the wrapper's own
  // `SyntaxRoutingTsServer.onStdErr` is a literal no-op (`onStdErr(_handler) {}`),
  // so it discards that pipe by construction. `stderrTail` is the WRAPPER's
  // stderr; the process that dies is its child. That is the whole reason a
  // death here has always looked silent, and it means "wrote zero bytes to
  // stderr" was never evidence about tsserver at all.
  //
  // What the wrapper DOES do on losing its semantic server is log
  // `[tsserver] Exited. Code: <code>. Signal: <signal>` as a `window/logMessage`
  // notification. That one line separates the live hypotheses — SIGABRT is a V8
  // heap abort (tsserver runs at node's DEFAULT old-space, ~2240MB on this box,
  // because `maxTsServerMemory` is unset), SIGKILL is an external kill. Keep a
  // bounded tail so the next death explains itself instead of being re-derived.
  connection.onNotification(
    'window/logMessage',
    (params: { type?: number; message?: string }) => {
      const message = params?.message;
      if (typeof message !== 'string' || message.length === 0) return;
      const next = `${client.logTail ?? ''}${message}\n`;
      client.logTail = next.length > 8000 ? next.slice(next.length - 8000) : next;
    },
  );

  // A dead server must never answer emptily and confidently again.
  child.on('exit', (code, signal) => {
    client.health = 'unhealthy';
    client.lastError = `language server exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`;
    state.clients.delete(clientKey(language, rootPath));
  });

  const initializationOptions =
    language === 'typescript'
      ? typescriptInitializationOptions(resolveTsserverPath())
      : { cargo: { buildScripts: { enable: false } }, procMacro: { enable: false } };

  const t0 = Date.now();
  await connection.sendRequest('initialize', {
    processId: process.pid,
    rootUri: client.rootUri,
    workspaceFolders: [{ uri: client.rootUri, name: 'papercusp' }],
    initializationOptions,
    capabilities: {
      textDocument: {
        definition: { linkSupport: false },
        references: {},
        implementation: { linkSupport: false },
        // Declaring publishDiagnostics is what makes the server push them at
        // all; without it `lsp.diagnostics` would report every file clean.
        publishDiagnostics: { relatedInformation: false },
        // `rename` here buys the PREVIEW only — the returned WorkspaceEdit is
        // never applied by this adapter (see the read-only rail above and
        // P-013, which gates application separately).
        rename: { prepareSupport: false },
      },
      workspace: { workspaceFolders: true, symbol: { dynamicRegistration: false } },
      // REQUIRED for the readiness protocol above. Without declaring this the
      // server never sends workDoneProgress, we can never tell "still loading"
      // from "done", and every early query silently returns the wrong answer.
      window: { workDoneProgress: true },
      // WI-40224: opt IN to rust-analyzer's `experimental/serverStatus`. It is
      // the only signal that means "ready" rather than "not currently busy",
      // and the server sends it ONLY if the client advertises this capability —
      // so omitting it is what left us inferring readiness from progress-token
      // bookkeeping that was never designed to answer the question.
      experimental: { serverStatusNotification: true },
    },
  });
  client.coldStartMs = Date.now() - t0;
  connection.sendNotification('initialized', {});
  client.health = 'healthy';

  state.clients.set(clientKey(language, rootPath), client);
  return client;
}

async function getClient(language: LspLanguage, rootPath: string): Promise<LspClient> {
  const key = clientKey(language, rootPath);
  const existing = state.clients.get(key);
  if (existing && existing.health !== 'unhealthy') return existing;

  // Defensive: a process that pinned an OLDER shape of this state (before
  // `starting` existed) keeps that object until it restarts.
  if (!state.starting) state.starting = new Map();

  // The whole point — see AdapterState.starting. A concurrent caller joins the
  // start already in flight instead of racing a second server into existence.
  const inFlight = state.starting.get(key);
  if (inFlight) return inFlight;

  const pending = startClient(language, rootPath).finally(() => {
    state.starting.delete(key);
  });
  state.starting.set(key, pending);
  return pending;
}

/** Start/reuse a client and hold its foreground project for one operation. */
async function getLeasedClient(
  language: LspLanguage,
  rootPath: string,
  file: string,
): Promise<{ client: LspClient; release: () => void }> {
  const client = await getClient(language, rootPath);
  const release = await acquireLspProjectLease(client, file);
  return { client, release };
}

type IntentReadinessPreparation = 'certified' | 'answerable' | 'canary' | 'timeout';

/**
 * What the readiness loop can conclude from ONE observation; 'wait' = poll again.
 *
 * `certified` and `answerable` are deliberately different (WI-2142382). Both
 * permit the query to run; only `certified` is a COMPLETENESS proof, and only a
 * completeness proof may bless an EMPTY answer as a real absence.
 */
export type ReadinessVerdict = 'certified' | 'answerable' | 'canary' | 'wait';

/** The readiness-relevant state of a client at one instant. */
export interface ReadinessObservation {
  /** The server's OWN done-verdict. `null` means it has not reported one. */
  readonly quiescent: boolean | null;
  /** True once at least one progress cycle has COMPLETED. */
  readonly everSettled: boolean;
  /** Whether the pending-progress set is empty right now. */
  readonly idle: boolean;
  /** How long it has been CONTINUOUSLY idle. */
  readonly idleForMs: number;
}

/**
 * The readiness decision, as a pure function of one observation (WI-2142382).
 *
 * ONE RULE, and it is the module's own doctrine applied without an exception:
 * **only the server's own `quiescent === true` certifies. Every inference from
 * silence is a canary.**
 *
 * `healthForAnswer` already states the principle, about the progress-signal
 * fallback: the settle window is "strictly weaker evidence than the server's
 * own verdict — good enough to answer on, not good enough to certify an
 * absence." The settle-window STRATEGY was the same weak evidence, but it
 * returned `certified` and so routed itself around the very rule written to
 * contain it: a proof lands in `certifiedReadiness`, `healthForAnswer` then
 * hands an EMPTY answer the client's `healthy`, and `isTrustworthyEmpty()`
 * reports a false absence as fact.
 *
 * MEASURED, and the reason this is not a guard on `everSettled`: at the moment
 * the bad proof was minted for a cross-project `definition`, the client read
 * `everSettled=true, pendingProgress=0, progressGeneration=1` — a genuine,
 * COMPLETED progress cycle. It was not certifying on silence; it was
 * certifying between PHASES. `everSettled`'s own doc comment says why that is
 * undecidable here: "HAS SETTLED ONCE" IS STRICTLY WEAKER THAN "IS DONE" — a
 * server that loads in phases is legitimately idle between them, with the flag
 * already true. Nothing in the progress protocol distinguishes silence between
 * phases from silence after the last one, so an `everSettled` guard would have
 * been a no-op on the real failure. TypeScript never sends
 * `experimental/serverStatus` at all, so for it `quiescent` is permanently
 * `null` and NO amount of waiting can produce a completeness proof.
 *
 * The consequence is deliberate: a TypeScript EMPTY is no longer certifiable,
 * so it stays `degraded` and `lspQuery` turns it into an honest refusal. We
 * give up claiming to prove absence for a server that cannot tell us it is
 * done, which we could never actually prove.
 *
 * WHY `answerable` EXISTS, and the regression that produced it: the first cut
 * of this fix collapsed the settle window to `canary`, which routed positive
 * answers into `certifyCanaryAnswer`'s stability guard. That guard requires
 * BOTH a progress boundary AND an answer CHANGE between two samples — evidence
 * a COLD server generates as it indexes, and a WARM one never generates at
 * all, because its correct answer is stable from the first query. So every
 * correct answer became permanently `degraded`. MEASURED on the two positive
 * cases: `pinModuleState` (the bench's passing control) and `managedSetInterval`
 * both returned their correct single site with health `degraded`, where before
 * they were `healthy`. That is the same class of defect as the one being fixed,
 * pointed the other way: a proof that can NEVER be minted is as wrong as one
 * minted on nothing.
 *
 * `answerable` is therefore the settle window's honest weight: run the query,
 * let a POSITIVE answer keep the client's health, and let an EMPTY fall through
 * to `degraded` because no proof was minted. It mints nothing, so it can never
 * bless an absence — which was the entire bug.
 */
export function readinessVerdict(
  strategy: LspReadinessStrategy,
  observation: ReadinessObservation,
): ReadinessVerdict {
  // An explicit canary-query strategy is unproven by construction.
  if (strategy.kind === 'canary-query') return 'canary';

  // The server's own verdict outranks every inference, in BOTH directions.
  if (observation.quiescent === true) return 'certified';
  if (observation.quiescent === false) return 'wait';

  if (!observation.idle) return 'wait';

  if (strategy.kind === 'progress-signal') {
    // Requires a COMPLETED cycle before even a canary: this server announces
    // its indexing, so pre-first-progress silence carries no information.
    return observation.everSettled && observation.idleForMs >= PROGRESS_SETTLE_WINDOW_MS
      ? 'canary'
      : 'wait';
  }

  return observation.idleForMs >= strategy.settleMs ? 'answerable' : 'wait';
}

/**
 * Record that the pending-progress set is EMPTY, remembering WHEN it became so.
 *
 * Idempotent BY DESIGN: an already-idle client keeps its original timestamp.
 * That is the whole fix — the idle period is CONTINUOUS and must survive across
 * queries, or every query re-measures it from zero and pays the settle window
 * again. Returns the effective idle-start so callers need no second read.
 *
 * Pinned module state may hold a pre-WI-2142532 client with no such field;
 * `undefined` (never installed) is treated as "idle as of now", which is the
 * honest reading when we have no earlier evidence, and matches exactly what the
 * old per-call variable did on its first iteration.
 */
function markIdle(client: LspClient): number {
  const compatible = client as LspClient & { idleSince?: number | null };
  if (typeof compatible.idleSince !== 'number') compatible.idleSince = Date.now();
  return compatible.idleSince;
}

/** Record that the server is loading again, breaking the idle period. */
function markBusy(client: LspClient): void {
  (client as LspClient & { idleSince?: number | null }).idleSince = null;
}

/** A project/document transition invalidates every readiness claim on the client. */
function invalidateClientReadiness(client: LspClient): void {
  markBusy(client);
  client.quiescent = null;
  readinessProofs(client).clear();
  canaryReadiness(client).clear();
  unprovenReadiness(client).clear();
}

/** Pinned module state may contain a pre-WI-41090 client until host restart. */
function readinessProofs(client: LspClient): Set<LspReadinessIntent> {
  const compatible = client as LspClient & {
    certifiedReadiness?: Set<LspReadinessIntent>;
  };
  return (compatible.certifiedReadiness ??= new Set());
}

/** Pinned module state may contain a pre-stability-guard client. */
function canaryReadiness(client: LspClient): Map<LspReadinessIntent, LspCanaryReadinessSample> {
  const compatible = client as LspClient & {
    canaryReadiness?: Map<LspReadinessIntent, LspCanaryReadinessSample>;
  };
  return (compatible.canaryReadiness ??= new Map());
}

/** Pinned module state may contain a pre-stability-guard client. */
function unprovenReadiness(client: LspClient): Set<LspReadinessIntent> {
  const compatible = client as LspClient & {
    unprovenReadiness?: Set<LspReadinessIntent>;
  };
  return (compatible.unprovenReadiness ??= new Set());
}

/** Pinned module state may contain a pre-stability-guard client. */
function progressGeneration(client: LspClient): number {
  const compatible = client as LspClient & { progressGeneration?: number };
  return (compatible.progressGeneration ??= 0);
}

/**
 * Prepare one intent without ever promoting server-wide readiness.
 *
 * `certified` means the configured strategy earned a proof for THIS intent.
 * `canary` means the query may run, but its result remains unproven until the
 * per-intent stable-readiness guard observes a complete answer transition.
 */
/**
 * Exported for the falsifiability guard. `readinessVerdict` is a PURE function
 * over an `idleForMs` it is handed, so it stayed green through a 5000×
 * warm-latency regression whose whole mechanism was where that number comes
 * from. The defect lives in THIS composition, so the guard must run THIS.
 */
export async function prepareIntentReadiness(
  client: LspClient,
  intent: LspReadinessIntent,
  timeoutMs = readyTimeoutFor(client.language),
): Promise<IntentReadinessPreparation> {
  const proofs = readinessProofs(client);
  if (proofs.has(intent)) return 'certified';

  const strategy = readinessStrategyFor(client.language, intent);
  if (strategy.kind === 'canary-query') return 'canary';

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (client.health === 'unhealthy') return 'timeout';
    const idle = client.pendingProgress.size === 0;
    // How long the pending set has been CONTINUOUSLY empty. A single
    // instantaneous reading cannot tell the gap between two loading phases
    // from the end of the last one; a sustained one can — and the sustained
    // observation is kept ON THE CLIENT so a quiet server is not re-timed from
    // scratch by every query (see `LspClient.idleSince`).
    if (!idle) markBusy(client);
    const idleForMs = idle ? Date.now() - markIdle(client) : 0;

    const verdict = readinessVerdict(strategy, {
      quiescent: client.quiescent,
      everSettled: client.everSettled,
      idle,
      idleForMs,
    });
    if (verdict === 'certified') {
      proofs.add(intent);
      return 'certified';
    }
    // Deliberately mints NO proof: `answerable` says the query may run, not
    // that an absence can be believed. Because nothing lands in
    // `certifiedReadiness`, `healthForAnswer` degrades an EMPTY on its own —
    // and because this is not `canary`, `certifyCanaryAnswer` returns early and
    // never marks a POSITIVE unproven, so a correct answer keeps its health.
    if (verdict === 'answerable') return 'answerable';
    if (verdict === 'canary') return 'canary';
    if (Date.now() > deadline) return 'timeout';
    await new Promise((r) => setTimeout(r, 50));
  }
}

export function certifyCanaryAnswer(
  client: LspClient,
  intent: LspReadinessIntent,
  preparation: IntentReadinessPreparation,
  siteCount: number,
  answerFingerprint?: string,
): boolean {
  if (preparation !== 'canary') return false;
  const strategy = readinessStrategyFor(client.language, intent);
  const minimumSites = strategy.kind === 'canary-query' ? strategy.minimumSites : 1;
  if (siteCount < minimumSites) return false;

  const samples = canaryReadiness(client);
  const previous = samples.get(intent);
  const currentGeneration = progressGeneration(client);
  const currentFingerprint = answerFingerprint ?? String(siteCount);
  const previousFingerprint = previous?.answerFingerprint ?? String(previous?.siteCount);
  const current: LspCanaryReadinessSample = {
    siteCount,
    answerFingerprint: currentFingerprint,
    progressGeneration: currentGeneration,
    sawProgressBoundary:
      previous?.sawProgressBoundary === true ||
      (previous !== undefined && currentGeneration > previous.progressGeneration),
    sawAnswerChange:
      previous?.sawAnswerChange === true ||
      (previous !== undefined &&
        (siteCount !== previous.siteCount || currentFingerprint !== previousFingerprint)),
  };

  samples.set(intent, current);
  if (!canaryReadinessIsStable(previous, current)) {
    unprovenReadiness(client).add(intent);
    return false;
  }

  readinessProofs(client).add(intent);
  unprovenReadiness(client).delete(intent);
  return true;
}

/**
 * The health an ANSWER may claim — which is not always the health the client
 * has. WI-40224's class fix, and the durable half of it.
 *
 * `prepareIntentReadiness` decides WHEN to answer; this decides whether an answer
 * is entitled to be BELIEVED. They are different questions, and conflating
 * them is what let a bounded readiness bug become an authoritative lie:
 * `isTrustworthyEmpty()` blesses any empty whose health is 'healthy', so the
 * moment readiness was wrong, absence became "proof" of absence.
 *
 * The rule: an EMPTY answer from a server that announces its indexing
 * (REQUIRES_PROGRESS_SIGNAL) but has never told us it is `quiescent` is
 * reported DEGRADED. We got there via the settle-window fallback, which is
 * strictly weaker evidence than the server's own verdict — good enough to
 * answer on, not good enough to certify an absence.
 *
 * A certified NON-EMPTY answer keeps the client's health. An unproven positive
 * canary is different: the measured cold-open failure returned two real sites
 * while hundreds of cross-file sites were still missing. Until the canary has
 * crossed the stable-readiness guard, its sites remain useful but DEGRADED.
 */
export function healthForAnswer(
  client: Pick<LspClient, 'health'> & {
    readonly certifiedReadiness?: ReadonlySet<LspReadinessIntent>;
    readonly unprovenReadiness?: ReadonlySet<LspReadinessIntent>;
  },
  intent: LspReadinessIntent,
  siteCount: number,
): BackendHealth {
  if (siteCount > 0) {
    if (
      client.unprovenReadiness?.has(intent) &&
      !client.certifiedReadiness?.has(intent)
    ) {
      return client.health === 'healthy' ? 'degraded' : client.health;
    }
    return client.health;
  }
  if (client.certifiedReadiness?.has(intent)) return client.health;
  return client.health === 'healthy' ? 'degraded' : client.health;
}

/**
 * Open a document, or RE-open it if the file on disk has changed since we did.
 *
 * WI-40251, and the reason this is not merely `if (open) return`: per the LSP
 * spec an OPEN document's CLIENT copy is authoritative and the server MUST
 * ignore disk. So once opened, a document is frozen at the text we sent until
 * we say otherwise. `lspResyncDocument` says otherwise — but its only caller is
 * `lsp.apply`, so a write through ANY other path (Edit/Write via the lock hook,
 * a git-sync pull, the merge-resolver, a human's editor) leaves the server
 * answering about text that no longer exists, and reporting it as healthy.
 *
 * That is a FLEET bug, not a single-agent one: the client registry is
 * module-scoped, so one warm server per language is shared by every agent and
 * one agent's unsynced write corrupts everyone's answers. Staleness scales with
 * agent count.
 *
 * The check is PULL rather than push (a lock-release hook) deliberately. Pull
 * catches every staleness source, including the ones no lock brackets; a
 * lock-release push would catch only agent writes through Edit/Write, and would
 * invert the dependency by making the lock plane know about code-intelligence.
 * A lock release is still a precise "content settled" signal worth exploiting
 * later as an optimisation — but correctness must not depend on it.
 *
 * Cost is one `stat` per query on an already-open document. mtime+size is
 * deliberate: it catches every writer here (git checkouts and normal writes all
 * move mtime) without hashing file contents on the hot path.
 *
 * Exported for the WI-40251 recurrence guard in lsp-adapter.test.ts, which
 * asserts the re-open actually happens; production callers stay in this file.
 */
export async function ensureOpen(client: LspClient, absPath: string): Promise<string> {
  const uri = pathToFileURL(absPath).href;
  const seen = client.openDocs.get(uri);
  const tsProjectKey = client.language === 'typescript' ? typescriptProjectKey(absPath, client.rootPath) : undefined;

  let stamp: { mtimeMs: number; size: number } | null = null;
  try {
    const st = await stat(absPath);
    stamp = { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    // Unstattable (deleted mid-flight, permissions). Fall through: if we have
    // it open, keep the copy we have rather than dropping it; if we do not, the
    // readFile below will surface the real error.
    if (seen) return uri;
  }

  if (seen) {
    if (stamp && seen.mtimeMs === stamp.mtimeMs && seen.size === stamp.size) return uri;
    // Disk moved under us. Close before re-opening: the adapter never
    // established incremental sync (documents open at version 1 and never
    // advance), so didChange would carry a version the server has no baseline
    // for. Re-opening restores the invariant the rest of the adapter assumes.
    client.connection.sendNotification('textDocument/didClose', { textDocument: { uri } });
    client.openDocs.delete(uri);
  }

  const text = await readFile(absPath, 'utf8');
  // Opening a document can start a new project-loading cycle. The client's
  // previous idle period describes the server BEFORE this document existed
  // and is therefore not readiness evidence for the query about to follow.
  //
  // This invalidation must happen before didOpen is sent. Without it, a warm
  // client can reuse an hours-old idleSince, answer immediately, then announce
  // and finish its project load AFTER the answer. The next query sees that new
  // progress boundary and pays the full 5-second settle window — measured as
  // [4844, 1, 2, 1, 1] in WI-2142941. An unchanged already-open document takes
  // the early return above and keeps the genuine hot-path observation.
  invalidateClientReadiness(client);
  client.connection.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: specForLanguage(client.language).languageId,
      version: 1,
      text,
    },
  });
  // Stamp from AFTER the read where the stat failed, so a transient stat error
  // cannot pin a document as permanently fresh.
  client.openDocs.set(uri, {
    ...(stamp ?? { mtimeMs: -1, size: -1 }),
    ...(tsProjectKey ? { typescriptProjectKey: tsProjectKey } : {}),
  });
  return uri;
}

/** An LSP Location or LocationLink, normalized to a one-indexed SymbolSite. */
function toSite(raw: unknown, rootPath: string): SymbolSite | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const uri = (r.uri ?? r.targetUri) as string | undefined;
  const range = (r.range ?? r.targetSelectionRange ?? r.targetRange) as
    | { start?: { line?: number } }
    | undefined;
  if (!uri) return null;

  let path: string;
  try {
    path = fileURLToPath(uri);
  } catch {
    return null;
  }
  const rel = path.startsWith(rootPath + '/') ? path.slice(rootPath.length + 1) : path;

  return {
    path: rel,
    // The LSP wire protocol is ZERO-indexed (`Position.line` is zero-based by
    // spec). Every line leaves this adapter one-indexed, via the same
    // normalizer GitNexus results go through — see D-008.
    line1: toOneIndexed('lsp-adapter', range?.start?.line),
    kind: null,
  };
}

export interface LspQuery {
  /** Absolute path to the file the cursor is in. */
  file: string;
  /** ONE-indexed line, as a human/grep/editor would state it. */
  line1: number;
  /** Zero-indexed character offset within the line. */
  character: number;
  /** Repo root (the LSP project root). */
  rootPath: string;
}

const METHOD_BY_INTENT: Partial<Record<CodeIntelIntent, string>> = {
  definition: 'textDocument/definition',
  references: 'textDocument/references',
  implementations: 'textDocument/implementation',
};

/**
 * Ask the pinned language server one READ-ONLY question.
 *
 * Never throws for a server-side failure: it returns an answer carrying
 * `error` and a non-healthy `health`, because a thrown exception loses the
 * distinction between "it broke" and "there are none" — which is exactly the
 * false-empty this design refuses to allow.
 */
export async function lspQuery(
  intent: CodeIntelIntent,
  query: LspQuery,
): Promise<CodeIntelAnswer> {
  const method = METHOD_BY_INTENT[intent];
  const started = Date.now();

  const fail = (error: string, health: BackendHealth = 'unhealthy'): CodeIntelAnswer => ({
    backend: 'lsp-adapter',
    intent,
    query: `${query.file}:${query.line1}:${query.character}`,
    sites: [],
    truncation: { truncated: false, totalAvailable: null, continuation: null },
    freshness: { health, indexedAt: null, staleVsDisk: null, indexedCommit: null },
    latencyMs: Date.now() - started,
    error,
  });

  if (!method) return fail(`intent '${intent}' is not served by the LSP adapter`, 'unknown');
  // METHOD_BY_INTENT contains only the three LSP query intents. The runtime
  // refusal above is the corresponding guard for plain-JS/persisted callers.
  const readinessIntent = intent as LspReadinessIntent;

  const language = languageForFile(query.file);
  if (!language) return fail(`no pinned language server for file ${query.file}`, 'unknown');

  // Root the server at the project that actually owns this file. For Rust that
  // is the nearest ancestor Cargo.toml, NOT the repo root — see
  // resolveProjectRoot. Sites are still reported relative to query.rootPath.
  const project = resolveProjectRoot(language, query.file, query.rootPath);
  if (project.error) return fail(project.error, 'unhealthy');

  let releaseProjectLease: (() => void) | null = null;
  try {
    const leased = await getLeasedClient(language, project.root, query.file);
    const client = leased.client;
    releaseProjectLease = leased.release;
    const uri = await ensureOpen(client, query.file);

    // Never answer from a half-loaded project — that returns a plausible WRONG
    // location, not an error (measured: ~4.7s window on this repo).
    const readiness = await prepareIntentReadiness(client, readinessIntent);
    if (readiness === 'timeout') {
      return fail(
        `language server did not establish readiness for intent '${intent}' within ` +
          `${readyTimeoutFor(client.language)}ms; refusing to answer from a half-loaded ` +
          `program because it returns a plausible WRONG location rather than an error`,
        'degraded',
      );
    }

    const params: Record<string, unknown> = {
      textDocument: { uri },
      // Back to ZERO-indexed on the way OUT: the caller speaks one-indexed,
      // the wire speaks zero-indexed, and this is the only place that converts.
      position: { line: query.line1 - 1, character: query.character },
    };
    if (intent === 'references') {
      // INCLUDE the declaration. This was `false` with no comment justifying
      // it, and that default is wrong for our caller: an agent asking "who
      // references this symbol?" is orienting itself, and the declaration is
      // the single most useful site in the answer — it is where the thing IS.
      // Standard editor behaviour agrees (VS Code's Find All References lists
      // the declaration), and the acceptance corpus's own ground truth for
      // `references-through-barrel-reexport` expects it.
      //
      // Excluding it also made a whole class of answer indistinguishable from
      // a false-empty: a symbol referenced ONLY at its declaration returned
      // `[]` from a healthy server, which isTrustworthyEmpty then blessed as
      // "nothing uses this" — the exact failure the corpus case exists to
      // catch.
      params.context = { includeDeclaration: true };
    }

    const raw = await client.connection.sendRequest(method, params);
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const sites = list.map((r) => toSite(r, query.rootPath)).filter((s): s is SymbolSite => s !== null);
    certifyCanaryAnswer(client, readinessIntent, readiness, sites.length, JSON.stringify(sites));

    // WI-2142693. An empty answer is the ONLY symptom a dead language service
    // produces, so this is the one place its death can be caught — and the
    // check must run on EVERY empty, not just an uncertified one. A corpse
    // whose readiness was certified before it died still reports `healthy`, and
    // that is the worst case of all: silence blessed as a proven absence.
    if (sites.length === 0) {
      const died = evictIfLanguageServiceDead(client, state.clients);
      if (died) return fail(died, 'unhealthy');
    }

    const answerHealth = healthForAnswer(client, readinessIntent, sites.length);
    // `isTrustworthyEmpty` accepts an error as an honest degraded answer, while
    // `error:null` plus degraded health would be an untrustworthy silent empty.
    // A readiness canary may still support useful non-empty results, but an
    // empty result needs a loud refusal until the server has certified the
    // intent as settled.
    if (sites.length === 0 && answerHealth !== 'healthy') {
      return fail(
        `the language server returned no sites for intent '${intent}', but readiness ` +
          `is not certified; an empty result is not a clean bill of health`,
        answerHealth,
      );
    }

    return {
      backend: 'lsp-adapter',
      intent,
      query: `${query.file}:${query.line1}:${query.character}`,
      sites,
      truncation: { truncated: false, totalAvailable: sites.length, continuation: null },
      freshness: {
        // NOT client.health directly (WI-40224): an EMPTY answer from a server
        // that has never reported itself quiescent must not be certifiable as
        // absence — "no results", "file is clean" and "nothing to rename" are
        // all read as facts by callers via isTrustworthyEmpty().
        health: answerHealth,
        indexedAt: new Date(client.startedAt).toISOString(),
        // The server reads from disk on didOpen, so an opened document is
        // never stale against disk. We do NOT claim to know about files the
        // server has not opened — that would be exactly the unfounded
        // freshness claim corpus case 6 exists to catch.
        staleVsDisk: false,
        indexedCommit: null,
      },
      latencyMs: Date.now() - started,
      error: null,
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  } finally {
    releaseProjectLease?.();
  }
}

/**
 * How long to wait for a `publishDiagnostics` push after the project is ready.
 * Diagnostics are not requestable on this server version, so this is the only
 * bound available; on timeout we report DEGRADED rather than "clean".
 */
const DIAGNOSTICS_PUSH_TIMEOUT_MS = 15_000;

/** LSP `DiagnosticSeverity`, 1-based per spec. */
const SEVERITY_NAME: Record<number, string> = {
  1: 'error',
  2: 'warning',
  3: 'information',
  4: 'hint',
};

/**
 * Read the diagnostics the server has published for one file.
 *
 * The false-empty trap here is DIFFERENT from the definition path's, and worse
 * in one specific way: diagnostics are PUSHED, so a file the server has never
 * spoken about produces exactly the same empty array as a genuinely clean one.
 * We therefore require an OBSERVED publish for the URI and return
 * `health:'degraded'` + an error when none arrived — "I have not been told"
 * must never render as "this file is clean".
 */
export async function lspDiagnostics(query: {
  file: string;
  rootPath: string;
}): Promise<CodeIntelAnswer> {
  const started = Date.now();
  const intent: CodeIntelIntent = 'diagnostics';
  const fail = (error: string, health: BackendHealth = 'unhealthy'): CodeIntelAnswer => ({
    backend: 'lsp-adapter',
    intent,
    query: query.file,
    sites: [],
    truncation: { truncated: false, totalAvailable: null, continuation: null },
    freshness: { health, indexedAt: null, staleVsDisk: null, indexedCommit: null },
    latencyMs: Date.now() - started,
    error,
  });

  const language = languageForFile(query.file);
  if (!language) return fail(`no pinned language server for file ${query.file}`, 'unknown');

  const project = resolveProjectRoot(language, query.file, query.rootPath);
  if (project.error) return fail(project.error, 'unhealthy');

  let releaseProjectLease: (() => void) | null = null;
  try {
    const leased = await getLeasedClient(language, project.root, query.file);
    const client = leased.client;
    releaseProjectLease = leased.release;
    const uri = await ensureOpen(client, query.file);
    const readiness = await prepareIntentReadiness(client, intent);
    if (readiness === 'timeout') {
      return fail(
        `language server did not establish readiness for intent '${intent}' within ` +
          `${readyTimeoutFor(client.language)}ms; diagnostics from a half-loaded program ` +
          `are not evidence of a clean file`,
        'degraded',
      );
    }

    const deadline = Date.now() + DIAGNOSTICS_PUSH_TIMEOUT_MS;
    while (!client.diagnostics.has(uri) && Date.now() < deadline) {
      if (client.health === 'unhealthy') return fail(client.lastError ?? 'server died');
      await new Promise((r) => setTimeout(r, 100));
    }

    const entry = client.diagnostics.get(uri);
    if (!entry) {
      return fail(
        `no textDocument/publishDiagnostics received for ${query.file} within ` +
          `${DIAGNOSTICS_PUSH_TIMEOUT_MS}ms. Reporting DEGRADED rather than "clean": ` +
          `an absent push is silence, not a clean bill of health`,
        'degraded',
      );
    }

    const rel = query.file.startsWith(query.rootPath + '/') ? query.file.slice(query.rootPath.length + 1) : query.file;
    const sites: SymbolSite[] = entry.diags.map((d) => ({
      path: rel,
      line1: toOneIndexed('lsp-adapter', d.range?.start?.line),
      kind: SEVERITY_NAME[d.severity ?? 0] ?? null,
      detail: [d.source, d.code, d.message].filter(Boolean).join(' ') || null,
    }));
    certifyCanaryAnswer(client, intent, readiness, sites.length, JSON.stringify(sites));

    // WI-2142693, and the reason this matters MORE here than for definition: an
    // empty diagnostics result legitimately means "this file is clean", so a
    // dead server's silence is indistinguishable from good news. Check liveness
    // before reporting a clean bill of health that nobody actually issued.
    if (sites.length === 0) {
      const died = evictIfLanguageServiceDead(client, state.clients);
      if (died) return fail(died, 'unhealthy');
    }

    const answerHealth = healthForAnswer(client, intent, sites.length);
    // A publish proves that the server spoke about this URI, not that an empty
    // result is complete. If readiness is still unproven, keep the empty loud:
    // `isTrustworthyEmpty` accepts an error as an honest degraded answer, while
    // `error:null` plus degraded health would be an untrustworthy silent empty.
    if (sites.length === 0 && answerHealth !== 'healthy') {
      return fail(
        `textDocument/publishDiagnostics was observed for ${query.file}, but diagnostics readiness ` +
          `is not certified; an empty result is not a clean bill of health`,
        answerHealth,
      );
    }

    return {
      backend: 'lsp-adapter',
      intent,
      query: query.file,
      sites,
      truncation: { truncated: false, totalAvailable: sites.length, continuation: null },
      freshness: {
        // NOT client.health directly (WI-40224): an EMPTY answer from a server
        // that has never reported itself quiescent must not be certifiable as
        // absence — "no results", "file is clean" and "nothing to rename" are
        // all read as facts by callers via isTrustworthyEmpty().
        health: answerHealth,
        indexedAt: new Date(entry.receivedAt).toISOString(),
        staleVsDisk: false,
        indexedCommit: null,
      },
      latencyMs: Date.now() - started,
      error: null,
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  } finally {
    releaseProjectLease?.();
  }
}

/**
 * Search declared symbols across the workspace by name (`workspace/symbol`).
 *
 * `rootFile` picks WHICH pinned server answers — the protocol has one symbol
 * index per server, so a TypeScript query cannot see Rust symbols and vice
 * versa. We take a representative file rather than guessing from the query
 * string, because guessing would silently answer from the wrong index.
 */
export async function lspWorkspaceSymbols(query: {
  name: string;
  rootPath: string;
  language: LspLanguage;
  limit?: number;
  /**
   * A file naming WHICH project this search covers. Required for TypeScript
   * (tsserver has no project until a document is opened); optional for rust,
   * where a root holding a Cargo.toml is enough. See resolveSymbolSearchScope.
   */
  anchor?: string;
}): Promise<CodeIntelAnswer> {
  const started = Date.now();
  const intent: CodeIntelIntent = 'symbol-search';
  const limit = query.limit ?? 50;
  const fail = (error: string, health: BackendHealth = 'unhealthy'): CodeIntelAnswer => ({
    backend: 'lsp-adapter',
    intent,
    query: query.name,
    sites: [],
    truncation: { truncated: false, totalAvailable: null, continuation: null },
    freshness: { health, indexedAt: null, staleVsDisk: null, indexedCommit: null },
    latencyMs: Date.now() - started,
    error,
  });

  // Establish the project context BEFORE querying. This is the only
  // server-querying path in the adapter that is not position-addressed, so
  // nothing else here resolves a crate root or opens a document for it.
  const scope = resolveSymbolSearchScope(query.language, query.anchor, query.rootPath);
  if (scope.error) return fail(scope.error, 'unknown');

  let releaseProjectLease: (() => void) | null = null;
  let client: LspClient;
  try {
    // Keep the lease assignment in this function's control-flow graph. An
    // assignment inside a Promise.then callback is not observed by
    // TypeScript's finally analysis, which narrows the initialized-null
    // variable to `never` at the optional call below (TS2349).
    if (scope.anchor) {
      const leased = await getLeasedClient(query.language, scope.root, scope.anchor);
      releaseProjectLease = leased.release;
      client = leased.client;
    } else {
      client = await getClient(query.language, scope.root);
    }
    // Opening the anchor is what CREATES the tsserver project this search runs
    // against; for rust it merely warms a crate graph the root already implies.
    if (scope.anchor) await ensureOpen(client, scope.anchor);
    const readiness = await prepareIntentReadiness(client, intent);
    if (readiness === 'timeout') {
      return fail(
        `language server did not establish readiness for intent '${intent}' within ` +
          `${readyTimeoutFor(client.language)}ms; a symbol index that is still building ` +
          `returns a PARTIAL list that looks complete`,
        'degraded',
      );
    }

    const raw = await client.connection.sendRequest('workspace/symbol', { query: query.name });
    const list = Array.isArray(raw) ? raw : [];
    const all = list
      .map((entry): SymbolSite | null => {
        const e = entry as { location?: unknown; containerName?: string; kind?: number };
        const site = toSite(e.location, query.rootPath);
        if (!site) return null;
        return { ...site, detail: e.containerName ?? null };
      })
      .filter((s): s is SymbolSite => s !== null);

    const sites = all.slice(0, limit);
    certifyCanaryAnswer(client, intent, readiness, sites.length, JSON.stringify(sites));
    // A certified server would otherwise return an empty as health:'healthy'
    // with error:null — the one shape isTrustworthyEmpty() reads as proven
    // absence, and the scope this search covers cannot support that claim.
    if (sites.length === 0) {
      return fail(symbolSearchEmptyCaveat(query.name, query.language, scope), 'degraded');
    }
    return {
      backend: 'lsp-adapter',
      intent,
      query: query.name,
      sites,
      truncation: {
        // Stated, never inferred from length: the caller must be able to tell
        // a 50-of-50 cut from a true 50.
        truncated: all.length > limit,
        totalAvailable: all.length,
        continuation: null,
      },
      freshness: {
        health: healthForAnswer(client, intent, sites.length),
        indexedAt: new Date(client.startedAt).toISOString(),
        staleVsDisk: null,
        indexedCommit: null,
      },
      latencyMs: Date.now() - started,
      error: null,
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  } finally {
    releaseProjectLease?.();
  }
}

/**
 * Compute a rename's affected sites WITHOUT applying anything.
 *
 * This asks the server for a `WorkspaceEdit` and reads it as a REPORT. Nothing
 * in this adapter writes a file: applying an edit would bypass the PreToolUse
 * lock arbitration that keeps this shared checkout collision-free, which is
 * why application is a separately gated capability (P-013) rather than a flag
 * on this function. The name carries "preview" for the same reason the
 * corpus's PREVIEW_ONLY_ALLOWLIST exists — the promise is verified by the
 * no-mutation case, not by the name.
 */
export async function lspRenamePreview(query: LspQuery & { newName: string }): Promise<CodeIntelAnswer> {
  const started = Date.now();
  const intent: CodeIntelIntent = 'rename-preview';
  const q = `${query.file}:${query.line1}:${query.character}→${query.newName}`;
  const fail = (error: string, health: BackendHealth = 'unhealthy'): CodeIntelAnswer => ({
    backend: 'lsp-adapter',
    intent,
    query: q,
    sites: [],
    truncation: { truncated: false, totalAvailable: null, continuation: null },
    freshness: { health, indexedAt: null, staleVsDisk: null, indexedCommit: null },
    latencyMs: Date.now() - started,
    error,
  });

  const language = languageForFile(query.file);
  if (!language) return fail(`no pinned language server for file ${query.file}`, 'unknown');

  const project = resolveProjectRoot(language, query.file, query.rootPath);
  if (project.error) return fail(project.error, 'unhealthy');

  let releaseProjectLease: (() => void) | null = null;
  try {
    const leased = await getLeasedClient(language, project.root, query.file);
    const client = leased.client;
    releaseProjectLease = leased.release;
    const uri = await ensureOpen(client, query.file);
    const readiness = await prepareIntentReadiness(client, intent);
    if (readiness === 'timeout') {
      return fail(
        `language server did not establish readiness for intent '${intent}' within ` +
          `${readyTimeoutFor(client.language)}ms; a rename plan computed from a half-loaded ` +
          `program MISSES call sites, which is the most dangerous possible partial answer`,
        'degraded',
      );
    }

    const raw = (await client.connection.sendRequest('textDocument/rename', {
      textDocument: { uri },
      position: { line: query.line1 - 1, character: query.character },
      newName: query.newName,
    })) as { changes?: Record<string, Array<{ range?: { start?: { line?: number } }; newText?: string }>> } | null;

    const sites: SymbolSite[] = [];
    for (const [editUri, edits] of Object.entries(raw?.changes ?? {})) {
      for (const edit of edits ?? []) {
        const site = toSite({ uri: editUri, range: edit.range }, query.rootPath);
        if (site) sites.push({ ...site, detail: edit.newText ?? null });
      }
    }
    certifyCanaryAnswer(client, intent, readiness, sites.length, JSON.stringify(sites));

    return {
      backend: 'lsp-adapter',
      intent,
      query: q,
      sites,
      truncation: { truncated: false, totalAvailable: sites.length, continuation: null },
      freshness: {
        // NOT client.health directly (WI-40224): an EMPTY answer from a server
        // that has never reported itself quiescent must not be certifiable as
        // absence — "no results", "file is clean" and "nothing to rename" are
        // all read as facts by callers via isTrustworthyEmpty().
        health: healthForAnswer(client, intent, sites.length),
        indexedAt: new Date(client.startedAt).toISOString(),
        staleVsDisk: false,
        indexedCommit: null,
      },
      latencyMs: Date.now() - started,
      error: null,
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  } finally {
    releaseProjectLease?.();
  }
}

/**
 * The RAW `WorkspaceEdit` behind `lspRenamePreview`, both encodings intact.
 *
 * `lspRenamePreview` flattens the edit into `SymbolSite[]` for an agent to
 * read, and in doing so it (a) drops `documentChanges` — the encoding a server
 * uses when it wants to say more than "replace this range" — and (b) discards
 * the newText/range pairing needed to actually apply anything. Both are correct
 * for a REPORT and useless for an application, so P-013's writer takes this
 * instead of re-deriving an edit from the flattened sites.
 *
 * Still read-only: this sends `textDocument/rename` and returns what came back.
 * Nothing here touches the filesystem. The application lives in `lsp-apply.ts`,
 * behind its own flag and its own lock.
 */
export async function lspRenameWorkspaceEdit(
  query: LspQuery & { newName: string },
): Promise<
  | {
      ok: true;
      edit: unknown;
      projectRoot: string;
      language: LspLanguage;
      /**
       * `true` only when the language server itself CERTIFIED a complete
       * symbol index (`quiescent === true`) before this edit was computed —
       * a completeness PROOF. `false` means readiness was reached via the
       * settle-window heuristic alone (`answerable`): good enough to answer
       * on, never an absence/completeness proof (WI-2142449). Every
       * TypeScript rename is `false` today — tsserver never sends
       * `experimental/serverStatus`, so it can never reach `certified`.
       */
      completenessProven: boolean;
      /**
       * Non-null exactly when `completenessProven` is `false`: states the
       * residual risk in the caller's own words rather than leaving it to be
       * inferred from a boolean. `null` when completeness was proven.
       */
      completenessWarning: string | null;
    }
  | { ok: false; error: string; health: BackendHealth }
> {
  const language = languageForFile(query.file);
  if (!language) return { ok: false, error: `no pinned language server for file ${query.file}`, health: 'unknown' };

  const project = resolveProjectRoot(language, query.file, query.rootPath);
  if (project.error) return { ok: false, error: project.error, health: 'unhealthy' };

  let releaseProjectLease: (() => void) | null = null;
  try {
    const leased = await getLeasedClient(language, project.root, query.file);
    const client = leased.client;
    releaseProjectLease = leased.release;
    const uri = await ensureOpen(client, query.file);
    const readiness = await prepareIntentReadiness(client, 'rename-preview');
    // `answerable` is accepted here to hold this gate EXACTLY where it stood
    // before WI-2142382 split the verdict: the settle window used to return
    // `certified`, so a TypeScript rename has always rested on it. Refusing it
    // now would silently disable rename-for-application for every TypeScript
    // project — TS never sends `experimental/serverStatus`, so it can never
    // reach `certified` on a warm server — which is a capability change this
    // fix has no mandate to make. The residual risk is real and PRE-EXISTING:
    // a settle window cannot prove the call-site set is complete, and this
    // caller WRITES.
    //
    // WI-2142449 (option 3 of the three it named): the risk is not fixed here
    // — fixing it would mean tightening the gate, which is exactly the
    // capability change refused above — it is made VISIBLE. `completenessProven`
    // / `completenessWarning` below tell the caller which of the two evidence
    // levels it got, so `lsp.apply`'s result can say so rather than reporting a
    // silent, indistinguishable success.
    if (readiness !== 'certified' && readiness !== 'answerable') {
      // The same refusal `lspRenamePreview` makes, and for a stronger reason
      // here: a rename plan computed from a half-loaded program MISSES call
      // sites, and this caller WRITES. A partial rename that compiles is the
      // worst outcome available — it renames the definition and leaves callers
      // pointing at a symbol that no longer exists, or worse, at a different one.
      return {
        ok: false,
        error:
          `language server has not certified readiness for intent 'rename-preview'; ` +
          `refusing to compute an edit for application`,
        health: 'degraded',
      };
    }

    const edit = await client.connection.sendRequest('textDocument/rename', {
      textDocument: { uri },
      position: { line: query.line1 - 1, character: query.character },
      newName: query.newName,
    });
    const completenessProven = readiness === 'certified';
    return {
      ok: true,
      edit,
      projectRoot: project.root,
      language,
      completenessProven,
      completenessWarning: completenessProven
        ? null
        : `call-site completeness is NOT proven for this rename: readiness was reached via a ` +
          `settle-window heuristic (sustained server idle), which is good evidence to answer on ` +
          `but not a completeness proof — it cannot establish that the symbol index is complete. ` +
          `This rename may miss call sites the server had not yet indexed. Independently verify ` +
          `(e.g. a broad text search for the old symbol name) before trusting it is total.`,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), health: 'unhealthy' };
  } finally {
    releaseProjectLease?.();
  }
}

/**
 * Tell a live server that a file we had open now holds different text.
 *
 * REQUIRED for an honest post-write diagnostic delta, and the reason is the
 * same asymmetry P-013 is built around: per the LSP spec, for an OPEN document
 * the client's copy is authoritative and the server MUST ignore disk. So after
 * `lsp.apply` writes, every diagnostic the server reports still describes the
 * PRE-write text — a delta computed from it would be confidently wrong, and
 * wrong in the reassuring direction ("no new errors").
 *
 * `didClose` + `didOpen` rather than `didChange`: the adapter never established
 * incremental sync (documents are opened at `version: 1` and never advanced),
 * so a `didChange` would be a version the server has no baseline for. Re-opening
 * restores exactly the invariant the rest of the adapter assumes.
 *
 * A no-op when no server is live for that language/root, or when the document
 * was never opened — both mean there is nothing holding a stale copy.
 */
export function lspResyncDocument(absPath: string, rootPath: string, newText: string): boolean {
  const language = languageForFile(absPath);
  if (!language) return false;
  const project = resolveProjectRoot(language, absPath, rootPath);
  if (project.error) return false;
  const client = state.clients.get(clientKey(language, project.root));
  if (!client || client.health === 'unhealthy') return false;

  const uri = pathToFileURL(absPath).href;
  if (!client.openDocs.has(uri)) return false;
  try {
    client.connection.sendNotification('textDocument/didClose', { textDocument: { uri } });
    client.connection.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: specForLanguage(client.language).languageId,
        version: 1,
        text: newText,
      },
    });
    // Re-stamp so ensureOpen's staleness check (WI-40251) does not immediately
    // re-open a document we just synced by hand. Dropping the entry rather than
    // stat-ing is deliberate: the caller wrote this text, so the next query
    // re-reads and re-stamps from disk, which is the conservative direction.
    client.openDocs.delete(uri);
    return true;
  } catch {
    // A dead pipe here costs us the delta's accuracy, not the write that already
    // landed. Report false so the caller marks the delta UNMEASURED rather than
    // reporting a clean one it did not earn.
    return false;
  }
}

/** Shut down every live language server. Safe to call repeatedly. */
export async function shutdownAllLspClients(): Promise<number> {
  const clients = [...state.clients.values()];
  state.clients.clear();
  await Promise.all(
    clients.map(async (c) => {
      // Only speak to a server whose pipe is actually still open. Writing to a
      // destroyed stream raises ERR_STREAM_DESTROYED as an UNHANDLED rejection
      // (vscode-jsonrpc writes asynchronously), which Vitest reports as an
      // unhandled error and warns can cause false-positive tests — so this is a
      // correctness guard, not tidiness.
      const writable = c.child.exitCode === null && !c.child.killed && c.child.stdin?.writable;
      if (writable) {
        try {
          await c.connection.sendRequest('shutdown');
          // sendNotification also returns a promise that can reject once the
          // server closes its end in response to `shutdown` — await it so the
          // rejection is HANDLED here rather than surfacing globally.
          await c.connection.sendNotification('exit');
        } catch {
          /* the server closed its pipe first — expected on a clean exit */
        }
      }
      try {
        c.connection.dispose();
      } catch {
        /* already disposed */
      }

      // GIVE THE PROTOCOL SHUTDOWN TIME TO LAND before reaching for a signal.
      // Measured defect: this used to SIGTERM immediately after `exit`, when
      // `exitCode` is of course still null because the server has had
      // microseconds to react. Under managedSpawn the child we hold is the
      // `systemd-run` CLIENT, not the server itself — so that signal killed the
      // wrapper while its scope still held the real process, and managed-spawn
      // logged exactly that, leaving the ledger row live for the reconciler.
      // A protocol `exit` makes the SERVER terminate itself inside the scope,
      // which is the only clean way out from here; killing a subtree by hand is
      // `processes:kill { taskId }`'s job, never a bare signal.
      if (!(await waitForChildExit(c.child, GRACEFUL_EXIT_WAIT_MS))) {
        if (c.child.exitCode === null && !c.child.killed) c.child.kill('SIGTERM');
      }
    }),
  );
  return clients.length;
}

/** How long a server gets to honour a protocol `exit` before we signal it. */
const GRACEFUL_EXIT_WAIT_MS = 5_000;

/** Resolve true when the child has exited, false on timeout. Never throws. */
function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    // Do not hold the event loop open purely to watch a shutdown.
    if (typeof timer.unref === 'function') timer.unref();
    child.once('exit', onExit);
  });
}

/**
 * Live server inventory — for health surfaces and the corpus runner.
 *
 * The readiness fields are NOT decoration. Whether an EMPTY answer is
 * trustworthy is decided entirely by `certifiedReadiness` (see
 * `healthForAnswer`), and until WI-2142382 that state was observable from
 * nowhere: an operator could see a client's `health: 'healthy'` and had no way
 * to ask HOW the proof behind it was minted, or whether the server had ever
 * actually completed a progress cycle. That is precisely the gap that let a
 * vacuous certification serve a false-healthy empty for a client's whole life
 * while every surface reported a healthy server. Exposing the proof state next
 * to the health it justifies is what makes the difference between "certified"
 * and "certified on silence" visible without attaching a debugger.
 */
export function lspClientInventory(): Array<{
  language: LspLanguage;
  rootPath: string;
  taskId: string;
  health: BackendHealth;
  coldStartMs: number;
  openDocs: number;
  pid: number | null;
  /** True once at least one progress cycle has COMPLETED. */
  everSettled: boolean;
  /** The server's own readiness verdict; `null` means it has not reported. */
  quiescent: boolean | null;
  /** Progress tokens open right now. */
  pendingProgress: number;
  /** Completed progress cycles observed. */
  progressGeneration: number;
  /** Intents holding a readiness proof — an empty answer for these is believed. */
  certifiedReadiness: LspReadinessIntent[];
  /** Intents with positive-but-unproven canary evidence. */
  unprovenReadiness: LspReadinessIntent[];
}> {
  return [...state.clients.entries()].map(([key, c]) => ({
    language: c.language,
    rootPath: key.slice(key.indexOf('::') + 2),
    taskId: c.taskId,
    health: c.health,
    coldStartMs: c.coldStartMs,
    openDocs: c.openDocs.size,
    pid: c.child.pid ?? null,
    everSettled: c.everSettled === true,
    quiescent: c.quiescent ?? null,
    pendingProgress: c.pendingProgress?.size ?? 0,
    progressGeneration: c.progressGeneration ?? 0,
    certifiedReadiness: [...(c.certifiedReadiness ?? [])],
    unprovenReadiness: [...(c.unprovenReadiness ?? [])],
  }));
}
