import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { providersFor, withoutUsageLimitSubscriptions } from "./usageLimitSubscriptions.ts";

const window = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-03T11:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("withoutUsageLimitSubscriptions", () => {
  const subscription = {
    id: "zai-coding-plan",
    label: "Z.ai",
    credentialFingerprint: "zai-key",
    checkedAt: "2026-09-03T11:00:00.000Z",
    windowIds: ["zai_five_hour"],
  };
  const listed = provider({
    usageLimits: {
      checkedAt: "2026-09-03T11:00:00.000Z",
      windows: [window],
      credentialFingerprint: "zai-key",
      resetCredits: { availableCount: 1 },
      subscriptions: [subscription],
    },
  });

  it("drops the subscriptions and nothing else", () => {
    const [stripped] = withoutUsageLimitSubscriptions([listed]);
    expect(stripped?.usageLimits).toEqual({
      checkedAt: "2026-09-03T11:00:00.000Z",
      windows: [window],
      credentialFingerprint: "zai-key",
      resetCredits: { availableCount: 1 },
    });
    expect(stripped).toEqual({ ...listed, usageLimits: stripped?.usageLimits });
    expect(listed.usageLimits?.subscriptions).toEqual([subscription]);
  });

  it("returns what it was given when there is nothing to drop", () => {
    const plain = [
      provider({}),
      provider({ usageLimits: { checkedAt: "2026-09-03T11:00:00.000Z", windows: [window] } }),
    ];
    expect(withoutUsageLimitSubscriptions(plain)).toBe(plain);
    const [, untouched] = withoutUsageLimitSubscriptions([listed, plain[1]!]);
    expect(untouched).toBe(plain[1]);
  });
});

describe("providersFor", () => {
  const listed = provider({
    usageLimits: {
      checkedAt: "2026-09-03T11:00:00.000Z",
      windows: [window],
      subscriptions: [
        {
          id: "zai-coding-plan",
          label: "Z.ai",
          credentialFingerprint: "zai-key",
          checkedAt: "2026-09-03T11:00:00.000Z",
          windowIds: ["five_hour"],
        },
      ],
    },
  });

  it("sends subscriptions only to a subscriber that asked for them", () => {
    const providers = [listed];
    expect(providersFor(providers, { usageLimitSubscriptions: true })).toBe(providers);
    for (const subscriber of [{}, { usageLimitSubscriptions: false }]) {
      expect(providersFor(providers, subscriber)[0]?.usageLimits?.subscriptions).toBeUndefined();
    }
  });

  it("keeps a subscription's credit with its subscriptions, so only the clients that asked get it", () => {
    const credit = {
      allowanceUsd: 60,
      balanceUsd: 41.2,
      purchasedBalanceUsd: 25,
      periodStart: "2026-08-15T09:30:00.000Z",
      periodEnd: "2026-09-15T09:30:00.000Z",
      planPriceUsd: 20,
      openRouterValueUsd: 9.1,
    };
    const providers = [
      provider({
        usageLimits: {
          checkedAt: "2026-09-03T11:00:00.000Z",
          windows: [window],
          subscriptions: [
            {
              id: "ollama-cloud",
              label: "Ollama Cloud",
              credentialFingerprint: "ollama-key",
              checkedAt: "2026-09-03T11:00:00.000Z",
              windowIds: ["five_hour"],
              credit,
            },
          ],
        },
      }),
    ];

    expect(
      providersFor(providers, { usageLimitSubscriptions: true })[0]?.usageLimits?.subscriptions?.[0]
        ?.credit,
    ).toEqual(credit);
    for (const subscriber of [{}, { usageLimitSubscriptions: false }]) {
      const sent = JSON.stringify(providersFor(providers, subscriber));
      expect(sent).not.toContain("credit");
      expect(sent).not.toContain("openRouterValueUsd");
    }
  });
});
