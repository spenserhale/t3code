import { effortSliderIsShown, stableListKeys } from "@t3tools/client-runtime/effort-slider";
import {
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { resolveProviderEffortSlider } from "@t3tools/shared/modelShortcuts";

import { useAddEffortSliderStep, useEnvironmentModelShortcuts } from "~/hooks/useModelShortcuts";
import { announce } from "~/lib/announce";
import type { ModelPickerEffortSlider } from "./EffortSlider";
import {
  type ComposerEffortSliderContext,
  currentEffortOf,
  effortSliderAddDisabledReason,
  findActiveComposerEffortStep,
  resolveComposerEffortSteps,
} from "./composerEffortSlider.logic";
import type { ProviderModelSelectOptions } from "./useComposerSelection";

/** The picker's shortcuts for the effort slider, shown with the selected model's effort levels. */
export interface EffortSliderActions {
  /** Why the selected model and effort cannot be added; null when they can. */
  readonly addDisabledReason: string | null;
  readonly onAdd: () => void;
  readonly sliderLabel: string;
  /** What the settings link opens: the project's own list when it is the one in use. */
  readonly settingsTarget: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId | null;
    readonly projectOverrides: boolean;
    readonly driver: ProviderDriverKind | null;
  };
}

export type ComposerEffortSliderForTab = (driver: ProviderDriverKind | null) => {
  slider: ModelPickerEffortSlider | null;
  actions: EffortSliderActions | null;
} | null;

function describeEffort(modelLabel: string, effortLabel: string | null) {
  return effortLabel === null ? modelLabel : `${modelLabel}, ${effortLabel.toLowerCase()} effort`;
}

/**
 * The slider the composer's model picker shows for the configured steps, and the shortcuts that
 * build it. Both are null where the environment does not keep a slider, and while several models
 * are selected, since stepping would then discard that selection.
 */
export function useComposerEffortSlider(
  input: ComposerEffortSliderContext & {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId | null;
    readonly suspended: boolean;
    readonly selectedModelSelection: ModelSelection;
    /** What the provider reports a started thread runs at, which the effort control shows. */
    readonly reportedModelSelection: ModelSelection | null | undefined;
    readonly onProviderModelSelect: (
      instanceId: ModelSelection["instanceId"],
      model: string,
      options?: ProviderModelSelectOptions,
    ) => void;
  },
): ComposerEffortSliderForTab {
  const { environmentId, projectId, selectedModelSelection } = input;
  const shortcuts = useEnvironmentModelShortcuts(environmentId, projectId);
  const addStep = useAddEffortSliderStep(environmentId, projectId);
  return (tabDriver) => {
    if (!shortcuts.effortSliderSupported || input.suspended) return null;

    const driver = shortcuts.providerEffortSlidersSupported ? tabDriver : null;
    const providerSlider =
      shortcuts.settings && driver !== null
        ? resolveProviderEffortSlider(shortcuts.settings, projectId, driver)
        : null;
    const sliderDriver = providerSlider ? driver : null;
    const configured = providerSlider?.steps ?? shortcuts.effortSlider;
    const driverLabel =
      sliderDriver === null ? null : (PROVIDER_DISPLAY_NAMES[sliderDriver] ?? sliderDriver);
    const steps = resolveComposerEffortSteps(configured, input, sliderDriver);
    const activeIndex = findActiveComposerEffortStep(
      steps,
      selectedModelSelection,
      input.instanceEntries,
      input.reportedModelSelection,
    );
    const active = activeIndex === null ? null : steps[activeIndex];
    const current = currentEffortOf(
      selectedModelSelection,
      input.instanceEntries,
      input.reportedModelSelection,
    );
    const stopKeys = stableListKeys(steps.map((step) => step.identity));

    const slider: ModelPickerEffortSlider | null = effortSliderIsShown(steps)
      ? {
          stops: steps.map((step, index) => ({
            key: stopKeys[index]!,
            modelLabel: step.modelLabel,
            effortLabel: step.effortLabel,
            unusableReason: step.unusableReason,
          })),
          activeIndex,
          valueText: active
            ? describeEffort(active.modelLabel, active.effortLabel)
            : "No step chosen",
          onSelect: (index) => {
            const step = steps[index];
            if (!step || step.unusableReason !== null || index === activeIndex) return;
            input.onProviderModelSelect(step.selection.instanceId, step.selection.model, {
              focusComposer: false,
              ...(step.selection.options?.length ? { modelOptions: step.selection.options } : {}),
            });
            announce(describeEffort(step.modelLabel, step.effortLabel), "effort-slider");
          },
        }
      : null;

    const selectedDriver = input.instanceEntries.find(
      (entry) => entry.instanceId === selectedModelSelection.instanceId,
    )?.driverKind;
    const addDisabledReason =
      sliderDriver !== null && selectedDriver !== sliderDriver
        ? `Choose a ${driverLabel} model to add to this slider`
        : effortSliderAddDisabledReason({
            stepCount: configured.length,
            activeIndex,
            selectedModelKnown: current.model !== undefined,
          });
    return {
      slider,
      actions: {
        addDisabledReason,
        sliderLabel: driverLabel === null ? "Favorites slider" : `${driverLabel} slider`,
        onAdd: () => {
          if (addDisabledReason !== null) return;
          void addStep(
            createModelSelection(
              selectedModelSelection.instanceId,
              selectedModelSelection.model,
              current.effort
                ? [{ id: current.effort.descriptorId, value: current.effort.value }]
                : undefined,
            ),
            sliderDriver,
          );
        },
        settingsTarget: {
          environmentId,
          projectId,
          projectOverrides:
            (providerSlider?.source ?? shortcuts.effortSliderSource) === "project" ||
            shortcuts.favoritesSource === "project",
          driver,
        },
      },
    };
  };
}
