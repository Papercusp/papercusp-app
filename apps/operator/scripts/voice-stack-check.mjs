#!/usr/bin/env node
/**
 * Voice stack health check — one-shot server-side verification.
 *
 * Exercises every wired path I can hit without a browser, mic, or
 * speakers. Useful before/after deploys, in CI, as a sanity check the
 * wiring is intact. Doesn't replace a human turning voice on and
 * actually talking — that's the part only you can do.
 *
 *   node apps/operator/scripts/voice-stack-check.mjs
 *
 * Each check emits one of:
 *   ✓ PASS  — fully working
 *   ⚠ WARN  — degraded (e.g. table missing, dev-mode auth) but expected
 *   ✗ FAIL  — broken
 *
 * Exits 0 on all-pass, 1 on any FAIL, 0 with WARNs noted.
 *
 * Env (all optional, defaults shown):
 *   OPERATOR_BASE=http://localhost:3055
 *   PG_URL=postgres://harness_app:harness_app_pwd@localhost/papercusp
 *   AGENT_ID=<from voice-prefs>
 *   XI_API_KEY=<from credentials.json>
 */

import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { createHmac } from "node:crypto";
import postgres from "postgres";

const BASE = process.env.OPERATOR_BASE ?? "http://localhost:3055";
const PG_URL =
  process.env.PG_URL ??
  "postgres://harness_app:harness_app_pwd@localhost/papercusp";

const checks = [];
function pass(name, detail = "") {
  checks.push({ status: "PASS", name, detail });
}
function warn(name, detail = "") {
  checks.push({ status: "WARN", name, detail });
}
function fail(name, detail = "") {
  checks.push({ status: "FAIL", name, detail });
}

// Honor PAPERCUSP_WORKSPACES_ROOT before falling back to homedir() — a bare
// homedir() here resolves to a NESTED registry when this script runs with
// HOME remapped to a per-workspace dir (P-051 spawned-child case). See
// agent-insights/workspaces-root-vs-remapped-home and the same env-first
// resolver in @papercusp/operator-core's workspace-registry.ts /
// @papercusp/plugin-loader's workspacesRootDir().
const workspacesRoot =
  process.env.PAPERCUSP_WORKSPACES_ROOT?.trim() ||
  path.join(homedir(), ".papercusp-workspaces");

const credsPath = path.join(homedir(), ".papercusp", "credentials.json");
const prefsPath = path.join(
  workspacesRoot,
  process.env.PAPERCUSP_WORKSPACE ?? "default",
  ".papercusp",
  "system",
  "operator",
  "voice-prefs.json",
);

console.log(`[voice-stack-check] base=${BASE}\n`);

// ─── 1b. Kokoro service contract ───────────────────────────────────
// The optional VoiceMode compatibility service must never install packages or download model
// files on a hot restart. Keep this check at the live-stack boundary because the service lives
// outside the Papercusp repository and can be replaced by an upstream installer. The focused
// TypeScript contract test carries the same rules with richer fixtures; this checker makes drift
// visible before a live voice verdict.
const kokoroRoot = path.join(homedir(), ".voicemode", "services", "kokoro");
const kokoroContractPaths = {
  unit: path.join(homedir(), ".config", "systemd", "user", "voicemode-kokoro.service"),
  start: path.join(kokoroRoot, "start-gpu.sh"),
  startCommon: path.join(kokoroRoot, "start-common.sh"),
  provision: path.join(kokoroRoot, "provision-gpu.sh"),
  provisionCommon: path.join(kokoroRoot, "provision-common.sh"),
};
const kokoroContractMissing = Object.entries(kokoroContractPaths)
  .filter(([, file]) => !fs.existsSync(file))
  .map(([name]) => name);
if (kokoroContractMissing.length > 0) {
  const detail = `missing ${kokoroContractMissing.join(", ")} under ${kokoroRoot}`;
  (process.env.PAPERCUSP_VOICE_LIVE === "1" ? fail : warn)("3b. Kokoro service contract", detail);
} else {
  const unitText = fs.readFileSync(kokoroContractPaths.unit, "utf8");
  const startText =
    fs.readFileSync(kokoroContractPaths.start, "utf8") +
    "\n" +
    fs.readFileSync(kokoroContractPaths.startCommon, "utf8");
  const provisionText =
    fs.readFileSync(kokoroContractPaths.provision, "utf8") +
    "\n" +
    fs.readFileSync(kokoroContractPaths.provisionCommon, "utf8");
  const violations = [];
  if (!/^Restart=always\s*$/m.test(unitText)) violations.push("Restart=always");
  if (!/^RestartPreventExitStatus=.*\b(?:78|127)\b.*$/m.test(unitText)) violations.push("EX_CONFIG restart guard");
  if (/^\s*(?:Environment=)?(?:.*)?UVICORN_LIMIT_MAX_REQUESTS\s*=/im.test(unitText)) violations.push("25-request recycle knob");
  if (!/^\s*ConditionPathExists=.*kokoro-v1_0\.pth\s*$/m.test(unitText)) violations.push("model ConditionPathExists");
  if (/(?:uv\s+pip\s+install|pip(?:3)?\s+install|download_model\.py|\b(?:curl|wget)\b)/i.test(startText)) {
    violations.push("install/download in hot start");
  }
  if (!/\bexec\b[\s\S]*\buvicorn\b/i.test(startText)) violations.push("exec uvicorn");
  if (!/exit\s+78\b/.test(startText)) violations.push("exit 78 for missing prerequisites");
  if (!/(?:uv\s+)?pip(?:3)?\s+install/i.test(provisionText) || !/download_model\.py/i.test(provisionText)) {
    violations.push("explicit provision path");
  }
  violations.length === 0
    ? pass("3b. Kokoro service contract", "offline hot start; explicit provision path; exit-0 restart supervision")
    : fail("3b. Kokoro service contract", violations.join(", "));
}

// ─── 1. Local config files (with PG-loopback fallback post round-1 migration) ──
async function tryLoopbackCreds() {
  for (const port of [process.env.OPERATOR_PORT ?? "3070", "3070", "3055"]) {
    try {
      const r = await fetch(
        `http://127.0.0.1:${port}/api/agent-mcp/el-admin-creds`,
      );
      if (!r.ok) continue;
      const d = await r.json();
      return { apiKey: d.apiKey ?? null, agentId: d.agentId ?? null };
    } catch {
      /* try next */
    }
  }
  return null;
}
let xiKey =
  process.env.XI_API_KEY ??
  (() => {
    try {
      return JSON.parse(fs.readFileSync(credsPath, "utf8"))?.elevenlabs?.apiKey;
    } catch {
      return null;
    }
  })();
let agentId = process.env.AGENT_ID;
if (!agentId) {
  try {
    agentId = JSON.parse(fs.readFileSync(prefsPath, "utf8"))?.elevenLabsAgentId;
  } catch {
    /* ignore */
  }
}
if (!xiKey || !agentId) {
  const loop = await tryLoopbackCreds();
  if (!xiKey && loop?.apiKey) xiKey = loop.apiKey;
  if (!agentId && loop?.agentId) agentId = loop.agentId;
}
// A legacy API-key ID is metadata, not a secret credential. Treat it as
// unusable before any release check can send it to ElevenLabs. The product's
// central reader enforces the same boundary; this duplicate guard also covers
// legacy credentials.json files and operators older than that fix.
let invalidXiKey = false;
if (
  typeof xiKey === "string" &&
  (!xiKey.trim().startsWith("sk_") || xiKey.trim().length <= 3)
) {
  invalidXiKey = true;
  xiKey = null;
}
xiKey
  ? pass(
      "1. ElevenLabs API key",
      xiKey === process.env.XI_API_KEY
        ? "env"
        : fs.existsSync(credsPath)
          ? credsPath
          : "PG via loopback",
    )
  : warn(
      "1. ElevenLabs API key",
      invalidXiKey
        ? "legacy API-key ID is unusable; bootstrap + agent-fetch will be skipped until replaced"
        : "unset; bootstrap + agent-fetch will be skipped",
    );
agentId
  ? pass("2. EL agent id", agentId)
  : warn("2. EL agent id", "unset; agent-fetch will be skipped");

const personaPath = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "prompts",
  "operator.persona.md",
);
try {
  const txt = fs.readFileSync(personaPath, "utf8");
  if (txt.length < 500)
    fail("3. persona.md", `${txt.length} chars (expected ~4KB)`);
  else pass("3. persona.md", `${txt.length} chars`);
} catch (e) {
  fail("3. persona.md", `unreadable: ${e?.message ?? e}`);
}

// ─── 2. Operator endpoints ──────────────────────────────────────────
async function probe(name, url, opts = {}) {
  try {
    const r = await fetch(url, opts);
    if (!r.ok)
      return {
        ok: false,
        status: r.status,
        body: (await r.text().catch(() => "")).slice(0, 200),
      };
    return {
      ok: true,
      status: r.status,
      json: await r.json().catch(() => null),
      text: null,
    };
  } catch (e) {
    return { ok: false, status: 0, body: e?.message ?? String(e) };
  }
}

const harnessR = await probe("harness", `${BASE}/harness`);
harnessR.ok
  ? pass("4. /harness route", `${harnessR.status}`)
  : fail("4. /harness route", `${harnessR.status} ${harnessR.body}`);

const settingsR = await fetch(`${BASE}/settings/voice`).catch(() => null);
settingsR?.ok
  ? pass("5. /settings/voice route", "")
  : fail("5. /settings/voice route", `${settingsR?.status ?? "no-response"}`);

const prefsR = await probe(
  "prefs",
  `${BASE}/api/agent-mcp/operator-voice-prefs`,
);
let voicePrefs = null;
if (prefsR.ok) {
  const k = prefsR.json ?? {};
  voicePrefs = k;
  const v = (key) => (key in k ? "✓" : "—");
  pass(
    "6. voice-prefs endpoint",
    `engine=${k.fullAgentEngine} privacy=${k.voicePrivacyMode} idle=${k.fullAgentIdleTimeoutMin}m cap=${k.fullAgentMonthlyMinuteCap}min`,
  );
} else {
  fail("6. voice-prefs endpoint", `${prefsR.status} ${prefsR.body}`);
}

const spendR = await probe("spend", `${BASE}/api/agent-mcp/operator-el-spend`);
if (spendR.ok) {
  const s = spendR.json ?? {};
  pass(
    "7. el-spend endpoint",
    `${s.minutes_used}/${s.minutes_cap ?? "∞"} min (${s.ym}); over_cap=${s.over_cap}`,
  );
} else {
  fail("7. el-spend endpoint", `${spendR.status} ${spendR.body}`);
}

const delsR = await probe("delegates", `${BASE}/api/agent-mcp/delegates`);
delsR.ok
  ? pass(
      "8. delegates list endpoint",
      `${(delsR.json?.sessions ?? []).length} open`,
    )
  : fail("8. delegates list endpoint", `${delsR.status} ${delsR.body}`);

if (xiKey && agentId) {
  const bootR = await probe(
    "boot",
    `${BASE}/api/agent-mcp/operator-elevenlabs-bootstrap`,
  );
  if (bootR.ok && bootR.json?.conversationToken?.length > 100) {
    pass("9. EL bootstrap", `token len=${bootR.json.conversationToken.length}`);
  } else if (
    bootR.status === 404 &&
    /not-enabled/.test(bootR.body ?? "") &&
    !["elevenlabs-conv", "elevenlabs-conversational"].includes(
      voicePrefs?.fullAgentEngine,
    )
  ) {
    // The shipped local-first posture deliberately keeps the optional cloud
    // full-agent engine off. In that state this endpoint MUST refuse to mint a
    // paid conversation token; a 404 not-enabled proves the gate is working.
    pass(
      "9. EL bootstrap",
      `disabled by voice prefs (engine=${voicePrefs?.fullAgentEngine ?? "off"})`,
    );
  } else if (bootR.status === 502 && /concurrent/.test(bootR.body ?? "")) {
    warn(
      "9. EL bootstrap",
      "rate-limited (workspace has active session); endpoint logic is fine",
    );
  } else {
    fail(
      "9. EL bootstrap",
      `${bootR.status} ${bootR.body?.slice?.(0, 150) ?? ""}`,
    );
  }
} else {
  warn("9. EL bootstrap", "skipped (no key/agent)");
}

// ─── 3. Direct EL API ────────────────────────────────────────────────
if (xiKey && agentId) {
  try {
    const r = await fetch(
      `https://api.elevenlabs.io/v1/convai/agents/${agentId}`,
      {
        headers: { "xi-api-key": xiKey },
      },
    );
    if (!r.ok) {
      fail(
        "10. EL agent config",
        `${r.status} ${(await r.text()).slice(0, 100)}`,
      );
    } else {
      const d = await r.json();
      const llm = d.conversation_config?.agent?.prompt?.llm;
      const tools = (d.conversation_config?.agent?.prompt?.tool_ids ?? [])
        .length;
      const promptLen = (d.conversation_config?.agent?.prompt?.prompt ?? "")
        .length;
      const ovr =
        d.platform_settings?.overrides?.conversation_config_override?.agent
          ?.prompt?.prompt;
      if (tools < 10 || promptLen < 500) {
        warn(
          "10. EL agent config",
          `llm=${llm} tools=${tools} prompt_len=${promptLen} overrides=${ovr} — run el-agent-sync.mjs`,
        );
      } else {
        pass(
          "10. EL agent config",
          `llm=${llm} tools=${tools} prompt_len=${promptLen} overrides=${ovr}`,
        );
      }
    }
  } catch (e) {
    fail("10. EL agent config", e?.message ?? String(e));
  }
} else {
  warn("10. EL agent config", "skipped");
}

// ─── 4. PG schema + audit tables ────────────────────────────────────
// NOTE: the legacy `delegates` table (and its `transcript` JSONB, old check
// #12) is RETIRED — delegated tasks are work_items (kind='task') and the
// transcript lives in the work_item's coord thread (see
// packages/operator-core/lib/delegated-tasks.ts; plan
// collapse-delegate-into-workitems-2026-06-04). The checks below test the
// surfaces the CURRENT voice stack actually writes.
let sql;
try {
  sql = postgres(PG_URL);
  const tables = await sql`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'harness_shared'
      AND tablename IN ('agent_actions', 'agent_queries', 'voice_utterances', 'el_conv_calls')
  `;
  const got = new Set(tables.map((t) => t.tablename));
  const want = [
    "agent_actions",
    "agent_queries",
    "voice_utterances",
    "el_conv_calls",
  ];
  const missing = want.filter((t) => !got.has(t));
  if (missing.length) {
    fail("11. PG voice/audit tables", `missing: ${missing.join(",")}`);
  } else {
    pass("11. PG voice/audit tables", `${want.length}/${want.length} present`);
  }
} catch (e) {
  fail("11. PG voice/audit tables", `connect failed: ${e?.message ?? e}`);
}

// Delegated-task home: the work_items surface that replaced delegates.*.
if (sql) {
  try {
    const rel = await sql`
      SELECT c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'harness_shared' AND c.relname = 'work_items'
    `;
    rel.length
      ? pass("12. work_items surface (delegated tasks)", "")
      : fail(
          "12. work_items surface (delegated tasks)",
          "harness_shared.work_items missing",
        );
  } catch (e) {
    fail("12. work_items surface (delegated tasks)", e?.message ?? String(e));
  }
}

// ─── 5. Round-trip writes through public endpoints ──────────────────
const TEST_CONV_ID = `voice-stack-check-${Date.now()}`;

// Voice utterance log — legacy path (not signed).
{
  const r = await fetch(`${BASE}/api/agent-mcp/voice-utterance-log`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: "legacy",
      mode: "default",
      lengthChars: 5,
      modifications: [],
      nameUsed: false,
      hadBackstory: false,
    }),
  }).catch(() => null);
  if (r?.ok) pass("13. voice-utterance-log", "POST 200");
  else fail("13. voice-utterance-log", `${r?.status ?? "err"}`);
}

// Post-call webhook — synthetic transcript, optionally signed.
{
  const body = JSON.stringify({
    type: "post_call_transcription",
    data: {
      conversation_id: TEST_CONV_ID,
      transcript: [{ role: "agent", message: "On it." }],
      metadata: { call_duration_secs: 0 },
    },
  });
  const headers = { "content-type": "application/json" };
  const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;
  if (secret) {
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", secret)
      .update(`${t}.${body}`)
      .digest("hex");
    headers["elevenlabs-signature"] = `t=${t},v0=${sig}`;
  }
  const r = await fetch(`${BASE}/api/elevenlabs/post-call`, {
    method: "POST",
    headers,
    body,
  }).catch(() => null);
  if (r?.ok) {
    pass(
      "14. post-call webhook",
      secret ? "POST 200 (signed)" : "POST 200 (dev-mode unsigned)",
    );
  } else if (!secret && r?.status === 401) {
    // The remote host may enforce a signing secret that is intentionally not
    // present in this checker's process. An unsigned 401 is then the secure,
    // expected result; it proves the endpoint is not anonymously writable.
    pass(
      "14. post-call webhook",
      "401 on unsigned (remote host requires signing)",
    );
  } else {
    fail("14. post-call webhook", `${r?.status ?? "err"}`);
  }
}

// Tool-call webhook — auth probe (always 401 if signed wrong, 200 if dev).
{
  const r = await fetch(`${BASE}/api/elevenlabs/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool_name: "workspace.list", parameters: {} }),
  }).catch(() => null);
  if (process.env.ELEVENLABS_WEBHOOK_SECRET) {
    if (r?.status === 401)
      pass("15. webhook auth", "401 on unsigned (correct in prod mode)");
    else fail("15. webhook auth", `expected 401, got ${r?.status}`);
  } else {
    if (r?.status === 401)
      pass(
        "15. webhook auth",
        "401 on unsigned (remote host requires signing)",
      );
    else if (r?.ok)
      pass("15. webhook auth", "200 on unsigned (dev mode, expected)");
    else fail("15. webhook auth", `${r?.status}`);
  }
}

// run-command endpoint with a registry query.
{
  const r = await fetch(`${BASE}/api/agent-mcp/run-command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "workspace.list", args: {}, agent: "oracle" }),
  }).catch(() => null);
  if (r?.ok) {
    const j = await r.json().catch(() => null);
    j?.ok
      ? pass(
          "16. run-command (workspace.list)",
          `${(j.value?.workspaces ?? []).length} workspaces`,
        )
      : fail(
          "16. run-command (workspace.list)",
          JSON.stringify(j).slice(0, 100),
        );
  } else {
    fail("16. run-command (workspace.list)", `${r?.status ?? "err"}`);
  }
}

// ─── 6. Cleanup ─────────────────────────────────────────────────────
if (sql) {
  try {
    await sql`DELETE FROM harness_shared.voice_utterances WHERE source IN ('legacy', 'elevenlabs-conv') AND length_chars IN (5, 6)`;
    await sql`DELETE FROM harness_shared.el_conv_calls WHERE conversation_id LIKE 'voice-stack-check-%'`;
  } catch {
    /* best-effort */
  }
  await sql.end().catch(() => {});
}

// ─── Report ─────────────────────────────────────────────────────────
console.log("");
const passes = checks.filter((c) => c.status === "PASS").length;
const warns = checks.filter((c) => c.status === "WARN").length;
const fails = checks.filter((c) => c.status === "FAIL").length;

for (const c of checks) {
  const sym = c.status === "PASS" ? "✓" : c.status === "WARN" ? "⚠" : "✗";
  const detail = c.detail ? ` — ${c.detail}` : "";
  console.log(`  ${sym} ${c.name}${detail}`);
}
console.log("");
console.log(`[voice-stack-check] ${passes} pass, ${warns} warn, ${fails} fail`);
if (fails > 0) {
  console.log("");
  console.log("FAIL items above need attention before deploy.");
  process.exit(1);
}
process.exit(0);
