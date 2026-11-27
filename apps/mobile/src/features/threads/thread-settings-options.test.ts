import {
  getPromptControlledTraits,
  getTraitSelectChange,
} from "@t3tools/client-runtime/model-traits";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ManagedPolicySummary,
  type ProviderOptionDescriptor,
  type RuntimeMode,
} from "@t3tools/contracts";
import { EFFORT_VARIANT_OPTION_ID } from "@t3tools/shared/effortModelNormalization";
import { describe, expect, it } from "vite-plus/test";

import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import {
  applyProviderOptionSelection,
  normalizeEffortProviderGroups,
  resolveEffortVariantOptionForGroup,
  resolveProviderOptionDescriptors,
  toEffortModelOption,
  withImplicitFastModeSelection,
} from "../../lib/providerOptions";
import {
  RUNTIME_MODE_CHOICES,
  resolveNewThreadRuntimeMode,
  selectableChoices,
  withManagedRuntimeModeLimits,
} from "./thread-settings-options";

const policy = (organization: string, maxRuntimeMode?: RuntimeMode): ManagedPolicySummary => ({
  organization,
  lockedSettings: [],
  ...(maxRuntimeMode === undefined ? {} : { limits: { maxRuntimeMode } }),
});

describe("managed runtime mode limits", () => {
  it("disables modes above the strictest target's ceiling with that target's reason", () => {
    const choices = withManagedRuntimeModeLimits(RUNTIME_MODE_CHOICES, [
      policy("Wide Corp", "auto"),
      undefined,
      policy("Narrow Corp", "auto-accept-edits"),
    ]);

    expect(choices.map((choice) => [choice.mode, choice.disabledReason])).toEqual([
      ["approval-required", undefined],
      ["auto-accept-edits", undefined],
      ["auto", "Narrow Corp limits threads to Auto-accept edits."],
      ["full-access", "Wide Corp limits threads to Auto."],
    ]);
  });

  it("drops a new thread's draft mode above the ceiling for the default", () => {
    const capped = policy("Corp", "auto");
    expect(resolveNewThreadRuntimeMode("full-access", "auto", capped)).toBe("auto");
    expect(resolveNewThreadRuntimeMode("approval-required", "auto", capped)).toBe(
      "approval-required",
    );
    expect(resolveNewThreadRuntimeMode(undefined, "auto", capped)).toBe("auto");
    expect(resolveNewThreadRuntimeMode("full-access", "auto", undefined)).toBe("full-access");
  });
});

const effortDescriptor: Extract<ProviderOptionDescriptor, { type: "select" }> = {
  id: "effort",
  label: "Reasoning",
  type: "select",
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium", isDefault: true },
    { id: "high", label: "High" },
    { id: "ultrathink", label: "Ultrathink" },
    { id: "ultracode", label: "Ultracode" },
  ],
  currentValue: "high",
  promptInjectedValues: ["ultrathink"],
};

describe("fast mode switch", () => {
  // regression: #29729 Cursor reports Fast on by default, but its picker shows an unset fastMode as off
  it("shows an unset fast mode as off, saves it as off and turns it on when toggled", () => {
    const capabilities = {
      optionDescriptors: [
        { id: "fastMode", label: "Fast", type: "boolean", currentValue: true } as const,
      ],
    };
    const selection = { instanceId: ProviderInstanceId.make("cursor"), model: "composer-2.5" };
    const descriptors = resolveProviderOptionDescriptors({ capabilities, selections: undefined });
    const shown = descriptors.find((descriptor) => descriptor.id === "fastMode")?.currentValue;

    expect({
      shown,
      saved: withImplicitFastModeSelection(selection, [
        { instanceId: selection.instanceId, models: [{ slug: selection.model, capabilities }] },
      ]).options,
      afterToggle: applyProviderOptionSelection(descriptors, { id: "fastMode", value: !shown }),
    }).toEqual({
      shown: false,
      saved: [{ id: "fastMode", value: false }],
      afterToggle: [{ id: "fastMode", value: true }],
    });
  });
});

describe("selectableChoices", () => {
  // regression: #21406 bring model controls in line with web
  it("leaves out prompt-injected choices and keeps workflow choices in declared order", () => {
    expect(selectableChoices(effortDescriptor).map((choice) => choice.id)).toEqual([
      "low",
      "medium",
      "high",
      "ultracode",
    ]);
  });
});

describe("prompt-controlled reasoning", () => {
  it("removes the prefix when choosing a regular effort and saves Ultracode as an option", () => {
    const descriptors = [effortDescriptor];
    const prompt = "Ultrathink:\nsolve it";
    expect(
      getTraitSelectChange(
        { ...getPromptControlledTraits(descriptors, prompt), descriptors },
        effortDescriptor,
        prompt,
        "ultracode",
      ),
    ).toEqual({ prompt: "solve it", modelOptions: [{ id: "effort", value: "ultracode" }] });
  });

  it("keeps body-controlled Ultrathink locked", () => {
    const descriptors = [effortDescriptor];
    const prompt = "please ultrathink about this";
    const selected = { ...getPromptControlledTraits(descriptors, prompt), descriptors };
    expect(selected.ultrathinkInBodyText).toBe(true);
    expect(getTraitSelectChange(selected, effortDescriptor, prompt, "low")).toBeNull();
  });
});

describe("effort-in-name model normalization", () => {
  const instanceId = ProviderInstanceId.make("antigravity");
  const driver = ProviderDriverKind.make("antigravity");
  const makeOption = (model: string, label: string): ModelOption => ({
    key: `${instanceId}:${model}`,
    providerKey: instanceId,
    providerDriver: driver,
    providerLabel: "Antigravity",
    providerBadge: { displayName: "Antigravity", accentColor: "#000", showBadge: false },
    label,
    subtitle: "",
    isDefault: false,
    isLegacy: false,
    isHidden: false,
    canHide: true,
    selection: { instanceId, model },
    capabilities: {},
  });

  it("collapses effort-in-name variants into one option per model and resolves concrete sibling slugs", () => {
    const models: ModelOption[] = [
      makeOption("gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"),
      makeOption("gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"),
      makeOption("gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"),
      makeOption("gemini-pro-agent", "Gemini 3.1 Pro (High)"),
      makeOption("gemini-3.1-pro-low", "Gemini 3.1 Pro (Low)"),
      makeOption("claude-sonnet-4-6", "Claude Sonnet 4.6"),
    ];
    const groups: ProviderGroup[] = [
      {
        providerKey: instanceId,
        providerLabel: "Antigravity",
        models,
      },
    ];

    const normalized = normalizeEffortProviderGroups(groups, {
      instanceId,
      model: "gemini-3.8-flash-low",
    });
    expect(normalized[0]?.models.map((item) => [item.label, item.selection.model])).toEqual([
      ["Gemini 3.8 Flash", "gemini-3.8-flash-low"],
      ["Gemini 3.1 Pro", "gemini-pro-agent"],
      ["Claude Sonnet 4.6", "claude-sonnet-4-6"],
    ]);

    const descriptors = resolveProviderOptionDescriptors({
      capabilities: {},
      selections: undefined,
      models: models.map(toEffortModelOption),
      model: "gemini-pro-agent",
    });
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({
      id: EFFORT_VARIANT_OPTION_ID,
      role: "reasoning",
      currentValue: "high",
    });

    // Synthetic effort changes never persist into ProviderOptionSelection[]
    expect(
      applyProviderOptionSelection(descriptors, { id: EFFORT_VARIANT_OPTION_ID, value: "low" }),
    ).toBeNull();

    // Selecting "low" resolves to the exact concrete sibling slug
    expect(
      resolveEffortVariantOptionForGroup({
        models,
        currentModel: "gemini-pro-agent",
        targetEffort: "low",
      })?.selection.model,
    ).toBe("gemini-3.1-pro-low");
  });
});
