import { useNavigate } from "@tanstack/react-router";

import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { modelShortcutsSettingsSearch } from "./composerEffortSlider.logic";
import type { EffortSliderActions } from "./useComposerEffortSlider";

/**
 * Opens Settings at the favorites and effort slider, in the scope whose lists the picker shows.
 * Only the open picker uses it, so the project groups it reads are built while it is up.
 */
export function useOpenModelShortcutsSettings(target: EffortSliderActions["settingsTarget"]) {
  const navigate = useNavigate();
  const groups = useSettingsProjectGroups();
  return () => {
    void navigate({
      to: "/settings/threads",
      search: modelShortcutsSettingsSearch(target, groups),
      hash: "model-shortcuts",
    });
  };
}
