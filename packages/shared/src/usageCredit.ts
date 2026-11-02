// @effect-diagnostics globalDate:off -- The reset date is a calendar day in the viewer's zone, via Intl.
import type { ServerProviderUsageCredit } from "@t3tools/contracts";

import { formatUsd } from "./usageFormat.ts";

/** A plan's round figures read as "$60", what was spent as "$18.80". */
function formatPlanUsd(value: number): string {
  return Number.isInteger(value) ? `$${value.toLocaleString("en-US")}` : formatUsd(value);
}

/**
 * One line about a subscription's credit pool, as parts to join with a separator:
 * what the period has used, when it renews, what that use would cost at OpenRouter's
 * zero-data-retention rates, what the plan costs, and any bought credit left.
 */
export function creditSummary(
  credit: ServerProviderUsageCredit,
  options: { readonly timeZone?: string } = {},
): ReadonlyArray<string> {
  const spentUsd = Math.max(0, credit.allowanceUsd - credit.balanceUsd);
  const periodEnd = new Date(credit.periodEnd);
  const parts = [`${formatUsd(spentUsd)} of ${formatPlanUsd(credit.allowanceUsd)} used`];
  if (!Number.isNaN(periodEnd.getTime())) {
    const day = new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
    });
    parts.push(`resets ${day.format(periodEnd)}`);
  }
  if (credit.openRouterValueUsd !== undefined) {
    parts.push(`≈ ${formatUsd(credit.openRouterValueUsd)} at OpenRouter private rates`);
  }
  if (credit.planPriceUsd !== undefined) parts.push(`plan ${formatPlanUsd(credit.planPriceUsd)}`);
  if (credit.purchasedBalanceUsd !== undefined && credit.purchasedBalanceUsd > 0) {
    parts.push(`${formatPlanUsd(credit.purchasedBalanceUsd)} purchased credit`);
  }
  return parts;
}
