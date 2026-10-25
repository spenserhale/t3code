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
});
