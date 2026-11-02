import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { DraftInput } from "../ui/draft-input";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function NewProjectsDirectoryRow() {
  const { connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["newProjectsDirectory"]);
  // Older servers drop the key without an error, so the row stays out of their reach.
  if (
    connectedEnvironments.some(
      (environment) =>
        environment.serverConfig?.environment.capabilities.newProjectsDirectory !== true,
    )
  ) {
    return null;
  }
  // "~" resolves per machine, so only a single environment has one folder to name.
  const effectiveRoot =
    connectedEnvironments.length === 1
      ? connectedEnvironments[0]?.serverConfig?.newProjectsRoot
      : undefined;

  return (
    <SettingsRow
      serverScoped
      settingKeys={["newProjectsDirectory"]}
      {...searchableSetting("new-projects-folder")}
      description={`Where a new project is created, and where a link clones one. Use an absolute path, or start with "~/". Leave empty for the projects folder in the T3 home.${
        effectiveRoot === undefined ? "" : ` Now: ${effectiveRoot}`
      }`}
      resetAction={
        mixed || settings.newProjectsDirectory !== DEFAULT_UNIFIED_SETTINGS.newProjectsDirectory ? (
          <SettingResetButton
            label="new projects folder"
            onClick={() =>
              updateSettings({
                newProjectsDirectory: DEFAULT_UNIFIED_SETTINGS.newProjectsDirectory,
              })
            }
          />
        ) : null
      }
      control={
        <DraftInput
          size="sm"
          className="w-full sm:w-72"
          value={mixed ? "" : settings.newProjectsDirectory}
          onCommit={(next) => updateSettings({ newProjectsDirectory: next })}
          placeholder={mixed ? "Mixed" : "T3 home"}
          autoCapitalize="none"
          spellCheck={false}
          aria-label="New projects folder"
        />
      }
    />
  );
}
