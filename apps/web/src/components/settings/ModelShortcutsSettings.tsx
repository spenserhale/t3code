import {
  effortChoices,
  effortSliderStepIdentity,
  selectedEffort,
  shownEffort,
  stableListKeys,
} from "@t3tools/client-runtime/effort-slider";
import {
  MAX_EFFORT_SLIDER_STEPS,
  type ModelSelection,
  type ProviderInstanceId,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { ArrowDownIcon, ArrowUpIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor, type ProviderInstanceEntry } from "../../providerInstances";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { getDisplayModelName } from "../chat/providerIconUtils";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  addFavorite,
  effortSliderAddBlockReason,
  effortSliderEditBlockReason,
  type FavoritesEdit,
  moveListItem,
  planFavoritesWrite,
  removeListItem,
  setFavoriteOptions,
  setSliderStepOptions,
} from "./modelShortcutsSettings.logic";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import {
  useClearScopedSettings,
  useScopedSettings,
  useScopedSettingsMixed,
  useScopedSettingSource,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const LAST_USED = "last-used";

function IconButton(props: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-micro"
            variant="ghost-muted"
            disabled={props.disabled}
            aria-label={props.label}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/** The effort a favorite or step opens at. Only favorites can leave it to what was last used. */
function EffortSelect(props: {
  modelName: string;
  model: Parameters<typeof effortChoices>[0];
  options: ReadonlyArray<ProviderOptionSelection> | undefined;
  allowLastUsed: boolean;
  disabled: boolean;
  onChange: (options: ReadonlyArray<ProviderOptionSelection> | undefined) => void;
}) {
  const levels = effortChoices(props.model);
  if (!levels) {
    return <span className="text-xs text-muted-foreground">No effort levels</span>;
  }
  const saved = props.options?.find((option) => option.id === levels.descriptorId);
  const current =
    saved && typeof saved.value === "string"
      ? saved.value
      : props.allowLastUsed
        ? LAST_USED
        : (selectedEffort(props.model, props.options)?.value ?? LAST_USED);
  const labelOf = (value: string | null) =>
    value === null || value === LAST_USED
      ? "Last used"
      : (levels.choices.find((choice) => choice.id === value)?.label ?? value);
  return (
    <Select
      value={current}
      disabled={props.disabled}
      onValueChange={(value) => {
        if (value === null) return;
        props.onChange(
          value === LAST_USED ? undefined : [{ id: levels.descriptorId, value: String(value) }],
        );
      }}
    >
      <SelectTrigger size="sm" className="w-32" aria-label={`Effort for ${props.modelName}`}>
        <SelectValue>{labelOf}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {props.allowLastUsed ? (
          <SelectItem hideIndicator value={LAST_USED}>
            Last used
          </SelectItem>
        ) : null}
        {levels.choices.map((choice) => (
          <SelectItem hideIndicator key={choice.id} value={choice.id}>
            {choice.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function ModelRow(props: {
  entry: ProviderInstanceEntry | undefined;
  instanceId: ProviderInstanceId;
  name: string;
  available: boolean;
  position?: number;
  index: number;
  count: number;
  readOnly: boolean;
  effort: ReactNode;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}) {
  return (
    <li className="flex min-h-8 items-center gap-2 rounded-md px-2 py-1 hover:bg-muted/30">
      {props.position === undefined ? null : (
        <span className="w-4 shrink-0 text-center text-xs text-muted-foreground tabular-nums">
          {props.position}
        </span>
      )}
      {props.entry ? (
        <ProviderInstanceIcon
          driverKind={props.entry.driverKind}
          displayName={props.entry.displayName}
          accentColor={props.entry.accentColor}
          acpRegistryAgentId={props.entry.acpRegistryAgentId}
          acpRegistryIconUrl={props.entry.acpRegistryIconUrl}
          className="size-4 shrink-0"
          iconClassName="size-4"
        />
      ) : null}
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span
          className={cn(
            "truncate text-sm",
            props.available ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {props.name}
        </span>
        <span className="truncate text-xs text-muted-foreground/70">
          {props.available ? (props.entry?.displayName ?? props.instanceId) : "Not available here"}
        </span>
      </span>
      {props.effort}
      <span className="flex shrink-0 items-center">
        <IconButton
          label={`Move ${props.name} up`}
          disabled={props.readOnly || props.index === 0}
          onClick={() => props.onMove(-1)}
        >
          <ArrowUpIcon className="size-3" />
        </IconButton>
        <IconButton
          label={`Move ${props.name} down`}
          disabled={props.readOnly || props.index === props.count - 1}
          onClick={() => props.onMove(1)}
        >
          <ArrowDownIcon className="size-3" />
        </IconButton>
        <IconButton
          label={`Remove ${props.name}`}
          disabled={props.readOnly}
          onClick={props.onRemove}
        >
          <XIcon className="size-3" />
        </IconButton>
      </span>
    </li>
  );
}

/** A project starts from its environment's list, and makes its own copy only when asked. */
function ProjectListControl(props: {
  source: "environment" | "project" | "mixed" | "t3.json";
  environmentLabel: string;
  onCustomize: () => void;
  onInherit: () => void;
}) {
  if (props.source === "environment") {
    return (
      <div className="flex flex-wrap items-center gap-2 px-2 pb-1 text-xs text-muted-foreground">
        <span>This project uses {props.environmentLabel}&apos;s list.</span>
        <Button size="xs" variant="outline" onClick={props.onCustomize}>
          Customize for this project
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 px-2 pb-1 text-xs text-muted-foreground">
      <span>
        {props.source === "mixed"
          ? "Some checkouts of this project have their own list."
          : "This project has its own list."}
      </span>
      <Button size="xs" variant="ghost" onClick={props.onInherit}>
        Use the environment&apos;s
      </Button>
    </div>
  );
}

export function ModelShortcutsSettings() {
  const { scope, target, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const clearOverrides = useClearScopedSettings();
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  const representative = target
    ? environments.find((environment) => environment.environmentId === target.environmentId)
    : undefined;
  const providers =
    (representative?.serverConfig
      ? providersByEnvironment.get(representative.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const entries = providerInstanceEntriesFor(providers, settings, target?.projectId ?? null);
  const modelOptions = getCustomModelOptionsByInstance(settings, providers);
  const disabledReason = useScopedModelDisabledReason(settings, entries);
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const unsupportedLabels = connectedEnvironments
    .filter(
      (environment) => environment.serverConfig?.environment.capabilities.effortSlider !== true,
    )
    .map((environment) => environment.label);
  const supportsEffortSlider = connectedEnvironments.length > 0 && unsupportedLabels.length === 0;
  const favoritesSource = useScopedSettingSource(["favorites"]);
  const sliderSource = useScopedSettingSource(["effortSlider"]);
  const mixedFavorites = useScopedSettingsMixed(["favorites"]);
  const mixedSlider = useScopedSettingsMixed(["effortSlider"]);
  const environmentLabel =
    representative?.label ?? (connectedEnvironments.length > 1 ? "the environment" : "environment");

  const favorites = settings.favorites;
  // Readers use the first six steps, so that is what is shown, and no write holds more.
  const steps =
    settings.effortSlider.length > MAX_EFFORT_SLIDER_STEPS
      ? settings.effortSlider.slice(0, MAX_EFFORT_SLIDER_STEPS)
      : settings.effortSlider;
  // A server that holds no list yet, or cannot take the change itself, gets the whole list.
  const listOnServer =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (environment) => (environment.serverConfig?.settings.favorites ?? null) !== null,
    );
  // A project that has not made its own list shows the environment's, read-only. Servers that
  // keep no efforts or slider keep no project lists either.
  const favoritesReadOnly =
    isProjectScope && (favoritesSource === "environment" || !supportsEffortSlider);
  const sliderReadOnly = isProjectScope && sliderSource === "environment";

  const firstEntry = entries.find((entry) => entry.enabled && entry.isAvailable);
  const firstModel = firstEntry ? modelOptions.get(firstEntry.instanceId)?.[0] : undefined;
  const describe = (instanceId: ProviderInstanceId, slug: string) => {
    const entry = entries.find((candidate) => candidate.instanceId === instanceId);
    const option = modelOptions.get(instanceId)?.find((candidate) => candidate.slug === slug);
    return {
      entry,
      model: entry?.models.find((candidate) => candidate.slug === slug),
      name: option ? getDisplayModelName(option) : slug,
      available: option !== undefined && option.isUnavailable !== true,
    };
  };
  // Models this environment does not know keep their saved options as their level.
  const effortOf = (selection: ModelSelection) =>
    shownEffort(describe(selection.instanceId, selection.model).model, selection)?.value ??
    (selection.options?.length ? JSON.stringify(selection.options) : null);
  const favoriteKeys = stableListKeys(
    favorites.map((favorite) => `${favorite.provider}:${favorite.model}`),
  );
  const stepKeys = stableListKeys(
    steps.map((step) => effortSliderStepIdentity(step, effortOf(step))),
  );
  const editFavorites = (edit: FavoritesEdit, list: typeof favorites) =>
    updateSettings(
      planFavoritesWrite({
        projectScope: isProjectScope,
        listOnServer,
        reorderSupported: supportsEffortSlider,
        list,
        edit,
      }),
    );
  const picker = (
    label: string,
    onPick: (instanceId: ProviderInstanceId, model: string) => void,
  ) =>
    firstEntry && firstModel ? (
      <ProviderModelPicker
        environmentId={representative?.environmentId ?? null}
        activeInstanceId={firstEntry.instanceId}
        model={firstModel.slug}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={modelOptions}
        triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
        triggerLabel={label}
        triggerAriaLabel={label}
        getModelDisabledReason={disabledReason}
        onInstanceModelChange={(instanceId, model) => {
          const reason = disabledReason(instanceId, model);
          if (reason) {
            toastManager.add({ type: "error", title: "Model not added", description: reason });
            return;
          }
          onPick(instanceId, model);
        }}
      />
    ) : (
      <span className="text-sm text-muted-foreground">No providers available</span>
    );

  const addStep = (instanceId: ProviderInstanceId, slug: string) => {
    const { model } = describe(instanceId, slug);
    const effort = selectedEffort(model, undefined);
    const step = createModelSelection(
      instanceId,
      slug,
      effort ? [{ id: effort.descriptorId, value: effort.value }] : undefined,
    );
    const blocked = effortSliderAddBlockReason(steps, step, effortOf);
    if (blocked) {
      toastManager.add({ type: "warning", title: "Step not added", description: blocked });
      return;
    }
    updateSettings({ effortSlider: [...steps, step] });
  };

  return (
    <SettingsSection id="model-shortcuts" title="Favorites and effort slider">
      <SettingsRow
        serverScoped
        settingKeys={["favorites"]}
        mixed={mixedFavorites}
        {...searchableSetting("model-favorites")}
        description={
          supportsEffortSlider
            ? "The model picker lists favorites first, in this order. A favorite with an effort opens at it instead of the effort you used last."
            : "The model picker lists favorites first, in this order. Favorite efforts need a newer T3 Code."
        }
        control={
          favoritesReadOnly
            ? undefined
            : picker("Add a favorite", (instanceId, model) => {
                const favorite = { provider: instanceId, model };
                const next = addFavorite(favorites, favorite);
                if (next !== favorites) editFavorites({ kind: "add", favorite }, next);
              })
        }
      >
        {isProjectScope && supportsEffortSlider ? (
          <ProjectListControl
            source={favoritesSource}
            environmentLabel={environmentLabel}
            onCustomize={() => editFavorites({ kind: "replace" }, favorites)}
            onInherit={() => clearOverrides(["favorites"])}
          />
        ) : null}
        {isProjectScope && !supportsEffortSlider ? (
          <p className="px-2 pb-1 text-xs text-muted-foreground">
            A project keeps its own favorites only on environments running a newer T3 Code.
          </p>
        ) : null}
        {mixedFavorites ? (
          <p className="px-2 pb-1 text-xs text-muted-foreground">
            The selected environments keep different lists. Changing this one replaces them all.
          </p>
        ) : null}
        {unsupportedLabels.length > 0 && connectedEnvironments.length > 1 ? (
          <p className="px-2 pb-1 text-xs text-muted-foreground">
            Favorite efforts and the slider need a newer T3 Code on {unsupportedLabels.join(", ")}.
          </p>
        ) : null}
        {favorites.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            No favorites yet. Star a model in the picker, or add one here.
          </p>
        ) : (
          <ol aria-label="Favorite models" className="pb-2">
            {favorites.map((favorite, index) => {
              const { entry, model, name, available } = describe(favorite.provider, favorite.model);
              return (
                <ModelRow
                  key={favoriteKeys[index]!}
                  entry={entry}
                  instanceId={favorite.provider}
                  name={name}
                  available={available}
                  index={index}
                  count={favorites.length}
                  readOnly={favoritesReadOnly}
                  effort={
                    supportsEffortSlider ? (
                      <EffortSelect
                        modelName={name}
                        model={model}
                        options={favorite.options}
                        allowLastUsed
                        disabled={favoritesReadOnly}
                        onChange={(options) =>
                          editFavorites(
                            { kind: "effort", favorite, options },
                            setFavoriteOptions(favorites, index, options),
                          )
                        }
                      />
                    ) : null
                  }
                  onMove={(direction) => {
                    const list = moveListItem(favorites, index, direction);
                    editFavorites({ kind: "move", list }, list);
                  }}
                  onRemove={() =>
                    editFavorites({ kind: "remove", favorite }, removeListItem(favorites, index))
                  }
                />
              );
            })}
          </ol>
        )}
      </SettingsRow>

      <SettingsRow
        serverScoped
        settingKeys={["effortSlider"]}
        mixed={mixedSlider}
        {...searchableSetting("effort-slider")}
        description={
          supportsEffortSlider
            ? `Up to ${MAX_EFFORT_SLIDER_STEPS} steps of model and effort, shown above the search in the composer's model picker. Left and Right in an empty search move along it. Fewer than two steps hide the slider.`
            : "The effort slider needs a newer T3 Code on every selected environment."
        }
        control={
          !supportsEffortSlider || sliderReadOnly
            ? undefined
            : picker(
                steps.length >= MAX_EFFORT_SLIDER_STEPS ? "Slider is full" : "Add a step",
                addStep,
              )
        }
      >
        {supportsEffortSlider ? (
          <>
            {isProjectScope ? (
              <ProjectListControl
                source={sliderSource}
                environmentLabel={environmentLabel}
                onCustomize={() => updateSettings({ effortSlider: steps })}
                onInherit={() => clearOverrides(["effortSlider"])}
              />
            ) : null}
            {mixedSlider ? (
              <p className="px-2 pb-1 text-xs text-muted-foreground">
                The selected environments keep different slider steps. Changing them replaces them
                all.
              </p>
            ) : null}
            {steps.length === 0 ? (
              <p className="px-2 py-2 text-xs text-muted-foreground">
                No steps yet. Add a model, or use Add to slider beside a model&apos;s effort in the
                picker.
              </p>
            ) : (
              <ol aria-label="Effort slider steps" className="pb-2">
                {steps.map((step, index) => {
                  const { entry, model, name, available } = describe(step.instanceId, step.model);
                  return (
                    <ModelRow
                      key={stepKeys[index]!}
                      entry={entry}
                      instanceId={step.instanceId}
                      name={name}
                      available={available}
                      position={index + 1}
                      index={index}
                      count={steps.length}
                      readOnly={sliderReadOnly}
                      effort={
                        <EffortSelect
                          modelName={name}
                          model={model}
                          options={step.options}
                          allowLastUsed={false}
                          disabled={sliderReadOnly}
                          onChange={(options) => {
                            const blocked = effortSliderEditBlockReason(
                              steps,
                              index,
                              createModelSelection(step.instanceId, step.model, options),
                              effortOf,
                            );
                            if (blocked) {
                              toastManager.add({
                                type: "warning",
                                title: "Step not changed",
                                description: blocked,
                              });
                              return;
                            }
                            updateSettings({
                              effortSlider: setSliderStepOptions(steps, index, options),
                            });
                          }}
                        />
                      }
                      onMove={(direction) =>
                        updateSettings({ effortSlider: moveListItem(steps, index, direction) })
                      }
                      onRemove={() =>
                        updateSettings({ effortSlider: removeListItem(steps, index) })
                      }
                    />
                  );
                })}
              </ol>
            )}
            {steps.length === 1 ? (
              <p className="px-2 pb-2 text-xs text-muted-foreground">
                One step is not enough: the slider appears with two or more.
              </p>
            ) : null}
          </>
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
}
