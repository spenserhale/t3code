import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelFavorite,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import type { EffortSliderStop } from "./EffortSlider";
import { ProviderModelPicker } from "./ProviderModelPicker";

const state = vi.hoisted(() => ({
  favorites: [] as ModelFavorite[],
  effortSliderSupported: true,
}));

vi.mock("~/hooks/useModelShortcuts", () => ({
  useEnvironmentModelShortcuts: () => ({
    settings: null,
    favorites: state.favorites,
    effortSliderSupported: state.effortSliderSupported,
  }),
  useToggleModelFavorite: () => vi.fn(),
}));

function setup() {
  state.favorites = [];
  state.effortSliderSupported = true;
}

const instanceId = ProviderInstanceId.make("codex");
const level = (id: string, label: string) => ({ id, label });
const withLevels = (slug: string, name: string, ids: ReadonlyArray<string>) => ({
  slug,
  name,
  isCustom: false,
  capabilities: {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning effort",
        type: "select" as const,
        options: ids.map((id) => level(id, id[0]!.toUpperCase() + id.slice(1))),
      },
    ],
  },
});
const entries = deriveProviderInstanceEntries([
  {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [
      withLevels("luna", "Luna model", ["low", "high"]),
      withLevels("sol", "Sol model", ["medium", "high"]),
      { slug: "plain", name: "Plain model", isCustom: false, capabilities: null },
    ],
    slashCommands: [],
    skills: [],
  },
]);
const options = new Map([
  [
    instanceId,
    [
      { slug: "luna", name: "Luna model" },
      { slug: "sol", name: "Sol model" },
      { slug: "plain", name: "Plain model" },
    ],
  ],
]);

const steps = [
  { model: "luna", effort: "low", modelLabel: "Luna", effortLabel: "Low" },
  { model: "sol", effort: "medium", modelLabel: "Sol", effortLabel: "Medium" },
  { model: "sol", effort: "high", modelLabel: "Sol", effortLabel: "High" },
];

function Picker(props: {
  /** The composer leaves the slider out where the server keeps none. */
  withoutSlider?: boolean;
  unusable?: ReadonlyArray<number>;
  onFavoritePick?: (model: string, picked: ReadonlyArray<ProviderOptionSelection>) => void;
  onSelectStop?: (index: number) => void;
}) {
  const [current, setCurrent] = useState<{ model: string; effort: string | null }>({
    model: "luna",
    effort: "low",
  });
  const stops: EffortSliderStop[] = steps.map((step, index) => ({
    key: `${step.model}-${step.effort}`,
    modelLabel: step.modelLabel,
    effortLabel: step.effortLabel,
    unusableReason: props.unusable?.includes(index) ? "Not available" : null,
  }));
  const found = steps.findIndex(
    (step) => step.model === current.model && step.effort === current.effort,
  );
  const activeIndex = found < 0 ? null : found;
  const active = activeIndex === null ? null : steps[activeIndex]!;
  return (
    <ProviderModelPicker
      environmentId={null}
      activeInstanceId={instanceId}
      model={current.model}
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={options}
      triggerAriaLabel="Choose model"
      {...(props.withoutSlider
        ? {}
        : {
            effortSlider: {
              stops,
              activeIndex,
              valueText: active
                ? `${active.modelLabel}, ${active.effortLabel.toLowerCase()} effort`
                : "None",
              onSelect: (index: number) => {
                props.onSelectStop?.(index);
                setCurrent({ model: steps[index]!.model, effort: steps[index]!.effort });
              },
            },
          })}
      onInstanceModelChange={(_, model, pick) => {
        if (pick) props.onFavoritePick?.(model, pick.options);
        setCurrent({
          model,
          effort: pick?.options.find((option) => option.id === "reasoningEffort")?.value as string,
        });
      }}
      effortColumn={
        <button type="button" role="radio" aria-checked data-effort-row data-effort-level>
          Medium
        </button>
      }
    />
  );
}

const slider = () => page.getByRole("slider", { name: "Effort slider" });

it("steps the slider with Left and Right in an empty search and keeps focus there", async () => {
  setup();
  await using screen = await render(<Picker />);
  await screen.getByRole("button", { name: "Choose model" }).click();
  const search = page.getByPlaceholder("Search models...");
  await expect.element(search).toHaveFocus();
  await expect.element(slider()).toHaveAttribute("aria-valuetext", "Luna, low effort");

  await userEvent.keyboard("{ArrowRight}");
  await expect.element(slider()).toHaveAttribute("aria-valuetext", "Sol, medium effort");
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(slider()).toHaveAttribute("aria-valuetext", "Sol, high effort");
  // The end of the slider holds: nothing wraps and nothing moves into the effort column.
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(slider()).toHaveAttribute("aria-valuetext", "Sol, high effort");
  await expect.element(slider()).toHaveAttribute("aria-valuenow", "3");
  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(slider()).toHaveAttribute("aria-valuetext", "Sol, medium effort");
  await expect.element(search).toHaveFocus();
  await expect.element(slider()).not.toHaveAttribute("tabindex");
});

it("leaves the arrow keys to the search text once something is typed", async () => {
  setup();
  await using screen = await render(<Picker />);
  await screen.getByRole("button", { name: "Choose model" }).click();
  const search = page.getByPlaceholder("Search models...");
  await userEvent.type(search, "so");
  await userEvent.keyboard("{ArrowLeft}");
  expect((search.element() as HTMLInputElement).selectionStart).toBe(1);
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(slider()).toHaveAttribute("aria-valuetext", "Luna, low effort");
  // Right at the end of the text still goes to the effort column, as before.
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(page.getByRole("radio", { name: "Medium" })).toHaveFocus();
});

it("skips a stop that cannot be applied", async () => {
  setup();
  await using screen = await render(<Picker unusable={[1]} />);
  await screen.getByRole("button", { name: "Choose model" }).click();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(slider()).toHaveAttribute("aria-valuetext", "Sol, high effort");
  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(slider()).toHaveAttribute("aria-valuetext", "Luna, low effort");
});

it("applies the stop that is pressed without taking focus from the search", async () => {
  setup();
  const onSelectStop = vi.fn();
  await using screen = await render(<Picker onSelectStop={onSelectStop} />);
  await screen.getByRole("button", { name: "Choose model" }).click();
  const search = page.getByPlaceholder("Search models...");
  await slider().getByText("High").click();
  await expect.element(slider()).toHaveAttribute("aria-valuetext", "Sol, high effort");
  expect(onSelectStop).toHaveBeenLastCalledWith(2);
  await expect.element(search).toHaveFocus();
});

it("follows a drag along the track and ends it on release", async () => {
  setup();
  const onSelectStop = vi.fn();
  await using screen = await render(<Picker onSelectStop={onSelectStop} />);
  await screen.getByRole("button", { name: "Choose model" }).click();
  const search = page.getByPlaceholder("Search models...");
  await userEvent.dragAndDrop(slider().getByText("Low"), slider().getByText("High"));
  await expect.element(slider()).toHaveAttribute("aria-valuetext", "Sol, high effort");
  expect(onSelectStop).toHaveBeenLastCalledWith(2);
  await expect.element(search).toHaveFocus();
});

it("lists favorites in the order they were saved and opens one at its saved effort", async () => {
  setup();
  state.favorites = [
    {
      provider: instanceId,
      model: "sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    },
    { provider: instanceId, model: "luna" },
  ];
  const onFavoritePick = vi.fn();
  await using screen = await render(<Picker onFavoritePick={onFavoritePick} />);
  await screen.getByRole("button", { name: "Choose model" }).click();
  const search = page.getByPlaceholder("Search models...");
  const rows = page.getByRole("option");
  const rowText = (index: number) => rows.nth(index).element().textContent ?? "";
  await vi.waitFor(() => expect(rowText(0)).toContain("Sol model"));
  expect(rowText(0)).toContain("High effort");
  expect(rowText(1)).toContain("Luna model");
  expect(rowText(1)).not.toContain("effort");

  await rows.nth(0).click();
  expect(onFavoritePick).toHaveBeenCalledWith("sol", [{ id: "reasoningEffort", value: "high" }]);
  await expect.element(slider()).toHaveAttribute("aria-valuetext", "Sol, high effort");
  await expect.element(search).toHaveFocus();

  // The slider is up, so a favorite without a saved effort leaves focus where it was as well.
  await rows.nth(1).click();
  await expect.element(search).toHaveFocus();
  await expect.element(page.getByRole("radio", { name: "Medium" })).not.toHaveFocus();
});

it("keeps focus in the search box for any pick made from the keyboard while the slider is up", async () => {
  setup();
  state.favorites = [
    { provider: instanceId, model: "sol", options: [{ id: "reasoningEffort", value: "high" }] },
    { provider: instanceId, model: "luna" },
  ];
  await using screen = await render(<Picker />);
  await screen.getByRole("button", { name: "Choose model" }).click();
  const search = page.getByPlaceholder("Search models...");
  await expect.element(search).toHaveFocus();
  // Luna has no saved effort. Enter on it used to hand focus to the effort column.
  await userEvent.keyboard("{ArrowDown}{Enter}");
  await expect.element(search).toHaveFocus();
  await expect.element(page.getByRole("radio", { name: "Medium" })).not.toHaveFocus();
  await expect.element(page.getByRole("button", { name: "Choose model" })).toBeVisible();
});

it("opens a favorite the way it always did on a server that keeps no efforts", async () => {
  setup();
  state.effortSliderSupported = false;
  state.favorites = [
    { provider: instanceId, model: "sol", options: [{ id: "reasoningEffort", value: "high" }] },
  ];
  const onFavoritePick = vi.fn();
  await using screen = await render(<Picker withoutSlider onFavoritePick={onFavoritePick} />);
  await screen.getByRole("button", { name: "Choose model" }).click();
  const row = page.getByRole("option").first();
  await expect.element(row).toBeVisible();
  expect(row.element().textContent).not.toContain("effort");
  await row.click();
  expect(onFavoritePick).not.toHaveBeenCalled();
  await expect.element(page.getByRole("radio", { name: "Medium" })).toHaveFocus();
});
