import type { LimitAccount, LimitPresentations } from "@t3tools/shared/usageLimits";
import { formatDuration } from "@t3tools/shared/usageLimits";
import {
  collectLimitGlance,
  formatCheckedAgo,
  type LimitGlanceWindow,
} from "@t3tools/shared/usageLimitsGlance";
import { ArrowRightIcon, RotateCcwIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { providerClients } from "../settings/providerDriverMeta";
import { InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useDailyTokens } from "./usageLimitDailyTokens";
import { useUsageLimitHistory } from "./usageLimitHistoryStore";
import { LimitGroupName, useCarriedLimitGroups } from "./UsageLimitGroupSections";

function WindowMeter({
  window,
  now,
  paired,
}: {
  readonly window: LimitGlanceWindow;
  readonly now: number;
  readonly paired: boolean;
}) {
  const expected = window.pace
    ? Math.max(0, Math.min(100, 100 - window.pace.expectedUsedPercent))
    : null;
  const outlook = window.pace?.outlook;
  const early =
    outlook?.kind === "runsOut" && window.resetsAt !== null
      ? Math.max(0, window.resetsAt - now - outlook.inMs)
      : null;
  const warning = early !== null || window.remainingPercent === 0;
  const description = [
    `${window.remainingPercent}% left`,
    expected === null ? null : `${Math.round(expected)}% expected left by now`,
    window.resetsIn ?? "Reset time unreported",
    early === null ? null : `May run out ${formatDuration(early)} before reset`,
  ]
    .filter((part) => part !== null)
    .join(". ");
  return (
    <div className="min-w-0">
      <div
        className={cn(
          "flex flex-wrap content-start items-baseline justify-between gap-x-1 gap-y-0.5",
          paired && "min-h-8 @lg:min-h-0",
        )}
      >
        <span className="text-2xs text-muted-foreground">{window.label}</span>
        <span
          className={cn(
            "ml-auto font-medium tabular-nums",
            warning ? "text-warning-foreground" : "text-foreground",
            window.kind === "session" && "text-2xs",
          )}
        >
          {window.remainingPercent}%
        </span>
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className="relative my-1.5 block"
              role="meter"
              aria-label={window.label}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={window.remainingPercent}
              aria-valuetext={description}
            />
          }
        >
          <span className="block h-1.5 overflow-hidden rounded-full bg-muted">
            <span
              className={cn(
                "block h-full rounded-full",
                warning ? "bg-warning-foreground" : "bg-foreground/60",
              )}
              style={{ width: `${window.remainingPercent}%` }}
            />
          </span>
          {expected === null ? null : (
            <span
              aria-hidden
              className="pointer-events-none absolute -top-1 h-3.5 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
              style={{ left: `${expected}%` }}
            />
          )}
        </TooltipTrigger>
        <TooltipPopup side="top">{description}</TooltipPopup>
      </Tooltip>
      <div className="flex items-center justify-end gap-1 text-2xs text-muted-foreground tabular-nums">
        <RotateCcwIcon aria-hidden className="size-2.5 shrink-0" />
        <span aria-label={window.resetsIn ?? "Reset time unreported"}>
          {window.resetsIn?.replace("resets in ", "") ?? "–"}
        </span>
      </div>
      {early === null ? null : (
        <span className="mt-0.5 block text-end text-2xs text-warning-foreground">
          {formatDuration(early)} early
        </span>
      )}
    </div>
  );
}

/** The clock is sampled on open; hovering never starts a refresh or a timer. */
export function UsageLimitsGlance({
  accounts,
  presentations,
  onOpenLimits,
}: {
  readonly accounts: readonly LimitAccount[];
  readonly presentations: LimitPresentations;
  readonly onOpenLimits: () => void;
}) {
  const [now] = useState(() => Date.now());
  const [groups] = useCarriedLimitGroups(accounts, presentations);
  const history = useUsageLimitHistory();
  const dailyTokens = useDailyTokens(now);
  const { sections, checkedAt } = collectLimitGlance(
    accounts,
    groups,
    now,
    (account) =>
      account.displayName ?? providerClients.get(account.driver)?.label ?? String(account.driver),
    { history, dailyTokens },
  );
  const checked = checkedAt ? formatCheckedAgo(checkedAt, now) : null;
  return (
    <div className="@container flex max-h-[calc(var(--available-height)-1rem)] min-h-0 flex-col gap-3 text-left text-xs">
      <header className="flex shrink-0 items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-foreground">Limits</span>
        {checked ? (
          <span className="text-2xs text-muted-foreground tabular-nums">{checked}</span>
        ) : null}
      </header>
      <div className="min-h-0 space-y-4 overflow-y-auto">
        {sections.map(({ group, rows }) => (
          <section
            key={group?.key ?? "all"}
            aria-label={group?.kind === "email" ? "Account group" : (group?.name ?? "Accounts")}
          >
            {group ? (
              <div className="mb-1.5 flex min-w-0 items-center gap-1.5 text-2xs font-medium text-muted-foreground">
                <LimitGroupName group={group} />
              </div>
            ) : null}
            <div className="divide-y divide-border/60">
              {rows.map((row) => (
                <div
                  key={row.account.key}
                  className="grid grid-cols-1 gap-x-3 gap-y-2 py-2.5 first:pt-0 last:pb-0 @lg:grid-cols-[5.5rem_minmax(0,1fr)]"
                >
                  <span className="min-w-0 pt-0.5 font-medium wrap-anywhere text-foreground">
                    {row.name}
                  </span>
                  {row.resetSinceChecked ? (
                    <span className="text-2xs text-muted-foreground">Reset since checked</span>
                  ) : (
                    <div className="min-w-0 divide-y divide-border/60">
                      {row.pools.map((pool) => (
                        <div
                          key={pool.key}
                          className={cn(
                            "grid min-w-0 gap-x-3 py-2 first:pt-0 last:pb-0",
                            pool.label === null
                              ? "grid-cols-1"
                              : "grid-cols-[4.5rem_minmax(0,1fr)]",
                          )}
                        >
                          {pool.label === null ? null : (
                            <span className="self-center text-2xs wrap-anywhere text-muted-foreground">
                              {pool.label}
                            </span>
                          )}
                          <div
                            className="grid min-w-0 gap-x-3 gap-y-2"
                            style={{
                              gridTemplateColumns: pool.windows
                                .map((window) =>
                                  window.kind === "session" ? "minmax(0,1fr)" : "minmax(0,2fr)",
                                )
                                .join(" "),
                            }}
                          >
                            {pool.windows.map((window) => (
                              <WindowMeter
                                key={window.id}
                                window={window}
                                now={now}
                                paired={pool.windows.length > 1}
                              />
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 pt-2 text-2xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-1 w-3 rounded-full bg-foreground/60" />
          Left
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-0.5 bg-foreground" />
          Expected left now
        </span>
        <span>– unreported</span>
        <InlineButton tone="muted" className="ml-auto" onClick={onOpenLimits}>
          Open limits
          <ArrowRightIcon aria-hidden className="size-3" />
        </InlineButton>
      </div>
    </div>
  );
}
