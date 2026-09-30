import newTool from '@papercusp/operator-core/lib/agent-tools/plans/new';
import addItem from '@papercusp/operator-core/lib/agent-tools/plans/add-item';
import setStatus from '@papercusp/operator-core/lib/agent-tools/plans/set-status';
import addDecision from '@papercusp/operator-core/lib/agent-tools/plans/add-decision';
import setNow from '@papercusp/operator-core/lib/agent-tools/plans/set-now';
import * as fs from 'node:fs/promises';

const ctx: any = { isSuperuser: true, uiClientId: 'audit-smoke' };
const slug = '_audit-scratch-2026-05-20';
function txt(r:any){ return JSON.parse(r.content[0].text); }

(async () => {
  try {
    const a = txt(await (newTool as any).handler({ slug, title: 'Audit scratch', status: 'active' }, ctx));
    console.log('new:', a.ok ?? a.error);
    const b = txt(await (addItem as any).handler({ slug, phase: 'Phase 1 — Smoke', text: 'first item' }, ctx));
    console.log('add-item 1:', b.itemId, 'createdPhase=' + b.createdPhase);
    const c = txt(await (addItem as any).handler({ slug, phase: 'Phase 1 — Smoke', text: 'second item', blockedBy: [b.itemId] }, ctx));
    console.log('add-item 2:', c.itemId, 'blocked-by', b.itemId);
    const d = txt(await (setStatus as any).handler({ slug, itemId: b.itemId, status: 'done' }, ctx));
    console.log('set-status', b.itemId, '->', d.ok ? d.newStatus : d.error);
    const e = txt(await (addDecision as any).handler({ slug, harness: 'all', title: 'Smoke decision', body: 'Because audit.', refs: [b.itemId] }, ctx));
    console.log('add-decision:', e.decisionId ?? e.error);
    const f = txt(await (setNow as any).handler({ slug, state: 'Smoke in progress.', next: 'finish audit.' }, ctx));
    console.log('set-now:', f.ok ?? f.error);
  } finally {
    // cleanup
    const { getPlansDir } = await import('@papercusp/operator-core/lib/agent-tools/plans/source');
    await fs.unlink(getPlansDir() + '/' + slug + '.md').catch(()=>{});
    console.log('cleaned up scratch file');
  }
})();
