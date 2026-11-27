import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { useGT } from "gt-react";
import { useState } from "react";

import { Input } from "../ui/input";
import { newProjectsDirectoryProblem } from "./NewProjectsDirectoryRow.logic";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useSearchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function NewProjectsDirectoryRow() {
  const setting = useSearchableSetting();
  const gt = useGT();
  const { connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["newProjectsDirectory"]);
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
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
  const saved = mixed ? "" : settings.newProjectsDirectory;

  // A refused folder stays in the field beside its message, so it can be corrected.
  const commit = () => {
    const next = (draft ?? saved).trim();
    if (draft === null || next === saved) {
      setDraft(null);
      setProblem(null);
      return;
    }
    const refusal = newProjectsDirectoryProblem(next);
    if (refusal !== null) {
      setProblem(refusal);
      return;
    }
    setDraft(null);
    updateSettings({ newProjectsDirectory: next });
  };

  return (
    <SettingsRow
      serverScoped
      settingKeys={["newProjectsDirectory"]}
      {...setting("new-projects-folder")}
      description={
        effectiveRoot === undefined
          ? gt(
              'Where a new project is created, and where a link clones one. Use an absolute path, or start with "~/". Leave empty for the default folder.',
            )
          : gt(
              'Where a new project is created, and where a link clones one. Use an absolute path, or start with "~/". Leave empty for the default folder. Now: {folder}',
              { folder: effectiveRoot },
            )
      }
      status={
        problem === null ? undefined : (
          <span role="alert" className="block text-destructive">
            {problem}
          </span>
        )
      }
      resetAction={
        mixed || settings.newProjectsDirectory !== DEFAULT_UNIFIED_SETTINGS.newProjectsDirectory ? (
          <SettingResetButton
            ariaLabel={gt("Reset new projects folder to default")}
            onClick={() => {
              setDraft(null);
              setProblem(null);
              updateSettings({
                newProjectsDirectory: DEFAULT_UNIFIED_SETTINGS.newProjectsDirectory,
              });
            }}
          />
        ) : null
      }
      control={
        <Input
          size="sm"
          className="w-full sm:w-72"
          value={draft ?? saved}
          onChange={(event) => {
            setDraft(event.target.value);
            setProblem(null);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
          placeholder={mixed ? gt("Mixed") : gt("Default")}
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={problem !== null}
          aria-label={gt("New projects folder")}
        />
      }
    />
  );
}
