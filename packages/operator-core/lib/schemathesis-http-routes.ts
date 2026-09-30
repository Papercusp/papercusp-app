// schemathesis-http-routes.ts — P-024, plan design-to-code-coverage-seam-2026-09-02.
//
// Schemathesis over the `http-route` surface family: positive, negative and
// stateful cases generated FROM the OpenAPI document, with zero per-endpoint
// maintenance. The same zero-authoring move P-023 made with zod arbitraries,
// one level up, for the surfaces those arbitraries do not reach.
//
// ── The input is real, and the census figure that says otherwise is a
//    different instrument (D-049) ──
// The live document at :3070/api/openapi.json is ~4.0 MB: 1611 paths / 1761
// operations, 1220 carrying a schema, 3568 components.schemas. It is produced
// by endpoint-route/routes/openapi-json.ts serving `allRouteFragments` from
// endpoint-route/openapi.ts. D-042's "http-route 11/882" is a CENSUS reading
// about `testing_surfaces.schema_ref` — a different instrument over a
// different population. Both numbers are correct; only one of them describes
// the input to this module.
//
// ── Why this module refuses instead of skipping (D-008) ──
// Schemathesis is a non-npm toolchain dependency: it is not installed here and
// npm cannot acquire it. The tempting shape is "if schemathesis is missing,
// skip the gate and exit 0" — and that shape is precisely the defect this plan
// exists to remove. A check that cannot fail is decoration, and a decoration
// that reports success is worse than no check at all, because it consumes the
// attention a real check would have earned. So an absent toolchain is
// `unavailable`: a LOUD, non-zero refusal that names its own remedy. There is
// deliberately no code path from "could not run" to "pass".
//
// ── The vacuous-green guard ──
// The second way this could become decoration needs no missing dependency at
// all: schemathesis invoked against a filter that matches no operation runs
// cleanly, finds nothing, and exits 0. "Tested nothing" and "tested everything
// and found nothing wrong" have identical exit codes and opposite meanings,
// and the confusion fails toward false confidence. So a run that exercised
// zero operations is `unavailable` here, never `pass` — the same discipline
// the sibling gates carry as `conclusive` (P-025/D-048), `unsuppliedTurns`
// (P-017) and `unmeasuredSessions` (P-018).
//
// Nothing in this module shells out, reads a file, or opens a socket: it takes
// observations and returns a verdict, so every branch above is unit-testable
// without a Python interpreter or a running operator.

/**
 * The pinned Schemathesis release this gate runs.
 *
 * A version pin is a curated value, not a derived one — nothing in the tree
 * knows which release we intend. It is kept as a single named constant so
 * there is exactly one copy: the runner interpolates it into the acquisition
 * command rather than a second manifest restating it.
 *
 * 4.x is the line with the Rust core. `requires_python >=3.10`.
 */
export const SCHEMATHESIS_PIN = '4.25.2';

/** How Schemathesis can be invoked on this host, in preference order. */
export type SchemathesisRunner = 'module' | 'pipx';

/**
 * What was observed about the host toolchain.
 *
 * Every field is an OBSERVATION, not a conclusion: `moduleVersion` is null
 * when `python3 -m schemathesis` could not report one, which covers both "not
 * installed" and "installed but broken". The distinction does not change the
 * verdict — neither can run the gate — so it is not modelled.
 */
export interface SchemathesisToolchainProbe {
  /** Did a usable `python3` resolve at all? */
  readonly pythonPresent: boolean;
  /** Version reported by an importable `schemathesis` module, else null. */
  readonly moduleVersion: string | null;
  /** Is `pipx` on PATH? It can acquire the pin without a global install. */
  readonly pipxPresent: boolean;
}

/**
 * The resolved toolchain, or an explicit account of why there is none.
 *
 * `remedy` is populated exactly when `available` is false. It exists because a
 * refusal that does not say how to clear itself is indistinguishable, to the
 * agent reading it, from a broken gate — and the reasonable response to a
 * broken gate is to route around it.
 */
export interface SchemathesisToolchain {
  readonly available: boolean;
  readonly runner: SchemathesisRunner | null;
  readonly version: string | null;
  readonly reason: string;
  readonly remedy: string | null;
}

/**
 * Resolve how — or whether — Schemathesis can run here.
 *
 * Preference order is deliberate. An already-importable module is used as-is
 * even when its version differs from the pin: the pin governs ACQUISITION, and
 * silently refusing a working installation because it is a patch release adrift
 * would make the gate unrunnable on developer machines for no safety gain. The
 * version actually resolved is reported, so a mismatch is visible rather than
 * assumed away.
 */
export function resolveSchemathesisToolchain(
  probe: SchemathesisToolchainProbe,
  pin: string = SCHEMATHESIS_PIN,
): SchemathesisToolchain {
  if (probe.moduleVersion) {
    return {
      available: true,
      runner: 'module',
      version: probe.moduleVersion,
      reason: `schemathesis ${probe.moduleVersion} importable via python3 -m`,
      remedy: null,
    };
  }

  if (probe.pipxPresent) {
    return {
      available: true,
      runner: 'pipx',
      version: pin,
      reason: `schemathesis not installed; pipx will acquire the pinned ${pin}`,
      remedy: null,
    };
  }

  if (!probe.pythonPresent) {
    return {
      available: false,
      runner: null,
      version: null,
      reason: 'no python3 interpreter on PATH, and schemathesis is a Python tool',
      remedy: `install python3 (>=3.10), then: pipx run schemathesis==${pin} --version`,
    };
  }

  return {
    available: false,
    runner: null,
    version: null,
    reason: 'schemathesis is not importable and pipx is not on PATH to acquire it',
    remedy: `pipx install schemathesis==${pin}   (or: python3 -m pip install schemathesis==${pin})`,
  };
}

/**
 * What the OpenAPI document actually offers this gate.
 *
 * This is the evidence that the input is real. It is computed from the
 * document rather than asserted, so a document that silently degrades to a
 * stub is visible as a collapsed operation count instead of continuing to
 * produce confident green runs over nothing.
 */
export interface OpenApiSurfaceSummary {
  readonly paths: number;
  readonly operations: number;
  /** Operations carrying a requestBody schema or any parameter schema. */
  readonly operationsWithSchema: number;
  readonly componentSchemas: number;
}

const HTTP_METHODS = new Set([
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function operationCarriesSchema(operation: Record<string, unknown>): boolean {
  const body = operation.requestBody;
  if (isRecord(body) && isRecord(body.content)) {
    for (const media of Object.values(body.content)) {
      if (isRecord(media) && media.schema !== undefined) return true;
    }
  }

  const parameters = operation.parameters;
  if (Array.isArray(parameters)) {
    for (const parameter of parameters) {
      if (isRecord(parameter) && parameter.schema !== undefined) return true;
    }
  }

  return false;
}

/**
 * Summarize an OpenAPI document's testable surface.
 *
 * Returns `null` for anything that is not a recognizable OpenAPI object —
 * absent, not empty. A parse that produced no usable document and a document
 * that genuinely describes no operations are different facts, and only the
 * second one is a statement about the API.
 */
export function summarizeOpenApiSurface(doc: unknown): OpenApiSurfaceSummary | null {
  if (!isRecord(doc)) return null;
  if (typeof doc.openapi !== 'string' && typeof doc.swagger !== 'string') return null;

  const paths = isRecord(doc.paths) ? doc.paths : null;
  if (!paths) return null;

  let operations = 0;
  let operationsWithSchema = 0;

  for (const pathItem of Object.values(paths)) {
    if (!isRecord(pathItem)) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      if (!isRecord(operation)) continue;
      operations += 1;
      if (operationCarriesSchema(operation)) operationsWithSchema += 1;
    }
  }

  const components = isRecord(doc.components) ? doc.components : null;
  const schemas = components && isRecord(components.schemas) ? components.schemas : null;

  return {
    paths: Object.keys(paths).length,
    operations,
    operationsWithSchema,
    componentSchemas: schemas ? Object.keys(schemas).length : 0,
  };
}

/**
 * The observed outcome of an actual Schemathesis invocation.
 *
 * `exitCode: null` means the process never ran. `operationsTested: null` means
 * the count could not be recovered from its output — which is NOT zero, and is
 * the reason these are nullable rather than defaulted.
 */
export interface SchemathesisRunObservation {
  readonly exitCode: number | null;
  readonly operationsTested: number | null;
  readonly checksFailed: number | null;
  /** Short diagnostic surfaced on the verdict, e.g. a spawn error. */
  readonly detail?: string;
}

/**
 * `pass`   — ran over at least one operation and found no violation.
 * `violations` — ran and found conclusive schema violations.
 * `unavailable` — could not produce a verdict. Never collapsed into either.
 */
export type SchemathesisDecision = 'pass' | 'violations' | 'unavailable';

export interface SchemathesisVerdict {
  readonly decision: SchemathesisDecision;
  /** True only for `pass`/`violations` — a real measurement was made. */
  readonly conclusive: boolean;
  readonly toolchain: SchemathesisToolchain;
  readonly surface: OpenApiSurfaceSummary | null;
  readonly operationsTested: number | null;
  readonly checksFailed: number | null;
  readonly notes: readonly string[];
}

export interface JudgeSchemathesisInput {
  readonly toolchain: SchemathesisToolchain;
  readonly surface: OpenApiSurfaceSummary | null;
  readonly run: SchemathesisRunObservation | null;
}

/**
 * Decide what a Schemathesis run proved.
 *
 * The ordering encodes the two decoration guards: the toolchain must have been
 * available, and the run must have exercised something. Only after both hold
 * does the exit code get to mean anything. There is no path from a falsy
 * precondition to `pass`, which is the property
 * `schemathesis-http-routes.test.ts` asserts exhaustively.
 */
export function judgeSchemathesisRun(input: JudgeSchemathesisInput): SchemathesisVerdict {
  const { toolchain, surface, run } = input;
  const notes: string[] = [];

  const unavailable = (reason: string): SchemathesisVerdict => {
    notes.push(reason);
    return {
      decision: 'unavailable',
      conclusive: false,
      toolchain,
      surface,
      operationsTested: run?.operationsTested ?? null,
      checksFailed: run?.checksFailed ?? null,
      notes,
    };
  };

  if (!toolchain.available) {
    return unavailable(`toolchain unavailable: ${toolchain.reason}`);
  }

  if (!surface) {
    return unavailable('no usable OpenAPI document — the schema could not be read or parsed');
  }

  if (surface.operations === 0) {
    return unavailable('the OpenAPI document describes zero operations — nothing to generate from');
  }

  if (!run || run.exitCode === null) {
    return unavailable(run?.detail ?? 'schemathesis did not run');
  }

  if (run.operationsTested === null) {
    return unavailable(
      'could not recover an operation count from the schemathesis output — a run whose extent is unknown is not a verdict',
    );
  }

  if (run.operationsTested === 0) {
    return unavailable(
      `schemathesis exercised 0 of ${surface.operations} operations — a clean run over nothing is not a pass`,
    );
  }

  notes.push(
    `exercised ${run.operationsTested} of ${surface.operations} operations (${surface.operationsWithSchema} carry a schema)`,
  );

  const failed = run.checksFailed ?? (run.exitCode === 0 ? 0 : null);

  if (run.exitCode === 0 && (failed === null || failed === 0)) {
    return {
      decision: 'pass',
      conclusive: true,
      toolchain,
      surface,
      operationsTested: run.operationsTested,
      checksFailed: 0,
      notes,
    };
  }

  if (failed !== null && failed > 0) {
    notes.push(`${failed} check(s) failed`);
  } else {
    notes.push(`schemathesis exited ${run.exitCode}`);
  }

  return {
    decision: 'violations',
    conclusive: true,
    toolchain,
    surface,
    operationsTested: run.operationsTested,
    checksFailed: failed,
    notes,
  };
}

/**
 * What one NDJSON report yielded.
 *
 * `operationsTested` is deliberately "operations actually EXERCISED", not
 * "operations selected": a run can select operations and then execute nothing
 * (every scenario skipped), and reporting the selection there would walk the
 * vacuous-green guard straight past its own check.
 */
export interface SchemathesisReportParse {
  readonly operationsTested: number | null;
  readonly operationsTotal: number | null;
  readonly operationsSelected: number | null;
  readonly scenariosExecuted: number;
  readonly checksFailed: number | null;
  readonly stopReason: string | null;
  readonly detail: string;
}

/**
 * Parse a Schemathesis 4.x NDJSON report.
 *
 * The shape below is MEASURED, not assumed — captured from schemathesis 4.25.2
 * run against this operator's own document on 2026-09-04:
 *
 *   {"LoadingFinished":{...,"statistic":{"operations":{"total":1761,"selected":5}}}}
 *   {"ScenarioFinished":{...,"status":"success"|"failure"|"skip",
 *                        "recorder":{"label":"GET /api/health",
 *                                    "checks":{"<caseId>":[{"name":...,"status":...}]}}}}
 *   {"EngineFinished":{...,"stop_reason":"completed"}}
 *
 * (The first attempt used `--report=json`, which 4.25.2 rejects outright — its
 * choices are junit, vcr, har, ndjson, allure. Hence a measured parser.)
 *
 * Every field is optional-by-construction: a report from a future version that
 * no longer carries `statistic` yields `operationsTested: null`, which the
 * judge treats as UNAVAILABLE. A format change therefore degrades to a
 * refusal, never to a false pass.
 */
export function parseSchemathesisReport(ndjson: string): SchemathesisReportParse {
  let operationsTotal: number | null = null;
  let operationsSelected: number | null = null;
  let scenariosExecuted = 0;
  let checksFailed = 0;
  let sawScenario = false;
  let stopReason: string | null = null;
  let malformed = 0;

  for (const rawLine of ndjson.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    if (!isRecord(event)) continue;

    const loading = event.LoadingFinished;
    if (isRecord(loading)) {
      const statistic = isRecord(loading.statistic) ? loading.statistic : null;
      const operations = statistic && isRecord(statistic.operations) ? statistic.operations : null;
      if (operations) {
        if (typeof operations.total === 'number') operationsTotal = operations.total;
        if (typeof operations.selected === 'number') operationsSelected = operations.selected;
      }
    }

    const scenario = event.ScenarioFinished;
    if (isRecord(scenario)) {
      sawScenario = true;
      if (scenario.status !== 'skip') scenariosExecuted += 1;

      const recorder = isRecord(scenario.recorder) ? scenario.recorder : null;
      const checks = recorder && isRecord(recorder.checks) ? recorder.checks : null;
      if (checks) {
        for (const perCase of Object.values(checks)) {
          if (!Array.isArray(perCase)) continue;
          for (const check of perCase) {
            if (isRecord(check) && check.status !== 'success') checksFailed += 1;
          }
        }
      }
    }

    const engine = event.EngineFinished;
    if (isRecord(engine) && typeof engine.stop_reason === 'string') {
      stopReason = engine.stop_reason;
    }
  }

  // Selected-but-nothing-executed is zero exercised, not "selected many".
  const operationsTested =
    operationsSelected === null ? null : scenariosExecuted > 0 ? operationsSelected : 0;

  const parts = [
    operationsTotal === null ? 'no operation census in report' : `${operationsTotal} operations in schema`,
    operationsSelected === null ? 'no selection count' : `${operationsSelected} selected`,
    `${scenariosExecuted} scenario(s) executed`,
    stopReason ? `stop_reason=${stopReason}` : 'no EngineFinished event',
  ];
  if (malformed > 0) parts.push(`${malformed} unparseable line(s)`);

  return {
    operationsTested,
    operationsTotal,
    operationsSelected,
    scenariosExecuted,
    // No scenario events at all means the count is unknown, not zero.
    checksFailed: sawScenario ? checksFailed : null,
    stopReason,
    detail: parts.join('; '),
  };
}

/**
 * Process exit code for a verdict.
 *
 * Three-valued, matching the sibling gates: 0 keep/pass, 1 a conclusive
 * failure, 2 could-not-measure. `unavailable` maps to 2 and never to 0 — that
 * mapping is the whole refusal contract, so it lives in one function that a
 * test can pin rather than being re-derived at each call site.
 */
export function schemathesisExitCode(verdict: SchemathesisVerdict): 0 | 1 | 2 {
  if (verdict.decision === 'pass') return 0;
  if (verdict.decision === 'violations') return 1;
  return 2;
}

/** One-line human summary, for logs and work-item evidence. */
export function describeSchemathesisVerdict(verdict: SchemathesisVerdict): string {
  const surface = verdict.surface;
  const scope = surface
    ? `${verdict.operationsTested ?? 0}/${surface.operations} operations`
    : 'no schema';

  switch (verdict.decision) {
    case 'pass':
      return `PASS — schemathesis found no violations over ${scope}`;
    case 'violations':
      return `VIOLATIONS — ${verdict.checksFailed ?? 'some'} check(s) failed over ${scope}`;
    default:
      return `UNAVAILABLE — ${verdict.notes[0] ?? 'no verdict could be produced'}`;
  }
}

/**
 * Build the argv that runs the gate, given a resolved toolchain.
 *
 * Zero per-endpoint maintenance is a property of this argv: it names the
 * schema and the base URL and nothing else about the API. No operation list,
 * no per-route options, no fixture. Adding an endpoint upstream changes what
 * this command tests without changing the command.
 */
export function buildSchemathesisArgv(options: {
  readonly toolchain: SchemathesisToolchain;
  readonly schemaLocation: string;
  readonly baseUrl: string;
  readonly maxExamples: number;
  readonly includePathRegex?: string | null;
  readonly stateful?: boolean;
}): { command: string; args: string[] } | null {
  const { toolchain, schemaLocation, baseUrl, maxExamples, includePathRegex, stateful } = options;
  if (!toolchain.available || !toolchain.runner) return null;

  const gateArgs = [
    'run',
    schemaLocation,
    '--url',
    baseUrl,
    '--max-examples',
    String(maxExamples),
    // ndjson, NOT json: `--report=json` is rejected by 4.25.2 ("invalid
    // choice(s): json. Choose from junit, vcr, har, ndjson, allure"). Measured,
    // not assumed — the first draft of this line guessed `json` and the CLI
    // refused it outright.
    '--report=ndjson',
  ];

  if (includePathRegex) gateArgs.push('--include-path-regex', includePathRegex);
  // Phases are examples, coverage, fuzzing, stateful. Stateful is the one that
  // needs link definitions, and schemathesis self-skips it as `not_applicable`
  // when the document declares no transitions — so leaving it ON by default
  // costs nothing and picks it up for free if links are ever added.
  if (stateful === false) gateArgs.push('--phases=examples,coverage,fuzzing');

  if (toolchain.runner === 'pipx') {
    return {
      command: 'pipx',
      args: ['run', `schemathesis==${toolchain.version ?? SCHEMATHESIS_PIN}`, ...gateArgs],
    };
  }

  // `-m schemathesis.cli`, NOT `-m schemathesis`: the package ships no
  // __main__, so the bare form dies with "'schemathesis' is a package and
  // cannot be directly executed" — a non-zero exit with no report written,
  // which this gate correctly reports as UNAVAILABLE rather than a failure,
  // but which is nonetheless a caller bug. Both declared console scripts
  // (`schemathesis`, `st`) resolve to `schemathesis.cli:schemathesis`; using
  // the module path avoids depending on either being on PATH.
  return { command: 'python3', args: ['-m', 'schemathesis.cli', ...gateArgs] };
}
