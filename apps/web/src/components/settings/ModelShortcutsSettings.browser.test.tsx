import {
  EnvironmentId,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type ModelFavorite } from "@t3tools/contracts/settings";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import { render } from "../../../test/render";
import type { ScopedSettingsPatch } from "./scopedSettings";

const instanceId = ProviderInstanceId.make("codex");
const environmentId = EnvironmentId.make("env-a");
const high = [{ id: "reasoningEffort", value: "high" }];

const state = vi.hoisted(() => ({
  favorites: [] as ModelFavorite[],
  effortSlider: [] as ModelSelection[],
  source: "environment" as "environment" | "project",
  projectScope: false,
  supported: true,
  updateSettings: vi.fn<(patch: ScopedSettingsPatch) => void>(),
  clearOverrides: vi.fn<(keys: readonly string[]) => void>(),
}));

function setup(overrides: Partial<Omit<typeof state, "updateSettings" | "clearOverrides">> = {}) {
  Object.assign(state, {
    favorites: [],
    effortSlider: [],
    source: "environment",
    projectScope: false,
    supported: true,
    ...overrides,
  });
  state.updateSettings.mockReset();
  state.clearOverrides.mockReset();
}

vi.mock("~/hooks/useModelShortcuts", () => ({
  useEnvironmentModelShortcuts: () => ({
    settings: null,
    favorites: [],
    effortSliderSupported: true,
  }),
  useToggleModelFavorite: () => vi.fn(),
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => vi.fn()) as never,
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => ({
    ...DEFAULT_UNIFIED_SETTINGS,
    favorites: state.favorites,
    effortSlider: state.effortSlider,
  })) as never,
  useScopedSettingsMixed: () => false,
  useScopedSettingSource: () => state.source,
  useUpdateScopedSettings: () => state.updateSettings,
  useClearScopedSettings: () => state.clearOverrides,
}));
vi.mock(import("./useScopedModelAvailability"), async (original) => ({
  ...(await original()),
  useScopedModelDisabledReason: () => () => null,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: state.projectScope
      ? { kind: "project", environmentIds: [environmentId] }
      : { kind: "environment", environmentId, environmentIds: [environmentId] },
    target: { environmentId, projectId: null },
    connectedEnvironments: [
      {
        environmentId,
        label: "Mac mini",
        serverConfig: {
          environment: { capabilities: state.supported ? { effortSlider: true } : {} },
        },
      },
    ],
  })) as never,
}));

const withLevels = (slug: string, name: string) => ({
  slug,
  name,
  isCustom: false,
  capabilities: {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning effort",
        type: "select" as const,
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
      },
    ],
  },
});
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({
    environments: [
      {
        environmentId,
        label: "Mac mini",
        serverConfig: { environment: { capabilities: {} } },
      },
    ],
  })) as never,
  useEnvironmentProviders: () =>
    new Map([
      [
        environmentId,
        [
          {
            instanceId,
            driver: ProviderDriverKind.make("codex"),
            enabled: true,
            installed: true,
            version: null,
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: "2026-01-01T00:00:00.000Z",
            models: [withLevels("luna", "Luna"), withLevels("sol", "Sol")],
            slashCommands: [],
            skills: [],
          },
        ],
      ],
    ]) as never,
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
const steps: ModelSelection[] = [
  { instanceId, model: "luna", options: [{ id: "reasoningEffort", value: "low" }] },
  { instanceId, model: "sol", options: high },
];

it("reorders, removes and sets the effort of favorites, each as one whole list", async () => {
  setup({ favorites });
  await using _screen = await render(<ModelShortcutsSettings />);

  await userEvent.click(page.getByRole("button", { name: "Move Luna up" }));
  expect(state.updateSettings).toHaveBeenLastCalledWith({
    favorites: [favorites[1], favorites[0]],
  });
  await userEvent.click(page.getByRole("button", { name: "Remove Sol" }));
  expect(state.updateSettings).toHaveBeenLastCalledWith({ favorites: [favorites[1]] });
  await expect.element(page.getByRole("button", { name: "Move Sol up" })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Move Luna down" })).toBeDisabled();

  await userEvent.click(page.getByRole("combobox", { name: "Effort for Luna" }));
  await userEvent.click(page.getByRole("option", { name: "Low" }));
  expect(state.updateSettings).toHaveBeenLastCalledWith({
    favorites: [
      favorites[0],
      { provider: instanceId, model: "luna", options: [{ id: "reasoningEffort", value: "low" }] },
    ],
  });
});

it("moves a slider step as one whole list", async () => {
  setup({ effortSlider: steps });
  await using _screen = await render(<ModelShortcutsSettings />);
  await userEvent.click(page.getByRole("button", { name: "Move Sol up" }));
  expect(state.updateSettings).toHaveBeenLastCalledWith({ effortSlider: [steps[1], steps[0]] });
  await expect.element(page.getByRole("list", { name: "Effort slider steps" })).toBeVisible();
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
