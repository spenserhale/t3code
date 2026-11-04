import {
  MAX_EFFORT_SLIDER_STEPS,
  type ModelSelection,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";

import {
  addFavorite,
  effortSliderAddBlockReason,
  effortSliderEditBlockReason,
  moveListItem,
  planFavoritesWrite,
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
    // The server keeps an effort a whole list does not mention, so clearing is said outright.
    expect(setFavoriteOptions(start, 0, undefined)).toEqual([
      { provider, model: "sol", options: [] },
      { provider, model: "luna" },
    ]);
    expect(setFavoriteOptions(start, 0, [])).toEqual([
      { provider, model: "sol", options: [] },
      { provider, model: "luna" },
    ]);
    // Nothing to clear on a favorite that never had one.
    expect(setFavoriteOptions(start, 1, undefined)).toEqual(start);
  });
});

describe("planFavoritesWrite", () => {
  const luna = { provider, model: "luna" };
  const sol = { provider, model: "sol", options: high };
  const list = [luna, sol];
  const environment = { projectScope: false, listOnServer: true, reorderSupported: true };

  it("sends what changed, so a favorite another client added in the meantime survives", () => {
    expect(
      planFavoritesWrite({ ...environment, list, edit: { kind: "move", list: [luna, sol] } }),
    ).toEqual({
      reorderModelFavorites: [
        { provider, model: "luna" },
        { provider, model: "sol" },
      ],
    });
    expect(
      planFavoritesWrite({ ...environment, list, edit: { kind: "add", favorite: luna } }),
    ).toEqual({ setModelFavorites: [{ provider, model: "luna", favorite: true }] });
    expect(
      planFavoritesWrite({ ...environment, list, edit: { kind: "remove", favorite: sol } }),
    ).toEqual({ setModelFavorites: [{ provider, model: "sol", favorite: false }] });
    expect(
      planFavoritesWrite({
        ...environment,
        list,
        edit: { kind: "effort", favorite: luna, options: high },
      }),
    ).toEqual({
      setModelFavorites: [{ provider, model: "luna", favorite: true, options: high }],
    });
  });

  it("says outright that an effort is cleared", () => {
    expect(
      planFavoritesWrite({
        ...environment,
        list,
        edit: { kind: "effort", favorite: sol, options: undefined },
      }),
    ).toEqual({ setModelFavorites: [{ provider, model: "sol", favorite: true, options: [] }] });
  });

  it("sends the whole list where an environment cannot take a reorder, or holds no list yet", () => {
    const move = { kind: "move", list: [luna, sol] } as const;
    expect(
      planFavoritesWrite({ ...environment, reorderSupported: false, list, edit: move }),
    ).toEqual({ favorites: list });
    expect(planFavoritesWrite({ ...environment, listOnServer: false, list, edit: move })).toEqual({
      favorites: list,
    });
    // Starring and unstarring work on every server, so only a list that is not there yet is whole.
    expect(
      planFavoritesWrite({
        ...environment,
        reorderSupported: false,
        list,
        edit: { kind: "add", favorite: luna },
      }),
    ).toEqual({ setModelFavorites: [{ provider, model: "luna", favorite: true }] });
    expect(
      planFavoritesWrite({
        ...environment,
        listOnServer: false,
        list,
        edit: { kind: "add", favorite: luna },
      }),
    ).toEqual({ favorites: list });
  });

  it("writes a project's list whole, since its override is stored as a whole entry", () => {
    const cleared = [luna, { provider, model: "sol", options: [] }];
    expect(
      planFavoritesWrite({
        ...environment,
        projectScope: true,
        list: cleared,
        edit: { kind: "effort", favorite: sol, options: undefined },
      }),
    ).toEqual({ favorites: [luna, { provider, model: "sol" }] });
  });
});

describe("effort slider steps", () => {
  const step = (model: string, value = "high") =>
    createModelSelection(provider, model, [{ id: "reasoningEffort", value }]);
  // A step saved without an effort runs at the model's default, which is medium here.
  const effortOf = (selection: ModelSelection) =>
    String(selection.options?.find((option) => option.id === "reasoningEffort")?.value ?? "medium");

  it("refuses a seventh step and a repeat of one that is there, however the repeat is spelled", () => {
    const full = Array.from({ length: MAX_EFFORT_SLIDER_STEPS }, (_, index) => step(`m${index}`));
    expect(effortSliderAddBlockReason(full, step("extra"), effortOf)).toMatch(/up to 6/);
    expect(effortSliderAddBlockReason([step("sol")], step("sol"), effortOf)).toMatch(/already/);
    expect(effortSliderAddBlockReason([step("sol")], step("sol", "low"), effortOf)).toBeNull();
    expect(effortSliderAddBlockReason([step("sol")], step("luna"), effortOf)).toBeNull();
    expect(
      effortSliderAddBlockReason(
        [createModelSelection(provider, "sol")],
        step("sol", "medium"),
        effortOf,
      ),
    ).toMatch(/already/);
  });

  it("refuses an edit that would make a step repeat another one", () => {
    const steps = [step("sol", "low"), step("sol", "high"), step("astra", "high")];
    expect(effortSliderEditBlockReason(steps, 1, step("sol", "low"), effortOf)).toMatch(/already/);
    expect(effortSliderEditBlockReason(steps, 1, step("sol", "medium"), effortOf)).toBeNull();
    // A step is never a repeat of itself.
    expect(effortSliderEditBlockReason(steps, 1, step("sol", "high"), effortOf)).toBeNull();
    expect(effortSliderEditBlockReason(steps, 2, step("astra", "low"), effortOf)).toBeNull();
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
