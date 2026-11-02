import type { ServerProviderUsageCredit } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { creditSummary } from "./usageCredit.ts";

const credit: ServerProviderUsageCredit = {
  allowanceUsd: 60,
  balanceUsd: 41.2,
  periodStart: "2026-10-15T09:30:00.000Z",
  periodEnd: "2026-11-14T09:30:00.000Z",
};

describe("creditSummary", () => {
  it("reads as spent of the pool, what is left and when it expires, the market value, the plan and bought credit", () => {
    expect(
      creditSummary(
        { ...credit, openRouterValueUsd: 9.1, planPriceUsd: 20, purchasedBalanceUsd: 25 },
        { timeZone: "UTC" },
      ),
    ).toEqual([
      "$18.80 of $60 used",
      "$41.20 left, expires Nov 14",
      "≈ $9.10 at OpenRouter private rates",
      "plan $20",
      "$25 purchased credit",
    ]);
  });

  it("leaves out what the server did not report, and bought credit that is gone", () => {
    expect(creditSummary({ ...credit, purchasedBalanceUsd: 0 }, { timeZone: "UTC" })).toEqual([
      "$18.80 of $60 used",
      "$41.20 left, expires Nov 14",
    ]);
    expect(creditSummary({ ...credit, periodEnd: "never" })).toEqual([
      "$18.80 of $60 used",
      "$41.20 left",
    ]);
  });

  it("names the day in the viewer's zone", () => {
    expect(creditSummary(credit, { timeZone: "Pacific/Auckland" })[1]).toBe(
      "$41.20 left, expires Nov 14",
    );
    expect(
      creditSummary(
        { ...credit, periodEnd: "2026-11-14T23:30:00.000Z" },
        { timeZone: "Pacific/Auckland" },
      )[1],
    ).toBe("$41.20 left, expires Nov 15");
  });

  it("keeps cents on an odd pool and never reports a negative spend", () => {
    expect(creditSummary({ ...credit, allowanceUsd: 12.5, balanceUsd: 20 })[0]).toBe(
      "$0.00 of $12.50 used",
    );
  });
});
