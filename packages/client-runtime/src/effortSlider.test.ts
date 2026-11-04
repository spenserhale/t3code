import { ProviderInstanceId, type ServerProviderModel } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";
import {
  effortChoices,
  effortSliderIsShown,
  findActiveEffortSliderStep,
  nearestUsableEffortSliderStep,
  nextEffortSliderStep,
  selectedEffort,
} from "./effortSlider.ts";

const instanceId = ProviderInstanceId.make("codex");
const otherInstanceId = ProviderInstanceId.make("claude");

const levels = (defaultId: string, ids: ReadonlyArray<string>) => ({
  id: "reasoningEffort",
  label: "Reasoning effort",
  type: "select" as const,
  options: ids.map((id) => ({
    id,
    label: id[0]!.toUpperCase() + id.slice(1),
    ...(id === defaultId ? { isDefault: true } : {}),
  })),
});
const model = (descriptors: ServerProviderModel["capabilities"]): ServerProviderModel => ({
  slug: "sol",
  name: "Sol",
  isCustom: false,
  capabilities: descriptors,
});

describe("selectedEffort", () => {
  const sol = model({ optionDescriptors: [levels("medium", ["low", "medium", "high"])] });

  it("is the model's own option, else what it defaults to", () => {
    expect(selectedEffort(sol, [{ id: "reasoningEffort", value: "high" }])).toEqual({
      descriptorId: "reasoningEffort",
      value: "high",
      label: "High",
    });
    expect(selectedEffort(sol, undefined)?.value).toBe("medium");
    expect(selectedEffort(sol, [{ id: "fastMode", value: true }])?.value).toBe("medium");
  });

  it("reads a level the model no longer offers as its default", () => {
    expect(selectedEffort(sol, [{ id: "reasoningEffort", value: "ludicrous" }])?.value).toBe(
      "medium",
    );
  });

  it("is nothing for a model without an effort control", () => {
    expect(selectedEffort(model({ optionDescriptors: [] }), undefined)).toBeNull();
    expect(selectedEffort(model(null), undefined)).toBeNull();
    expect(selectedEffort(undefined, undefined)).toBeNull();
    expect(effortChoices(model(null))).toBeNull();
  });

  it("offers the levels a person can pick, not the ones typed into a prompt", () => {
    const claude = model({
      optionDescriptors: [
        {
          ...levels("high", ["low", "high", "ultrathink"]),
          id: "effort",
          promptInjectedValues: ["ultrathink"],
        },
      ],
    });
    expect(effortChoices(claude)?.choices.map((choice) => choice.id)).toEqual(["low", "high"]);
  });
});

describe("findActiveEffortSliderStep", () => {
  const steps = [
    { selection: createModelSelection(instanceId, "luna"), effort: "low" },
    { selection: createModelSelection(instanceId, "sol"), effort: "medium" },
    { selection: createModelSelection(instanceId, "sol"), effort: "high" },
    { selection: createModelSelection(otherInstanceId, "sol"), effort: "high" },
  ];

  it("needs the same instance, model and effective effort", () => {
    expect(findActiveEffortSliderStep(steps, { instanceId, model: "sol", effort: "high" })).toBe(2);
    expect(findActiveEffortSliderStep(steps, { instanceId, model: "sol", effort: "medium" })).toBe(
      1,
    );
    expect(
      findActiveEffortSliderStep(steps, {
        instanceId: otherInstanceId,
        model: "sol",
        effort: "high",
      }),
    ).toBe(3);
    expect(
      findActiveEffortSliderStep(steps, { instanceId, model: "sol", effort: "low" }),
    ).toBeNull();
    expect(
      findActiveEffortSliderStep(steps, { instanceId, model: "astra", effort: "low" }),
    ).toBeNull();
  });

  it("matches a step without an effort only when the model has none either", () => {
    const plain = [{ selection: createModelSelection(instanceId, "plain"), effort: null }];
    expect(findActiveEffortSliderStep(plain, { instanceId, model: "plain", effort: null })).toBe(0);
    expect(
      findActiveEffortSliderStep(plain, { instanceId, model: "plain", effort: "high" }),
    ).toBeNull();
  });
});

describe("nextEffortSliderStep", () => {
  const usable = { unusableReason: null };
  const blocked = { unusableReason: "Model unavailable" };

  it("moves to the next usable step and skips the ones that cannot be applied", () => {
    const steps = [usable, blocked, blocked, usable, usable];
    expect(nextEffortSliderStep(steps, 0, 1)).toBe(3);
    expect(nextEffortSliderStep(steps, 3, 1)).toBe(4);
    expect(nextEffortSliderStep(steps, 4, -1)).toBe(3);
    expect(nextEffortSliderStep(steps, 3, -1)).toBe(0);
  });

  it("stops at the ends instead of wrapping", () => {
    const steps = [usable, usable, blocked];
    expect(nextEffortSliderStep(steps, 1, 1)).toBeNull();
    expect(nextEffortSliderStep(steps, 0, -1)).toBeNull();
  });

  it("enters from the first usable step on Right and the last on Left when off the slider", () => {
    const steps = [blocked, usable, usable, usable, blocked];
    expect(nextEffortSliderStep(steps, null, 1)).toBe(1);
    expect(nextEffortSliderStep(steps, null, -1)).toBe(3);
    expect(nextEffortSliderStep([blocked, blocked], null, 1)).toBeNull();
  });
});

describe("effortSliderIsShown", () => {
  it("needs two steps that can be applied", () => {
    const usable = { unusableReason: null };
    const blocked = { unusableReason: "Model unavailable" };
    expect(effortSliderIsShown([])).toBe(false);
    expect(effortSliderIsShown([usable])).toBe(false);
    expect(effortSliderIsShown([usable, blocked])).toBe(false);
    expect(effortSliderIsShown([usable, blocked, usable])).toBe(true);
  });
});

describe("nearestUsableEffortSliderStep", () => {
  it("lands on the stop under the pointer, or the closest one that can be applied", () => {
    const usable = { unusableReason: null };
    const blocked = { unusableReason: "Model unavailable" };
    const steps = [usable, usable, blocked, usable];
    expect(nearestUsableEffortSliderStep(steps, 0.05)).toBe(0);
    expect(nearestUsableEffortSliderStep(steps, 0.3)).toBe(1);
    expect(nearestUsableEffortSliderStep(steps, 0.6)).toBe(1);
    expect(nearestUsableEffortSliderStep(steps, 0.99)).toBe(3);
    expect(nearestUsableEffortSliderStep(steps, 1.4)).toBe(3);
    expect(nearestUsableEffortSliderStep([blocked], 0.5)).toBeNull();
  });
});
