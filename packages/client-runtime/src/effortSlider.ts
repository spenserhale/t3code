import type {
  ModelSelection,
  ProviderInstanceId,
  ProviderOptionSelection,
  SelectProviderOptionDescriptor,
  ServerProviderModel,
} from "@t3tools/contracts";
import { getProviderOptionDescriptors } from "@t3tools/shared/model";
import {
  getDescriptorStringValue,
  isReasoningSelect,
  selectableProviderOptionChoices,
} from "./modelTraits.ts";

/** The model's reasoning level control, when it has one. */
function findEffortDescriptor(
  model: Pick<ServerProviderModel, "capabilities"> | undefined,
  options?: ReadonlyArray<ProviderOptionSelection>,
): SelectProviderOptionDescriptor | null {
  if (!model?.capabilities) return null;
  const descriptor = getProviderOptionDescriptors({
    caps: model.capabilities,
    selections: options,
  }).find(isReasoningSelect);
  return descriptor ?? null;
}

export interface SelectedEffort {
  readonly descriptorId: string;
  readonly value: string;
  readonly label: string;
}

/** The effort a selection runs at: its own option, else what the model defaults to. */
export function selectedEffort(
  model: Pick<ServerProviderModel, "capabilities"> | undefined,
  options: ReadonlyArray<ProviderOptionSelection> | undefined,
): SelectedEffort | null {
  const descriptor = findEffortDescriptor(model, options);
  const value = descriptor?.currentValue ?? descriptor?.options.find((o) => o.isDefault)?.id;
  if (!descriptor || value === undefined) return null;
  return {
    descriptorId: descriptor.id,
    value,
    label: descriptor.options.find((option) => option.id === value)?.label ?? value,
  };
}

/**
 * The effort the composer's effort control shows for a selection, by the control's own rules: the
 * selection's option, else the level the provider reports for this model, else the default.
 */
export function shownEffort(
  model: Pick<ServerProviderModel, "capabilities"> | undefined,
  selection: ModelSelection,
  reportedSelection?: ModelSelection | null,
): SelectedEffort | null {
  const descriptor = findEffortDescriptor(model, selection.options);
  const value = descriptor
    ? getDescriptorStringValue(descriptor, selection, reportedSelection)
    : null;
  if (!descriptor || value === null) return null;
  return {
    descriptorId: descriptor.id,
    value,
    label: descriptor.options.find((option) => option.id === value)?.label ?? value,
  };
}

/** The pickable levels of a model's effort control, in the catalog's order. */
export function effortChoices(model: Pick<ServerProviderModel, "capabilities"> | undefined) {
  const descriptor = findEffortDescriptor(model);
  return descriptor
    ? { descriptorId: descriptor.id, choices: selectableProviderOptionChoices(descriptor) }
    : null;
}

/** What makes two steps the same stop: the instance, the model and the level they run at. */
export function effortSliderStepIdentity(
  selection: Pick<ModelSelection, "instanceId" | "model">,
  effort: string | null,
): string {
  return JSON.stringify([selection.instanceId, selection.model, effort]);
}

/**
 * A key for each item that holds when the list is reordered: its identity, and how many identical
 * ones came before it, so items repeated in stored data still get distinct keys.
 */
export function stableListKeys(identities: ReadonlyArray<string>): ReadonlyArray<string> {
  const seen = new Map<string, number>();
  return identities.map((identity) => {
    const earlier = seen.get(identity) ?? 0;
    seen.set(identity, earlier + 1);
    return `${identity}#${earlier}`;
  });
}

export interface EffortSliderStepView {
  readonly selection: ModelSelection;
  /** The level the step runs at, null when its model has no effort control. */
  readonly effort: string | null;
  readonly identity: string;
  /** Why the step cannot be applied here; null when it can. */
  readonly unusableReason: string | null;
}

/** The step the committed selection sits on: same instance, model and effective effort. */
export function findActiveEffortSliderStep(
  steps: ReadonlyArray<Pick<EffortSliderStepView, "selection" | "effort">>,
  current: {
    readonly instanceId: ProviderInstanceId;
    readonly model: string;
    readonly effort: string | null;
  },
): number | null {
  const index = steps.findIndex(
    (step) =>
      step.selection.instanceId === current.instanceId &&
      step.selection.model === current.model &&
      step.effort === current.effort,
  );
  return index < 0 ? null : index;
}

/** The slider is offered only when there is something to slide between. */
export function effortSliderIsShown(
  steps: ReadonlyArray<Pick<EffortSliderStepView, "unusableReason">>,
): boolean {
  return steps.filter((step) => step.unusableReason === null).length >= 2;
}

/**
 * The next usable step in a direction, or null at the end (no wrap). A step that repeats the one
 * the selection is on is passed over, so stored duplicates cannot hold the keys in place. Off the
 * slider, Right enters at the first usable step and Left at the last.
 */
export function nextEffortSliderStep(
  steps: ReadonlyArray<Pick<EffortSliderStepView, "unusableReason"> & { identity?: string }>,
  active: number | null,
  direction: 1 | -1,
): number | null {
  const here = active === null ? undefined : steps[active]?.identity;
  const start = active ?? (direction === 1 ? -1 : steps.length);
  for (let index = start + direction; index >= 0 && index < steps.length; index += direction) {
    const step = steps[index];
    if (step === undefined || step.unusableReason !== null) continue;
    if (here !== undefined && step.identity === here) continue;
    return index;
  }
  return null;
}

/** The step nearest a point on the track, among the usable ones; null when none can be applied. */
export function nearestUsableEffortSliderStep(
  steps: ReadonlyArray<Pick<EffortSliderStepView, "unusableReason">>,
  fraction: number,
): number | null {
  const target = Math.min(steps.length - 1, Math.max(0, Math.floor(fraction * steps.length)));
  let best: number | null = null;
  for (const [index, step] of steps.entries()) {
    if (step.unusableReason !== null) continue;
    if (best === null || Math.abs(index - target) < Math.abs(best - target)) best = index;
  }
  return best;
}
