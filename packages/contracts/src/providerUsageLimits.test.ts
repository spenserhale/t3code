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
});
