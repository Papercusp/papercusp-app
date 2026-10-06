/** R-4: persisted canonical GOAL notification in the real, isolated Tauri shell.
 * Run through verify-tauri-headless.sh with isolated DB + ready onboarding seed.
 * This reuses the approved fixture and production publish/delivery/read seams.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import postgres from 'postgres';
import { resolveScriptPgUrl } from './lib/pg-url.mjs';
import { execFileViaSidecar } from '../packages/operator-core/lib/fleet/git-via-sidecar.ts';
import { defaultEvidenceRoot, parseSelectionArgs, runHarness } from '@papercusp/verification-harness';
import { GOAL_SPEND_SNAPSHOT_SOURCE } from '@papercusp/db-org';
import { serializeGoalOwnerReportSnapshot } from '@papercusp/chat-protocol';
import { goalOwnerReportFixture, goalReportBrowserFeedProbeScript, seedGoalReportFixturePresence } from '../packages/operator-core/test/fixtures/goal-owner-report.ts';
import { getReport, publishReport } from '../packages/operator-core/lib/report-library.ts';
import { makeGoalReportReferenceReads, persistGoalReportReference } from '../packages/operator-core/lib/goal-owner-report-reference.ts';

async function runGoalReportNative(evidenceDir: string) {
  assert.equal(process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED, '1', 'Refusing fixture writes outside isolated verifier DB');
  const pid = process.env.VERIFY_TAURI_PID!;
  const origin = process.env.VERIFY_TAURI_DEV_URL!;
  const workspaceId = process.env.PAPERCUSP_WORKSPACE!;
  const isolatedPg = resolveScriptPgUrl();
  assert.ok(pid && origin && workspaceId &&
    isolatedPg.source === 'env' && isolatedPg.via === 'HARNESS_ADMIN_DATABASE_URL' &&
    !isolatedPg.envLocal.applied.includes('HARNESS_ADMIN_DATABASE_URL'),
    'Requires an explicitly supplied isolated admin database URL');
  const out = process.env.TAURI_GOAL_REPORT_OUT ?? evidenceDir;
  mkdirSync(out, { recursive: true });
  const save = (name: string, value: unknown) => writeFileSync(join(out, name), JSON.stringify(value, null, 2));
  const tool = process.env.VERIFY_TAURI_AGENT_TOOLS_BIN ?? 'tauri-agent-tools';
  const native = (...args: string[]) => execFileSync(tool, [...args, '--pid', pid], { encoding: 'utf8', timeout: 60_000 });
  // Preserve the subject and the actual route on failure. A missing card alone
  // cannot distinguish a missing feed item from navigation or hydration failure.
  const captureUi = (name: string) => {
    save(`${name}.json`, JSON.parse(native('eval', `JSON.stringify({
      url: location.href,
      browserWorkspace: window.__PAPERCUSP_WS__ ?? null,
      queryWorkspace: new URL(location.href).searchParams.get('ws'),
      routerLocation: window.__TSR_ROUTER__?.state?.location,
      ipcEvents: window.__ipcInspector?.events({path:'rest-query'}),
      selectedRows: Array.from(document.querySelectorAll('.op-inbox__row.is-selected')).map(n => n.textContent),
      reportCards: document.querySelectorAll('[data-component="report-block"]').length,
      body: document.body.innerText,
      alerts: Array.from(document.querySelectorAll('[role="alert"]')).map(n => n.textContent)
    })`)));
    native('screenshot', '--output', join(out, `${name}.png`));
  };
  const poll = (expression: string, require: string) => {
    try {
      const result = execFileSync(process.env.VERIFY_TAURI_POLL!, ['--require', require, '--eval', expression],
        { encoding: 'utf8', timeout: 90_000, env: { ...process.env, VERIFY_TAURI_DOM_TIMEOUT: '60' } });
      writeFileSync(join(out, `check-${observations.length}.json`), result);
    } catch (error) {
      try { captureUi(`failed-subject-${observations.length}`); } catch (captureError) {
        save('capture-error.json', { error: String(captureError) });
      }
      throw error;
    }
  };
  const sql = postgres(isolatedPg.url, { max: 1, onnotice: () => {} });
  const observations: unknown[] = [];
  // Measure the same window.fetch + IPC/workspace wrappers as usePlanAttention.
  // A Node HTTP preflight with an explicit header cannot prove this request.
  const captureBrowserFeed = async (phase: string, expectedMessageId: string, expectedReport: unknown) => {
    const request = '/api/zero-harness/rest-query?' + new URLSearchParams({
      name: 'plans.attention', args: JSON.stringify({ limit: 100, offset: 0 }),
    });
    // Compare the SAME named-query route against the browser bridge, rather than
    // treating a positive /admin/plans/attention read as proof of this route.
    const directResponse = await fetch(`${origin}${request}`, {
      headers: { 'x-papercusp-workspace': workspaceId }, signal: AbortSignal.timeout(15_000),
    });
    const directData = await directResponse.json() as any;
    save(`${phase}-http-sync-feed.json`, {
      status: directResponse.status, request, workspaceHeader: workspaceId,
      data: directData,
    });
    assert.equal(directResponse.status, 200, 'Direct named-query read failed');
    const directItem = directData.rows?.flatMap((group: any) => group.items ?? [])
      .find((item: any) => item.id === `coord-message:${expectedMessageId}`);
    assert.ok(directItem, 'Persisted report absent from the same named-query route; refusing visual verification');
    assert.deepEqual(directItem.report, expectedReport, 'Direct named-query read changed the exact report pin');
    native('eval', goalReportBrowserFeedProbeScript(request));
    const deadline = Date.now() + 30_000;
    let result: any;
    do {
      result = JSON.parse(native('eval', 'JSON.stringify(window.__goalReportFeedProbe)'));
      if (result.done) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    save(`${phase}-browser-feed.json`, result);
    assert.equal(result.done, true, 'Browser sync request did not settle');
    assert.equal(result.status, 200, 'Browser sync request failed');
    assert.equal(result.browserWorkspace, workspaceId, 'Browser workspace differs from the persisted fixture');
    const item = result.data?.rows?.flatMap((group: any) => group.items ?? [])
      .find((item: any) => item.id === `coord-message:${expectedMessageId}`);
    assert.ok(item, 'Exact persisted report is absent from the actual browser sync feed');
    assert.deepEqual(item.report, expectedReport, 'Browser sync feed changed the exact report pin');
  };
  const sourcePaths = ['apps/operator/app/_components/chat/ReportBlockCard.tsx', 'libs/generic/chat-cards/src/index.tsx',
    'apps/operator/app/globals.css', 'packages/operator-core/lib/sync-resolver/index.ts',
    'packages/operator-core/lib/agent-tools/plans/read-dispatch.ts',
    'packages/operator-core/lib/agent-tools/plans/read-dispatch.test.ts',
    'packages/operator-core/lib/agent-tools/plans/attention.cache.test.ts',
    'packages/operator-core/lib/goal-report-browser-probe.test.ts',
    'packages/operator-core/test/fixtures/goal-owner-report.ts',
    'scripts/tauri-surface-verify-goal-report.mts'];
  const sourceFingerprint = sourcePaths.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }));
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 60_000 }).trim();
  let recording: ReturnType<typeof spawn> | undefined;
  let recordingExit: Promise<number | null> | undefined;
  const stopRecording = async () => {
    if (!recording) return;
    recording.kill('SIGINT');
    const timeout = setTimeout(() => {
      recording!.kill('SIGKILL');
    }, 10_000).unref();
    try { await recordingExit; } finally {
      clearTimeout(timeout);
      recording = undefined;
      recordingExit = undefined;
    }
  };
  // A textContent match proves the body was loaded, not that clipped lines were
  // visible. Scroll the real pre and record every line while it is in view.
  const captureVisibleBody = async (selector: string, expectedBody: string, phase: string) => {
    const lines = expectedBody.split('\n');
    const required = lines.flatMap((line, index) => line.length ? [index] : []);
    const covered = new Set<number>();
    const pages: unknown[] = [];
    native('eval', `(()=>{const p=document.querySelector(${JSON.stringify(selector)});p.scrollTop=0;p.scrollIntoView({block:'start'});return true})()`);
    for (let page = 0; page < 100; page++) {
      await new Promise(resolve => setTimeout(resolve, 400));
      const measured = JSON.parse(native('eval', `JSON.stringify((()=>{
        const p=document.querySelector(${JSON.stringify(selector)}), node=p.firstChild;
        if(!node || node.nodeType!==Node.TEXT_NODE)throw Error('Canonical body is not a single text node');
        const box=p.getBoundingClientRect(), top=Math.max(0,box.top+p.clientTop), bottom=Math.min(innerHeight,box.top+p.clientTop+p.clientHeight);
        let offset=0;const visible=[];
        for(const [index,line] of ${JSON.stringify(lines)}.entries()){
          if(line.length){const r=document.createRange();r.setStart(node,offset);r.setEnd(node,offset+line.length);
            const rects=Array.from(r.getClientRects());
            if(rects.length && rects.every(b=>{const e=document.elementFromPoint((b.left+b.right)/2,(b.top+b.bottom)/2);
              return b.top>=top && b.bottom<=bottom && b.left>=0 && b.right<=innerWidth && (e===p || p.contains(e));}))visible.push(index);
          }offset+=line.length+1;
        }
        return {visible,scrollTop:p.scrollTop,clientHeight:p.clientHeight,scrollHeight:p.scrollHeight,viewport:{width:innerWidth,height:innerHeight},box:{top:box.top,bottom:box.bottom},atEnd:p.scrollTop+p.clientHeight>=p.scrollHeight-1};
      })())`));
      assert.ok(measured.clientHeight > 0, 'Expanded body has no visible viewport');
      for (const line of measured.visible) covered.add(line);
      const screenshot = join(out, `${phase}-page-${page}.png`);
      native('screenshot', '--output', screenshot);
      pages.push({ ...measured, screenshot });
      if (measured.atEnd) break;
      native('eval', `(()=>{const p=document.querySelector(${JSON.stringify(selector)});p.scrollTop+=p.clientHeight*0.65;return p.scrollTop})()`);
    }
    const missing = required.filter(line => !covered.has(line));
    save(`${phase}-visual-coverage.json`, { lines, required, covered: [...covered], missing, pages });
    assert.deepEqual(missing, [], 'Every canonical report line must be visibly observed while scrolling');
  };
  try {
    // SQL here is test setup only, in the disposable fully migrated database.
    // The report and notification themselves use the actual production writers.
    const goalId = 'goal-expandable-reports';
    const ownerId = 'goal-report-tauri-fixture';
    const at = new Date().toISOString();
    const due = new Date(Date.now() + 300_000).toISOString();
    const snapshot = goalOwnerReportFixture(workspaceId);
    await sql`INSERT INTO harness_shared.goals
      (workspace_id,id,install_slug,title,budget_cents,budget_window_sec,metadata,updated_at)
      VALUES (${workspaceId},${goalId},${workspaceId},'Canonical GOAL Tauri fixture',1000,3600,
        ${JSON.stringify({ spentCents: 125.5, spentCentsSource: GOAL_SPEND_SNAPSHOT_SOURCE, spentCentsAt: at,
          spentCentsBreakdown: { measured: true, lineageScope: 'partial; legacy unpriced' } })}::text::jsonb,${at}::timestamptz)`;
    await sql`INSERT INTO harness_shared.agent_modes (workspace_id,owner_id,axis_key,mode,subject,set_by)
      VALUES (${workspaceId},${ownerId},'goal','goal',${goalId},'isolated-test-fixture')`;
    // The canonical wake read requires a living elected holder, not just a mode
    // row. Bind the fixture to THIS assertion process and its current activity.
    await seedGoalReportFixturePresence(sql, workspaceId, ownerId, at);
    const [wake] = await sql`INSERT INTO harness_shared.event_awaits
      (workspace_id,subscriber_id,event_key,timeout_behavior,expires_ts)
      VALUES (${workspaceId},${ownerId},'fixture:report-progress','wake',${due}::timestamptz) RETURNING id`;
    for (const wall of snapshot.ownerWalls) {
      await sql`INSERT INTO harness_shared.work_items
        (workspace_id,harness_slug,feature_id,item_kind,title,status,goal_id,updated_ts,payload)
        VALUES (${workspaceId},${workspaceId},${wall.itemRef},'task','Exact owner action','needs-human',${goalId},${Date.parse(at)},
          ${JSON.stringify({ ownerAction: wall.exactAction, ownerDecisionRefs: wall.decisionRefs, ownerArtifactRefs: wall.artifactRefs })}::text::jsonb)`;
    }
    await sql`INSERT INTO harness_shared.work_items
      (workspace_id,harness_slug,feature_id,item_kind,title,status,goal_id,updated_ts,authority,terminal_completion_ref)
      VALUES (${workspaceId},${workspaceId},'WI-completed','task','Completed work','done',${goalId},${Date.parse(at)},'committed','receipt:complete-19'),
        (${workspaceId},${workspaceId},'WI-observed','task','Observed work','wip',${goalId},${Date.parse(at)},NULL,NULL)`;
    await sql`INSERT INTO harness_shared.work_items
      (workspace_id,harness_slug,feature_id,item_kind,title,status,goal_id,updated_ts,payload)
      VALUES (${workspaceId},${workspaceId},'WI-killed','task','Historical direction','dropped',${goalId},${Date.parse(at)},
        ${JSON.stringify({ disposition: 'stopped: duplicate surface', dispositionEvidenceRefs: ['decision:stop-3'] })}::text::jsonb)`;
    const reads = makeGoalReportReferenceReads(sql, workspaceId, goalId);
    snapshot.sources = [(await reads.source(`goal:${goalId}`))!, (await reads.source('legacy-spend'))!];
    snapshot.cost = (await reads.cost())!;
    snapshot.ownerWalls = (await reads.ownerWalls())!;
    snapshot.moved = [(await reads.movement('WI-completed'))!, (await reads.movement('WI-observed'))!];
    snapshot.killed = [{ ref: 'WI-killed', disposition: 'stopped: duplicate surface', evidenceRefs: ['decision:stop-3'], at }];
    snapshot.nextWake = { kind: 'event', ref: 'fixture:report-progress', expectedAt: due, evidenceRef: `await:${wake!.id}` };
    snapshot.observedAt = new Date().toISOString();
    const wakeEvidenceValid = await reads.wake(snapshot.nextWake);
    save('fixture-wake-preflight.json', { ownerId, assertionPid: process.pid, host: hostname(),
      nextWake: snapshot.nextWake, wakeEvidenceValid });
    assert.ok(wakeEvidenceValid, 'Isolated fixture lacks live-holder next-wake evidence; refusing publication');
    const report = await publishReport(sql, { workspaceId, title: 'Canonical GOAL Tauri fixture', goalOwnerReport: snapshot,
      visibility: 'workspace' }, { authorOwnerId: ownerId });
    const reference = { schemaVersion: 1 as const, goalId, reportId: report.reportId, bodySha256: report.bodySha256 };
    const envelope = await persistGoalReportReference(sql,
      { msg_id: 'fixture-input', from: ownerId, to: ['human'], kind: 'message', ts: new Date().toISOString(), expects: 'none' },
      { workspaceId, goalId, ref: reference, viewer: { ownerId } });
    assert.deepEqual(envelope.report, { plans: [], goalReport: reference });
    const [{ count: plans }] = await sql`SELECT count(*) FROM harness_shared.harness_plans WHERE workspace_id=${workspaceId}`;
    assert.equal(Number(plans), 0, 'The reference-only fixture must have zero real plan rows');
    save('published-fixture.json', { report, envelope, snapshot, plans: Number(plans) });
    const health = await (await fetch(`${origin}/api/health`)).json() as Record<string, unknown>;
    save('runtime-health.json', health);
    const runtimeIdentity = { runtime: 'desktop-shell', buildSha: health.buildSha ?? health.sha ?? head,
      shaSource: health.buildSha || health.sha ? 'isolated host health' : 'measured source HEAD', pid, origin,
      frozenSpa: process.env.VERIFY_TAURI_SPA_DIST, launchProvenance: process.env.VERIFY_TAURI_LAUNCH_PROVENANCE };
    const recordingRef = join(out, 'journey.mp4');
    const displayDimensions = /dimensions:\s+(\d+x\d+)/.exec((await execFileViaSidecar('xdpyinfo',
      ['-display', process.env.VERIFY_TAURI_DISPLAY!], {
        cwd: process.cwd(), timeoutMs: 60_000, subsystem: 'goal-tauri-verifier',
      })).stdout)?.[1];
    assert.ok(displayDimensions, 'Cannot measure the full recording display');
    recording = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'x11grab', '-framerate', '3',
      '-video_size', displayDimensions, '-i', process.env.VERIFY_TAURI_DISPLAY!, '-c:v', 'libx264', '-preset', 'ultrafast', recordingRef],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    recordingExit = new Promise((resolve, reject) => { recording!.once('error', reject); recording!.once('exit', resolve); });
    recording.stderr!.on('data', chunk => process.stderr.write(chunk));
    // Boot has already warmed plans:attention. Its message source deliberately
    // has a 20s SWR window, and this fixture writes through the real transaction
    // from another process. A first read can therefore precede convergence.
    // Verify the exact durable pin at the actual UI read seam BEFORE the card
    // gate, preserving each response rather than retrying an opaque DOM failure.
    const feedAttempts: unknown[] = [];
    const deadline = Date.now() + 90_000;
    let feedReady = false;
    while (Date.now() < deadline) {
      const attentionResponse = await fetch(`${origin}/api/admin/plans/attention`, {
        headers: { 'x-papercusp-workspace': workspaceId }, signal: AbortSignal.timeout(15_000),
      });
      const data = await attentionResponse.json() as { groups?: Array<{ items?: Array<{ id?: string; report?: unknown }> }> };
      const item = data.groups?.flatMap(group => group.items ?? [])
        .find(item => item.id === `coord-message:${envelope.msg_id}`);
      const measured = { observedAt: new Date().toISOString(), status: attentionResponse.status, data };
      save(`attention-preflight-${feedAttempts.length}.json`, measured);
      save('attention-preflight.json', measured);
      feedReady = false;
      if (item && attentionResponse.status === 200) {
        try { assert.deepEqual(item.report, envelope.report); feedReady = true; } catch { feedReady = false; }
      }
      feedAttempts.push({ observedAt: measured.observedAt, status: measured.status, exactPinPresent: feedReady });
      if (feedReady) break;
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    save('attention-convergence.json', { feedAttempts, result: feedReady ? 'pass' : 'fail',
      expectedMessageId: envelope.msg_id, expectedReport: envelope.report });
    assert.ok(feedReady, 'Exact persisted GOAL pin never reached the UI feed; refusing card verification');
    captureUi('before-navigation');
    save('navigation.json', JSON.parse(native('navigate',
      `/inbox?opci=all&opcis=${encodeURIComponent(`coord-message:${envelope.msg_id}`)}`, '--json')));
    // The existing desktop subscription may still hold its pre-fixture snapshot.
    // Exercise a real fresh load from the converged feed, not a forged DOM card.
    native('eval', 'setTimeout(()=>location.reload(),0);true');
    await new Promise(resolve => setTimeout(resolve, 500));
    poll('location.pathname === "/inbox" && !!document.querySelector(".op-inbox")', '.op-inbox');
    captureUi('after-navigation');
    await captureBrowserFeed('after-navigation', envelope.msg_id, envelope.report);
    const card = '[data-component="report-block"]';
    poll(`Array.from(document.querySelectorAll('${card} button')).some(b=>b.textContent==='Expand full report')`, card);
    native('screenshot', '--output', join(out, 'notification.png'));
    native('check', '--eval', `(()=>{const b=Array.from(document.querySelectorAll('${card} button')).find(b=>b.textContent==='Expand full report');if(!b)return false;b.click();return true})()`, '--json');
    const expectedBody = serializeGoalOwnerReportSnapshot(snapshot);
    assert.ok(expectedBody.length > 600);
    const bodySelector = `.report-block-goal-body[data-report-id="${report.reportId}"]`;
    poll(`document.querySelector(${JSON.stringify(bodySelector)})?.textContent===${JSON.stringify(expectedBody)}`, bodySelector);
    // Independent transport read: actual reports:get dispatcher, distinct from the
    // card's reports.get sync query and the fixture's direct store writer.
    const reply = await (await fetch(`${origin}/api/agent-mcp/run-tool`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'reports:get', args: { id: report.reportId, lineage: true }, callerSid: `tauri-goal-report-${pid}` }) })).json() as any;
    save('reports-get.json', reply);
    assert.equal(reply.ok, true);
    const content = reply.result.content.find((c: any) => c.type === 'text' && c.text.includes('body_md'));
    const retrieved = JSON.parse(content.text).results.find((r: any) => r.id === report.reportId).report;
    assert.equal(retrieved.report_id, report.reportId);
    assert.equal(retrieved.workspace_id, workspaceId);
    assert.equal(retrieved.body_sha256, reference.bodySha256);
    assert.equal(retrieved.body_md, expectedBody);
    assert.deepEqual(retrieved.goal_owner_report, snapshot);
    assert.equal(createHash('sha256').update(retrieved.body_md, 'utf8').digest('hex'), reference.bodySha256);
    const fields = ['exact canonical UTF-8 body', 'three exact owner actions', 'source observed/measured timestamps', 'cost measured/read timestamps',
      'successful mutation receipt', 'historical kills', 'checked/unchecked/notApplicable/residue coverage', 'explicit unknown reasons',
      'historical snapshot label', 'in-card expansion', 'zero fabricated plan rows', 'no parallel viewer'];
    poll(`document.querySelector('.report-block-goal-as-of')?.textContent.includes(${JSON.stringify(snapshot.observedAt)}) &&
      document.querySelectorAll('.report-block-plan').length===0 && location.pathname==='/inbox'`, card);
    const unknowns = [snapshot.sources[1]!.unknownReason!, snapshot.coverage.unknowns[0]!.reason];
    const observe = (name: string) => observations.push({ name, reportId: report.reportId, bodySha256: reference.bodySha256, workspaceId, goalId,
      runtimeIdentity, sourceFingerprint, observedAt: new Date().toISOString(), recordingRef, exactExpectedBody: expectedBody,
      visibleOwnerActions: snapshot.ownerWalls.map(w => w.exactAction), observedFieldCoverage: fields, explicitUnknownLabels: unknowns, result: 'pass' });
    await captureVisibleBody(bodySelector, expectedBody, 'original');
    observe('REPORT-PINNED-DETAIL-P003 original exact notification expansion');
    native('screenshot', '--output', join(out, 'expanded.png'));
    save('captured-card.json', JSON.parse(native('eval', `JSON.stringify({body:document.querySelector(${JSON.stringify(bodySelector)})?.textContent,
      label:document.querySelector('.report-block-goal-as-of')?.textContent,url:location.href})`)));
    // The successor changes actual body and lineage, never the original pin.
    const successorSnapshot = structuredClone(snapshot);
    successorSnapshot.ownerWalls[0]!.exactAction = 'SUCCESSOR ONLY: this must never replace the pinned action.';
    const successor = await publishReport(sql, { workspaceId, title: 'Successor GOAL Tauri fixture', goalOwnerReport: successorSnapshot,
      visibility: 'workspace', supersedes: report.reportId }, { authorOwnerId: ownerId });
    const original = await getReport(sql, workspaceId, report.reportId, { isOwner: true });
    assert.equal(original!.bodyMd, expectedBody);
    assert.notEqual(successor.bodySha256, report.bodySha256);
    native('navigate', `/inbox?opci=all&opcis=${encodeURIComponent(`coord-message:${envelope.msg_id}`)}&goalReport=${encodeURIComponent(report.reportId)}`, '--json');
    poll(`document.querySelector(${JSON.stringify(bodySelector)})?.textContent===${JSON.stringify(expectedBody)} &&
      !document.querySelector(${JSON.stringify(bodySelector)})?.textContent.includes('SUCCESSOR ONLY')`, bodySelector);
    await captureVisibleBody(bodySelector, expectedBody, 'after-successor');
    observe('REPORT-PINNED-DETAIL-P003 successor/latest-lineage control');
    native('screenshot', '--output', join(out, 'pinned-after-successor.png'));
    save('successor-control.json', { successorId: successor.reportId, successorBodySha256: successor.bodySha256, pinnedOriginal: original });
    await stopRecording();
    const recordingProbe = JSON.parse((await execFileViaSidecar('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,nb_read_frames:format=duration', '-of', 'json', recordingRef], {
        cwd: process.cwd(), timeoutMs: 60_000, subsystem: 'goal-tauri-verifier',
      })).stdout);
    save('recording-probe.json', recordingProbe);
    assert.ok(Number(recordingProbe.streams[0]?.nb_read_frames) > 0 && Number(recordingProbe.format?.duration) > 0, 'Recording has no decoded video frames');
    assert.equal(`${recordingProbe.streams[0].width}x${recordingProbe.streams[0].height}`, displayDimensions);
    save('manifest.json', { criterion: 'R-4', observations, recordingProbe, coverage: { population: fields, checked: fields, notChecked: [], notApplicable: [], residue: [] }, result: 'pass' });
    console.log(`GOAL_REPORT_TAURI_PASS output=${out}`);
  } catch (error) {
    save('manifest.json', { criterion: 'R-4', observations, result: 'fail', error: String(error), sourceFingerprint });
    throw error;
  } finally {
    await stopRecording();
    await sql.end();
  }
}

const selection = parseSelectionArgs(process.argv.slice(2));
const result = await runHarness({
  contract: {
    name: 'goal-report-tauri',
    phases: [{ id: 'native', description: 'Persisted, pinned GOAL report in the isolated Tauri shell' }],
  },
  evidenceRoot: defaultEvidenceRoot('goal-report-tauri'),
  selection,
  reuseFrom: selection.reuse,
  async runPhase(ctx) {
    ctx.markStep('isolated-runtime-preconditions');
    await runGoalReportNative(ctx.evidenceDir);
    return { ok: true };
  },
});
process.exitCode = result.verdict === 'pass' ? 0 : 1;
