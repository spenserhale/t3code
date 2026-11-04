import { effortSliderIsShown } from "@t3tools/client-runtime/effort-slider";
import type { EnvironmentId, ModelSelection, ProjectId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";

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
  readonly onOpenSettings: () => void;
}

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
    readonly onProviderModelSelect: (
      instanceId: ModelSelection["instanceId"],
      model: string,
      options?: ProviderModelSelectOptions,
    ) => void;
  },
): { slider: ModelPickerEffortSlider | null; actions: EffortSliderActions | null } {
  const { environmentId, projectId, selectedModelSelection } = input;
  const navigate = useNavigate();
  const { effortSlider, effortSliderSupported } = useEnvironmentModelShortcuts(
    environmentId,
    projectId,
  );
  const addStep = useAddEffortSliderStep(environmentId, projectId);
  if (!effortSliderSupported || input.suspended) return { slider: null, actions: null };

  const steps = resolveComposerEffortSteps(effortSlider, input);
  const activeIndex = findActiveComposerEffortStep(
    steps,
    selectedModelSelection,
    input.instanceEntries,
  );
  const active = activeIndex === null ? null : steps[activeIndex];
  const current = currentEffortOf(selectedModelSelection, input.instanceEntries);

  const slider: ModelPickerEffortSlider | null = effortSliderIsShown(steps)
    ? {
        stops: steps.map((step, index) => ({
          key: `${index}:${step.selection.instanceId}:${step.selection.model}:${step.effort}`,
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

  const addDisabledReason = effortSliderAddDisabledReason({
    stepCount: effortSlider.length,
    activeIndex,
    selectedModelKnown: current.model !== undefined,
  });
  return {
    slider,
    actions: {
      addDisabledReason,
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
        );
      },
      onOpenSettings: () => {
        void navigate({
          to: "/settings/threads",
          search: { machine: environmentId },
          hash: "model-shortcuts",
        });
      },
    },
  };
}
