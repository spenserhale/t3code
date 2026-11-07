import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function UsageCostSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();

  return (
    <SettingsRow
      {...searchableSetting("usage-and-cost")}
      description="Show tokens and estimated cost after each turn's “Worked for” summary, in thread hover cards, and as a Thread breakdown on Usage. Costs follow your custom model prices."
      resetAction={
        settings.usageCostAnalysisEnabled !== DEFAULT_UNIFIED_SETTINGS.usageCostAnalysisEnabled ? (
          <SettingResetButton
            label="usage and cost"
            onClick={() =>
              updateSettings({
                usageCostAnalysisEnabled: DEFAULT_UNIFIED_SETTINGS.usageCostAnalysisEnabled,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.usageCostAnalysisEnabled}
          onCheckedChange={(checked) =>
            updateSettings({ usageCostAnalysisEnabled: Boolean(checked) })
          }
          aria-label="Usage and cost"
        />
      }
    />
  );
}
