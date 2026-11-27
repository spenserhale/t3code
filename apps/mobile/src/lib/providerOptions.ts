import type {
  ModelCapabilities,
  ModelSelection,
  ProviderInstanceId,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  ServerProviderModel,
} from "@t3tools/contracts";
import {
  buildEffortModelIndex,
  buildEffortVariantDescriptor,
  EFFORT_VARIANT_OPTION_ID,
  resolveEffortModelVariant,
  resolveEffortVariantSlug,
  stripSyntheticEffortOptions,
  type EffortModelLike,
} from "@t3tools/shared/effortModelNormalization";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
  withImplicitFastModeDefault,
} from "@t3tools/shared/model";
import type { ModelOption, ProviderGroup } from "./modelOptions";

export type EffortModelOption = EffortModelLike & {
  readonly option: ModelOption;
};

export function toEffortModelOption(option: ModelOption): EffortModelOption {
  return {
    slug: option.selection.model,
    name: option.label,
    ...(option.shortName ? { shortName: option.shortName } : {}),
    ...(option.subtitle ? { subProvider: option.subtitle } : {}),
    isDefault: option.isDefault,
    isLegacy: option.isLegacy,
    ...(option.isUnavailable ? { isUnavailable: true } : {}),
    capabilities: option.capabilities,
    option,
  };
}

export function resolveEffortVariantOptionForGroup(input: {
  readonly models: ReadonlyArray<ModelOption>;
  readonly currentModel: string;
  readonly targetEffort: string;
}): ModelOption | null {
  const match = resolveEffortModelVariant(
    input.models.map(toEffortModelOption),
    input.currentModel,
  );
  if (!match) return null;
  const targetSlug = resolveEffortVariantSlug(match.group, input.targetEffort);
  if (!targetSlug) return null;
  return input.models.find((option) => option.selection.model === targetSlug) ?? null;
}

export function normalizeEffortProviderGroups(
  groups: ReadonlyArray<ProviderGroup>,
  activeSelection: ModelSelection | null | undefined,
): ReadonlyArray<ProviderGroup> {
  return groups.map((group) => {
    const index = buildEffortModelIndex(group.models.map(toEffortModelOption));
    if (index.byRawSlug.size === 0) {
      return group;
    }
    const normalizedModels: ModelOption[] = [];
    for (const entry of index.entries) {
      if (entry.kind === "model") {
        normalizedModels.push(entry.model.option);
        continue;
      }
      const { group: effortGroup } = entry;
      const activeMember =
        activeSelection && activeSelection.instanceId === group.providerKey
          ? effortGroup.variants.find((variant) => variant.slug === activeSelection.model)
          : undefined;
      const representative =
        activeMember ??
        effortGroup.variants.find((variant) => variant.slug === effortGroup.representativeSlug) ??
        effortGroup.defaultVariant;
      const baseOption = representative.model.option;
      const isUnavailable = effortGroup.variants.every(
        (variant) => variant.model.option.isUnavailable === true,
      );
      normalizedModels.push({
        ...baseOption,
        label: effortGroup.displayName,
        ...(baseOption.shortName ? { shortName: effortGroup.displayName } : {}),
        isLegacy: effortGroup.isLegacy,
        ...(isUnavailable ? { isUnavailable: true } : { isUnavailable: false }),
      });
    }
    return {
      ...group,
      models: normalizedModels,
    };
  });
}

export function resolveProviderOptionDescriptors(input: {
  readonly capabilities: ModelCapabilities | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly models?: ReadonlyArray<EffortModelLike> | undefined;
  readonly model?: string | null | undefined;
  readonly effortLabel?: string | undefined;
}): ReadonlyArray<ProviderOptionDescriptor> {
  const realDescriptors = input.capabilities
    ? getProviderOptionDescriptors({
        caps: input.capabilities,
        selections: withImplicitFastModeDefault(input.capabilities, input.selections),
      })
    : [];
  if (!input.models || !input.model) {
    return realDescriptors;
  }
  const effortMatch = resolveEffortModelVariant(input.models, input.model);
  if (!effortMatch) {
    return realDescriptors;
  }
  return [
    ...realDescriptors,
    buildEffortVariantDescriptor(effortMatch.group, effortMatch.variant.effort, input.effortLabel),
  ];
}

/** Spells out the Fast off the picker shows, or a provider such as Cursor applies its own default. */
export function withImplicitFastModeSelection(
  selection: ModelSelection,
  providers: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly models: ReadonlyArray<Pick<ServerProviderModel, "slug" | "capabilities">>;
  }>,
): ModelSelection {
  const capabilities = providers
    .find((provider) => provider.instanceId === selection.instanceId)
    ?.models.find((model) => model.slug === selection.model)?.capabilities;
  const options = capabilities
    ? withImplicitFastModeDefault(capabilities, selection.options)
    : selection.options;
  return options === selection.options ? selection : { ...selection, options };
}

export function applyProviderOptionSelection(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  change: ProviderOptionSelection,
): ReadonlyArray<ProviderOptionSelection> | null {
  if (change.id === EFFORT_VARIANT_OPTION_ID) {
    return null;
  }
  const realDescriptors = descriptors.filter(
    (candidate) => candidate.id !== EFFORT_VARIANT_OPTION_ID,
  );
  const descriptor = realDescriptors.find((candidate) => candidate.id === change.id);
  if (!descriptor) {
    return null;
  }
  if (
    (descriptor.type === "boolean" && typeof change.value !== "boolean") ||
    (descriptor.type === "select" &&
      (typeof change.value !== "string" ||
        !descriptor.options.some((option) => option.id === change.value)))
  ) {
    return null;
  }

  const nextDescriptors = realDescriptors.map((candidate) =>
    candidate.id === descriptor.id
      ? {
          ...candidate,
          currentValue: change.value,
        }
      : candidate,
  ) as ReadonlyArray<ProviderOptionDescriptor>;

  return (
    stripSyntheticEffortOptions(buildProviderOptionSelectionsFromDescriptors(nextDescriptors)) ?? []
  );
}
