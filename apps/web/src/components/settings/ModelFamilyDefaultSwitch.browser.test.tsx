import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { expect, it, vi } from "vite-plus/test";
import "../../index.css";
import { render } from "../../../test/render";
import { ModelFamilyDefaultSwitch } from "./ModelFamilyDefaultSwitch";

it("follows and pins the latest Sol while preserving High effort", async () => {
  const instanceId = ProviderInstanceId.make("codex");
  const provider: ServerProvider = {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-18T00:00:00Z",
    models: ["gpt-6.1-sol", "gpt-6.2-sol"].map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: {},
    })),
    slashCommands: [],
    skills: [],
  };
  const selection = {
    instanceId,
    model: "gpt-6.1-sol",
    options: [{ id: "reasoningEffort", value: "high" }],
  };
  const target = {
    environmentId: EnvironmentId.make("laptop"),
    projectId: ProjectId.make("work"),
    providers: [provider],
    settings: { ...DEFAULT_SERVER_SETTINGS, defaultModelSelection: selection },
  };
  const onChange = vi.fn();
  const control = (followLatest: boolean) => (
    <ModelFamilyDefaultSwitch
      targets={[
        {
          ...target,
          settings: {
            ...target.settings,
            defaultModelSelection: {
              ...selection,
              ...(followLatest ? { followLatest: true } : {}),
            },
          },
        },
      ]}
      clientSettings={DEFAULT_CLIENT_SETTINGS}
      onChange={onChange}
    />
  );
  await using screen = await render(control(false));
  const toggle = screen.getByRole("switch", { name: "Follow latest Sol" });
  const latest = { ...selection, model: "gpt-6.2-sol" };
  await toggle.click();
  expect(onChange).toHaveBeenLastCalledWith([
    {
      environmentId: target.environmentId,
      projectId: target.projectId,
      selection: { ...latest, followLatest: true },
    },
  ]);
  await screen.rerender(control(true));
  await expect.element(toggle).toBeChecked();
  await toggle.click();
  expect(onChange).toHaveBeenLastCalledWith([
    {
      environmentId: target.environmentId,
      projectId: target.projectId,
      selection: latest,
    },
  ]);
});
