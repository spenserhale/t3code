import {
  type EffortSliderStepView,
  findActiveEffortSliderStep,
  selectedEffort,
} from "@t3tools/client-runtime/effort-slider";
import {
  MAX_EFFORT_SLIDER_STEPS,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { createModelSelection, resolveSelectableModel } from "@t3tools/shared/model";

import { isProviderInstancePickerReady, type ProviderInstanceEntry } from "../../providerInstances";
import { getTriggerDisplayModelName, type ModelEsque } from "./providerIconUtils";

export interface ComposerEffortStep extends EffortSliderStepView {
  readonly modelLabel: string;
  readonly effortLabel: string | null;
}

export interface ComposerEffortSliderContext {
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  readonly lockedProvider: ProviderDriverKind | null;
  readonly lockedContinuationGroupKey: string | null;
  readonly getModelDisabledReason: (instanceId: ProviderInstanceId, model: string) => string | null;
}

/** The configured steps as this composer can use them, each with why it cannot be, if so. */
export function resolveComposerEffortSteps(
  configured: ReadonlyArray<ModelSelection>,
  context: ComposerEffortSliderContext,
): ReadonlyArray<ComposerEffortStep> {
  return configured.map((step) => {
    const entry = context.instanceEntries.find(
      (candidate) => candidate.instanceId === step.instanceId,
    );
    const options = context.modelOptionsByInstance.get(step.instanceId);
    const model =
      entry && options ? resolveSelectableModel(entry.driverKind, step.model, options) : null;
    const lockedOut =
      entry !== undefined &&
      context.lockedProvider !== null &&
      (entry.driverKind !== context.lockedProvider ||
        (context.lockedContinuationGroupKey !== null &&
          entry.continuationGroupKey !== context.lockedContinuationGroupKey));
    const unusableReason =
      !entry || !isProviderInstancePickerReady(entry)
        ? "This provider is not available"
        : model === null
          ? "This model is not available"
          : lockedOut
            ? `${entry.displayName} is unavailable in this thread`
            : context.getModelDisabledReason(step.instanceId, model);
    const resolved = model ?? step.model;
    const effort = selectedEffort(
      entry?.models.find((candidate) => candidate.slug === resolved),
      step.options,
    );
    const option = options?.find((candidate) => candidate.slug === resolved);
    return {
      selection: createModelSelection(step.instanceId, resolved, step.options),
      effort: effort?.value ?? null,
      effortLabel: effort?.label ?? null,
      modelLabel: option ? getTriggerDisplayModelName(option, entry?.driverKind) : resolved,
      unusableReason,
    };
  });
}

/** The effort a selection runs at, compared with the steps the way the steps compare to it. */
export function currentEffortOf(
  selection: ModelSelection,
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>,
) {
  const model = instanceEntries
    .find((entry) => entry.instanceId === selection.instanceId)
    ?.models.find((candidate) => candidate.slug === selection.model);
  return { model, effort: selectedEffort(model, selection.options) };
}

export function findActiveComposerEffortStep(
  steps: ReadonlyArray<ComposerEffortStep>,
  selection: ModelSelection,
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>,
): number | null {
  return findActiveEffortSliderStep(steps, {
    instanceId: selection.instanceId,
    model: selection.model,
    effort: currentEffortOf(selection, instanceEntries).effort?.value ?? null,
  });
}

/** Why the selected model and effort cannot join the slider, or null when they can. */
export function effortSliderAddDisabledReason(input: {
  readonly stepCount: number;
  readonly activeIndex: number | null;
  readonly selectedModelKnown: boolean;
}): string | null {
  if (input.stepCount >= MAX_EFFORT_SLIDER_STEPS) {
    return `The slider holds up to ${MAX_EFFORT_SLIDER_STEPS} steps`;
  }
  if (input.activeIndex !== null) return "Already on the slider";
  return input.selectedModelKnown ? null : "This model is not available";
}
