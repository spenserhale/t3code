import { describe, expect, it } from "vite-plus/test";
import {
  buildEffortModelIndex,
  buildEffortVariantDescriptor,
  EFFORT_VARIANT_OPTION_ID,
  resolveEffortModelVariant,
  resolveEffortVariantSlug,
  stripSyntheticEffortOptions,
  type EffortModelLike,
} from "./effortModelNormalization.ts";

describe("effortModelNormalization", () => {
  it("groups prebuilt Google/Antigravity effort-in-name models including irregular Gemini 3.1 Pro slugs", () => {
    const models: ReadonlyArray<EffortModelLike> = [
      { slug: "gemini-4-carbon", name: "Gemini 4 Carbon" },
      { slug: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", isDefault: true },
      { slug: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
      { slug: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
      { slug: "gemini-pro-agent", name: "Gemini 3.1 Pro (High)", isLegacy: true },
      { slug: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)", isLegacy: true },
    ];

    const index = buildEffortModelIndex(models);

    expect(index.entries).toHaveLength(3);
    expect(index.entries[0]).toMatchObject({
      kind: "model",
      model: { slug: "gemini-4-carbon" },
    });

    const flashEntry = index.entries[1]!;
    expect(flashEntry.kind).toBe("group");
    if (flashEntry.kind === "group") {
      expect(flashEntry.group.displayName).toBe("Gemini 3.8 Flash");
      expect(flashEntry.group.source).toBe("prebuilt");
      expect(flashEntry.group.isDefault).toBe(true);
      expect(flashEntry.group.isLegacy).toBe(false);
      expect(flashEntry.group.representativeSlug).toBe("gemini-3.8-flash-high");
      expect(flashEntry.group.variants.map((variant) => [variant.effort, variant.slug])).toEqual([
        ["low", "gemini-3.8-flash-low"],
        ["medium", "gemini-3.8-flash-medium"],
        ["high", "gemini-3.8-flash-high"],
      ]);
    }

    const proEntry = index.entries[2]!;
    expect(proEntry.kind).toBe("group");
    if (proEntry.kind === "group") {
      expect(proEntry.group.displayName).toBe("Gemini 3.1 Pro");
      expect(proEntry.group.source).toBe("prebuilt");
      expect(proEntry.group.isLegacy).toBe(true);
      expect(proEntry.group.representativeSlug).toBe("gemini-pro-agent");
      expect(proEntry.group.variants.map((variant) => [variant.effort, variant.slug])).toEqual([
        ["low", "gemini-3.1-pro-low"],
        ["high", "gemini-pro-agent"],
      ]);
      expect(resolveEffortVariantSlug(proEntry.group, "high")).toBe("gemini-pro-agent");
      expect(resolveEffortVariantSlug(proEntry.group, "low")).toBe("gemini-3.1-pro-low");
    }
  });

  it("automatically detects unseen effort-in-name models from parenthesized names, separated names, and slug suffixes", () => {
    const models: ReadonlyArray<EffortModelLike> = [
      // Parenthesized with irregular slugs
      { slug: "gemini-5-pro-agent", name: "Gemini 5 Pro (Extra High)" },
      { slug: "gemini-5-pro-mid", name: "Gemini 5 Pro (Medium)" },
      { slug: "gemini-5-pro-min", name: "Gemini 5 Pro (Minimal)" },
      // Dash-separated display names
      { slug: "future-flash-a", name: "Future Flash - High" },
      { slug: "future-flash-b", name: "Future Flash - Low" },
      // Slug-only / space-separated display names
      { slug: "google/gemini-4-neon-high", name: "Gemini 4 Neon High" },
      { slug: "google/gemini-4-neon-low", name: "Gemini 4 Neon Low" },
    ];

    const index = buildEffortModelIndex(models);
    expect(index.groups).toHaveLength(3);

    expect(index.groups[0]!.displayName).toBe("Gemini 5 Pro");
    expect(index.groups[0]!.source).toBe("detected");
    expect(index.groups[0]!.representativeSlug).toBe("gemini-5-pro-agent");
    expect(index.groups[0]!.variants.map((variant) => variant.effort)).toEqual([
      "minimal",
      "medium",
      "xhigh",
    ]);

    expect(index.groups[1]!.displayName).toBe("Future Flash");
    expect(index.groups[1]!.variants.map((variant) => variant.effort)).toEqual(["low", "high"]);

    expect(index.groups[2]!.displayName).toBe("Gemini 4 Neon");
    expect(index.groups[2]!.variants.map((variant) => variant.slug)).toEqual([
      "google/gemini-4-neon-low",
      "google/gemini-4-neon-high",
    ]);
  });

  it("guards against false positives: singletons, native reasoning controls, non-effort suffixes, duplicates, and subProviders", () => {
    const models: ReadonlyArray<EffortModelLike> = [
      // Singleton -max model (e.g. Qwen 3.8 Max)
      { slug: "alibaba/qwen3.8-max", name: "Qwen 3.8 Max" },
      // Singleton prebuilt variant (e.g. user hid Low & Medium)
      { slug: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
      // Non-effort suffixes
      { slug: "claude-sonnet-4-fast", name: "Claude Sonnet 4 (Fast)" },
      { slug: "claude-sonnet-4-mini", name: "Claude Sonnet 4 (Mini)" },
      // Native reasoning descriptor must never be collapsed
      {
        slug: "gemini-4-native-high",
        name: "Gemini 4 Native (High)",
        capabilities: {
          optionDescriptors: [
            {
              id: "thought_level",
              label: "Thinking",
              type: "select",
              role: "reasoning",
              options: [
                { id: "low", label: "Low" },
                { id: "high", label: "High" },
              ],
            },
          ],
        },
      },
      {
        slug: "gemini-4-native-low",
        name: "Gemini 4 Native (Low)",
        capabilities: {
          optionDescriptors: [
            {
              id: "thought_level",
              label: "Thinking",
              type: "select",
              role: "reasoning",
              options: [
                { id: "low", label: "Low" },
                { id: "high", label: "High" },
              ],
            },
          ],
        },
      },
      // Duplicate colliding effort levels must not collapse (no model becomes unreachable)
      { slug: "dup-model-v1-high", name: "Dup Model (High)" },
      { slug: "dup-model-v2-high", name: "Dup Model (High)" },
      { slug: "dup-model-low", name: "Dup Model (Low)" },
      // Different subProviders must not merge together
      { slug: "gemini-4-x-high", name: "Gemini 4 X (High)", subProvider: "vertex" },
      { slug: "gemini-4-x-low", name: "Gemini 4 X (Low)", subProvider: "google" },
      // Custom vs built-in must not merge together
      { slug: "gemini-4-y-high", name: "Gemini 4 Y (High)", isCustom: true },
      { slug: "gemini-4-y-low", name: "Gemini 4 Y (Low)", isCustom: false },
    ];

    const index = buildEffortModelIndex(models);
    expect(index.groups).toHaveLength(0);
    expect(index.entries).toHaveLength(models.length);
    expect(index.entries.every((entry) => entry.kind === "model")).toBe(true);
  });

  it("builds a synthetic reasoning descriptor and strips the synthetic id from option selections", () => {
    const models: ReadonlyArray<EffortModelLike> = [
      { slug: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", isDefault: true },
      { slug: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
      { slug: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
    ];

    const resolved = resolveEffortModelVariant(models, "gemini-3.8-flash-low");
    expect(resolved).not.toBeNull();
    const descriptor = buildEffortVariantDescriptor(resolved!.group, resolved!.variant.effort);

    expect(descriptor).toEqual({
      id: EFFORT_VARIANT_OPTION_ID,
      label: "Effort",
      type: "select",
      role: "reasoning",
      currentValue: "low",
      options: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High", isDefault: true },
      ],
    });

    expect(
      stripSyntheticEffortOptions([
        { id: EFFORT_VARIANT_OPTION_ID, value: "low" },
        { id: "mode", value: "code" },
      ]),
    ).toEqual([{ id: "mode", value: "code" }]);
    expect(stripSyntheticEffortOptions([{ id: EFFORT_VARIANT_OPTION_ID, value: "low" }])).toBe(
      undefined,
    );
  });

  it("marks a group legacy only when every variant is legacy", () => {
    const models: ReadonlyArray<EffortModelLike> = [
      { slug: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", isLegacy: false },
      { slug: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)", isLegacy: true },
    ];

    const index = buildEffortModelIndex(models);
    expect(index.groups).toHaveLength(1);
    expect(index.groups[0]!.isLegacy).toBe(false);
  });
});
