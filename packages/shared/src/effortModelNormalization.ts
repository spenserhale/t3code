import type {
  ModelCapabilities,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
} from "@t3tools/contracts";

/**
 * UI-only option id presenting effort-in-name variants as an effort selector.
 * Never persist into `ModelSelection.options`; selecting it switches the raw slug.
 */
export const EFFORT_VARIANT_OPTION_ID = "__effortVariant__";

export type NormalizedEffortLevel =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

const EFFORT_LEVEL_RANK: Readonly<Record<NormalizedEffortLevel, number>> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

const EFFORT_LEVEL_LABELS: Readonly<Record<NormalizedEffortLevel, string>> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

const CORE_EFFORT_LEVELS: ReadonlySet<NormalizedEffortLevel> = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

const NATIVE_REASONING_DESCRIPTOR_IDS: ReadonlySet<string> = new Set([
  "reasoningEffort",
  "effort",
  "reasoning",
  "variant",
  "reasoning_effort",
  "thinking_level",
  "thought_level",
  "thinking",
]);

export interface PrebuiltEffortModelSpec {
  readonly groupKey: string;
  readonly displayName: string;
  readonly effort: NormalizedEffortLevel;
  readonly preferredDefaultEffort?: NormalizedEffortLevel;
}

/**
 * Prebuilt registry of known models whose thinking/reasoning effort is encoded
 * directly in the model slug/name instead of a separate reasoning option
 * (notably Google / Antigravity models, including irregular slug pairs such as
 * `gemini-pro-agent` + `gemini-3.1-pro-low`).
 */
const PREBUILT_EFFORT_IN_NAME_MODELS: Readonly<Record<string, PrebuiltEffortModelSpec>> = {
  // Gemini 3.8 Flash
  "gemini-3.8-flash-low": {
    groupKey: "gemini-3.8-flash",
    displayName: "Gemini 3.8 Flash",
    effort: "low",
    preferredDefaultEffort: "high",
  },
  "gemini-3.8-flash-medium": {
    groupKey: "gemini-3.8-flash",
    displayName: "Gemini 3.8 Flash",
    effort: "medium",
    preferredDefaultEffort: "high",
  },
  "gemini-3.8-flash-high": {
    groupKey: "gemini-3.8-flash",
    displayName: "Gemini 3.8 Flash",
    effort: "high",
    preferredDefaultEffort: "high",
  },
  // Gemini 3.7 Flash
  "gemini-3.7-flash-low": {
    groupKey: "gemini-3.7-flash",
    displayName: "Gemini 3.7 Flash",
    effort: "low",
    preferredDefaultEffort: "high",
  },
  "gemini-3.7-flash-medium": {
    groupKey: "gemini-3.7-flash",
    displayName: "Gemini 3.7 Flash",
    effort: "medium",
    preferredDefaultEffort: "high",
  },
  "gemini-3.7-flash-high": {
    groupKey: "gemini-3.7-flash",
    displayName: "Gemini 3.7 Flash",
    effort: "high",
    preferredDefaultEffort: "high",
  },
  // Gemini 3.6 Flash
  "gemini-3.6-flash-low": {
    groupKey: "gemini-3.6-flash",
    displayName: "Gemini 3.6 Flash",
    effort: "low",
    preferredDefaultEffort: "high",
  },
  "gemini-3.6-flash-medium": {
    groupKey: "gemini-3.6-flash",
    displayName: "Gemini 3.6 Flash",
    effort: "medium",
    preferredDefaultEffort: "high",
  },
  "gemini-3.6-flash-high": {
    groupKey: "gemini-3.6-flash",
    displayName: "Gemini 3.6 Flash",
    effort: "high",
    preferredDefaultEffort: "high",
  },
  // Gemini 3.1 Pro (irregular High slug `gemini-pro-agent` paired with `gemini-3.1-pro-low`)
  "gemini-pro-agent": {
    groupKey: "gemini-3.1-pro",
    displayName: "Gemini 3.1 Pro",
    effort: "high",
    preferredDefaultEffort: "high",
  },
  "gemini-3.1-pro-low": {
    groupKey: "gemini-3.1-pro",
    displayName: "Gemini 3.1 Pro",
    effort: "low",
    preferredDefaultEffort: "high",
  },
  "gemini-3.1-pro-medium": {
    groupKey: "gemini-3.1-pro",
    displayName: "Gemini 3.1 Pro",
    effort: "medium",
    preferredDefaultEffort: "high",
  },
  "gemini-3.1-pro-high": {
    groupKey: "gemini-3.1-pro",
    displayName: "Gemini 3.1 Pro",
    effort: "high",
    preferredDefaultEffort: "high",
  },
  // Gemini 3 Pro
  "gemini-3-pro-low": {
    groupKey: "gemini-3-pro",
    displayName: "Gemini 3 Pro",
    effort: "low",
    preferredDefaultEffort: "high",
  },
  "gemini-3-pro-medium": {
    groupKey: "gemini-3-pro",
    displayName: "Gemini 3 Pro",
    effort: "medium",
    preferredDefaultEffort: "high",
  },
  "gemini-3-pro-high": {
    groupKey: "gemini-3-pro",
    displayName: "Gemini 3 Pro",
    effort: "high",
    preferredDefaultEffort: "high",
  },
};

export interface EffortModelLike {
  readonly slug: string;
  readonly name: string;
  readonly isCustom?: boolean | undefined;
  readonly isDefault?: boolean | undefined;
  readonly isLegacy?: boolean | undefined;
  readonly subProvider?: string | undefined;
  readonly capabilities?: ModelCapabilities | null | undefined;
}

export interface EffortModelVariant<T extends EffortModelLike = EffortModelLike> {
  readonly slug: string;
  readonly effort: NormalizedEffortLevel;
  readonly effortLabel: string;
  readonly model: T;
  readonly originalIndex: number;
}

export interface EffortModelGroup<T extends EffortModelLike = EffortModelLike> {
  readonly key: string;
  readonly displayName: string;
  /** Raw slug of the group's default variant (used as stable representative key). */
  readonly representativeSlug: string;
  readonly defaultVariant: EffortModelVariant<T>;
  /** Variants sorted in canonical ascending effort order. */
  readonly variants: ReadonlyArray<EffortModelVariant<T>>;
  readonly firstOriginalIndex: number;
  readonly isDefault: boolean;
  readonly isLegacy: boolean;
  readonly isCustom: boolean;
  readonly subProvider?: string | undefined;
  readonly source: "prebuilt" | "detected";
}

export type NormalizedModelEntry<T extends EffortModelLike = EffortModelLike> =
  | { readonly kind: "group"; readonly group: EffortModelGroup<T> }
  | { readonly kind: "model"; readonly model: T };

export interface EffortModelIndex<T extends EffortModelLike = EffortModelLike> {
  readonly groups: ReadonlyArray<EffortModelGroup<T>>;
  readonly byRawSlug: ReadonlyMap<
    string,
    { readonly group: EffortModelGroup<T>; readonly variant: EffortModelVariant<T> }
  >;
  readonly entries: ReadonlyArray<NormalizedModelEntry<T>>;
}

interface ParsedEffortCandidate {
  readonly bucketBaseKey: string;
  readonly displayName: string;
  readonly effort: NormalizedEffortLevel;
  readonly preferredDefaultEffort?: NormalizedEffortLevel;
  readonly source: "prebuilt" | "detected";
}

const EFFORT_TOKEN_MAP: Readonly<Record<string, NormalizedEffortLevel>> = {
  none: "none",
  off: "none",
  minimal: "minimal",
  min: "minimal",
  low: "low",
  medium: "medium",
  med: "medium",
  high: "high",
  xhigh: "xhigh",
  "x-high": "xhigh",
  "extra high": "xhigh",
  "extra-high": "xhigh",
  extrahigh: "xhigh",
  max: "max",
};

const PAREN_EFFORT_RE = /^(.+?)\s*\(\s*([^()]+?)\s*\)$/;
const SEPARATOR_EFFORT_RE = /^(.+?)\s*[-–—·:]\s*([a-z][a-z\s-]*)$/i;
const SPACE_EFFORT_RE = /^(.+?)\s+(extra\s+high|x-?high|minimal|medium|high|low|med|max|none)$/i;
const SLUG_EFFORT_RE =
  /^(.+?)[-_:/](extra[-_]?high|x[-_]?high|minimal|medium|high|low|med|max|none)$/i;

function parseEffortToken(raw: string): NormalizedEffortLevel | null {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/\s+(?:thinking|effort|reasoning)$/i, "")
    .replace(/\s+/g, " ");
  return EFFORT_TOKEN_MAP[cleaned] ?? null;
}

function splitSlashPrefix(slug: string): { readonly prefix: string; readonly leaf: string } {
  const slashIndex = slug.lastIndexOf("/");
  if (slashIndex <= 0) {
    return { prefix: "", leaf: slug };
  }
  return {
    prefix: slug.slice(0, slashIndex).toLowerCase(),
    leaf: slug.slice(slashIndex + 1),
  };
}

function normalizeBaseKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");
}

function hasNativeReasoningDescriptor(capabilities: ModelCapabilities | null | undefined): boolean {
  const descriptors = capabilities?.optionDescriptors;
  if (!descriptors || descriptors.length === 0) {
    return false;
  }
  return descriptors.some(
    (descriptor) =>
      (descriptor.type === "select" && descriptor.role === "reasoning") ||
      NATIVE_REASONING_DESCRIPTOR_IDS.has(descriptor.id),
  );
}

function formatNormalizedEffortLabel(effort: NormalizedEffortLevel): string {
  return EFFORT_LEVEL_LABELS[effort];
}

function parseEffortCandidate(model: EffortModelLike): ParsedEffortCandidate | null {
  if (hasNativeReasoningDescriptor(model.capabilities)) {
    return null;
  }

  const trimmedSlug = model.slug.trim();
  const trimmedName = model.name.trim();
  if (!trimmedSlug) {
    return null;
  }

  // 1. Prebuilt known-model list (matches exact slug or provider-prefixed leaf slug).
  const lowerSlug = trimmedSlug.toLowerCase();
  const directPrebuilt = PREBUILT_EFFORT_IN_NAME_MODELS[lowerSlug];
  if (directPrebuilt) {
    return {
      bucketBaseKey: `prebuilt:${directPrebuilt.groupKey}`,
      displayName: directPrebuilt.displayName,
      effort: directPrebuilt.effort,
      ...(directPrebuilt.preferredDefaultEffort
        ? { preferredDefaultEffort: directPrebuilt.preferredDefaultEffort }
        : {}),
      source: "prebuilt",
    };
  }

  const { prefix, leaf } = splitSlashPrefix(trimmedSlug);
  if (prefix) {
    const leafPrebuilt = PREBUILT_EFFORT_IN_NAME_MODELS[leaf.toLowerCase()];
    if (leafPrebuilt) {
      return {
        bucketBaseKey: `prebuilt:${prefix}/${leafPrebuilt.groupKey}`,
        displayName: leafPrebuilt.displayName,
        effort: leafPrebuilt.effort,
        ...(leafPrebuilt.preferredDefaultEffort
          ? { preferredDefaultEffort: leafPrebuilt.preferredDefaultEffort }
          : {}),
        source: "prebuilt",
      };
    }
  }

  // 2. Display-name parenthesized qualifier: e.g. "Gemini 4 Neon (High)"
  if (trimmedName) {
    const parenMatch = PAREN_EFFORT_RE.exec(trimmedName);
    if (parenMatch) {
      const baseName = parenMatch[1]!.trim();
      const effort = parseEffortToken(parenMatch[2]!);
      if (baseName.length >= 2 && effort) {
        return {
          bucketBaseKey: `name:${prefix ? `${prefix}/` : ""}${normalizeBaseKey(baseName)}`,
          displayName: baseName,
          effort,
          source: "detected",
        };
      }
    }

    // 3. Display-name separated qualifier: e.g. "Gemini 4 Neon - High" or "Gemini 4 Neon · Low"
    const sepMatch = SEPARATOR_EFFORT_RE.exec(trimmedName);
    if (sepMatch) {
      const baseName = sepMatch[1]!.trim();
      const effort = parseEffortToken(sepMatch[2]!);
      if (baseName.length >= 2 && effort) {
        return {
          bucketBaseKey: `name:${prefix ? `${prefix}/` : ""}${normalizeBaseKey(baseName)}`,
          displayName: baseName,
          effort,
          source: "detected",
        };
      }
    }
  }

  // 4. Slug suffix fallback: e.g. "gemini-4-neon-high" (with or without matching trailing word in name)
  const slugMatch = SLUG_EFFORT_RE.exec(leaf);
  if (slugMatch) {
    const baseLeaf = slugMatch[1]!.trim();
    const effort = parseEffortToken(slugMatch[2]!);
    if (baseLeaf.length >= 2 && effort) {
      let displayName = trimmedName || (prefix ? `${prefix}/${baseLeaf}` : baseLeaf);
      if (trimmedName) {
        const spaceMatch = SPACE_EFFORT_RE.exec(trimmedName);
        if (spaceMatch && parseEffortToken(spaceMatch[2]!) === effort) {
          displayName = spaceMatch[1]!.trim();
        } else {
          const nameSlugMatch = SLUG_EFFORT_RE.exec(trimmedName);
          if (nameSlugMatch && parseEffortToken(nameSlugMatch[2]!) === effort) {
            displayName = nameSlugMatch[1]!.trim();
          }
        }
      }
      return {
        bucketBaseKey: `slug:${prefix ? `${prefix}/` : ""}${normalizeBaseKey(baseLeaf)}`,
        displayName: displayName || baseLeaf,
        effort,
        source: "detected",
      };
    }
  }

  return null;
}

function compareEffortLevel(a: NormalizedEffortLevel, b: NormalizedEffortLevel): number {
  return EFFORT_LEVEL_RANK[a] - EFFORT_LEVEL_RANK[b];
}

/**
 * Groups models encoding thinking effort in their name/slug. Skips models with
 * native reasoning descriptors, requires >= 2 unique levels per bucket, and
 * rejects duplicate-effort collisions.
 */
export function buildEffortModelIndex<T extends EffortModelLike>(
  models: ReadonlyArray<T>,
): EffortModelIndex<T> {
  interface BucketEntry {
    readonly model: T;
    readonly originalIndex: number;
    readonly candidate: ParsedEffortCandidate;
  }

  const buckets = new Map<string, BucketEntry[]>();
  const modelToBucketKey = new Map<number, string>();

  for (let index = 0; index < models.length; index += 1) {
    const model = models[index]!;
    const candidate = parseEffortCandidate(model);
    if (!candidate) {
      continue;
    }
    const bucketKey = [
      model.subProvider ?? "",
      model.isCustom ? "1" : "0",
      candidate.bucketBaseKey,
    ].join("\0");
    let list = buckets.get(bucketKey);
    if (!list) {
      list = [];
      buckets.set(bucketKey, list);
    }
    list.push({ model, originalIndex: index, candidate });
    modelToBucketKey.set(index, bucketKey);
  }

  const validGroupsByBucketKey = new Map<string, EffortModelGroup<T>>();
  const byRawSlug = new Map<
    string,
    { readonly group: EffortModelGroup<T>; readonly variant: EffortModelVariant<T> }
  >();

  for (const [bucketKey, members] of buckets) {
    if (members.length < 2) {
      continue;
    }

    // Refuse to collapse if two distinct slugs collide on the same effort level.
    const seenEfforts = new Set<NormalizedEffortLevel>();
    let hasCollision = false;
    for (const member of members) {
      if (seenEfforts.has(member.candidate.effort)) {
        hasCollision = true;
        break;
      }
      seenEfforts.add(member.candidate.effort);
    }
    if (hasCollision) {
      continue;
    }

    const isPrebuilt = members.every((member) => member.candidate.source === "prebuilt");
    const hasCoreEffort = members.some((member) => CORE_EFFORT_LEVELS.has(member.candidate.effort));
    if (!isPrebuilt && !hasCoreEffort) {
      continue;
    }

    const variants: Array<EffortModelVariant<T>> = members
      .map((member) => ({
        slug: member.model.slug,
        effort: member.candidate.effort,
        effortLabel: formatNormalizedEffortLabel(member.candidate.effort),
        model: member.model,
        originalIndex: member.originalIndex,
      }))
      .sort((left, right) => compareEffortLevel(left.effort, right.effort));

    const firstMember = members[0]!;
    const preferredDefaultEffort = members.find(
      (member) => member.candidate.preferredDefaultEffort !== undefined,
    )?.candidate.preferredDefaultEffort;

    const defaultVariant =
      variants.find((variant) => variant.model.isDefault === true) ??
      (preferredDefaultEffort
        ? variants.find((variant) => variant.effort === preferredDefaultEffort)
        : undefined) ??
      variants.reduce((earliest, candidate) =>
        candidate.originalIndex < earliest.originalIndex ? candidate : earliest,
      );

    const group: EffortModelGroup<T> = {
      key: bucketKey,
      displayName: firstMember.candidate.displayName,
      representativeSlug: defaultVariant.slug,
      defaultVariant,
      variants,
      firstOriginalIndex: firstMember.originalIndex,
      isDefault: variants.some((variant) => variant.model.isDefault === true),
      isLegacy: variants.every((variant) => variant.model.isLegacy === true),
      isCustom: firstMember.model.isCustom === true,
      ...(firstMember.model.subProvider ? { subProvider: firstMember.model.subProvider } : {}),
      source: isPrebuilt ? "prebuilt" : "detected",
    };

    validGroupsByBucketKey.set(bucketKey, group);
    for (const variant of variants) {
      byRawSlug.set(variant.slug, { group, variant });
    }
  }

  const emittedGroups = new Set<string>();
  const groups: Array<EffortModelGroup<T>> = [];
  const entries: Array<NormalizedModelEntry<T>> = [];

  for (let index = 0; index < models.length; index += 1) {
    const model = models[index]!;
    const bucketKey = modelToBucketKey.get(index);
    const group = bucketKey ? validGroupsByBucketKey.get(bucketKey) : undefined;
    if (!group) {
      entries.push({ kind: "model", model });
      continue;
    }
    if (emittedGroups.has(group.key)) {
      continue;
    }
    emittedGroups.add(group.key);
    groups.push(group);
    entries.push({ kind: "group", group });
  }

  return {
    groups,
    byRawSlug,
    entries,
  };
}

export function resolveEffortModelVariant<T extends EffortModelLike>(
  models: ReadonlyArray<T>,
  modelSlug: string | null | undefined,
): { readonly group: EffortModelGroup<T>; readonly variant: EffortModelVariant<T> } | null {
  if (!modelSlug) {
    return null;
  }
  return buildEffortModelIndex(models).byRawSlug.get(modelSlug) ?? null;
}

export function resolveEffortVariantSlug<T extends EffortModelLike>(
  group: EffortModelGroup<T>,
  effort: string,
): string | null {
  return group.variants.find((variant) => variant.effort === effort)?.slug ?? null;
}

export function buildEffortVariantDescriptor<T extends EffortModelLike>(
  group: EffortModelGroup<T>,
  activeEffort: NormalizedEffortLevel,
  label = "Effort",
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  return {
    id: EFFORT_VARIANT_OPTION_ID,
    label,
    type: "select",
    role: "reasoning",
    currentValue: activeEffort,
    options: group.variants.map((variant) => ({
      id: variant.effort,
      label: variant.effortLabel,
      ...(variant.effort === group.defaultVariant.effort ? { isDefault: true } : {}),
    })),
  };
}

export function stripSyntheticEffortOptions(
  options: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  if (!options || options.length === 0) {
    return options ?? undefined;
  }
  const filtered = options.filter((option) => option.id !== EFFORT_VARIANT_OPTION_ID);
  return filtered.length > 0 ? filtered : undefined;
}
