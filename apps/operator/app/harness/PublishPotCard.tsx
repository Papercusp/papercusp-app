'use client';

/**
 * PublishPotCard — the picker share-offer's embedded Share-Hive form
 * (comb-hive-native-sharing-2026-06-11 P-004).
 *
 * Was the retired ShareWizard's one-click default-public publish; now the
 * MINIMAL embedded form of the Share-Hive dialog: the same visibility choice
 * (public / invite / private) with consequence copy, title + description,
 * member-repo listing, and the invite artifact — via the shared
 * `SharePotForm` core (SharePotDialog.tsx). Sharing happens at the HIVE
 * level; surfaces that used to launch the ShareWizard embed this card.
 */

import React from 'react';
import { SharePotForm, type ShareHiveFormProps } from './SharePotDialog';

export function PublishPotCard({
  potSlug,
  hiveLabel = 'hive',
  ...seams
}: {
  potSlug: string;
  hiveLabel?: string;
} & Pick<ShareHiveFormProps, 'fetchShareMeta' | 'setHiveListing' | 'onSaved'>) {
  return (
    <div
      data-testid="publish-pot-card"
      style={{
        border: '1px solid var(--accent, #4a90d9)',
        borderRadius: 8,
        padding: 12,
        fontSize: 13,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6 }}>
        Share {hiveLabel} <code>{potSlug}</code>
      </div>
      <div style={{ color: 'var(--fg-dim)', marginBottom: 10 }}>
        Sharing happens at the {hiveLabel} level — choose who can find and join it.
      </div>
      <SharePotForm potSlug={potSlug} hiveLabel={hiveLabel} compact {...seams} />
    </div>
  );
}
