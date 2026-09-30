'use client';

/**
 * AdvGitWorkspace — the /adv Git tab, rebuilt as a dockview dock (sibling of
 * HarnessesWorkspace). The Git graph + Pull requests are draggable dock
 * panels; the "+" catalog is constrained to those two types so this page only
 * offers git panels. Shares the blue-frost dock theme (adv-dock.css) via the
 * `.pc-adv-dock` class.
 *
 * The active harness slug comes from `?slug=` (owned by the AdvShell header).
 */

import { parseAsString, useQueryState } from 'nuqs';
import { useLexicon } from '@/lib/useLexicon';
import { AddPanelCatalog } from '../../harness/dock/AddPanelCatalog';
import AdvGitDock from './AdvGitDock';
import './adv-dock.css';

export default function AdvGitWorkspace() {
  const t = useLexicon();
  const [slug] = useQueryState('slug', parseAsString.withDefault(''));

  return (
    <div className="pc-adv-git pc-adv-dock">
      <div className="pc-adv-git__bar">
        <AddPanelCatalog
          defaultSlug={slug}
          allowedTypes={['adv:git-graph', 'adv:prs']}
          className="pc-adv-git__add-panel"
        />
      </div>
      <div className="pc-adv-git__dock">
        {slug ? (
          <AdvGitDock slug={slug} />
        ) : (
          <div className="pc-adv-git__empty">Pick a {t('pot', { lower: true })} from the selector above.</div>
        )}
      </div>

      <style>{`
        .pc-adv-git {
          flex: 1;
          min-height: 0;
          display: flex;
          flex-direction: column;
          height: 100%;
          position: relative;
        }
        .pc-adv-git__bar {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 10px;
          flex-shrink: 0;
          border-bottom: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
        }
        .pc-adv-git__dock {
          flex: 1;
          min-height: 0;
          position: relative;
        }
        .pc-adv-git__empty {
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          color: var(--fg-mute, #7f9bb4);
          font-size: 13px;
          text-align: center;
        }
      `}</style>
    </div>
  );
}
