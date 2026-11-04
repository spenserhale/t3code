import type {
  ModelSelection,
  ProviderInstanceId,
  ProviderOptionSelection,
  SelectProviderOptionDescriptor,
  ServerProviderModel,
} from "@t3tools/contracts";
import { getProviderOptionDescriptors } from "@t3tools/shared/model";
import { REASONING_SELECT_DESCRIPTOR_IDS, selectableProviderOptionChoices } from "./modelTraits.ts";

/** The model's reasoning level control, when it has one. */
function findEffortDescriptor(
  model: Pick<ServerProviderModel, "capabilities"> | undefined,
  options?: ReadonlyArray<ProviderOptionSelection>,
): SelectProviderOptionDescriptor | null {
  if (!model?.capabilities) return null;
  const descriptor = getProviderOptionDescriptors({ caps: model.capabilities, selections: options })
    .filter((candidate): candidate is SelectProviderOptionDescriptor => candidate.type === "select")
    .find((candidate) => REASONING_SELECT_DESCRIPTOR_IDS.has(candidate.id));
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

/** The pickable levels of a model's effort control, in the catalog's order. */
export function effortChoices(model: Pick<ServerProviderModel, "capabilities"> | undefined) {
  const descriptor = findEffortDescriptor(model);
  return descriptor
    ? { descriptorId: descriptor.id, choices: selectableProviderOptionChoices(descriptor) }
    : null;
}

export interface EffortSliderStepView {
  readonly selection: ModelSelection;
  /** The level the step runs at, null when its model has no effort control. */
  readonly effort: string | null;
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
 * The next usable step in a direction, or null at the end (no wrap). Off the slider, Right enters
 * at the first usable step and Left at the last.
 */
export function nextEffortSliderStep(
  steps: ReadonlyArray<Pick<EffortSliderStepView, "unusableReason">>,
  active: number | null,
  direction: 1 | -1,
): number | null {
  const usable = (index: number) => steps[index]?.unusableReason === null;
  const start = active ?? (direction === 1 ? -1 : steps.length);
  for (let index = start + direction; index >= 0 && index < steps.length; index += direction) {
    if (usable(index)) return index;
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
