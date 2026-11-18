import type {
  ClientSettings,
  DefaultModelSelection,
  EnvironmentId,
  ProjectId,
  ServerProvider,
  ServerSettings,
  UnifiedSettings,
} from "@t3tools/contracts";
import { modelFamilyName, resolveModelFamilyDefault } from "@t3tools/shared/modelFamilyDefault";
import { resolveEffectiveDefaultModelSelection } from "../../modelSelection";
import { mergeEnvironmentSettings } from "../../hooks/useSettings";
import {
  providerInstanceEntriesFor,
  resolveProjectDefaultProviderModelSelection,
} from "../../providerInstances";
import { Switch } from "../ui/switch";

function modelFamilyDefaultForTarget(
  settings: UnifiedSettings,
  projectId: ProjectId | null,
  providers: ReadonlyArray<ServerProvider>,
) {
  const stored = settings.defaultModelSelection;
  const selected =
    stored ?? resolveProjectDefaultProviderModelSelection(providers, settings, projectId);
  if (!selected) return null;
  const entry = providerInstanceEntriesFor(providers, settings, projectId).find(
    (candidate) => candidate.instanceId === selected.instanceId,
  );
  if (!entry?.enabled || !entry.isAvailable) return null;
  const family = modelFamilyName(entry.driverKind, selected.model);
  if (!family || entry.models.some((model) => model.slug === selected.model && model.isCustom))
    return null;
  const latest = resolveModelFamilyDefault(
    { ...selected, followLatest: true },
    providers,
    settings,
  );
  const concrete = entry.models.find((model) => model.slug === latest.model);
  const available =
    concrete &&
    !concrete.isCustom &&
    !concrete.isLegacy &&
    !settings.providerModelPreferences?.[selected.instanceId]?.hiddenModels.includes(concrete.slug);
  const following = stored?.followLatest === true;
  if (!available && !following) return null;
  const pin = available
    ? latest
    : resolveEffectiveDefaultModelSelection(settings, providers, latest);
  return { family, latest, pin, following };
}

export function ModelFamilyDefaultSwitch({
  targets,
  clientSettings,
  onChange,
}: {
  targets: readonly {
    environmentId: EnvironmentId;
    projectId: ProjectId | null;
    settings: ServerSettings;
    providers: readonly ServerProvider[];
  }[];
  clientSettings: ClientSettings;
  onChange: (
    defaults: readonly {
      environmentId: EnvironmentId;
      projectId: ProjectId | null;
      selection: DefaultModelSelection;
    }[],
  ) => void;
}) {
  const choices = targets.flatMap(({ environmentId, projectId, settings, providers }) => {
    const choice = modelFamilyDefaultForTarget(
      mergeEnvironmentSettings(settings, clientSettings),
      projectId,
      providers,
    );
    return choice ? [{ ...choice, environmentId, projectId }] : [];
  });
  const family = choices[0]?.family;
  if (
    !family ||
    choices.length !== targets.length ||
    !choices.every((choice) => choice.family === family)
  )
    return null;
  const following = choices.every((choice) => choice.following);
  return (
    <label className="inline-flex items-center gap-1.5 text-xs">
      Follow latest {family}
      <Switch
        size="sm"
        aria-label={`Follow latest ${family}`}
        checked={following}
        mixed={!following && choices.some((choice) => choice.following)}
        onCheckedChange={(enabled) =>
          onChange(
            choices.map(({ environmentId, projectId, latest, pin }) => ({
              environmentId,
              projectId,
              selection: enabled ? { ...latest, followLatest: true } : pin,
            })),
          )
        }
      />
    </label>
  );
}
