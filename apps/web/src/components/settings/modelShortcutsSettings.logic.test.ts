import { MAX_EFFORT_SLIDER_STEPS, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";

import {
  addFavorite,
  effortSliderAddBlockReason,
  moveListItem,
  removeListItem,
  setFavoriteOptions,
  setSliderStepOptions,
} from "./modelShortcutsSettings.logic";

const provider = ProviderInstanceId.make("codex");
const high = [{ id: "reasoningEffort", value: "high" }];

describe("ordering a list", () => {
  it("moves an item one place and stops at the ends", () => {
    expect(moveListItem(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveListItem(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    const items = ["a", "b"];
    expect(moveListItem(items, 0, -1)).toBe(items);
    expect(moveListItem(items, 1, 1)).toBe(items);
    expect(removeListItem(["a", "b", "c"], 1)).toEqual(["a", "c"]);
  });
});

describe("favorites", () => {
  it("adds a model once, at the end, without an effort", () => {
    const start = [{ provider, model: "sol", options: high }];
    expect(addFavorite(start, { provider, model: "luna" })).toEqual([
      ...start,
      { provider, model: "luna" },
    ]);
    expect(addFavorite(start, { provider, model: "sol" })).toBe(start);
  });

  it("saves or forgets the effort of one favorite and leaves the others alone", () => {
    const start = [
      { provider, model: "sol", options: high },
      { provider, model: "luna" },
    ];
    expect(setFavoriteOptions(start, 1, high)).toEqual([
      { provider, model: "sol", options: high },
      { provider, model: "luna", options: high },
    ]);
    expect(setFavoriteOptions(start, 0, undefined)).toEqual([
      { provider, model: "sol" },
      { provider, model: "luna" },
    ]);
    expect(setFavoriteOptions(start, 0, [])).toEqual([
      { provider, model: "sol" },
      { provider, model: "luna" },
    ]);
  });
});

describe("effort slider steps", () => {
  const step = (model: string, value = "high") =>
    createModelSelection(provider, model, [{ id: "reasoningEffort", value }]);

  it("refuses a seventh step and a repeat of one that is there", () => {
    const full = Array.from({ length: MAX_EFFORT_SLIDER_STEPS }, (_, index) => step(`m${index}`));
    expect(effortSliderAddBlockReason(full, step("extra"))).toMatch(/up to 6/);
    expect(effortSliderAddBlockReason([step("sol")], step("sol"))).toMatch(/already/);
    expect(effortSliderAddBlockReason([step("sol")], step("sol", "low"))).toBeNull();
    expect(effortSliderAddBlockReason([step("sol")], step("luna"))).toBeNull();
  });

  it("changes the effort of one step in place", () => {
    const steps = [step("sol", "low"), step("luna", "low")];
    expect(setSliderStepOptions(steps, 1, [{ id: "reasoningEffort", value: "high" }])).toEqual([
      step("sol", "low"),
      step("luna", "high"),
    ]);
    expect(setSliderStepOptions(steps, 0, undefined)).toEqual([
      createModelSelection(provider, "sol"),
      step("luna", "low"),
    ]);
  });
});
