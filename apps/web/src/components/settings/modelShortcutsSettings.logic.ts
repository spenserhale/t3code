import {
  MAX_EFFORT_SLIDER_STEPS,
  type ModelFavorite,
  type ModelSelection,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

export function moveListItem<T>(
  items: ReadonlyArray<T>,
  index: number,
  direction: -1 | 1,
): ReadonlyArray<T> {
  const target = index + direction;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function removeListItem<T>(items: ReadonlyArray<T>, index: number): ReadonlyArray<T> {
  return items.filter((_, position) => position !== index);
}

/** A favorite keeps its place and gains or loses its saved effort; no options means last used. */
export function setFavoriteOptions(
  favorites: ReadonlyArray<ModelFavorite>,
  index: number,
  options: ReadonlyArray<ProviderOptionSelection> | undefined,
): ReadonlyArray<ModelFavorite> {
  return favorites.map((favorite, position) => {
    if (position !== index) return favorite;
    const { options: _previous, ...rest } = favorite;
    return options?.length ? { ...rest, options } : rest;
  });
}

export function addFavorite(
  favorites: ReadonlyArray<ModelFavorite>,
  favorite: Pick<ModelFavorite, "provider" | "model">,
): ReadonlyArray<ModelFavorite> {
  return favorites.some(
    (entry) => entry.provider === favorite.provider && entry.model === favorite.model,
  )
    ? favorites
    : [...favorites, { provider: favorite.provider, model: favorite.model }];
}

/** Why a step cannot be added, or null: the slider holds six, and a step is added once. */
export function effortSliderAddBlockReason(
  steps: ReadonlyArray<ModelSelection>,
  step: ModelSelection,
): string | null {
  if (steps.length >= MAX_EFFORT_SLIDER_STEPS) {
    return `The slider holds up to ${MAX_EFFORT_SLIDER_STEPS} steps.`;
  }
  const effortOf = (selection: ModelSelection) =>
    JSON.stringify(selection.options?.map((option) => [option.id, option.value]) ?? []);
  return steps.some(
    (entry) =>
      entry.instanceId === step.instanceId &&
      entry.model === step.model &&
      effortOf(entry) === effortOf(step),
  )
    ? "That model and effort is already on the slider."
    : null;
}

export function setSliderStepOptions(
  steps: ReadonlyArray<ModelSelection>,
  index: number,
  options: ReadonlyArray<ProviderOptionSelection> | undefined,
): ReadonlyArray<ModelSelection> {
  return steps.map((step, position) =>
    position === index ? createModelSelection(step.instanceId, step.model, options) : step,
  );
}
