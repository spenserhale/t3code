import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ServerProvider } from "./server.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);

const baseProviderSnapshot = {
  instanceId: "codex",
  driver: "codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  models: [],
};

describe("server config forward compatibility", () => {
  it("reads the subscriptions of an account, which older servers do not send", () => {
    const usageLimits = {
      checkedAt: "2026-04-10T00:00:00.000Z",
      windows: [{ id: "zai_weekly", kind: "weekly", label: "Z.ai · Weekly", usedPercent: 12 }],
    };
    const subscription = {
      id: "zai-coding-plan",
      label: "Z.ai",
      credentialFingerprint: "zai-fingerprint",
      checkedAt: "2026-04-09T23:00:00.000Z",
      windowIds: ["zai_weekly"],
      resetCredits: { availableCount: 1 },
    };

    expect(decodeServerProvider({ ...baseProviderSnapshot, usageLimits }).usageLimits).toEqual(
      usageLimits,
    );
    expect(
      decodeServerProvider({
        ...baseProviderSnapshot,
        usageLimits: {
          ...usageLimits,
          subscriptions: [subscription, { ...subscription, id: "future", windowIds: "all" }],
        },
      }).usageLimits,
    ).toEqual({ ...usageLimits, subscriptions: [subscription] });
  });

  it("reads the credit of a subscription, and drops only a credit it cannot read", () => {
    const credit = {
      allowanceUsd: 60,
      balanceUsd: 41.2,
      purchasedBalanceUsd: 25,
      periodStart: "2026-10-15T09:30:00.000Z",
      periodEnd: "2026-11-15T09:30:00.000Z",
      planPriceUsd: 20,
      openRouterValueUsd: 9.1,
    };
    const subscription = {
      id: "ollama-cloud",
      label: "Ollama Cloud",
      credentialFingerprint: "ollama-fingerprint",
      checkedAt: "2026-11-02T00:00:00.000Z",
      windowIds: ["ollama_monthly"],
    };
    const decode = (entry: object) =>
      decodeServerProvider({
        ...baseProviderSnapshot,
        usageLimits: {
          checkedAt: "2026-11-02T00:00:00.000Z",
          windows: [],
          subscriptions: [entry],
        },
      }).usageLimits?.subscriptions;

    expect(decode({ ...subscription, credit: { ...credit, future: true } })).toEqual([
      { ...subscription, credit },
    ]);
    expect(decode(subscription)).toEqual([subscription]);
    expect(decode({ ...subscription, credit: { ...credit, allowanceUsd: "sixty" } })).toEqual([
      subscription,
    ]);
  });
});
