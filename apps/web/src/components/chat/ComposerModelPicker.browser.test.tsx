import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelFavorite,
  type ModelSelection,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ComposerModelPicker } from "./ComposerFooterControls";
import { resolveFanOutSelections } from "./composerMultiModel.logic";

const state = vi.hoisted(() => ({ favorites: [] as ModelFavorite[] }));

vi.mock("~/hooks/useModelShortcuts", () => ({
  useEnvironmentModelShortcuts: () => ({
    settings: null,
    favorites: state.favorites,
    effortSliderSupported: true,
  }),
  useToggleModelFavorite: () => vi.fn(),
}));

function setup(favorites: ModelFavorite[]) {
  state.favorites = favorites;
}

const instanceId = ProviderInstanceId.make("codex");
const high = [{ id: "reasoningEffort", value: "high" }];
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
    models: [],
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
const luna: ModelSelection = { instanceId, model: "luna" };

function Picker(props: {
  selections: ReadonlyArray<ModelSelection> | null;
  onChange: (selections: ReadonlyArray<ModelSelection> | null) => void;
  onSelect: (instanceId: ProviderInstanceId, model: string, options?: unknown) => void;
}) {
  return (
    <ComposerModelPicker
      environmentId={null}
      multipleModelsEnabled
      multipleModelSelections={props.selections}
      onMultipleModelSelectionsChange={props.onChange}
      selectedModelSelection={luna}
      onProviderModelSelect={props.onSelect}
      activeInstanceId={instanceId}
      model="luna"
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={options}
      triggerAriaLabel="Choose models"
    />
  );
}

async function shiftClick(name: RegExp) {
  await userEvent.keyboard("{Shift>}");
  try {
    await page.getByRole("option", { name }).click();
  } finally {
    await userEvent.keyboard("{/Shift}");
  }
}

it("adds a favorite to several models at its saved effort", async () => {
  setup([{ provider: instanceId, model: "sol", options: high }]);
  const onChange = vi.fn();
  const onSelect = vi.fn();
  await using screen = await render(
    <Picker selections={null} onChange={onChange} onSelect={onSelect} />,
  );
  await screen.getByRole("button", { name: "Choose models" }).click();
  await shiftClick(/Sol model/);
  expect(onChange).toHaveBeenLastCalledWith([luna, { instanceId, model: "sol", options: high }]);
  // Sol is not the primary model, so the effort control's selection is left as it was.
  expect(onSelect).not.toHaveBeenCalled();
});

it("adds a model with no saved effort as it always did, leaving its options to what was last used", async () => {
  setup([]);
  const onChange = vi.fn();
  await using screen = await render(
    <Picker selections={null} onChange={onChange} onSelect={vi.fn()} />,
  );
  await screen.getByRole("button", { name: "Choose models" }).click();
  await shiftClick(/Plain model/);
  expect(onChange).toHaveBeenLastCalledWith([luna, { instanceId, model: "plain" }]);
});

it("keeps a favorite's saved effort when the selection falls back to that one model", async () => {
  setup([
    { provider: instanceId, model: "sol", options: high },
    { provider: instanceId, model: "luna" },
  ]);
  const onChange = vi.fn();
  const onSelect = vi.fn();
  await using screen = await render(
    <Picker
      selections={[luna, { instanceId, model: "sol", options: high }]}
      onChange={onChange}
      onSelect={onSelect}
    />,
  );
  await screen.getByRole("button", { name: "Choose models" }).click();
  await shiftClick(/Luna model/);
  expect(onChange).toHaveBeenLastCalledWith(null);
  expect(onSelect).toHaveBeenLastCalledWith(instanceId, "sol", {
    focusComposer: false,
    modelOptions: high,
  });
});

it("sends a favorite's saved effort after it was taken out of several models and put back", async () => {
  setup([
    { provider: instanceId, model: "luna", options: high },
    { provider: instanceId, model: "sol" },
    { provider: instanceId, model: "plain" },
  ]);
  const low = [{ id: "reasoningEffort", value: "low" }];

  // The composer around the picker: the primary selection the effort control edits, the models
  // picked for the draft, and what a send would carry out of the two.
  function Draft() {
    const [selections, setSelections] = useState<ReadonlyArray<ModelSelection> | null>(null);
    const [primary, setPrimary] = useState<ModelSelection>(
      createModelSelection(instanceId, "luna", low),
    );
    const outgoing = selections === null ? [primary] : resolveFanOutSelections(selections, primary);
    return (
      <>
        <output aria-label="Outgoing">{JSON.stringify(outgoing)}</output>
        <ComposerModelPicker
          environmentId={null}
          multipleModelsEnabled
          multipleModelSelections={selections}
          onMultipleModelSelectionsChange={setSelections}
          selectedModelSelection={primary}
          onProviderModelSelect={(
            id: ProviderInstanceId,
            model: string,
            picked?: { modelOptions?: ReadonlyArray<ProviderOptionSelection> },
          ) => setPrimary(createModelSelection(id, model, picked?.modelOptions))}
          activeInstanceId={instanceId}
          model="luna"
          lockedProvider={null}
          instanceEntries={entries}
          modelOptionsByInstance={options}
          triggerAriaLabel="Choose models"
        />
      </>
    );
  }
  const outgoing = (screen: { getByRole: typeof page.getByRole }) =>
    JSON.parse(screen.getByRole("status", { name: "Outgoing" }).element().textContent ?? "[]");

  await using screen = await render(<Draft />);
  await screen.getByRole("button", { name: "Choose models" }).click();
  await shiftClick(/Sol model/);
  await shiftClick(/Plain model/);
  await shiftClick(/Luna model/);
  await vi.waitFor(() =>
    expect(outgoing(screen)).toEqual([
      { instanceId, model: "sol" },
      { instanceId, model: "plain" },
    ]),
  );
  await shiftClick(/Luna model/);
  await vi.waitFor(() =>
    expect(outgoing(screen)).toEqual([
      { instanceId, model: "sol" },
      { instanceId, model: "plain" },
      { instanceId, model: "luna", options: high },
    ]),
  );
});
