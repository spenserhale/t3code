import {
  type EnvironmentId,
  isProviderDriverKind,
  MAX_EFFORT_SLIDER_STEPS,
  type ModelFavorite,
  type ModelSelection,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ProviderOptionSelection,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";

import { planFavoritesWrite } from "./modelShortcutsSettings.logic";

/** A connected environment's own lists, as stored on it, with what it can store. */
export interface CompareEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly settings: ServerSettings;
  readonly capabilities: {
    readonly effortSlider?: boolean | undefined;
    readonly providerEffortSliders?: boolean | undefined;
  };
}

export type CompareItem =
  | { readonly kind: "favorites" }
  | { readonly kind: "effortSlider" }
  | { readonly kind: "providerSlider"; readonly driver: ProviderDriverKind };

export interface CompareSummary {
  readonly text: string;
  /** Each entry's model and saved effort, for a tooltip. */
  readonly detail: string;
}

export interface CompareRow {
  readonly environment: CompareEnvironment;
  readonly summary: CompareSummary;
  readonly blockedReason: string | null;
}

export interface ItemComparison {
  readonly item: CompareItem;
  readonly label: string;
  readonly source: CompareSummary;
  readonly differing: readonly CompareRow[];
  readonly same: readonly CompareEnvironment[];
}

type Entry = ModelFavorite | ModelSelection;

export function compareItemKey(item: CompareItem): string {
  return item.kind === "providerSlider" ? `provider:${item.driver}` : item.kind;
}

export function compareItemLabel(item: CompareItem): string {
  switch (item.kind) {
    case "favorites":
      return "Favorite models";
    case "effortSlider":
      return "Favorites slider";
    case "providerSlider":
      return `${PROVIDER_DISPLAY_NAMES[item.driver] ?? item.driver} slider`;
  }
}

/** "A", "A and B", "A, B and C", or with `max` 2: "A, B and 3 more". */
export function listLabels(labels: readonly string[], max = Number.POSITIVE_INFINITY): string {
  if (labels.length > max) {
    return `${labels.slice(0, max).join(", ")} and ${labels.length - max} more`;
  }
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

function visibleSteps(steps: readonly ModelSelection[]) {
  return steps.length > MAX_EFFORT_SLIDER_STEPS ? steps.slice(0, MAX_EFFORT_SLIDER_STEPS) : steps;
}

/** An empty options list and no options both open at what was used last. */
function withoutEmptyOptions<T extends Entry>(entries: readonly T[], keepOptions = true) {
  return entries.map((entry) => {
    const { options, ...rest } = entry;
    return keepOptions && options?.length ? entry : (rest as T);
  });
}

/** The environment's own provider slider, or null when that tab uses the Favorites slider. */
function providerSteps(settings: ServerSettings, driver: ProviderDriverKind) {
  const sliders = settings.providerEffortSliders;
  return sliders && Object.hasOwn(sliders, driver) ? visibleSteps(sliders[driver] ?? []) : null;
}

function readItem(
  settings: ServerSettings,
  item: CompareItem,
  keepOptions = true,
): readonly Entry[] | null {
  switch (item.kind) {
    case "favorites":
      return settings.favorites === null
        ? null
        : withoutEmptyOptions(settings.favorites, keepOptions);
    case "effortSlider":
      return withoutEmptyOptions(visibleSteps(settings.effortSlider));
    case "providerSlider": {
      const steps = providerSteps(settings, item.driver);
      return steps === null ? null : withoutEmptyOptions(steps);
    }
  }
}

function sameItem(source: CompareEnvironment, other: CompareEnvironment, item: CompareItem) {
  // A server without favorite efforts drops them, so its list matches once the models do.
  const keepOptions = item.kind !== "favorites" || other.capabilities.effortSlider === true;
  return Equal.equals(
    readItem(source.settings, item, keepOptions),
    readItem(other.settings, item, keepOptions),
  );
}

function effortText(options: readonly ProviderOptionSelection[] | undefined) {
  return options?.length ? ` · ${options.map((option) => String(option.value)).join(" ")}` : "";
}

function count(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

function summarizeItem(settings: ServerSettings, item: CompareItem): CompareSummary {
  const entries = readItem(settings, item);
  const detail = (entries ?? [])
    .map((entry) => `${entry.model}${effortText(entry.options)}`)
    .join(", ");
  if (entries === null) {
    return {
      text: item.kind === "favorites" ? "Not saved yet" : "Uses Favorites slider",
      detail,
    };
  }
  if (entries.length === 0) return { text: "None", detail };
  return {
    text:
      item.kind === "favorites"
        ? count(entries.length, "model", "models")
        : count(entries.length, "step", "steps"),
    detail,
  };
}

/** How a selected target's slider differs from the one shown: "uses the Favorites slider". */
function describeSliderDifference(
  theirs: { readonly steps: readonly ModelSelection[]; readonly source?: string } | null,
  shown: readonly ModelSelection[],
): string {
  if (theirs === null) return "uses the Favorites slider";
  if (theirs.steps.length === 0) return "has no steps";
  if (theirs.steps.length !== shown.length) {
    return `has ${count(theirs.steps.length, "step", "steps")}`;
  }
  if (!Equal.equals(theirs.steps, shown)) return "has different steps";
  return theirs.source === "environment" ? "uses its environment's slider" : "has its own copy";
}

interface MixedTarget {
  readonly label: string;
  readonly settings: Pick<ServerSettings, "favorites" | "effortSlider">;
}

type ResolvedSlider = { readonly steps: readonly ModelSelection[]; readonly source: string } | null;

/** "Showing LinkPro's list. RW has a different one. ...", or null when none differs from it. */
export function favoritesMixedNote(
  targets: readonly MixedTarget[],
  shown: MixedTarget | null,
): string | null {
  if (shown === null) return null;
  const labels = [
    ...new Set(
      targets
        .filter((target) => !Equal.equals(target.settings.favorites, shown.settings.favorites))
        .map((target) => target.label),
    ),
  ];
  if (labels.length === 0) return null;
  return `Showing ${shown.label}'s list. ${listLabels(labels)} ${labels.length === 1 ? "has" : "have"} a different one. Changing it here replaces theirs.`;
}

/**
 * "Showing LinkPro's OpenCode slider. Torrent uses the Favorites slider. ...", or null when none
 * differs. `provider` holds each target's resolved provider slider, in target order.
 */
export function sliderMixedNote(input: {
  readonly targets: readonly MixedTarget[];
  readonly shown: MixedTarget | null;
  readonly sliderLabel: string;
  readonly steps: readonly ModelSelection[];
  readonly provider?: {
    readonly sliders: readonly ResolvedSlider[];
    readonly shown: ResolvedSlider;
  };
}): string | null {
  const { shown, provider } = input;
  if (shown === null) return null;
  const sentences = input.targets.flatMap((target, index) => {
    if (!provider) {
      return Equal.equals(target.settings.effortSlider, shown.settings.effortSlider)
        ? []
        : [
            `${target.label} ${describeSliderDifference({ steps: visibleSteps(target.settings.effortSlider) }, input.steps)}.`,
          ];
    }
    const slider = provider.sliders[index] ?? null;
    return slider?.source === provider.shown?.source &&
      Equal.equals(slider?.steps, provider.shown?.steps)
      ? []
      : [`${target.label} ${describeSliderDifference(slider, input.steps)}.`];
  });
  if (sentences.length === 0) return null;
  return `Showing ${shown.label}'s ${input.sliderLabel} slider. ${sentences.join(" ")} Saving applies this list to each selected environment.`;
}

/** Why the source's value cannot be written to this destination, or null. */
function copyBlockedReason(
  source: CompareEnvironment,
  destination: CompareEnvironment,
  item: CompareItem,
): string | null {
  if (item.kind === "favorites") {
    return source.settings.favorites === null
      ? `${source.label} has not saved its favorites yet.`
      : null;
  }
  if (destination.capabilities.effortSlider !== true) {
    return `${destination.label} runs a version without effort sliders.`;
  }
  if (item.kind === "providerSlider" && destination.capabilities.providerEffortSliders !== true) {
    return `${destination.label} runs a version without provider sliders.`;
  }
  return null;
}

/** Favorite models, the Favorites slider, then every provider slider one of them has. */
function compareItems(environments: readonly CompareEnvironment[]): CompareItem[] {
  const drivers = new Set<ProviderDriverKind>();
  for (const { settings } of environments) {
    for (const key of Object.keys(settings.providerEffortSliders ?? {})) {
      if (isProviderDriverKind(key)) drivers.add(key);
    }
  }
  const providerItems = [...drivers]
    .map((driver): CompareItem => ({ kind: "providerSlider", driver }))
    .toSorted((a, b) => compareItemLabel(a).localeCompare(compareItemLabel(b)));
  return [{ kind: "favorites" }, { kind: "effortSlider" }, ...providerItems];
}

export function compareWithSource(
  source: CompareEnvironment,
  others: readonly CompareEnvironment[],
): ItemComparison[] {
  return compareItems([source, ...others]).map((item) => {
    const differing: CompareRow[] = [];
    const same: CompareEnvironment[] = [];
    for (const other of others) {
      if (sameItem(source, other, item)) same.push(other);
      else
        differing.push({
          environment: other,
          summary: summarizeItem(other.settings, item),
          blockedReason: copyBlockedReason(source, other, item),
        });
    }
    return {
      item,
      label: compareItemLabel(item),
      source: summarizeItem(source.settings, item),
      differing,
      same,
    };
  });
}

/** "Torrent differs from LinkPro on OpenCode slider.", or null when every list matches. */
export function describeDifferences(
  source: CompareEnvironment,
  others: readonly CompareEnvironment[],
): string | null {
  const differing = compareWithSource(source, others).filter(
    (comparison) => comparison.differing.length > 0,
  );
  if (differing.length === 0) return null;
  const differingIds = new Set(
    differing.flatMap((comparison) =>
      comparison.differing.map((row) => row.environment.environmentId),
    ),
  );
  const environments = others
    .filter((other) => differingIds.has(other.environmentId))
    .map((other) => other.label);
  const items =
    differing.length <= 2
      ? listLabels(differing.map((comparison) => comparison.label))
      : `${differing.length} settings`;
  const verb = environments.length === 1 ? "differs" : "differ";
  return `${listLabels(environments, 2)} ${verb} from ${source.label} on ${items}.`;
}

/**
 * Writes the source's lists to each destination, one write per destination, leaving out the
 * items that already match there and the ones that destination cannot store.
 */
export function planSettingsCopy(
  source: CompareEnvironment,
  destinations: readonly CompareEnvironment[],
  items: readonly CompareItem[],
) {
  const blocked: string[] = [];
  const others = destinations.filter(
    (destination) => destination.environmentId !== source.environmentId,
  );
  const serverWrites = others.flatMap((destination) => {
    const copied = items.filter((item) => {
      if (sameItem(source, destination, item)) return false;
      const reason = copyBlockedReason(source, destination, item);
      if (reason !== null) blocked.push(reason);
      return reason === null;
    });
    const providerEdits = copied.flatMap((item) => {
      if (item.kind !== "providerSlider") return [];
      const steps = providerSteps(source.settings, item.driver);
      return [{ driver: item.driver, steps: steps === null ? null : [...steps] }];
    });
    const patch: ServerSettingsPatch = {
      ...(copied.some((item) => item.kind === "favorites")
        ? planFavoritesWrite({
            scope: "all",
            destination: { listOnServer: true, reorderSupported: true },
            list: source.settings.favorites ?? [],
            edit: { kind: "replace" },
          })
        : {}),
      ...(copied.some((item) => item.kind === "effortSlider")
        ? { effortSlider: [...visibleSteps(source.settings.effortSlider)] }
        : {}),
      ...(providerEdits.length > 0 ? { setProviderEffortSliders: providerEdits } : {}),
    };
    if (copied.length === 0) return [];
    return [
      {
        environmentId: destination.environmentId,
        label: destination.label,
        previous: destination.settings,
        patch,
      },
    ];
  });
  return {
    clientPatch: {},
    hasClientWrite: false,
    serverWrites,
    unavailableReason:
      serverWrites.length > 0 ? null : (blocked[0] ?? "These environments already match."),
  };
}

/**
 * The slider a tab shows on the source but not on the destination, which has none of its own:
 * the tab's provider slider, else the Favorites slider when neither keeps one for that tab.
 */
export function missingSliderItem(
  source: CompareEnvironment,
  destination: CompareEnvironment,
  driver: ProviderDriverKind | null,
): CompareItem | null {
  if (driver !== null && providerSteps(destination.settings, driver) !== null) return null;
  const sourceProviderSteps = driver === null ? null : providerSteps(source.settings, driver);
  const item: CompareItem =
    driver !== null && sourceProviderSteps !== null
      ? { kind: "providerSlider", driver }
      : { kind: "effortSlider" };
  const sourceSteps = sourceProviderSteps ?? visibleSteps(source.settings.effortSlider);
  if (sourceSteps.length < 2) return null;
  if (item.kind === "effortSlider" && visibleSteps(destination.settings.effortSlider).length >= 2) {
    return null;
  }
  return copyBlockedReason(source, destination, item) === null ? item : null;
}
