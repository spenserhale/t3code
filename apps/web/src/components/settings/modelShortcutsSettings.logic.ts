import { effortSliderStepIdentity } from "@t3tools/client-runtime/effort-slider";
import {
  MAX_EFFORT_SLIDER_STEPS,
  type ModelFavorite,
  type ModelSelection,
  type ProviderOptionSelection,
  type ServerSettingsPatch,
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

/**
 * A favorite keeps its place and gains or loses its saved effort; no options means last used.
 * The server keeps an effort a whole list does not mention, so clearing one says so with an
 * empty list.
 */
export function setFavoriteOptions(
  favorites: ReadonlyArray<ModelFavorite>,
  index: number,
  options: ReadonlyArray<ProviderOptionSelection> | undefined,
): ReadonlyArray<ModelFavorite> {
  return favorites.map((favorite, position) => {
    if (position !== index) return favorite;
    const { options: previous, ...rest } = favorite;
    if (options?.length) return { ...rest, options };
    return previous?.length ? { ...rest, options: [] } : rest;
  });
}

type FavoriteName = Pick<ModelFavorite, "provider" | "model">;

export type FavoritesEdit =
  | { readonly kind: "add"; readonly favorite: FavoriteName }
  | { readonly kind: "remove"; readonly favorite: FavoriteName }
  | {
      readonly kind: "effort";
      readonly favorite: FavoriteName;
      readonly options: ReadonlyArray<ProviderOptionSelection> | undefined;
    }
  | { readonly kind: "move"; readonly list: ReadonlyArray<FavoriteName> }
  /** The list as given, such as a project's first copy of the environment's. */
  | { readonly kind: "replace" };

/**
 * One environment is sent the change itself, which its server applies to the list it holds now,
 * so a favorite another client added since this page loaded survives. All environments is a bulk
 * edit: every list is replaced whole, with every effort spelled out so none survives unchosen. A
 * project's list is written whole too, as upstream writes every project override whole.
 */
export function planFavoritesWrite(input: {
  readonly scope: "environment" | "all" | "project";
  /** The one environment an environment scope writes to: its own list and capability decide. */
  readonly destination: {
    /** The environment keeps its favorites on the server, not only in this client's old copy. */
    readonly listOnServer: boolean;
    /** The environment can reorder favorites by intent. */
    readonly reorderSupported: boolean;
  };
  /** The list as it reads after the edit. */
  readonly list: ReadonlyArray<ModelFavorite>;
  readonly edit: FavoritesEdit;
}): ServerSettingsPatch {
  if (input.scope === "project") {
    return {
      favorites: input.list.map(({ options, ...rest }) =>
        options?.length ? { ...rest, options } : rest,
      ),
    };
  }
  const whole = {
    favorites: input.list.map((favorite) => ({
      ...favorite,
      options: favorite.options?.length ? favorite.options : [],
    })),
  };
  const { edit, destination } = input;
  if (
    input.scope === "all" ||
    edit.kind === "replace" ||
    !destination.listOnServer ||
    (edit.kind === "move" && !destination.reorderSupported)
  ) {
    return whole;
  }
  const named = (favorite: FavoriteName) => ({
    provider: favorite.provider,
    model: favorite.model,
  });
  switch (edit.kind) {
    case "move":
      return { reorderModelFavorites: edit.list.map(named) };
    case "add":
      return { setModelFavorites: [{ ...named(edit.favorite), favorite: true }] };
    case "remove":
      return { setModelFavorites: [{ ...named(edit.favorite), favorite: false }] };
    case "effort":
      return {
        setModelFavorites: [
          {
            ...named(edit.favorite),
            favorite: true,
            options: edit.options?.length ? edit.options : [],
          },
        ],
      };
  }
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

const ALREADY_ON_SLIDER = "That model and effort is already on the slider.";

/** The level a step runs at: its own, else the model's default; null for a model without one. */
type EffortOf = (selection: ModelSelection) => string | null;

const stepIdentity = (selection: ModelSelection, effortOf: EffortOf) =>
  effortSliderStepIdentity(selection, effortOf(selection));

/** Why a step cannot be added, or null: the slider holds six, and a stop is on it once. */
export function effortSliderAddBlockReason(
  steps: ReadonlyArray<ModelSelection>,
  step: ModelSelection,
  effortOf: EffortOf,
): string | null {
  if (steps.length >= MAX_EFFORT_SLIDER_STEPS) {
    return `The slider holds up to ${MAX_EFFORT_SLIDER_STEPS} steps.`;
  }
  const identity = stepIdentity(step, effortOf);
  return steps.some((entry) => stepIdentity(entry, effortOf) === identity)
    ? ALREADY_ON_SLIDER
    : null;
}

/** Why a step cannot become `next`, or null: it would repeat another step on the slider. */
export function effortSliderEditBlockReason(
  steps: ReadonlyArray<ModelSelection>,
  index: number,
  next: ModelSelection,
  effortOf: EffortOf,
): string | null {
  const identity = stepIdentity(next, effortOf);
  return steps.some(
    (entry, position) => position !== index && stepIdentity(entry, effortOf) === identity,
  )
    ? ALREADY_ON_SLIDER
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
