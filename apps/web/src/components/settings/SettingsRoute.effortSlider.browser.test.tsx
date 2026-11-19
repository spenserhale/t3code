import { RegistryContext } from "@effect/atom-react";
import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  type ModelSelection,
  type ServerSettings,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useLocation,
} from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import {
  codexInstanceId,
  highEffort,
  lowEffort,
  modelShortcutProviders,
  modelShortcutSteps,
  openCodeInstanceId,
} from "../../../test/modelShortcutsSettingsFixtures";
import { render } from "../../../test/render";
import { ComposerEffortColumn } from "../chat/ComposerModelEffort";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { isAppModalPage } from "../sidebar/mainAppLocation";
import { SidebarProvider } from "../ui/sidebar";
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import type { EnvironmentPresentation } from "../../state/environments";
import type { Project } from "../../types";
import { Route as SettingsRoute } from "../../routes/_chat.settings";
import { Route as ThreadsRoute } from "../../routes/_chat.settings.threads";

const primaryId = EnvironmentId.make("env-a");
const remoteId = EnvironmentId.make("env-b");
const codex = ProviderDriverKind.make("codex");
const openCode = ProviderDriverKind.make("opencode");
const providerSnapshots = new Map([
  [primaryId, modelShortcutProviders],
  [remoteId, modelShortcutProviders],
]);
const project: Project = {
  id: ProjectId.make("project-slider"),
  environmentId: primaryId,
  title: "Slider project",
  workspaceRoot: "/workspace/slider",
  defaultModelSelection: { instanceId: codexInstanceId, model: "luna" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  scripts: [],
};
const projectGroup = buildSidebarProjectSnapshots({
  projects: [project],
  settings: DEFAULT_CLIENT_SETTINGS,
  primaryEnvironmentId: primaryId,
  resolveEnvironmentLabel: () => "Mac mini",
})[0]!;
const checkoutScope = {
  project: projectGroup.projectKey,
  machine: primaryId,
  checkout: projectGroup.memberProjects[0]!.physicalProjectKey,
};
const missingProjectFile = Atom.make(AsyncResult.initial<never, never>());

const state = vi.hoisted(() => ({
  environments: [] as EnvironmentPresentation[],
  writeSettings: vi.fn(),
}));

vi.mock(import("../../localEnvironment"), () => ({ isLocalEnvironmentDisabled: () => true }));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: () => ({
    isReady: true,
    networkStatus: "online",
    environments: state.environments,
    presentationById: new Map(
      state.environments.map((environment) => [environment.environmentId, environment]),
    ),
  }),
  useEnvironmentProviders: () => providerSnapshots,
  usePrimaryEnvironmentId: () => primaryId,
  usePrimaryEnvironment: () => state.environments[0] ?? null,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
  useEnvironmentsWithScope: (environments) =>
    new Set(environments.map(({ environmentId }) => environmentId)),
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => [project],
}));
vi.mock(import("../files/projectFilesQueryState"), async (original) => ({
  ...(await original()),
  getProjectFileQueryAtom: () => missingProjectFile,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => {
  const { serverEnvironment } = await import("../../state/server");
  const actual = await original();
  return {
    ...actual,
    useAtomCommand: (command, options) => {
      const run = actual.useAtomCommand(command, options);
      return Object.is(command, serverEnvironment.updateSettings) ? state.writeSettings : run;
    },
  };
});

const openCodeSteps: ModelSelection[] = [
  { instanceId: openCodeInstanceId, model: "open", options: lowEffort },
  { instanceId: openCodeInstanceId, model: "open", options: highEffort },
];
const sixSteps: ModelSelection[] = [
  ...modelShortcutSteps,
  { ...modelShortcutSteps[0]!, options: highEffort },
  { ...modelShortcutSteps[1]!, options: lowEffort },
  ...openCodeSteps,
];
const fiveSteps = sixSteps.slice(0, 5);

function environment(
  environmentId: EnvironmentId,
  label: string,
  settings: Partial<ServerSettings>,
): EnvironmentPresentation {
  const displayUrl = window.location.origin;
  return {
    environmentId,
    label,
    displayUrl,
    relayManaged: false,
    entry: {
      target: new PrimaryConnectionTarget({
        environmentId,
        label,
        httpBaseUrl: displayUrl,
        wsBaseUrl: displayUrl.replace(/^http/, "ws"),
      }),
      profile: Option.none(),
      enabled: true,
    },
    connection: { phase: "connected", error: null, traceId: null },
    serverConfig: {
      environment: {
        environmentId,
        label,
        platform: { os: "darwin", arch: "arm64" },
        serverVersion: "0.1.9",
        capabilities: { repositoryIdentity: true, effortSlider: true, providerEffortSliders: true },
      },
      auth: {
        policy: "loopback-browser",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "t3_session",
      },
      cwd: "/workspace",
      keybindingsConfigPath: "/workspace/keybindings.json",
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
      issues: [],
      availableEditors: [],
      observability: {
        logsDirectoryPath: "/workspace/logs",
        localTracingEnabled: false,
        otlpTracesEnabled: false,
        otlpMetricsEnabled: false,
        otlpLogsEnabled: false,
      },
      settings: { ...DEFAULT_SERVER_SETTINGS, ...settings },
    },
  };
}

function setup(primary: Partial<ServerSettings>, remote = primary) {
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  state.environments = [
    environment(primaryId, "Mac mini", primary),
    environment(remoteId, "Laptop", remote),
  ];
  state.writeSettings.mockReset();
  state.writeSettings.mockResolvedValue(AsyncResult.success(undefined));
}

const pickerEntries = deriveProviderInstanceEntries(modelShortcutProviders);
const pickerModels = new Map(
  modelShortcutProviders.map(({ instanceId, models }) => [instanceId, models]),
);

function ModelPickerEntry() {
  return (
    <ProviderModelPicker
      environmentId={primaryId}
      activeInstanceId={codexInstanceId}
      model="luna"
      lockedProvider={codex}
      instanceEntries={pickerEntries}
      modelOptionsByInstance={pickerModels}
      preferActiveProvider
      triggerAriaLabel="Choose model"
      onInstanceModelChange={() => {}}
      effortColumn={<ComposerEffortColumn traits={null} />}
      effortSliderForTab={() => ({
        slider: null,
        actions: {
          selection: modelShortcutSteps[0]!,
          settingsTarget: {
            environmentId: primaryId,
            projectId: null,
            projectOverrides: false,
            driver: codex,
          },
        },
      })}
    />
  );
}

function ChatLayout() {
  const modalOpen = useLocation({ select: ({ pathname }) => isAppModalPage(pathname) });
  return (
    <>
      <div inert={modalOpen}>
        <ModelPickerEntry />
      </div>
      <Outlet />
    </>
  );
}

const root = createRootRoute();
const chat = createRoute({ getParentRoute: () => root, id: "_chat", component: ChatLayout });
const index = createRoute({ getParentRoute: () => chat, path: "/" });
const settingsOptions = {
  ...SettingsRoute.options,
  id: "/settings",
  path: "/settings",
  getParentRoute: () => chat,
};
const threadsOptions = {
  ...ThreadsRoute.options,
  id: "/threads",
  path: "/threads",
  getParentRoute: () => SettingsRoute,
};
const routeTree = root.addChildren([
  chat.addChildren([
    index,
    SettingsRoute.update(settingsOptions).addChildren([ThreadsRoute.update(threadsOptions)]),
  ]),
]);

async function mountSettings(url = "/settings/threads", width = 1280, height = 520) {
  await page.viewport(width, height);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [url] }),
    disableGlobalCatchBoundary: true,
  });
  await router.load();
  // Use the actual Settings and Threads routes, including their search validators.
  const screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <SidebarProvider>
        <RouterProvider router={router} />
      </SidebarProvider>
    </RegistryContext.Provider>,
    { router: false },
  );
  return { ...screen, router };
}

const sliderPicker = () => page.getByRole("combobox", { name: "Slider to edit" });
const addStep = () => page.getByRole("button", { name: "Edit slider" });
const sliderSteps = () =>
  page.getByRole("list", { name: "Effort slider steps" }).getByRole("listitem");
const codexFallback = () => page.getByText(/The Codex tab uses the Favorites slider/);
const paneSelector = "[data-settings-page-scroll]";
const scrollPane = () => document.querySelector<HTMLElement>(paneSelector)!;

function measureEditor() {
  const pane = scrollPane();
  const trigger = sliderPicker().element();
  const paneBounds = pane.getBoundingClientRect();
  const triggerBounds = trigger.getBoundingClientRect();
  return {
    pane,
    trigger,
    paneBounds,
    triggerBounds,
    scrollTop: pane.scrollTop,
    maxScrollTop: pane.scrollHeight - pane.clientHeight,
  };
}

function fitsInPane(control: DOMRect, pane: DOMRect) {
  return (
    control.top >= pane.top &&
    control.bottom <= pane.bottom &&
    control.left >= pane.left &&
    control.right <= pane.right
  );
}

function expectControlsInPane(measurement: ReturnType<typeof measureEditor>, control = addStep()) {
  expect(fitsInPane(measurement.triggerBounds, measurement.paneBounds)).toBe(true);
  expect(fitsInPane(control.element().getBoundingClientRect(), measurement.paneBounds)).toBe(true);
}

function showEditor(control = addStep(), inset = 100) {
  const pane = scrollPane();
  const trigger = sliderPicker().element();
  const header = control.element();
  pane.scrollTop +=
    Math.min(trigger.getBoundingClientRect().top, header.getBoundingClientRect().top) -
    pane.getBoundingClientRect().top -
    inset;
  const before = measureEditor();
  expect(before.scrollTop).toBeGreaterThan(0);
  expectControlsInPane(before, control);
  return before;
}

async function selectSlider(name: string) {
  await userEvent.click(sliderPicker());
  await userEvent.click(page.getByRole("option", { name, exact: true }));
  await waitForSlider(name);
}

async function waitForSlider(name: string) {
  await expect.element(sliderPicker()).toHaveTextContent(name);
  await expect.element(sliderPicker()).toHaveAttribute("aria-expanded", "false");
  await expect.element(page.getByRole("option", { name, exact: true })).not.toBeInTheDocument();
}

function expectSameEditor(
  before: ReturnType<typeof measureEditor>,
  after: ReturnType<typeof measureEditor>,
) {
  expect(
    {
      samePane: before.pane === after.pane && before.pane.isConnected,
      sameTrigger: before.trigger === after.trigger && before.trigger.isConnected,
    },
    `scrollTop/max before ${before.scrollTop}/${before.maxScrollTop}, after ${after.scrollTop}/${after.maxScrollTop}; trigger top ${before.triggerBounds.top} to ${after.triggerBounds.top}`,
  ).toEqual({ samePane: true, sameTrigger: true });
}

it("keeps the editor in view when switching between Favorites and an empty provider slider", async () => {
  setup({ effortSlider: fiveSteps });
  await using screen = await mountSettings();
  await expect.element(sliderPicker()).toHaveTextContent("Favorites");
  await vi.waitFor(() => expect(sliderSteps().elements()).toHaveLength(5));
  const before = showEditor();

  await selectSlider("Codex");
  await expect.element(codexFallback()).toBeVisible();
  const empty = measureEditor();
  expectSameEditor(before, empty);
  expect(empty.maxScrollTop).toBeGreaterThan(before.scrollTop);
  expect(empty.scrollTop).toBe(before.scrollTop);
  expectControlsInPane(empty);
  expect(screen.router.state.location.search).toEqual({ effortSliderProvider: "codex" });

  await selectSlider("Favorites");
  await vi.waitFor(() => expect(sliderSteps().elements()).toHaveLength(5));
  const restored = measureEditor();
  expectSameEditor(before, restored);
  expect(restored.scrollTop).toBe(before.scrollTop);
  expect(Math.abs(restored.triggerBounds.top - before.triggerBounds.top)).toBeLessThanOrEqual(1);
  expect(screen.router.state.location.search).toEqual({});

  (restored.trigger as HTMLElement).focus({ preventScroll: true });
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("option", { name: "Codex", exact: true })).toBeVisible();
  await userEvent.keyboard("{ArrowDown}{Enter}");
  await waitForSlider("Codex");
  await expect.element(codexFallback()).toBeVisible();
  await expect.element(sliderPicker()).toHaveFocus();
  const keyboard = measureEditor();
  expectSameEditor(before, keyboard);
  expect(keyboard.scrollTop).toBe(before.scrollTop);
  expectControlsInPane(keyboard);
  expect(screen.router.state.location.search).toEqual({ effortSliderProvider: "codex" });

  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  await expect.element(addStep()).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("option", { name: /Sol.*Codex/ })).toBeVisible();
  await expect
    .element(page.getByRole("option", { name: /OpenCode model/ }))
    .not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await expect.element(addStep()).toHaveFocus();
  await userEvent.keyboard("{Tab}");
  await expect.element(sliderPicker()).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("option", { name: "Favorites", exact: true })).toBeVisible();
  await userEvent.keyboard("{ArrowUp}{Enter}");
  await waitForSlider("Favorites");
  await expect.element(sliderPicker()).toHaveFocus();
  await vi.waitFor(() => expect(sliderSteps().elements()).toHaveLength(5));
  const keyboardRestored = measureEditor();
  expectSameEditor(before, keyboardRestored);
  expect(keyboardRestored.scrollTop).toBe(before.scrollTop);
  expectControlsInPane(keyboardRestored);
  expect(screen.router.state.location.search).toEqual({});
  expect(state.writeSettings).not.toHaveBeenCalled();
});

it("keeps the same editor and offset when switching between equally long provider lists", async () => {
  setup({ providerEffortSliders: { [codex]: modelShortcutSteps, [openCode]: openCodeSteps } });
  await using _screen = await mountSettings("/settings/threads?effortSliderProvider=codex");
  await expect.element(sliderPicker()).toHaveTextContent("Codex");
  await vi.waitFor(() => expect(sliderSteps().elements()).toHaveLength(2));
  const before = showEditor();

  await selectSlider("OpenCode");
  await vi.waitFor(() => expect(sliderSteps().elements()).toHaveLength(2));
  const after = measureEditor();
  expectSameEditor(before, after);
  expect(after.maxScrollTop).toBe(before.maxScrollTop);
  expect(after.scrollTop).toBe(before.scrollTop);
  expect(Math.abs(after.triggerBounds.top - before.triggerBounds.top)).toBeLessThanOrEqual(1);
});

it("keeps the controls usable at the end of the visible editor in a short pane", async () => {
  setup({ effortSlider: sixSteps });
  await using _screen = await mountSettings("/settings/threads", 1280, 420);
  const full = addStep;
  await expect.element(full()).toBeEnabled();
  await vi.waitFor(() => expect(sliderSteps().elements()).toHaveLength(6));
  const before = showEditor(full(), 24);

  await selectSlider("Codex");
  await expect.element(codexFallback()).toBeVisible();
  const empty = measureEditor();
  expectSameEditor(before, empty);
  expect(empty.maxScrollTop).toBeLessThan(before.maxScrollTop);
  expect(empty.maxScrollTop).toBeGreaterThan(before.scrollTop);
  expect(empty.scrollTop).toBe(before.scrollTop);
  expectControlsInPane(empty);

  // Open the model picker where the controls landed, without scrolling them into view first.
  await userEvent.click(addStep());
  await expect.element(page.getByRole("option", { name: /Sol.*Codex/ })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("option", { name: /Sol.*Codex/ })).not.toBeInTheDocument();
  expect(scrollPane().scrollTop).toBe(empty.scrollTop);

  await selectSlider("Favorites");
  await vi.waitFor(() => expect(sliderSteps().elements()).toHaveLength(6));
  const restored = measureEditor();
  expectSameEditor(before, restored);
  expect(restored.maxScrollTop).toBe(before.maxScrollTop);
  expect(restored.scrollTop).toBe(before.scrollTop);
  expectControlsInPane(restored, full());
});

it("refreshes the slider when the environment scope changes", async () => {
  setup(
    { effortSlider: fiveSteps },
    { providerEffortSliders: { [codex]: [modelShortcutSteps[1]!] } },
  );
  await using screen = await mountSettings(`/settings/threads?machine=${primaryId}`);
  await expect.element(sliderPicker()).toHaveTextContent("Favorites");
  const before = showEditor();

  await selectSlider("Codex");
  await expect.element(codexFallback()).toBeVisible();
  expectSameEditor(before, measureEditor());
  expect(screen.router.state.location.search).toEqual({
    machine: primaryId,
    effortSliderProvider: codex,
  });

  await userEvent.click(page.getByRole("button", { name: "Environment scope: Mac mini" }));
  await userEvent.click(page.getByRole("menuitemradio", { name: /^Laptop/ }));
  await expect
    .element(page.getByRole("button", { name: "Environment scope: Laptop" }))
    .toBeVisible();
  await expect.element(sliderPicker()).toHaveTextContent("Codex");
  await expect.element(sliderSteps().first().getByText("Sol", { exact: true })).toBeVisible();
  await vi.waitFor(() => expect(sliderSteps().elements()).toHaveLength(1));
  expect(screen.router.state.location.search).toEqual({
    machine: remoteId,
    effortSliderProvider: codex,
  });
  expect(before.pane.isConnected).toBe(false);
  expect(state.writeSettings).not.toHaveBeenCalled();
});

it.each([
  { width: 360, height: 620, layout: "a narrow window" },
  { width: 640, height: 520, layout: "a 200% zoom-equivalent viewport" },
])("keeps the checkout editor usable in $layout", async ({ width, height }) => {
  setup({
    providerEffortSliders: { [codex]: [modelShortcutSteps[0]!] },
    projectSettingsOverrides: { [project.id]: { effortSlider: fiveSteps } },
  });
  const search = new URLSearchParams(checkoutScope);
  await using screen = await mountSettings(`/settings/threads?${search}`, width, height);
  const row = () => page.elementLocator(document.getElementById("effort-slider")!);
  const hint = () => row().getByText(/One step is not enough/);
  const customize = () => row().getByRole("button", { name: "Customize for this project" });
  await expect.element(sliderPicker()).toHaveTextContent("Favorites");
  await expect.element(row().getByRole("button", { name: "Use the environment's" })).toBeEnabled();
  const description = row()
    .getByText(/^Set up to 6 model and effort steps/)
    .element();
  expect(description.getBoundingClientRect().height).toBeGreaterThan(
    Number.parseFloat(getComputedStyle(description).lineHeight),
  );
  const before = showEditor();

  await selectSlider("Codex");
  await expect.element(row().getByText("This project uses Mac mini's Codex slider.")).toBeVisible();
  await expect.element(hint()).toBeVisible();
  await expect.element(customize()).toBeEnabled();
  const inherited = measureEditor();
  expectSameEditor(before, inherited);
  expect(inherited.scrollTop).toBe(before.scrollTop);
  expectControlsInPane(inherited, customize());
  expect(fitsInPane(hint().element().getBoundingClientRect(), inherited.paneBounds)).toBe(true);
  expect(screen.router.state.location.search).toEqual({
    ...checkoutScope,
    effortSliderProvider: codex,
  });

  await selectSlider("Favorites");
  const restored = measureEditor();
  expectSameEditor(before, restored);
  expect(restored.scrollTop).toBe(before.scrollTop);
  expectControlsInPane(restored);
  expect(screen.router.state.location.search).toEqual(checkoutScope);
  expect(state.writeSettings).not.toHaveBeenCalled();
});

it("dismisses the model picker and opens the requested slider at its scroll target", async () => {
  setup({ effortSlider: fiveSteps });
  await using screen = await mountSettings("/");
  const modelPicker = page.getByRole("button", { name: "Choose model" });
  const modelPickerTrigger = modelPicker.element();
  await userEvent.click(modelPicker);
  const modelSearch = page.getByPlaceholder("Search models...");
  await expect.element(modelSearch).toHaveFocus();
  const settings = page.getByRole("button", { name: "Effort slider settings" });
  await expect.element(settings).toBeVisible();
  using scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");

  await userEvent.click(settings);
  await expect.element(sliderPicker()).toHaveTextContent("Codex");
  await expect.element(codexFallback()).toBeVisible();
  await vi.waitFor(() => expect(screen.router.state.location.hash).toBe(""));
  expect(screen.router.state.location.search).toEqual({
    machine: primaryId,
    effortSliderProvider: codex,
  });
  expect(modelPickerTrigger.isConnected).toBe(true);
  await expect.element(modelSearch).not.toBeInTheDocument();
  await expect
    .element(page.elementLocator(document.getElementById("effort-slider")!))
    .toHaveFocus();
  await vi.waitFor(() => {
    const editor = measureEditor();
    expect(editor.scrollTop).toBeGreaterThan(0);
    expectControlsInPane(editor);
  });
  const targetScrolls = () =>
    scrollIntoView.mock.contexts.filter(
      (element) => element instanceof Element && element.id === "effort-slider",
    );
  expect(targetScrolls()).toHaveLength(1);

  await selectSlider("Favorites");
  expect(targetScrolls()).toHaveLength(1);
  expect(screen.router.state.location.search).toEqual({ machine: primaryId });
  expect(screen.router.state.location.hash).toBe("");
  expect(state.writeSettings).not.toHaveBeenCalled();
});

it("opens the composer selection in the editor and returns to chat after inserting an effort", async () => {
  setup({ providerEffortSliders: { [codex]: [modelShortcutSteps[0]!, modelShortcutSteps[1]!] } });
  await using screen = await mountSettings("/");
  await page.getByRole("button", { name: "Choose model" }).click();
  await page.getByRole("button", { name: "Edit slider" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Codex slider" });
  const after = dialog.getByRole("button", { name: "Add step after" });
  await expect
    .element(dialog.getByRole("button", { name: "Luna · Low", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect.element(after).toBeDisabled();
  await dialog.getByRole("button", { name: "High", exact: true }).click();
  expect(state.writeSettings).not.toHaveBeenCalled();
  await after.click();
  expect(state.writeSettings).toHaveBeenCalledWith({
    environmentId: primaryId,
    input: {
      patch: {
        setProviderEffortSliders: [
          {
            driver: codex,
            steps: [
              modelShortcutSteps[0],
              { ...modelShortcutSteps[0], options: highEffort },
              modelShortcutSteps[1],
            ],
          },
        ],
      },
    },
  });
  await expect
    .element(dialog.getByRole("button", { name: "Luna · High", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await dialog.getByRole("button", { name: "Done" }).click();
  await vi.waitFor(() => expect(screen.router.state.location.pathname).toBe("/"));
});
