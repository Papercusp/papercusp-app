"use client";

import {
  createContext,
  useContext,
  type ReactNode,
} from "react";

/**
 * Host-owned controls that belong inside one of the operator's canonical
 * Settings pages.
 *
 * A host may have settings the desktop operator does not own (for example the
 * web portal's persisted light/system/dark preference). Those controls still
 * belong in the Settings information architecture, not in a second host-level
 * card above it. These slots let the host supply the control while the
 * operator page keeps ownership of its location and surrounding hierarchy.
 */
export type OperatorSettingsSlotName =
  | "personalization"
  | "papercup-agent";

export type OperatorSettingsSlots = Partial<
  Record<OperatorSettingsSlotName, ReactNode>
>;

const OperatorSettingsSlotsContext =
  createContext<OperatorSettingsSlots>({});

export function OperatorSettingsSlotsProvider({
  slots,
  children,
}: {
  slots: OperatorSettingsSlots;
  children: ReactNode;
}) {
  return (
    <OperatorSettingsSlotsContext.Provider value={slots}>
      {children}
    </OperatorSettingsSlotsContext.Provider>
  );
}

/** Render one host addition in the page that owns its information category. */
export function OperatorSettingsSlot({
  name,
}: {
  name: OperatorSettingsSlotName;
}) {
  return useContext(OperatorSettingsSlotsContext)[name] ?? null;
}
