import {
  EnvironmentId,
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type ModelFavorite } from "@t3tools/contracts/settings";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import {
  codexInstanceId as instanceId,
  highEffort as high,
  modelShortcutProviders,
  modelShortcutSteps as steps,
} from "../../../test/modelShortcutsSettingsFixtures";
import { render } from "../../../test/render";
import type { ScopedSettingsPatch } from "./scopedSettings";

const opusInstance = ProviderInstanceId.make("claudeAgent");
const environmentId = EnvironmentId.make("env-a");
const otherEnvironmentId = EnvironmentId.make("env-b");

const state = vi.hoisted(() => ({
  favorites: [] as ModelFavorite[],
  effortSlider: [] as ModelSelection[],
  providerEffortSliders: undefined as (typeof DEFAULT_SERVER_SETTINGS)["providerEffortSliders"],
  source: "environment" as "environment" | "project",
  projectScope: false,
  /** All environments is selected, and a second environment is connected beside the first. */
  allEnvironments: false,
  supported: true,
  providerSlidersSupported: false,
  /** The environment keeps its favorites on the server, instead of this client's old copy. */
  listOnServer: true,
  updateSettings:
    vi.fn<(patch: ScopedSettingsPatch, options?: { onFailed?: () => void }) => void>(),
  clearOverrides: vi.fn<(keys: readonly string[]) => void>(),
  updateProviderSlider: vi.fn(),
}));

function setup(
  overrides: Partial<
    Omit<typeof state, "updateSettings" | "clearOverrides" | "updateProviderSlider">
  > = {},
) {
  Object.assign(state, {
    favorites: [],
    effortSlider: [],
    providerEffortSliders: undefined,
    source: "environment",
    projectScope: false,
    allEnvironments: false,
    supported: true,
    providerSlidersSupported: false,
    listOnServer: true,
    ...overrides,
  });
  state.updateSettings.mockReset();
  state.clearOverrides.mockReset();
  state.updateProviderSlider.mockReset();
}

vi.mock("~/hooks/useModelShortcuts", () => ({
  useEnvironmentModelShortcuts: () => ({
    settings: null,
    favorites: [],
    effortSliderSupported: true,
  }),
  useToggleModelFavorite: () => vi.fn(),
}));
const scopedSliderSettings = () => ({
  ...DEFAULT_SERVER_SETTINGS,
  effortSlider: state.effortSlider,
  ...(state.providerEffortSliders ? { providerEffortSliders: state.providerEffortSliders } : {}),
});
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => ({
    ...DEFAULT_UNIFIED_SETTINGS,
    ...scopedSliderSettings(),
    favorites: state.favorites,
    effortSlider: state.effortSlider,
  })) as never,
  useScopedSettingsMixed: () => false,
  useScopedSettingSource: () => state.source,
  useUpdateScopedSettings: () => state.updateSettings,
  useScopedSettingsWriteAllowed: () => true,
  useUpdateScopedProviderEffortSlider: () => state.updateProviderSlider,
  useClearScopedSettings: () => state.clearOverrides,
}));
vi.mock(import("./useScopedModelAvailability"), async (original) => ({
  ...(await original()),
  useScopedModelUnavailableEnvironments: () => () => new Map(),
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    search: {},
    scope: state.projectScope
      ? { kind: "project", environmentIds: [environmentId] }
      : state.allEnvironments
        ? { kind: "all", environmentIds: [environmentId, otherEnvironmentId] }
        : { kind: "environment", environmentId, environmentIds: [environmentId] },
    target: { environmentId, projectId: null },
    targets: [{ environmentId, projectId: null, settings: scopedSliderSettings() }],
    connectedEnvironments: [
      environmentId,
      ...(state.allEnvironments ? [otherEnvironmentId] : []),
    ].map((id) => ({
      environmentId: id,
      label: id === environmentId ? "Mac mini" : "Laptop",
      serverConfig: {
        settings: { favorites: state.listOnServer ? state.favorites : null },
        environment: {
          capabilities: state.supported
            ? { effortSlider: true, providerEffortSliders: state.providerSlidersSupported }
            : {},
        },
      },
    })),
  })) as never,
}));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({
    environments: [
      {
        environmentId,
        label: "Mac mini",
        connection: { phase: "connected" },
        serverConfig: { settings: DEFAULT_SERVER_SETTINGS, environment: { capabilities: {} } },
      },
    ],
  })) as never,
  useEnvironmentProviders: () =>
    new Map([
      [
        environmentId,
        [
          ...modelShortcutProviders,
          {
            ...modelShortcutProviders[0]!,
            instanceId: opusInstance,
            driver: ProviderDriverKind.make("claudeAgent"),
            models: [
              {
                slug: "opus",
                name: "Claude Opus",
                isCustom: false,
                capabilities: {
                  optionDescriptors: [
                    {
                      id: "effort",
                      label: "Reasoning effort",
                      type: "select" as const,
                      options: [
                        { id: "medium", label: "Medium", isDefault: true },
                        { id: "high", label: "High" },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        ],
      ],
    ]),
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: ({ title, description, control, children }) => (
    <div>
      <h3>{title}</h3>
      <p>{description}</p>
      {control}
      {children}
    </div>
  ),
  SettingsSection: (({ children }: { children: ReactNode }) => children) as never,
}));

import { ModelShortcutsSettings } from "./ModelShortcutsSettings";

const favorites: ModelFavorite[] = [
  { provider: instanceId, model: "sol", options: high },
  { provider: instanceId, model: "luna" },
];
const luna = { provider: instanceId, model: "luna" };
const sol = { provider: instanceId, model: "sol" };

it("reorders, removes and sets the effort of favorites by saying what changed", async () => {
  setup({ favorites });
  await using _screen = await render(<ModelShortcutsSettings />);

  await userEvent.click(page.getByRole("button", { name: "Move Luna up" }));
  expect(state.updateSettings).toHaveBeenLastCalledWith({ reorderModelFavorites: [luna, sol] });
  await userEvent.click(page.getByRole("button", { name: "Remove Sol" }));
  expect(state.updateSettings).toHaveBeenLastCalledWith({
    setModelFavorites: [{ ...sol, favorite: false }],
  });
  await expect.element(page.getByRole("button", { name: "Move Sol up" })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Move Luna down" })).toBeDisabled();

  await userEvent.click(page.getByRole("combobox", { name: "Effort for Luna" }));
  await userEvent.click(page.getByRole("option", { name: "Low" }));
  expect(state.updateSettings).toHaveBeenLastCalledWith({
    setModelFavorites: [
      { ...luna, favorite: true, options: [{ id: "reasoningEffort", value: "low" }] },
    ],
  });
  await userEvent.click(page.getByRole("combobox", { name: "Effort for Sol" }));
  await userEvent.click(page.getByRole("option", { name: "Last used" }));
  expect(state.updateSettings).toHaveBeenLastCalledWith({
    setModelFavorites: [{ ...sol, favorite: true, options: [] }],
  });
});

it("writes the whole list where the server holds none yet, or cannot reorder by intent", async () => {
  setup({ favorites, listOnServer: false });
  await using screen = await render(<ModelShortcutsSettings />);
  await userEvent.click(page.getByRole("button", { name: "Remove Sol" }));
  expect(state.updateSettings).toHaveBeenLastCalledWith({
    favorites: [{ ...luna, options: [] }],
  });

  setup({ favorites, supported: false });
  await screen.rerender(<ModelShortcutsSettings key="older-server" />);
  await userEvent.click(page.getByRole("button", { name: "Move Luna up" }));
  expect(state.updateSettings).toHaveBeenLastCalledWith({
    favorites: [{ ...luna, options: [] }, favorites[0]],
  });
  // Unstarring needs nothing newer, so an older server is still told only what changed.
  await userEvent.click(page.getByRole("button", { name: "Remove Sol" }));
  expect(state.updateSettings).toHaveBeenLastCalledWith({
    setModelFavorites: [{ ...sol, favorite: false }],
  });
});

it("replaces every environment's list whole at All environments", async () => {
  setup({ favorites, allEnvironments: true });
  await using _screen = await render(<ModelShortcutsSettings />);

  // The same list goes to every environment, so each ends up with what this page shows.
  await userEvent.click(page.getByRole("button", { name: "Move Luna up" }));
  expect(state.updateSettings).toHaveBeenLastCalledWith({
    favorites: [{ ...luna, options: [] }, favorites[0]],
  });
  await userEvent.click(page.getByRole("button", { name: "Remove Sol" }));
  expect(state.updateSettings).toHaveBeenLastCalledWith({
    favorites: [{ ...luna, options: [] }],
  });
  await userEvent.click(page.getByRole("combobox", { name: "Effort for Sol" }));
  await userEvent.click(page.getByRole("option", { name: "Last used" }));
  expect(state.updateSettings).toHaveBeenLastCalledWith({
    favorites: [
      { ...sol, options: [] },
      { ...luna, options: [] },
    ],
  });
});

it("moves a slider step as one whole list", async () => {
  setup({ effortSlider: steps });
  await using _screen = await render(<ModelShortcutsSettings />);
  await userEvent.click(page.getByRole("button", { name: "Move Sol up" }));
  expect(state.updateSettings).toHaveBeenLastCalledWith(
    { effortSlider: [steps[1], steps[0]] },
    undefined,
  );
  await expect.element(page.getByRole("list", { name: "Effort slider steps" })).toBeVisible();
});

it("opens the requested provider editor, restricts model choices, and can clear the override", async () => {
  const driver = ProviderDriverKind.make("codex");
  setup({
    effortSlider: steps,
    providerSlidersSupported: true,
    providerEffortSliders: { [driver]: [steps[0]!] },
  });
  await using screen = await render(<ModelShortcutsSettings />, {
    router: "/?effortSliderProvider=codex",
  });
  const picker = screen.getByRole("combobox", { name: "Slider to edit" });
  await expect.element(picker).toHaveTextContent("Codex");
  await screen.getByRole("button", { name: "Edit slider" }).click();
  const solOption = page.getByRole("option", { name: /^Sol\b/ });
  await expect.element(solOption).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "OpenCode", exact: true }))
    .not.toBeInTheDocument();
  await solOption.click();
  expect(state.updateProviderSlider).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Add step after" }).click();
  expect(state.updateProviderSlider).toHaveBeenLastCalledWith(
    driver,
    [steps[0], { instanceId, model: "sol" }],
    expect.any(Function),
  );
  expect(state.updateSettings).not.toHaveBeenCalled();

  await page.getByRole("button", { name: "Done" }).click();
  await screen.getByRole("button", { name: "Use Favorites slider" }).click();
  expect(state.updateProviderSlider).toHaveBeenLastCalledWith(driver, null);
});

it("omits Claude branding in the scoped slider list and editor", async () => {
  setup({
    providerSlidersSupported: true,
    providerEffortSliders: {
      [ProviderDriverKind.make("claudeAgent")]: [{ instanceId: opusInstance, model: "opus" }],
    },
  });
  await using screen = await render(<ModelShortcutsSettings />, {
    router: "/?effortSliderProvider=claudeAgent",
  });
  const steps = page.getByRole("list", { name: "Effort slider steps" });
  await expect.element(steps.getByText("Opus", { exact: true })).toBeVisible();
  await expect.element(steps.getByText(/Claude/)).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Edit slider" }).click();
  await expect.element(page.getByRole("option", { name: /^Opus\b/ })).toBeVisible();
});

it("refuses to make one step repeat another, since the arrow keys could not tell them apart", async () => {
  const solLow = { instanceId, model: "sol", options: [{ id: "reasoningEffort", value: "low" }] };
  setup({ effortSlider: [solLow, steps[1]!] });
  await using _screen = await render(<ModelShortcutsSettings />);
  await userEvent.click(page.getByRole("combobox", { name: "Effort for Sol" }).nth(1));
  await userEvent.click(page.getByRole("option", { name: "Low" }));
  expect(state.updateSettings).not.toHaveBeenCalled();
});

it("shows the first six steps of a longer stored list, the ones the picker uses", async () => {
  const seven = Array.from({ length: 7 }, (_, index) => steps[index % 2]!);
  setup({ effortSlider: seven });
  await using _screen = await render(<ModelShortcutsSettings />);
  await expect
    .element(page.getByRole("list", { name: "Effort slider steps" }).getByRole("listitem").first())
    .toBeVisible();
  expect(
    page.getByRole("list", { name: "Effort slider steps" }).getByRole("listitem").elements(),
  ).toHaveLength(6);
});

it("says that one step is too few for the slider to appear", async () => {
  setup({ effortSlider: steps.slice(0, 1) });
  await using _screen = await render(<ModelShortcutsSettings />);
  await expect.element(page.getByText(/appears with two or more/)).toBeVisible();
});

it("shows a project the environment's list until it asks for its own", async () => {
  setup({ favorites, projectScope: true, source: "environment" });
  await using screen = await render(<ModelShortcutsSettings />);
  await expect.element(page.getByRole("button", { name: "Move Luna up" })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Remove Sol" })).toBeDisabled();

  await userEvent.click(screen.getByRole("button", { name: "Customize for this project" }).first());
  expect(state.updateSettings).toHaveBeenLastCalledWith({ favorites });
});

it("lets a project that has its own list go back to the environment's", async () => {
  setup({ favorites, projectScope: true, source: "project" });
  await using screen = await render(<ModelShortcutsSettings />);
  await expect.element(page.getByRole("button", { name: "Move Luna up" })).toBeEnabled();

  await userEvent.click(screen.getByRole("button", { name: "Use the environment's" }).first());
  expect(state.clearOverrides).toHaveBeenLastCalledWith(["favorites"]);
});

it("keeps the order of favorites but offers no efforts or slider where the server cannot store them", async () => {
  setup({ favorites, supported: false });
  await using screen = await render(<ModelShortcutsSettings />);
  await expect.element(page.getByRole("button", { name: "Move Luna up" })).toBeEnabled();
  await expect
    .element(screen.getByRole("combobox", { name: "Effort for Sol" }))
    .not.toBeInTheDocument();
  await expect.element(screen.getByText(/needs a newer T3 Code/).first()).toBeVisible();
  await expect
    .element(screen.getByRole("list", { name: "Effort slider steps" }))
    .not.toBeInTheDocument();
});

it("offers a project no list of its own on a server that cannot keep one", async () => {
  setup({ favorites, projectScope: true, source: "environment", supported: false });
  await using screen = await render(<ModelShortcutsSettings />);
  await expect.element(page.getByRole("button", { name: "Move Luna up" })).toBeDisabled();
  await expect
    .element(screen.getByRole("button", { name: "Customize for this project" }))
    .not.toBeInTheDocument();
  await expect.element(screen.getByText(/only on environments running a newer/)).toBeVisible();
});

it("can add another Opus at High, then reorder the saved pair without reopening", async () => {
  const medium = {
    instanceId: opusInstance,
    model: "opus",
    options: [{ id: "effort", value: "medium" }],
  };
  const high = { ...medium, options: [{ id: "effort", value: "high" }] };
  setup({ effortSlider: [medium] });
  await using screen = await render(<ModelShortcutsSettings />);
  await page.getByRole("button", { name: "Edit slider" }).click();
  const editor = page.getByRole("dialog", { name: "Edit Favorites slider" });
  const before = editor.getByRole("button", { name: "Add step before" });
  await expect.element(before).toBeDisabled();
  await expect
    .element(editor.getByRole("button", { name: /Medium On slider/ }))
    .toHaveAttribute("aria-pressed", "true");
  await editor.getByRole("button", { name: "High", exact: true }).click();
  expect(state.updateSettings).not.toHaveBeenCalled();

  await before.click();
  expect(state.updateSettings.mock.calls.at(-1)?.[0]).toEqual({ effortSlider: [high, medium] });
  const selected = editor.getByRole("button", { name: "Claude Opus · High", exact: true });
  await expect.element(selected).toHaveAttribute("aria-pressed", "true");
  state.effortSlider = [high, medium];
  await screen.rerender(<ModelShortcutsSettings />);
  await selected.hover();
  await editor.getByRole("button", { name: "Move Claude Opus · High right" }).click();
  expect(state.updateSettings.mock.calls.at(-1)?.[0]).toEqual({ effortSlider: [medium, high] });
  await expect.element(selected).toHaveAttribute("aria-pressed", "true");
  state.effortSlider = [medium, high];
  await screen.rerender(<ModelShortcutsSettings />);
  await expect
    .element(editor.getByRole("button", { name: "Move Claude Opus · High right" }))
    .toBeDisabled();
});

it("drops a step after a neighbor and restores order when a write fails", async () => {
  setup({ effortSlider: steps });
  await using _screen = await render(<ModelShortcutsSettings />);
  await page.getByRole("button", { name: "Edit slider" }).click();
  const editor = page.getByRole("dialog", { name: "Edit Favorites slider" });
  const items = editor.getByRole("listitem").elements();
  const transfer = new DataTransfer();
  const drag = (el: Element, type: string, x: number) =>
    el.dispatchEvent(
      new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: x }),
    );
  const lastEdge = items[1]!.getBoundingClientRect().right - 1;
  drag(items[0]!, "dragstart", 0);
  await vi.waitFor(() => {
    drag(items[1]!, "dragover", lastEdge);
    expect(items[1]!.classList.contains("border-r-primary")).toBe(true);
  });
  drag(items[1]!, "drop", lastEdge);
  expect(state.updateSettings.mock.calls.at(-1)?.[0]).toEqual({
    effortSlider: [steps[1], steps[0]],
  });
  const writeOptions = state.updateSettings.mock.lastCall?.[1];
  writeOptions?.onFailed?.();
  await expect.element(editor.getByRole("listitem").first()).toHaveTextContent("LunaLow");
});
