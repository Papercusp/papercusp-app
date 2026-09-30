/**
 * Vitest reporter that harvests installed-TUI release evidence (P-012 / D-018).
 *
 * Each `PUI_*_ACCEPTANCE <json>` line becomes one row, paired with the FINAL
 * state of the test that printed it — a line printed before an assertion that
 * later failed is recorded as failed, not as evidence. The suite's
 * `PUI_ACCEPTANCE_HARNESS` stamp says which operator the module drove.
 *
 * Inert unless PUI_RELEASE_EVIDENCE names the output file. The release runner
 * also sets PUI_RELEASE_PLATFORM; the engine and model come from the same
 * PUI_REAL_* variables the suites themselves read.
 */
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { Reporter, TestModule } from 'vitest/node';
import {
  parseAcceptanceLines, parseHarnessLine, REPO_ROOT, type EvidenceRow, type HarnessStamp,
} from './release-acceptance';

type ConsoleLog = Parameters<NonNullable<Reporter['onUserConsoleLog']>>[0];

export interface EvidenceFile {
  schemaVersion: 1;
  context: { platform: string | null; engine: string; model: string | null };
  rows: EvidenceRow[];
}

export function runContext(env: NodeJS.ProcessEnv = process.env): EvidenceFile['context'] {
  const real = env.PUI_REAL_ENGINE === '1';
  return {
    platform: env.PUI_RELEASE_PLATFORM || null,
    engine: real ? (env.PUI_REAL_BACKEND ?? 'claude') : 'scripted',
    model: real ? (env.PUI_REAL_MODEL || null) : null,
  };
}

const text = (value: unknown) => (typeof value === 'string' && value ? value : null);

function realpath(file: string | null): string | null {
  if (!file || !existsSync(file)) return null;
  return realpathSync(file);
}

export default class ReleaseAcceptanceReporter implements Reporter {
  private readonly logs: Array<{ taskId?: string; content: string }> = [];

  onUserConsoleLog(log: ConsoleLog): void {
    if (log.type === 'stdout') this.logs.push({ taskId: log.taskId, content: log.content });
  }

  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const out = process.env.PUI_RELEASE_EVIDENCE;
    if (!out) return;
    const context = runContext();
    const rows: EvidenceRow[] = [];
    for (const module of testModules) {
      const ids = new Set([module.id, ...[...module.children.allSuites()].map((suite) => suite.id)]);
      const tests = new Map([...module.children.allTests()].map((testCase) => [testCase.id, testCase]));
      for (const testCase of tests.values()) ids.add(testCase.id);
      const own = this.logs.filter((log) => log.taskId !== undefined && ids.has(log.taskId));
      let harness: HarnessStamp | null = null;
      for (const log of own) harness = parseHarnessLine(log.content) ?? harness;
      for (const log of own) {
        const testCase = tests.get(log.taskId!);
        if (!testCase) continue;
        const { lines, unparsed } = parseAcceptanceLines(log.content);
        const base = {
          test: testCase.fullName,
          module: path.relative(REPO_ROOT, module.moduleId),
          state: testCase.result().state,
          harness,
          ...context,
        };
        for (const line of lines) {
          const binary = text(line.payload.binary) ?? harness?.binary ?? null;
          rows.push({
            ...base,
            tag: line.tag,
            binary,
            binaryRealpath: realpath(binary),
            binarySha256: text(line.payload.binarySha256) ?? harness?.binarySha256 ?? null,
            correlation: {
              chatId: text(line.payload.chatId),
              traffic: Array.isArray(line.payload.traffic) ? line.payload.traffic : [],
            },
          });
        }
        for (const tag of unparsed) {
          rows.push({ ...base, tag, binary: null, binaryRealpath: null, binarySha256: null, correlation: null, unparsed: true });
        }
      }
    }
    mkdirSync(path.dirname(out), { recursive: true });
    const file: EvidenceFile = { schemaVersion: 1, context, rows };
    writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
  }
}
