/**
 * Equivalence pairs — the SERVICE family (plan
 * `bash-to-tool-substitution-2026-07-26`, P-009).
 *
 * Population in the 7d corpus: 709 `systemctl` atoms across 50 sessions, 493
 * `curl` across 51, and 138 socket queries (`ss` 100 / `lsof` 38 / `netstat` 2)
 * across ~30. Proposed replacements: `dev:service_health` (read) and
 * `dev:restart` (write).
 *
 * ── The capability envelope, read from the tools ─────────────────────────────
 * `dev:service_health` takes `z.object({})` — NO arguments at all. It returns a
 * FIXED payload:
 *   • `services[]` — one probe per entry in `HEALTH_ENDPOINTS` plus four
 *     portless/opt-in probes. Only these carry an `up` verdict:
 *       operator (http://127.0.0.1:3070/api/desktop/version)
 *       vite (:3055, onDemand) · embed-sidecar (:3384, opt-in)
 *       desktop · bg-host-ticker · bg-host-code · substrate-sidecar (portless)
 *   • `supervision[]` — one row per `SUPERVISED_PROCESSES` entry, carrying
 *     `flapState` / `restartsLast10m` / `consecutiveProbeFailures` /
 *     `secondsSinceStart` — restart CHURN — PLUS, for `systemd-user` rows,
 *     systemd's `ActiveState` verbatim as `activeState`, the `healthy` verdict
 *     (WI-6149), and the raw `active` boolean. OMITTED means the probe genuinely
 *     could not tell and must never be read as "down".
 *     ⚠ The churn fields are currently ALWAYS zero/'ok' for every unit: they are
 *     read from the reconciler's module singleton, and the reconciler has never
 *     been armed (EI-18746253391734322 — no `supervision-reconcile` routines
 *     row). `activeState`/`healthy`/`active` ARE real (the tool overlay execs
 *     systemctl per call). Do not score coverage against the churn fields.
 *
 * ⚠ HISTORY, because the original verdict rests on it: this block used to carry
 * NO up-or-down field at all, and a stopped unit was indistinguishable from a
 * failed probe (both left `secondsSinceStart` undefined). That was D-010 item 2
 * and it has been FIXED — `active` is added by the tool's overlay
 * (`SupervisionStatusEntryWithRecency`), NOT by `unit-reconciler`'s own type,
 * which is why grepping the reconciler still makes it look like an open gap.
 *
 * The practical consequence TODAY: `papercup-dev-api` (→ `operator`),
 * `papercup-staging-api` (→ `staging-api`, added by WI-6146), `papercup-bg-host`
 * (→ `bg-host-ticker`), `papercup-embed-sidecar` (→ `embed-sidecar`) and
 * `papercup-oddsmith-sidecar` (→ `oddsmith-sidecar`, added by WI-6149) have a
 * liveness answer from a PROBE. `papercup-inference-gateway`,
 * `papercup-mcp-proxy` and `papercup-live-federation-gate` remain supervised but
 * unprobed — they get a determinate `activeState` + `healthy` from systemd, which
 * IS a faithful answer to `is-active` (WI-6149 scores them covered on that
 * basis — see `SUPERVISED_BUT_UNPROBED`), but no HTTP probe, so nothing confirms
 * they are actually SERVING. That serving gap belongs to `curlHealthProbe`.
 *
 * ⚠ MODEL DRIFT: the constants below are a hand-written MODEL of that tool, and
 * nothing in the equivalence machinery reads the real `HEALTH_ENDPOINTS`. The
 * `expectedVerdict` latch does NOT catch a tool that was widened without
 * updating this model — it only catches a model changed without updating the
 * verdict. `pairs/service-model-drift.test.ts` (WI-6153) is the guard that
 * closes that hole; keep it green rather than routing around it.
 *
 * `dev:restart` takes `target: 'dev' | 'staging' | 'gateway' | 'bg-host' |
 * 'embed-sidecar'` and only ever RESTARTS (`systemctl --user restart <unit>`);
 * there is no start, no stop, no daemon-reload, no reset-failed.
 *
 * ── What the corpus asks for, bucketed by QUESTION ───────────────────────────
 * systemctl (709 atoms), by verb:
 *   234 (33.0%)  inventory / schedule   `list-timers` (174), `list-units` (60)
 *   188 (26.5%)  unit CONFIG            `show -p …` (122), `cat` (60), `list-unit-files` (3)
 *   145 (20.5%)  state + journal tail   `status`
 *    93 (13.1%)  boolean liveness       `is-active` (89), `is-failed` (4)
 *    41 ( 5.8%)  lifecycle WRITE        `restart` (32), `start` (5), `stop` (4)
 *     8 ( 1.1%)  other                  `daemon-reload`, `reset-failed`, …
 *
 * Only the fourth bucket is the question `dev:service_health` is shaped to
 * answer, and only the fifth is `dev:restart`'s. Three of the five name a
 * capability neither tool has at all — `systemctl show -p NRestarts`,
 * `systemctl cat`, and `systemctl list-timers` have no tool form whatsoever,
 * and together they are 422 atoms, 59% of the family.
 *
 * ── Three pairs, drawn on the intent boundaries ──────────────────────────────
 * Per D-008 the pattern is the unit of enforcement, so each pair claims exactly
 * one question:
 *   `service.systemctl-is-active`  — is this unit up? (boolean liveness)
 *   `service.curl-health-probe`    — is this local port answering?
 *   `service.listening-ports`      — what is listening / who owns this port?
 *
 * Two candidate pairs were considered and deliberately NOT written:
 *
 *   `systemctl status` (145 atoms) is EXCLUDED from the liveness pair rather
 *   than folded into it. `status` returns ActiveState AND the unit's last
 *   journal lines, and 21 of its distinct shapes pass `-n <N>` asking for
 *   exactly those lines. `dev:service_health` returns no journal at all, so
 *   enforcing a liveness advisory over `status` would answer a question the
 *   agent did not ask. That bucket routes to P-013 (unit coverage) and P-023
 *   (`logs:read`), not here. This narrowing does not flatter the verdict: the
 *   pair lands `needs-widening` either way, because most probed units have no
 *   liveness answer regardless of which verb asked.
 *
 *   `systemctl restart|start|stop` → `dev:restart` earned NO pair, because the
 *   corpus cannot support one: 41 atoms but only **11 distinct shapes** across 9
 *   sessions, under `MIN_SAMPLE_SIZE`, so `auditPair` rightly refuses a verdict.
 *   That scarcity is itself the finding — see `SERVICE_LIFECYCLE_WRITE_FINDING`.
 */

import type { CoverageResult, BashSubstitutionPair } from '../types';

/**
 * Local ports `dev:service_health` actually probes, with the `services[]` entry
 * each one reports as. Duplicated from `HEALTH_ENDPOINTS` /
 * `probeEmbedSidecar` deliberately — this is a MODEL of the tool used to score
 * coverage, and if the real endpoint list changes the recomputed verdict must
 * change with it rather than silently tracking a shared constant. The
 * `expectedVerdict` latch is what surfaces the divergence.
 */
export const PROBED_PORTS: Record<string, string> = {
  '3070': 'operator',
  '3055': 'vite',
  '3384': 'embed-sidecar',
  // WI-6146 added this to HEALTH_ENDPOINTS; the model must follow or the audit
  // scores against a tool that no longer exists. `service-model-drift.test.ts`
  // is what forces that now — see the note on MODEL DRIFT below.
  '3170': 'staging-api',
  // WI-6149 (D-010 item 4): the oddsmith sidecar's Hono port, pinned in its unit
  // file as `ODDSMITH_HONO_PORT=46229`. Named in `curlHealthProbe`'s header as
  // one of the unprobed ports the corpus curls — now probed.
  '46229': 'oddsmith-sidecar',
};

/**
 * systemd units whose liveness `dev:service_health` can actually answer, and the
 * `services[]` probe that answers it. Note NONE of these is answered by the
 * `supervision[]` block — they are answered because something probes them.
 */
export const UNIT_TO_PROBE: Record<string, string> = {
  'papercusp-dev-api': 'operator',
  'papercup-dev-api': 'operator',
  'papercusp-bg-host': 'bg-host-ticker',
  'papercup-bg-host': 'bg-host-ticker',
  'papercup-embed-sidecar': 'embed-sidecar',
  // WI-6146: staging-api is now genuinely probed (:3170), so `is-active
  // papercusp-staging-api` HAS a faithful tool expression. The papercup-* key
  // remains as a compatibility alias while the installed unit exposes both.
  'papercusp-staging-api': 'staging-api',
  'papercup-staging-api': 'staging-api',
  // WI-6149 (D-010 item 4): the single most-asked-about unit in this pair's
  // corpus that had no answer at all (73 `is-active` atoms). Now probed on
  // :46229 with 2-tick flap damping — see `ODDSMITH_SIDECAR_DOWN_CONFIRM_TICKS`.
  'papercup-oddsmith-sidecar': 'oddsmith-sidecar',
};

/**
 * Units that ARE in `SUPERVISED_PROCESSES` but have no HTTP probe.
 *
 * ⚠ WI-6149 RECLASSIFIED these as COVERED for THIS pair, and the reason matters
 * because it moves the score. The old `cover()` reason claimed the tool "returns
 * a supervision row with flap counters and no up/down field" — that sentence was
 * already false when it was written: this file's own header records that
 * `active` had been added by the tool overlay (D-010 item 2, WI-6146). The model
 * carried a stale failure reason and scored against it, which is the same defect
 * class as the false "there is no tool form" advisory item 3 removed from
 * `listeningPorts`.
 *
 * The test that settles it is the pair's own scoping rule: does the tool answer
 * THE QUESTION THE ATOM ASKED? `systemctl is-active <unit>` asks systemd for
 * `ActiveState`; `supervision[].activeState` returns that same string verbatim
 * for every registered systemd-user unit, plus `healthy` (the same oracle the
 * reconciler acts on). That is a faithful, complete answer. "Nothing confirms it
 * is actually SERVING" is a DIFFERENT question — `curlHealthProbe` owns it — and
 * folding it in here would enforce an advisory against a question the agent did
 * not ask, which is exactly the reasoning this file uses to exclude `systemctl
 * status`. Consistency has to cut both ways.
 *
 * The set is KEPT (not deleted) because it is still the right distinction for the
 * serving question, and because the remedy for these differs from an unregistered
 * unit's: they need a PROBE, not registration.
 */
export const SUPERVISED_BUT_UNPROBED = new Set([
  // NOTE: `papercup-staging-api` used to head this list. WI-6146 gave it a real
  // probe (:3170), so it now lives in UNIT_TO_PROBE instead. Its removal is the
  // single largest coverage change this family has seen — staging-api was the
  // most-asked-about unit in the corpus (34 is-active/status reads in 7d).
  'papercup-inference-gateway',
  'papercup-mcp-proxy',
  'papercup-live-federation-gate',
  'papercup-live-federation-gate.timer',
]);

/**
 * WI-6149: the `supervision[].name` each unprobed-but-registered UNIT reports as.
 * Needed so `cover()`'s `expression` names the field an agent would actually read
 * — `supervision[]` is keyed by the registry's `name`, not by the systemd unit, and
 * emitting the unit there would be a wrong expression on a correct `covered` (the
 * quieter half of the D-001 failure mode, per `listeningPorts`' item-3 fix).
 * `service-model-drift.test.ts` asserts this covers SUPERVISED_BUT_UNPROBED exactly
 * and that every value is a real registry row name.
 */
export const SUPERVISION_ROW_NAME: Readonly<Record<string, string>> = {
  'papercup-inference-gateway': 'inference-gateway',
  'papercup-mcp-proxy': 'mcp-proxy',
  'papercup-live-federation-gate': 'live-federation-gate',
  'papercup-live-federation-gate.timer': 'live-federation-gate-timer',
};

function supervisionNameFor(unit: string): string {
  return SUPERVISION_ROW_NAME[unit] ?? unit;
}

/**
 * WI-6149 (D-010 item 4): why each DELIBERATELY-excluded unit is excluded.
 *
 * A generic "outside the registry" reason is not good enough here, because the
 * reason string is what the registry stores and what an agent reads — and these
 * four units are not oversights awaiting registration, they are four DIFFERENT
 * structural impossibilities, each settled with a measurement. Telling an agent
 * "not registered" invites the next one to register it; telling it "this is a
 * timer-driven oneshot, liveness is the wrong question" does not.
 *
 * The reason CODES are duplicated from `service-health.ts`'s `NON_PROBED_UNITS`
 * rather than imported, for the same reason `PROBED_PORTS` duplicates
 * `HEALTH_ENDPOINTS`: this file is a MODEL, and a shared constant would let the
 * model track a tool change silently instead of forcing a re-score.
 * `service-model-drift.test.ts` asserts the two sets agree.
 *
 * A key ending in `*` is a PREFIX match — the green-checkpoint units carry a
 * per-run random suffix, which is the whole reason they are here.
 */
export const EXCLUSION_REASON: Readonly<Record<string, string>> = {
  'papercup-green-checkpoint-manual-*':
    'is a per-run TRANSIENT unit (systemd-run --unit= with a random suffix), so no static registry can ever name it — "is my checkpoint run still going?" is run-scoped, not health-scoped',
  'papercusp-db-backup':
    'is a timer-driven ONESHOT (measured: 152s active per 3600s), deliberately excluded — `inactive` is its healthy state, and the last-run RESULT it is really being asked about is served by papercup-backup-health + STATUS.json + papercusp-db-backup-alert, not by a liveness probe',
  auditd:
    'is a SYSTEM-scope unit; the supervision registry and its reconciler are `systemctl --user` only (SupervisionLayer has no systemd-system member), so it cannot be represented without a new layer + a second exec path',
  pgbouncer:
    'is a SYSTEM-scope unit; the supervision registry and its reconciler are `systemctl --user` only (SupervisionLayer has no systemd-system member), so it cannot be represented without a new layer + a second exec path',
  fail2ban:
    'is NOT INSTALLED on this host (LoadState=not-found) — probing an absent unit is the permanent phantom-DOWN class that got :3001 and :4321 removed (EI-188 / EI-276)',
  crowdsec:
    'is NOT INSTALLED on this host (LoadState=not-found) — probing an absent unit is the permanent phantom-DOWN class that got :3001 and :4321 removed (EI-188 / EI-276)',
};

/** The documented exclusion reason for a unit, or null when it is genuinely unknown. */
export function exclusionReasonFor(unit: string): string | null {
  const exact = EXCLUSION_REASON[unit];
  if (exact) return exact;
  for (const [key, reason] of Object.entries(EXCLUSION_REASON)) {
    if (key.endsWith('*') && unit.startsWith(key.slice(0, -1))) return reason;
  }
  return null;
}

/**
 * WI-6149: units named by an atom BEYOND the first — `systemctl` accepts a unit
 * LIST (`is-active fail2ban crowdsec`) and `systemctlUnit` only ever returns the
 * head. Returns the tail (empty for the normal single-unit shape). Applies the
 * same token filter as `systemctlUnit`, so redirects/flags/globs never count as
 * units; a `$(…)`/glob token stops the scan rather than being reported as a unit
 * name, matching `systemctlUnit`'s own refusal to resolve one.
 */
export function additionalUnits(atom: string): string[] {
  const match = /^systemctl\s+((?:--?\S+\s+)*)(\S+)\s*(.*)$/.exec(atom);
  if (!match) return [];
  const units: string[] = [];
  for (const token of match[3].trim().split(/\s+/)) {
    if (!token) continue;
    if (token.startsWith('-')) continue;
    if (/^[$|>&]/.test(token) || /^\d?>/.test(token)) continue;
    if (token.includes('*')) break;
    units.push(normalizeUnit(token));
  }
  return units.slice(1);
}

/** Strip `.service`, a trailing redirect, and quoting from a unit token. */
function normalizeUnit(raw: string): string {
  return raw
    .replace(/^["']|["']$/g, '')
    .replace(/\.service$/, '')
    .trim();
}

/**
 * The unit a `systemctl <verb> …` atom names: the first token after the verb
 * that is not a flag, a redirect, or a shell fragment. Returns null when the
 * atom names no resolvable unit (a glob, a `$(…)` substitution, a bare verb).
 */
export function systemctlUnit(atom: string): string | null {
  const match = /^systemctl\s+((?:--?\S+\s+)*)(\S+)\s*(.*)$/.exec(atom);
  if (!match) return null;
  for (const token of match[3].trim().split(/\s+/)) {
    if (!token) continue;
    if (token.startsWith('-')) continue;
    if (/^[$|>&]/.test(token) || /^\d?>/.test(token)) continue;
    if (token.includes('*')) return null;
    return normalizeUnit(token);
  }
  return null;
}

/** The `http://host:port/path` a curl atom targets, if it has one. */
export function curlTarget(atom: string): { port: string; path: string } | null {
  const match = /https?:\/\/(?:127\.0\.0\.1|localhost)(?::(\d+))?(\/[^\s'"`]*)?/.exec(atom);
  if (!match) return null;
  return { port: match[1] ?? '80', path: match[2] ?? '/' };
}

/** curl was told to throw the response body away — it wants only liveness. */
const DISCARDS_BODY = /-o\s*\/dev\/null\b/;

/**
 * P-014: the `curlHealthProbe` pattern, DERIVED from `PROBED_PORTS` so the
 * claim and the model cannot drift apart. See the pair's header for why this is
 * computed rather than written out.
 *
 * The `-o /dev/null` LOOKAHEAD (rather than a `cover()` rejection) is what makes
 * the pair claim only the liveness question; the body-reading majority is
 * `HEALTH_PAYLOAD_FINDING`'s.
 */
export function buildProbedPortCurlPattern(ports: string[] = Object.keys(PROBED_PORTS)): RegExp {
  const alt = [...ports].sort().join('|');
  return new RegExp(
    `^curl\\b(?=[^\\n]*-o\\s*/dev/null\\b)[^\\n]*https?://(?:127\\.0\\.0\\.1|localhost):(?:${alt})/(?:api/)?(?:health|version)\\b`,
  );
}

/**
 * The systemd manager an atom is really asking. THREE-valued, not a boolean —
 * the `logs:read` lesson (P-023), and the corpus corroborates it here too:
 * `systemctl` with NEITHER flag defaults to `--system`, and every flagless atom
 * in this family names a genuine system unit (`auditd`, `ufw`, `fail2ban`,
 * `crowdsec`). Modelling flagless as "user" would have scored those against a
 * manager that cannot hold the answer.
 */
export function systemctlScope(atom: string): 'user' | 'system' {
  return /(?:^|\s)--user\b/.test(atom) ? 'user' : 'system';
}

/**
 * P-009 / P-014 — "is this unit up?" → `dev:service_health`.
 *
 * Scoped to the boolean-liveness verbs (`is-active`, `is-failed`) for the reason
 * given in the header: `status` additionally asks for the journal tail, which
 * this tool cannot produce, so folding it in would enforce an advisory against a
 * question the tool does not answer.
 *
 * ── RE-DERIVED 2026-07-27 (P-014, WI-6244): the TOOL widened ────────────────
 * This is the one pair in the family whose residue was NOT a different question.
 * `systemctl is-active <anything>` and `systemctl is-active papercup-dev-api`
 * ask the SAME question about different subjects, so narrowing the pattern to
 * the registry would not have been honest bookkeeping — it would have hidden a
 * real gap. It was also not possible: the narrowed pattern claims only **19
 * distinct shapes**, below `MIN_SAMPLE_SIZE`, and `auditPair` rightly refuses a
 * verdict there. Narrowing could not have closed this verdict at all.
 *
 * So the tool widened instead: `dev:service_health { units:[…], scope }` now
 * answers `is-active`/`is-failed` for ANY unit, in either manager, several at a
 * time (`probeUnitStates`). That takes the UNCHANGED pattern from 64/114 to
 * **114/114 = `equivalent`** across 39 distinct shapes and 23 sessions.
 *
 * ⚠ WHY THIS WAS WORTH BUILDING RATHER THAN CONCEDING — the widening fixed a
 * WRONG ANSWER, not just a missing one. `systemctl is-active <unit-that-does-
 * not-exist>` prints `inactive` (exit 4), and three units in this corpus —
 * `papercup-auto-deploy`, `papercup-green-checkpoint`, `papercup-pgbouncer` —
 * are `LoadState=not-found` in BOTH scopes on this host. Every atom querying
 * them captured stdout with `2>&1` / `2>/dev/null` and none read the exit code,
 * so agents asked about a phantom unit and read back "inactive": byte-identical
 * to a real service that is stopped. `unitStates[].known` + `unitsUnknown[]`
 * separate them. That is the same class as `logs:read`'s `unitsUnknown` and
 * `dev:listening_ports`' `ownerVisible` — ABSENT EVIDENCE MUST NEVER READ AS
 * EVIDENCE OF ABSENCE.
 *
 * `UNIT_TO_PROBE` / `SUPERVISED_BUT_UNPROBED` are KEPT and still consulted
 * first, because they name a STRONGER answer than `unitStates` (a real HTTP
 * probe, or the reconciler's own `healthy` verdict, versus systemd's raw
 * ActiveState). `EXCLUSION_REASON` is kept for the same reason it was written:
 * it documents why a unit cannot be REGISTERED, which is still true and is a
 * different claim from "the tool cannot report its state".
 */
export const systemctlIsActive: BashSubstitutionPair = {
  id: 'service.systemctl-is-active',
  intentLabel: 'unit-liveness-query',
  bashPattern: /^systemctl\s+(?:--\S+\s+)*(?:is-active|is-failed)\b/,
  toolName: 'dev:service_health',
  advisoryText:
    'dev:service_health { units:[…], scope:\'user\'|\'system\'|\'all\' } answers is-active/is-failed for ANY unit — pass several at once, and pass scope:\'system\' for auditd/ufw/pgbouncer (a bare `systemctl` defaults to system, `--user` does not). READ unitsUnknown[] FIRST: systemd prints `inactive` for a unit it has never heard of, byte-identical to a stopped one, and three units agents queried in the last week do not exist on this host at all. For a REGISTERED unit the snapshot is richer than ActiveState: services[].up is a real HTTP probe (papercusp-dev-api :3070, staging-api :3170, bg-host, embed-sidecar :3384, oddsmith-sidecar :46229, vite :3055), and supervision[].healthy is the reconciler\'s own verdict — an `episodic` timer-driven unit is idle, not down, while inactive.',
  routing: {
    want: 'whether a systemd unit is active / failed',
    use: '`dev:service_health { units:["<unit>"], scope }` — unitStates[].{loadState,activeState,active,failed} for any unit, plus unitsUnknown[] for ones systemd does not know; services[].up / supervision[].healthy for registered units',
    insteadOf: '`systemctl --user is-active <unit>` — note it prints `inactive` for a unit that does not exist, which the tool reports as unitsUnknown instead',
  },
  expectedVerdict: 'equivalent',
  cover(atom: string): CoverageResult {
    const unit = systemctlUnit(atom);
    if (!unit) {
      // A glob or `$(…)` names no unit the caller can pass in `units`, which is
      // a literal list. This is the one shape that stays in bash — and it is
      // kept as a real branch, not deleted, because the corpus will eventually
      // contain one.
      return {
        covered: false,
        reason: 'names no resolvable unit (glob or shell substitution); `units` takes literal unit names',
      };
    }
    const scope = systemctlScope(atom);
    // MULTI-UNIT (`systemctl is-active fail2ban crowdsec`) is now EXPRESSIBLE —
    // `units` is an array and `probeUnitStates` issues one exec for the whole
    // list. Before the widening this was rejected outright, which was wrong even
    // then for the observed `is-active papercup-dev-api papercup-staging-api`:
    // BOTH units were probed, so one snapshot already answered it.
    const all = [unit, ...additionalUnits(atom)];
    if (all.length > 1) {
      return {
        covered: true,
        expression: `dev:service_health { units: [${all.map((u) => `'${u}'`).join(', ')}], scope: '${scope}' } → unitStates[].{active,failed}, unitsUnknown`,
      };
    }
    // A registered unit has a STRONGER answer than raw ActiveState, so prefer
    // it — an HTTP probe actually confirms the unit is SERVING, which
    // `unitStates` deliberately does not claim (see SUPERVISED_BUT_UNPROBED).
    const probe = UNIT_TO_PROBE[unit];
    if (probe) {
      return { covered: true, expression: `dev:service_health → services.find(s => s.name === '${probe}').up` };
    }
    if (SUPERVISED_BUT_UNPROBED.has(unit)) {
      return {
        covered: true,
        expression: `dev:service_health → supervision.find(s => s.name === '${supervisionNameFor(unit)}').{activeState,healthy}`,
      };
    }
    // WI-6149's exclusion reasons are still TRUE and still worth carrying — they
    // say why a unit cannot be REGISTERED — but they no longer make the atom
    // uncoverable, because `units` reaches a unit without registering it. The
    // reason rides along in the expression so the distinction survives.
    const excluded = exclusionReasonFor(unit);
    return {
      covered: true,
      expression:
        `dev:service_health { units: ['${unit}'], scope: '${scope}' } → unitStates[0].{loadState,active,failed}` +
        (excluded ? ` (unregistered by design: ${unit} ${excluded})` : ''),
    };
  },
};

/**
 * The health-payload finding: the DOMINANT curl intent has no tool form.
 *
 * P-014 narrowed `curlHealthProbe` to body-DISCARDING probes, which is honest —
 * but the residue it drops is not small and must not vanish silently. Of 138
 * loopback health/version curls in the 7d corpus, **79 (57%) read the response
 * BODY** (no `-o /dev/null`): `/api/health` for pool state and queue depths,
 * `/api/version` for the build sha, `/api/health/analyst` and
 * `/api/health/ingestion` on the oddsmith sidecar. `dev:service_health` returns
 * its OWN diagnostic shape and never the probed service's payload, so this is a
 * genuinely different question, not a coverage gap in the pair.
 *
 * Recorded rather than fixed because the fix is a design decision, not a
 * widening: either the tool grows a `body: true` passthrough (and inherits every
 * probed service's payload schema), or the intent stays in bash. Neither should
 * be decided by a pattern that quietly claims it.
 */
export const HEALTH_PAYLOAD_FINDING = {
  pattern: /^curl\b(?![^\n]*-o\s*\/dev\/null)[^\n]*https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/(?:api\/)?health/,
  atoms: 79,
  sessions: 19,
  verdictWithheld: 'a different question — dev:service_health never returns the probed service\'s own payload',
  note: 'the majority curl intent is READ THE HEALTH BODY, not "is it up". No tool form today; a `body:true` passthrough is the open design question.',
} as const;

/**
 * P-009 — "is this local port answering?" → `dev:service_health`.
 *
 * ── NARROWED 2026-07-27 (P-014, WI-6244) ────────────────────────────────────
 * Both failure axes named below were re-measured against the whole corpus
 * (138 atoms, not the 24-atom sample) and both turned out to be shapes the tool
 * DELIBERATELY declines rather than shapes it is missing:
 *   • 79 read the BODY — a different question entirely (`HEALTH_PAYLOAD_FINDING`);
 *   • 17 target a port outside the fixed probe set (:3270, :8788, :18071/2,
 *     :17701, :15070) — mostly ad-hoc second instances and A/B sidecars, and the
 *     advisory ALREADY says "keep using curl" for them.
 * Claiming either and then failing it scored the pair `needs-widening` for
 * behaving exactly as documented. Requiring `-o /dev/null` AND a probed port
 * takes it to **42/42 = `equivalent`** (26 distinct shapes, 13 sessions).
 *
 * ⚠ The port list in the pattern is BUILT FROM `PROBED_PORTS`, not hand-written.
 * A hand-written list is a second model of the same tool and would drift the
 * moment `HEALTH_ENDPOINTS` gains a port — precisely the staleness class D-016's
 * drift guards exist to catch. Deriving it means adding a probe automatically
 * widens the claim, the frozen fixture stops matching, and the `expectedVerdict`
 * latch forces a re-score. That is the designed behaviour, not a surprise.
 *
 * :8788 (the inference gateway) was CONSIDERED for a probe and deliberately not
 * added: every corpus atom hitting it passes `-H 'authorization: Bearer …'`, so
 * an unauthenticated probe would 401 and manufacture a permanent phantom-DOWN —
 * the exact class that got :3001 and :4321 removed (EI-188 / EI-276).
 *
 * The two original axes, kept for the record:
 *   • the PORT is not probed (`:3170` staging, `:3270`, `:8788` gateway,
 *     `:46229`, `:18071`…) — the tool has no argument to add one; and
 *   • the BODY is wanted, not the status code. `curl … /api/health` without
 *     `-o /dev/null` is read for its payload (pool state, build sha, queue
 *     depths); `dev:service_health` returns its OWN diagnostic shape and never
 *     that body, so substituting it silently answers a different question.
 *
 * `:3170` is the sharpest single finding in this family. `CLAUDE.md` instructs
 * every agent to verify a staging edit by restarting `:3170` and probing it —
 * and `:3170` is not in `HEALTH_ENDPOINTS`, so the documented workflow has no
 * tool form and 80 curl atoms went to bash because there was nowhere else to go.
 */
export const curlHealthProbe: BashSubstitutionPair = {
  id: 'service.curl-health-probe',
  intentLabel: 'local-service-health-probe',
  bashPattern: buildProbedPortCurlPattern(),
  toolName: 'dev:service_health',
  advisoryText:
    'dev:service_health probes a FIXED set (operator :3070, staging-api :3170, vite :3055, embed-sidecar :3384, oddsmith-sidecar :46229) and returns up/latency per service — no url/port argument, and never the probed service\'s own /api/health body. :3170 IS covered, so the CLAUDE.md verify-a-staging-edit workflow (dev:restart{target:"staging"} then check staging-api) needs no curl. Keep using curl for an UNPROBED port (:8788 gateway, an ad-hoc second instance) and whenever you actually READ the health payload — that payload is a different question and this tool does not carry it.',
  routing: {
    want: 'whether a local dev service is answering',
    use: '`dev:service_health` — for the probed set (incl. :3170 staging), when you need only up/down',
    insteadOf: '`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:<port>/api/health` — still required for :8788 and other unprobed ports, and whenever you read the body',
  },
  expectedVerdict: 'equivalent',
  cover(atom: string): CoverageResult {
    const target = curlTarget(atom);
    if (!target) {
      return { covered: false, reason: 'no resolvable loopback URL; dev:service_health takes no url argument' };
    }
    const probed = PROBED_PORTS[target.port];
    if (!probed) {
      return {
        covered: false,
        reason: `probes :${target.port}, which dev:service_health does not probe — it has no port/url argument to add one`,
      };
    }
    if (!DISCARDS_BODY.test(atom)) {
      return {
        covered: false,
        reason: `reads the ${target.path} response BODY; dev:service_health returns its own diagnostic payload, never that body`,
      };
    }
    return { covered: true, expression: `dev:service_health → services.find(s => s.name === '${probed}').up` };
  },
};

/**
 * P-009 / P-013 D-017 — "what is listening / who owns this port?" →
 * `dev:listening_ports`.
 *
 * ── RE-DERIVED 2026-07-26 (WI-6149 item 3) ──────────────────────────────────
 * This pair used to point at `dev:service_health` with a `not-a-substitute`
 * verdict and an advisory reading "there is no tool form for ss/lsof/netstat
 * today; keep using them". D-017 built one — `dev:listening_ports` — so that
 * advisory became FALSE, and a false advisory is exactly the staleness shape
 * D-016's drift guards exist to catch. The tripwire the old comment promised
 * ("if P-013 later adds a socket table and this pair is re-derived, that branch
 * is where coverage will start appearing") is now cashed in.
 *
 * MEASURED 15/24 → `needs-widening` (was 0/24 → `not-a-substitute`).
 *
 * The residue is the interesting part, and MEASURING it corrected the guess
 * this comment first carried. All NINE misses are a SINGLE axis — socket STATE:
 *
 *   • 4× all-states ss/netstat (`ss -tn`, `ss -tinp`, `ss -tin dst …`,
 *     `netstat -an -p tcp`) — no `-l`, so the question is about ESTABLISHED
 *     connections, which this tool cannot see.
 *   • 5× lsof without `-sTCP:LISTEN` (`lsof -i :3270`, `-iTCP:8044`, …) — lsof
 *     prints established rows for the port too, so a LISTEN-only reply is a
 *     subset, not a substitute.
 *
 * MULTI-PORT lsof (`-iTCP:3070 -iTCP:19045 -iTCP:3170`) is genuinely
 * inexpressible — `port` is a scalar — but it is NOT independently observable
 * here: both multi-port atoms in the sample ALSO omit `-sTCP:LISTEN`, so the
 * state check rejects them first. The branch is kept and unit-tested directly,
 * because the corpus will eventually contain a `-sTCP:LISTEN` multi-port shape
 * and a verdict that only holds while a second defect masks it is not a
 * verdict. Do not delete it as dead code.
 *
 * ── NARROWED 2026-07-27 (P-014, WI-6244) ────────────────────────────────────
 * The intermediate state above is now cashed in. The residue it named was
 * re-measured against the whole 7d corpus rather than the 24-atom sample, and
 * it is still exactly ONE axis and nothing else: of 149 claimed atoms, the 49
 * misses are 37 ss/netstat without `-l` (all-states), 11 lsof without
 * `-sTCP:LISTEN`, and 1 UDP. Every one of them asks about ESTABLISHED
 * connections or UDP — a DIFFERENT QUESTION from "what is listening", which is
 * this pair's whole `intentLabel`. So the pattern was over-claiming, and the
 * fix is the narrowing D-008 prescribes, not a widening: requiring listen-ness
 * takes the pair from 100/149 to **100/100 = `equivalent`** (21 distinct
 * shapes, 29 sessions) without the tool changing at all.
 *
 * This is the P-023 lesson applied a second time: a shape the tool DELIBERATELY
 * declines is not a shape it is MISSING, and failing it in `cover()` scores a
 * family `needs-widening` for working as designed. The `cover()` state checks
 * below are KEPT anyway, as an anti-rot backstop — if the pattern is ever
 * loosened, they fail loudly instead of the pair silently claiming a question
 * the tool answers with a wrong subset.
 *
 * What the narrowing DROPS is recorded, not discarded — see
 * `SOCKET_STATE_FINDING`: the established-connection question has no tool form
 * at all, and it is a third of this family.
 *
 * `^ss(?:\s+-|\s*$)` rather than `^ss\b`: the corpus contains JavaScript
 * heredocs with `ss._blocked=true` and `ss=makeStore()`, which `\b` happily
 * matched. The harness surfaced them as "atoms" the first time this pattern ran
 * — a pattern that claims a language's variable names is not claiming an
 * intent. Requiring a FLAG (or nothing at all) after the verb is what separates
 * the two: every one of the 16 distinct real `ss` shapes in the corpus is
 * `ss -<flags>`, while an assignment is always followed by `=`.
 */
export const listeningPorts: BashSubstitutionPair = {
  id: 'service.listening-ports',
  intentLabel: 'listening-socket-query',
  // P-014: LISTEN-ness is part of the CLAIM, not something cover() rejects
  // after the fact. `ss`/`netstat` signal it with an `l` in a flag cluster that
  // also carries `t` (TCP) and not `u` (UDP); `lsof` signals it with
  // `-sTCP:LISTEN`. Requiring a FLAG token before the cluster also keeps the
  // old `^ss(?:\s+-…)` guard against the corpus's JavaScript `ss = makeStore()`
  // heredocs — a pattern that claims a language's variable names claims no
  // intent at all.
  bashPattern:
    /^(?:ss|netstat)\s+(?:-\S+\s+)*-(?=[a-zA-Z]*l)(?=[a-zA-Z]*t)(?![a-zA-Z]*u)[a-zA-Z]+\b|^lsof\b[^\n]*-sTCP:LISTEN\b/,
  toolName: 'dev:listening_ports',
  advisoryText:
    'dev:listening_ports { port } answers "what is bound here and which process owns it" — the structured ss/lsof/netstat answer, including a same-uid pid + command. Read ownerVisible before pid: a socket owned by ANOTHER user reports ownerVisible:false, which means bound-but-unreadable, not free. It reports TCP LISTEN only, so keep using bash for established connections and for a single call spanning several ports.',
  routing: {
    want: 'what is listening on a TCP port / which process owns it',
    use: '`dev:listening_ports { port }` (or `{ pid }` for the reverse lookup) — structured rows with pid, command and ownerVisible',
    insteadOf:
      '`ss -ltnp` / `lsof -nP -iTCP:<port> -sTCP:LISTEN` / `netstat -tlnp`. ⚠ LISTEN sockets only — an established-connection query (`ss -tn`, `netstat -an`) or one lsof call spanning several ports still needs bash',
  },
  expectedVerdict: 'equivalent',
  cover(atom: string): CoverageResult {
    // ── 1. Is this even a LISTEN query? ──────────────────────────────────────
    // The tool returns TCP sockets in LISTEN state and nothing else, so an
    // all-states query is a DIFFERENT question. Answering it with the listen
    // table is a confident wrong answer, which is the D-001 failure mode.
    //
    // Each verb signals listen-ness differently:
    //   ss / netstat → an `-l` in the flag cluster (`-ltn`, `-lptn`, `-tlnp`).
    //   lsof         → `-sTCP:LISTEN`; without it lsof prints ESTABLISHED rows
    //                  for the port too, and the tool's answer is a subset.
    const isLsof = /^lsof\b/.test(atom);
    const listenOnly = isLsof
      ? /-sTCP:LISTEN\b/.test(atom)
      : /(?:^|\s)-[a-zA-Z]*l[a-zA-Z]*\b/.test(atom);
    if (!listenOnly) {
      return {
        covered: false,
        reason: isLsof
          ? 'no -sTCP:LISTEN, so it also lists ESTABLISHED connections on the port; dev:listening_ports reports LISTEN sockets only'
          : 'no -l flag — this asks for connections in every state; dev:listening_ports reports LISTEN sockets only',
      };
    }

    // ── 2. UDP is out of scope entirely. ─────────────────────────────────────
    if (/(?:^|\s)-[a-zA-Z]*u[a-zA-Z]*\b/.test(atom) || /iUDP/i.test(atom)) {
      return { covered: false, reason: 'asks about UDP; dev:listening_ports reports TCP sockets only' };
    }

    // ── 3. A non-port/pid selector has no argument to carry it. ──────────────
    // `ss -tin dst 140.82.113.3` filters by PEER address; the tool's only
    // filters are `port` and `pid`.
    if (/\b(?:dst|src)\s+\S/.test(atom)) {
      return {
        covered: false,
        reason: 'filters by peer address (dst/src); dev:listening_ports filters only by port or pid',
      };
    }

    // ── 4. Several ports in ONE call. `port` is a scalar. ────────────────────
    // Count SELECTORS, not just literal numbers: `-iTCP:$p` is a port selector
    // whose operand is only known at runtime. Conflating it with "no selector"
    // is what made this branch first emit the whole-table expression for a
    // single-port query — a wrong expression on a correct `covered`, which is
    // the quieter half of the D-001 failure mode.
    const selectors = atom.match(/(?:iTCP:|sport\s*=\s*:)([^\s'"]+)/g) ?? [];
    const operands = [...new Set(selectors.map((t) => t.replace(/^(?:iTCP:|sport\s*=\s*:)/, '')))];
    const literalPorts = operands.filter((o) => /^\d{2,5}$/.test(o));
    if (operands.length > 1) {
      return {
        covered: false,
        reason: `spans ${operands.length} ports (${operands.join(', ')}) in one call; dev:listening_ports takes a single scalar \`port\``,
      };
    }

    // ── 5. Expressible. Name the actual call. ────────────────────────────────
    // A pid selector (`lsof -p "$APPID" -a -iTCP -sTCP:LISTEN`) is the reverse
    // lookup, served by `pid`. A shell-variable operand is still covered: the
    // agent already holds the value it interpolated.
    if (/(?:^|\s)-p\s+\S/.test(atom) && isLsof) {
      return { covered: true, expression: 'dev:listening_ports { pid } → sockets[].port' };
    }
    if (operands.length === 1) {
      const shown = literalPorts.length === 1 ? literalPorts[0] : `<${operands[0]}>`;
      return {
        covered: true,
        expression: `dev:listening_ports { port: ${shown} } → sockets[0].{pid,command,ownerVisible}`,
      };
    }
    return { covered: true, expression: 'dev:listening_ports {} → sockets[] (the whole LISTEN table, one row per port+address+command)' };
  },
};

/**
 * The lifecycle-WRITE finding, recorded as data because it earned no pair.
 *
 * `systemctl restart|start|stop` is 41 atoms / 11 distinct shapes / 9 sessions —
 * below `MIN_SAMPLE_SIZE`, so no verdict may be issued. What the shapes say is
 * more interesting than a verdict would have been:
 *
 *   • ZERO raw restarts of `papercup-dev-api` or `papercup-staging-api` in seven
 *     days, against 34 `is-active`/`status` reads of staging-api alone. Those are
 *     precisely the two units `CLAUDE.md` names in its "never shell out to a raw
 *     `systemctl --user restart`" rule, and the rule appears to have worked:
 *     the restart intent moved to `dev:restart` while the READ intent, which no
 *     rule mentions and no tool serves, stayed in bash. That is the P-019 thesis
 *     (prose that cannot drift from the gate) showing up in the corpus.
 *   • Of the 32 `restart` atoms, 28 target `papercup-oddsmith-sidecar` — not a
 *     `dev:restart` target — and 4 target `papercup-bg-host`, which is. So even
 *     the residue is mostly a unit the tool cannot name.
 *   • 9 of the 11 distinct shapes are `start`/`stop`, which `dev:restart` cannot
 *     express at all: its handler only ever runs `systemctl --user restart`.
 */
export const SERVICE_LIFECYCLE_WRITE_FINDING = {
  pattern: /^systemctl\s+(?:--\S+\s+)*(?:restart|start|stop)\b/,
  atoms: 41,
  distinctShapes: 11,
  sessions: 9,
  verdictWithheld: 'sample below MIN_SAMPLE_SIZE (20 distinct) — no verdict may be issued',
  note: 'restart intent already migrated to dev:restart; residue is oddsmith-sidecar (not a target) and start/stop (not expressible).',
} as const;

/**
 * The socket-STATE finding: what `listeningPorts`' P-014 narrowing dropped.
 *
 * `dev:listening_ports` reports TCP sockets in LISTEN state and nothing else,
 * so the narrowed pattern no longer claims the other third of the family — but
 * that third is real and has NO tool form at all: 49 atoms across 14 sessions
 * asking about ESTABLISHED connections (`ss -tn state established '( dport =
 * :5432 )'` — who is connected to Postgres/PgBouncer right now, the single
 * most common shape), `ss -s` (a socket summary), `lsof -i :<port>` without a
 * state filter, one UDP query, and multi-port `lsof -iTCP:a -iTCP:b`.
 *
 * Recorded rather than built because the question is genuinely different — a
 * connection census, not a bind table — and because deciding whether the tool
 * grows a `state` filter or a sibling verb is a design call that should be made
 * on this evidence, not smuggled in under a pattern that claims it.
 */
export const SOCKET_STATE_FINDING = {
  pattern: /^(?:ss|netstat)\s+(?!.*(?:^|\s)-[a-zA-Z]*l)|^lsof\b[^\n]*-{1,2}i(?![^\n]*-sTCP:LISTEN)/,
  atoms: 49,
  sessions: 14,
  verdictWithheld: 'a different question — dev:listening_ports reports LISTEN sockets only',
  note: 'established-connection census (dport :5432/:6432 dominates), ss -s summary, UDP, and multi-port lsof. No tool form; `state` filter vs sibling verb is the open design question.',
} as const;

/** Every pair in the service family, in registry order. */
export const SERVICE_PAIRS: BashSubstitutionPair[] = [systemctlIsActive, curlHealthProbe, listeningPorts];
