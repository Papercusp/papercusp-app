import type { AttentionItem } from '@/app/admin/plans/plans-api';

/** The durable work-item id an attention row can open in the shared discussion
 * surface. Conservative by design: an owner-wall ref that is not a WI/EI/F id
 * returns null rather than guessing a destination. */
export function attentionWorkItemId(item: AttentionItem): string | null {
  const ref = item.ref as Record<string, unknown>;
  switch (ref.kind) {
    case 'work-item-needs-human':
    case 'work-item-blocked':
      return typeof ref.workItemId === 'string' ? ref.workItemId : null;
    case 'improvement':
      return typeof ref.issueId === 'string' ? ref.issueId : null;
    case 'owner-wall':
      return typeof ref.wallRef === 'string' && /^(?:WI|EI|F)-\d+$/i.test(ref.wallRef)
        ? ref.wallRef.toUpperCase()
        : null;
    default:
      return null;
  }
}
