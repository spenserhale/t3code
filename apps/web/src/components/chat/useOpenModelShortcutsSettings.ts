import type { ModelSelection } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { modelShortcutsSettingsSearch } from "./composerEffortSlider.logic";
import type { EffortSliderActions } from "./useComposerEffortSlider";

declare module "@tanstack/react-router" {
  interface HistoryState {
    sliderEditorSelection?: ModelSelection;
  }
}

/**
 * Opens Settings at the favorites and effort slider, in the scope whose lists the picker shows.
 * Only the open picker uses it, so the project groups it reads are built while it is up.
 */
export function useOpenModelShortcutsSettings(target: EffortSliderActions["settingsTarget"]) {
  const navigate = useNavigate();
  const groups = useSettingsProjectGroups();
  return (selection?: ModelSelection) => {
    void navigate({
      to: "/settings/threads",
      search: {
        ...modelShortcutsSettingsSearch(target, groups),
        ...(target.driver === null ? {} : { effortSliderProvider: target.driver }),
      },
      ...(selection ? { state: { sliderEditorSelection: selection } } : { hash: "effort-slider" }),
    });
  };
}
