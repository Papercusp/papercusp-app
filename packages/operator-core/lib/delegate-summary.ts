/**
 * Delegated-task title generator (collapse-delegate-into-workitems-2026-06-04).
 *
 * A delegated task is a work_item (issue-family kind=task). Its panel title starts
 * as the first words of the request; after the first turn we upgrade it to a concise
 * haiku-generated title. The update is SILENT (no subscribe→inject fan-out) — a
 * cosmetic title change is not a notify-worthy lifecycle event.
 *
 * Runs in the background — never blocks the user. Cost is negligible (~$0.001/title).
 */

import { runHaiku } from './haiku';
import { updateIssue } from './issues-engineer';

/** Best-effort: derive + persist a concise title onto a delegated-task work_item. */
export async function generateTaskTitle(opts: {
  workItemId: string;
  initiatorMsg: string;
  firstResponse?: string;
}): Promise<void> {
  const prompt = `Generate a 5-10 word descriptive title for this delegated task. Just the title — no quotes, no preamble.

User asked: ${opts.initiatorMsg}
${opts.firstResponse ? `\nThe agent responded (excerpt): ${opts.firstResponse.slice(0, 400)}` : ''}

Title:`;
  let title = await runHaiku(prompt, 50).catch(() => '');
  if (!title || title.length > 80) {
    // Fallback: first 8 words of the initiator message.
    title = opts.initiatorMsg.split(/\s+/).slice(0, 8).join(' ');
  }
  if (title) {
    await updateIssue(opts.workItemId, { title, silent: true }).catch(() => {});
  }
}
