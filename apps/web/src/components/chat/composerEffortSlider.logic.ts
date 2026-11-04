import {
  canonicalEffortSliderSteps,
  type EffortSliderStepView,
  effortSliderStepIdentity,
  findActiveEffortSliderStep,
  shownEffort,
} from "@t3tools/client-runtime/effort-slider";
import {
  type EnvironmentId,
  MAX_EFFORT_SLIDER_STEPS,
  type ModelSelection,
  type ProjectId,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { createModelSelection, resolveSelectableModel } from "@t3tools/shared/model";

import { isProviderInstancePickerReady, type ProviderInstanceEntry } from "../../providerInstances";
import type { SettingsScopeSearch } from "../settings/settingsScope";
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

/**
 * The configured steps as this composer can use them, each with why it cannot be, if so. A step
 * that repeats an earlier one by model and effective effort is left out.
 */
export function resolveComposerEffortSteps(
  configured: ReadonlyArray<ModelSelection>,
  context: ComposerEffortSliderContext,
): ReadonlyArray<ComposerEffortStep> {
  const steps = configured.map((step): ComposerEffortStep => {
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
    const selection = createModelSelection(step.instanceId, resolved, step.options);
    const effort = shownEffort(
      entry?.models.find((candidate) => candidate.slug === resolved),
      selection,
    );
    const option = options?.find((candidate) => candidate.slug === resolved);
    return {
      selection,
      identity: effortSliderStepIdentity(selection, effort?.value ?? null),
      effort: effort?.value ?? null,
      effortLabel: effort?.label ?? null,
      modelLabel: option ? getTriggerDisplayModelName(option, entry?.driverKind) : resolved,
      unusableReason,
    };
  });
  return canonicalEffortSliderSteps(steps);
}

/**
 * The effort a selection runs at, as the composer's effort control shows it, so the slider and
 * the control never disagree about where a thread is.
 */
export function currentEffortOf(
  selection: ModelSelection,
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>,
  reportedSelection?: ModelSelection | null,
) {
  const model = instanceEntries
    .find((entry) => entry.instanceId === selection.instanceId)
    ?.models.find((candidate) => candidate.slug === selection.model);
  return { model, effort: shownEffort(model, selection, reportedSelection) };
}

export function findActiveComposerEffortStep(
  steps: ReadonlyArray<ComposerEffortStep>,
  selection: ModelSelection,
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>,
  reportedSelection?: ModelSelection | null,
): number | null {
  return findActiveEffortSliderStep(steps, {
    instanceId: selection.instanceId,
    model: selection.model,
    effort: currentEffortOf(selection, instanceEntries, reportedSelection).effort?.value ?? null,
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

/**
 * Where the picker's settings link goes: the checkout whose own list the picker is showing, so
 * what is edited there is that list, and otherwise the environment's.
 */
export function modelShortcutsSettingsSearch(
  input: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId | null;
    readonly projectOverrides: boolean;
  },
  groups: ReadonlyArray<{
    readonly projectKey: string;
    readonly memberProjects: ReadonlyArray<{
      readonly id: ProjectId;
      readonly environmentId: EnvironmentId;
      readonly physicalProjectKey: string;
    }>;
  }>,
): SettingsScopeSearch {
  if (input.projectOverrides && input.projectId !== null) {
    for (const group of groups) {
      const member = group.memberProjects.find(
        (candidate) =>
          candidate.id === input.projectId && candidate.environmentId === input.environmentId,
      );
      if (member) {
        return {
          project: group.projectKey,
          machine: input.environmentId,
          checkout: member.physicalProjectKey,
        };
      }
    }
  }
  return { machine: input.environmentId };
}
