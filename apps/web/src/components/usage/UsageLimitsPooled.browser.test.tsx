import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { CHATGPT_USAGE_URL } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { UsageLimitsPooled } from "./UsageLimitsPooled";

const checkedAt = "2026-10-25T16:00:00.000Z";

function managedChatGpt(instanceId: string, displayName: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    displayName,
    enabled: true,
    installed: true,
    version: "0.164.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [],
      unavailable: { reason: "unsupported", message: "Track usage in ChatGPT." },
      externalUsage: { label: "ChatGPT usage", url: CHATGPT_USAGE_URL },
    },
  };
}

describe("UsageLimitsPooled ChatGPT usage card", () => {
  it("names the managed connections it covers", async () => {
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              managedChatGpt("chatgpt_work", "ChatGPT Work"),
              managedChatGpt("chatgpt_personal", "ChatGPT Personal"),
            ],
          },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    await expect
      .element(screen.getByText("ChatGPT Work on Desk, ChatGPT Personal on Desk"))
      .toBeVisible();
    await expect
      .element(screen.getByText("View usage in ChatGPT with your connected account."))
      .toBeVisible();
  });
});

function opencodeProvider(usageLimits: NonNullable<ServerProvider["usageLimits"]>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("opencode_unlid"),
    driver: ProviderDriverKind.make("opencode"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits,
  };
}

const unlidSubscription = {
  id: "unlid",
  label: "Unlid",
  credentialFingerprint: "unlid-key",
  checkedAt,
  windowIds: [],
};

function deskPresentation(providers: readonly ServerProvider[]) {
  return new Map([
    [
      EnvironmentId.make("desk"),
      { entry: { target: { label: "Desk" } }, serverConfig: { providers } },
    ],
  ]);
}

describe("UsageLimitsPooled pay-as-you-go balances", () => {
  it("shows the balance lines for a windowless account, with no meter, beside a sibling bar", async () => {
    const presentations = deskPresentation([
      opencodeProvider({
        checkedAt,
        windows: [{ id: "go_5h", kind: "session", label: "Go", usedPercent: 40 }],
        subscriptions: [
          {
            ...unlidSubscription,
            balance: { balanceUsd: 4.99, heldUsd: 0.01, monthSpendUsd: 14.82 },
          },
          {
            id: "opencode-go",
            label: "OpenCode Go",
            credentialFingerprint: "go-key",
            checkedAt,
            windowIds: ["go_5h"],
          },
        ],
      }),
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    await expect.element(screen.getByText("$4.99 left")).toBeVisible();
    await expect.element(screen.getByText("held $0.01 · $14.82 this month")).toBeVisible();
    const balanceColumn = screen.getByText("$4.99 left").element().closest("div");
    expect(balanceColumn?.querySelectorAll('[role="progressbar"]')).toHaveLength(0);
    await expect
      .element(screen.getByRole("button", { name: "OpenCode Go: 60% left" }))
      .toBeVisible();
  });

  it("shows only the balance when the account reports nothing else", async () => {
    const presentations = deskPresentation([
      opencodeProvider({
        checkedAt,
        windows: [],
        subscriptions: [{ ...unlidSubscription, balance: { balanceUsd: 12 } }],
      }),
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    await expect.element(screen.getByText("$12.00 left")).toBeVisible();
    expect(screen.container.textContent).not.toContain("held");
    expect(screen.container.textContent).not.toContain("this month");
  });
});
