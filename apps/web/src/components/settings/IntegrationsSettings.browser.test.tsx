import { render } from "../../../test/render";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  /** Each environment in scope, and whether its server reads the escalation setting. */
  environments: [] as Array<{ readonly label: string; readonly secretRelay?: boolean }>,
}));

vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => ({
    ...DEFAULT_UNIFIED_SETTINGS,
    // An older server's own setting: it never asks, whatever the escalation control shows.
    browserLogins: { ...DEFAULT_UNIFIED_SETTINGS.browserLogins, approval: "never" },
  })) as never,
  useUpdateScopedSettings: () => vi.fn(),
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => {
    const connectedEnvironments = state.environments.map(({ label, secretRelay }) => ({
      environmentId: label,
      label,
      connection: { phase: "connected" },
      serverConfig: {
        settings: DEFAULT_UNIFIED_SETTINGS,
        ...(secretRelay === undefined ? {} : { secretRelay }),
      },
    }));
    return {
      scope: { kind: "all", environmentIds: [] },
      environment: connectedEnvironments[0] ?? null,
      connectedEnvironments,
    };
  }) as never,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: ({ status, control }) => (
    <div>
      {status}
      {control}
    </div>
  ),
}));

import { BrowserLoginSettings } from "./IntegrationsSettings";

const escalation = () =>
  page.getByRole("combobox", { name: "Outside this machine's service accounts" });

const content = (): ReactNode => <BrowserLoginSettings />;

describe("BrowserLoginSettings", () => {
  it("shows the escalation setting only to servers that read it", async () => {
    state.environments = [{ label: "LinkMini" }];
    await using screen = await render(content());
    await expect.element(page.getByText(/Update T3 Code on LinkMini\b/)).toBeInTheDocument();
    await expect.element(escalation()).not.toBeInTheDocument();

    state.environments = [{ label: "LinkMini", secretRelay: true }];
    await screen.rerender(content());
    await expect.element(escalation()).toBeInTheDocument();
    await expect.element(page.getByText(/Update T3 Code on/)).not.toBeInTheDocument();

    // Set from several machines at once, the older ones are named.
    state.environments = [{ label: "LinkMini", secretRelay: true }, { label: "RW" }];
    await screen.rerender(content());
    await expect.element(escalation()).toBeInTheDocument();
    await expect.element(page.getByText(/Update T3 Code on RW\b/)).toBeInTheDocument();
  });
});
