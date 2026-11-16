import type { LimitAccount, LimitPresentations } from "@t3tools/shared/usageLimits";
import { normalizeProviderAccentColor } from "@t3tools/client-runtime/state/provider-instance-display";
import { formatDuration } from "@t3tools/shared/usageLimits";
import {
  collectLimitGlance,
  formatCheckedAgo,
  type LimitGlanceWindow,
} from "@t3tools/shared/usageLimitsGlance";
import { AlertTriangleIcon, ArrowRightIcon, RotateCcwIcon } from "lucide-react";
import { type CSSProperties, useState } from "react";

import { cn } from "../../lib/utils";
import { providerClients } from "../settings/providerDriverMeta";
import { InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useDailyTokens } from "./usageLimitDailyTokens";
import { useUsageLimitHistory } from "./usageLimitHistoryStore";
import { LimitGroupName, useCarriedLimitGroups } from "./UsageLimitGroupSections";
import { PROVIDER_PRESENTATION } from "./usageProviders";

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
  const ready = window.remainingPercent === 100 && window.resetsAt === null;
  const description = [
    `${window.remainingPercent}% left`,
    expected === null ? null : `${Math.round(expected)}% expected left by now`,
    ready ? "Ready. Reset time unreported" : (window.resetsIn ?? "Reset time unreported"),
    early === null ? null : `May run out ${formatDuration(early)} before reset`,
  ]
    .filter((part) => part !== null)
    .join(". ");
  return (
    <div
      className={cn(
        "grid min-w-0 items-center gap-x-1.5 gap-y-1",
        paired ? "grid-cols-[minmax(0,1fr)_auto]" : "grid-cols-[auto_minmax(0,1fr)_auto_auto]",
      )}
    >
      <span
        className={cn(
          "col-start-1 row-start-1 text-2xs text-muted-foreground",
          paired ? "wrap-anywhere" : "whitespace-nowrap",
        )}
      >
        {paired && window.kind === "session" ? window.label.replace(/-hour$/, "h") : window.label}
      </span>
      <span
        className={cn(
          "row-start-1 text-right font-medium whitespace-nowrap tabular-nums",
          paired ? "col-start-2" : "col-start-3",
          warning ? "text-warning-foreground" : "text-foreground",
        )}
      >
        {window.remainingPercent}%
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className={cn(
                "relative block min-w-3",
                paired ? "col-start-1 row-start-2" : "col-start-2 row-start-1",
              )}
              role="meter"
              aria-label={window.label}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={window.remainingPercent}
              aria-valuetext={description}
            />
          }
        >
          <span className="block h-1 overflow-hidden rounded-full bg-muted">
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
              className="pointer-events-none absolute -top-0.5 h-2 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
              style={{ left: `${expected}%` }}
            />
          )}
        </TooltipTrigger>
        <TooltipPopup side="top">{description}</TooltipPopup>
      </Tooltip>
      <div
        className={cn(
          "flex items-center justify-end gap-0.5 text-2xs whitespace-nowrap text-muted-foreground tabular-nums",
          paired ? "col-start-2 row-start-2" : "col-start-4 row-start-1",
        )}
      >
        {ready ? (
          <span>Ready</span>
        ) : (
          <>
            <RotateCcwIcon aria-hidden className="size-2.5 shrink-0" />
            <span aria-label={window.resetsIn ?? "Reset time unreported"}>
              {window.resetsIn?.replace("resets in ", "") ?? "–"}
            </span>
          </>
        )}
      </div>
      {early === null ? null : (
        <span
          className={cn(
            "flex items-center gap-1 text-2xs text-warning-foreground",
            paired ? "col-span-2 row-start-3" : "col-span-3 col-start-2 row-start-2",
          )}
        >
          <AlertTriangleIcon aria-hidden className="size-2.5 shrink-0" />
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
    <div className="@container flex max-h-[calc(var(--available-height)-1rem)] min-h-0 flex-col gap-2 text-left text-xs">
      <header className="flex shrink-0 items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-foreground">Limits</span>
        {checked ? (
          <span className="text-2xs text-muted-foreground tabular-nums">{checked}</span>
        ) : null}
      </header>
      <div className="min-h-0 space-y-2 overflow-y-auto">
        {sections.map(({ group, rows }) => (
          <section
            key={group?.key ?? "all"}
            aria-label={group?.kind === "email" ? "Account group" : (group?.name ?? "Accounts")}
          >
            {group ? (
              <div className="mb-1 flex min-w-0 items-center gap-1.5 text-2xs font-medium text-muted-foreground">
                <LimitGroupName group={group} />
              </div>
            ) : null}
            <div className="divide-y divide-border/60">
              {rows.map((row) => {
                const color =
                  normalizeProviderAccentColor(row.account.accentColor) ??
                  Object.values(PROVIDER_PRESENTATION).find(
                    (presentation) => presentation.driverKind === row.account.driver,
                  )?.color ??
                  "var(--foreground)";
                return (
                  <div key={row.account.key} className="py-1 first:pt-0 last:pb-0">
                    <div
                      role="group"
                      aria-label={row.name}
                      className="min-w-0 border-l-2 pl-2.5"
                      style={{ borderColor: color }}
                    >
                      {row.resetSinceChecked ? (
                        <div className="grid grid-cols-1 items-center gap-x-2.5 gap-y-0.5 py-0.5 @lg:grid-cols-[8.25rem_minmax(0,1fr)]">
                          <span className="font-medium wrap-anywhere text-foreground">
                            {row.name}
                          </span>
                          <span className="text-2xs text-muted-foreground">
                            Reset since checked
                          </span>
                        </div>
                      ) : (
                        <div className="min-w-0">
                          {row.pools.map((pool, index) => {
                            const scope = pool.label?.startsWith(`${row.name} `)
                              ? pool.label.slice(row.name.length + 1)
                              : pool.label;
                            const showScope =
                              scope !== null &&
                              !(row.pools.length === 1 && row.name.includes(scope));
                            return (
                              <div
                                key={pool.key}
                                className="grid min-w-0 items-center gap-x-2.5 gap-y-0.5 py-0.5 @lg:grid-cols-[8.25rem_minmax(0,1fr)]"
                              >
                                <div
                                  className={cn(
                                    "flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5",
                                    index > 0 && "pl-3",
                                  )}
                                >
                                  {index === 0 ? (
                                    <span className="font-medium wrap-anywhere text-foreground">
                                      {row.name}
                                    </span>
                                  ) : (
                                    <span
                                      aria-hidden
                                      className="size-1 shrink-0 self-center rounded-full"
                                      style={{ backgroundColor: color }}
                                    />
                                  )}
                                  {showScope ? (
                                    <span className="text-2xs wrap-anywhere text-muted-foreground">
                                      {index === 0 ? "· " : ""}
                                      {scope}
                                    </span>
                                  ) : null}
                                </div>
                                <div
                                  className={cn(
                                    "grid min-w-0 grid-cols-[var(--glance-columns)] gap-x-2.5 gap-y-1",
                                    pool.windows.length > 2 &&
                                      "@max-md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] @max-md:[&>:nth-child(n+3)]:col-span-full",
                                  )}
                                  style={
                                    {
                                      "--glance-columns": pool.windows
                                        .map((window) =>
                                          window.kind === "session"
                                            ? "minmax(0,1fr)"
                                            : "minmax(0,2fr)",
                                        )
                                        .join(" "),
                                    } as CSSProperties
                                  }
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
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
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
