"use client";

import { useCallback, useMemo } from "react";
import { parseAsArrayOf, parseAsString, useQueryState } from "nuqs";
import {
  parseDesktopSelection,
  serializeDesktopSelection,
  type DesktopGridSelection,
} from "./desktop-grid-model";

export interface DesktopGridUrlState {
  selection: DesktopGridSelection | null;
  setSelection: (selection: DesktopGridSelection | null) => void;
  pinned: string[];
  setPinned: (pinned: string[]) => void;
  filter: string;
  setFilter: (filter: string) => void;
}

/**
 * The grid's user-meaningful state lives in the URL (repo rule: nuqs, not
 * useState), so an agent driving the UI through `ui:get_state` / `ui:dispatch`
 * sees which desktop is open, which are pinned, and the filter.
 *
 *   desktop=watch:<id> | takeover:<id>   the large viewer
 *   desktopPins=<id>,<id>                the live-pinned tiles (≤ 2)
 *   desktopFilter=<text>                 the tile filter
 */
export function useDesktopGridState(): DesktopGridUrlState {
  const [rawSelection, setRawSelection] = useQueryState("desktop", parseAsString);
  const [rawPins, setRawPins] = useQueryState(
    "desktopPins",
    parseAsArrayOf(parseAsString).withDefault([]),
  );
  const [rawFilter, setRawFilter] = useQueryState(
    "desktopFilter",
    parseAsString.withDefault(""),
  );
  const selection = useMemo(() => parseDesktopSelection(rawSelection), [rawSelection]);
  const setSelection = useCallback(
    (next: DesktopGridSelection | null) => void setRawSelection(serializeDesktopSelection(next)),
    [setRawSelection],
  );
  const setPinned = useCallback(
    (next: string[]) => void setRawPins(next.length > 0 ? next : null),
    [setRawPins],
  );
  const setFilter = useCallback(
    (next: string) => void setRawFilter(next ? next : null),
    [setRawFilter],
  );
  return { selection, setSelection, pinned: rawPins, setPinned, filter: rawFilter, setFilter };
}
