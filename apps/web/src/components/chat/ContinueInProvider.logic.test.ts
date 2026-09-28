import { describe, expect, it } from "vite-plus/test";

import { isUsageLimitError, shouldOfferContinueInProvider } from "./ContinueInProvider.logic";

describe("isUsageLimitError", () => {
  it.each([
    "Claude usage limit reached. Send the message again once the limit resets.",
    "Claude stopped: a usage limit blocked the request.",
    "Codex usage limit reached. The weekly limit resets in 2 days.",
    "Grok usage limit reached. Try again later.",
    "rate_limit_error: This request would exceed your rate limit",
    "429 Too Many Requests",
    "You exceeded your current quota",
  ])("recognizes %s", (error) => {
    expect(isUsageLimitError(error)).toBe(true);
  });

  it.each([
    "Turn failed",
    "Claude CLI is not logged in",
    "ENOENT: no such file or directory",
    "Context window exceeded",
  ])("ignores %s", (error) => {
    expect(isUsageLimitError(error)).toBe(false);
  });
});

describe("shouldOfferContinueInProvider", () => {
  const exhausted = {
    checkedAt: "2026-09-28T10:00:00.000Z",
    windows: [{ id: "session", kind: "session" as const, label: "5-hour", usedPercent: 100 }],
  };

  it("needs an error to offer anything", () => {
    expect(shouldOfferContinueInProvider({ error: null, usageLimits: exhausted })).toBe(false);
  });

  it("offers on a generic error when the provider's window is used up", () => {
    expect(shouldOfferContinueInProvider({ error: "Turn failed", usageLimits: exhausted })).toBe(
      true,
    );
  });

  it("stays quiet on a generic error while the provider has room", () => {
    expect(
      shouldOfferContinueInProvider({
        error: "Turn failed",
        usageLimits: { ...exhausted, windows: [{ ...exhausted.windows[0]!, usedPercent: 40 }] },
      }),
    ).toBe(false);
  });
});
