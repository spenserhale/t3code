// @effect-diagnostics globalDate:off -- The cache is dated by the wall clock when the totals arrive.
import { makeWindow } from "@t3tools/shared/usageFormat";
import { useEffect, useState } from "react";

import { useUsage } from "../../state/usage";
import { cacheDailyTokens } from "./usageLimitDailyTokens";

/**
 * Fetches the last 90 days of token totals and keeps them in the local cache.
 * Mount it only while something needs them, which is the weekday forecast.
 */
export function DailyTokensSync() {
  const [window] = useState(() => makeWindow(90));
  const { merged } = useUsage(window);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- copies fetched token totals into the local cache that forecasts and reminders read
  useEffect(() => {
    if (merged.daily.length > 0) cacheDailyTokens(merged.daily, Date.now());
  }, [merged]);
  return null;
}
