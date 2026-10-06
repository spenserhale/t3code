import type { LimitAccount } from "@t3tools/shared/usageLimits";
import { collectLimitGlance, formatCheckedAgo } from "@t3tools/shared/usageLimitsGlance";
import { ArrowRightIcon } from "lucide-react";
import { Fragment, useState } from "react";

import { getDriverOption } from "../settings/providerDriverMeta";
import { InlineButton } from "../ui/button";
import { useUsageLimitGroups } from "./usageLimitGroupPreferences";
import { AccountAvatar, LimitGroupName } from "./UsageLimitsPooled";

/**
 * What is left on each subscription, sized for a popover: one row per account
 * with its tightest window, under the same groups as Limits. Render it only
 * while it is on show. It reads the clock once, when it mounts, and reports
 * what the servers last pushed; it never ticks and never asks for a re-check.
 */
export function UsageLimitsGlance({
  accounts,
  onOpenLimits,
}: {
  readonly accounts: readonly LimitAccount[];
  readonly onOpenLimits: () => void;
}) {
  const [now] = useState(() => Date.now());
  const [groups] = useUsageLimitGroups();
  const { sections, checkedAt } = collectLimitGlance(
    accounts,
    groups,
    now,
    (account) =>
      account.displayName ?? getDriverOption(account.driver)?.label ?? String(account.driver),
  );
  const checked = checkedAt ? formatCheckedAgo(checkedAt, now) : null;
  return (
    <div className="flex max-h-[calc(var(--available-height)-1rem)] min-h-0 flex-col gap-2 text-left text-xs">
      <div className="flex shrink-0 items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-foreground">Limits</span>
        {checked ? (
          <span className="text-2xs text-muted-foreground tabular-nums">{checked}</span>
        ) : null}
      </div>
      <div className="grid min-h-0 grid-cols-[auto_minmax(0,1fr)_auto_auto_auto] items-center gap-x-2 gap-y-1 overflow-y-auto">
        {sections.map(({ group, rows }) => (
          <Fragment key={group?.key ?? "all"}>
            {group ? (
              <div className="col-span-full flex min-w-0 items-center gap-1.5 pt-1 text-2xs font-medium text-muted-foreground">
                <LimitGroupName group={group} />
              </div>
            ) : null}
            {rows.map((row) => (
              <Fragment key={row.account.key}>
                <span className="flex size-5 items-center justify-center">
                  <AccountAvatar account={row.account} />
                </span>
                <span className="truncate font-medium text-foreground">{row.name}</span>
                {row.resetSinceChecked ? (
                  <span className="col-span-3 text-end text-2xs whitespace-nowrap text-muted-foreground">
                    reset since checked
                  </span>
                ) : (
                  <>
                    <span className="text-muted-foreground">{row.windowLabel}</span>
                    <span className="text-end font-medium whitespace-nowrap text-foreground tabular-nums">
                      {row.remainingPercent}% left
                    </span>
                    <span className="text-end text-2xs whitespace-nowrap text-muted-foreground tabular-nums">
                      {row.resetsIn?.replace("resets in ", "↻ ") ?? ""}
                    </span>
                  </>
                )}
              </Fragment>
            ))}
          </Fragment>
        ))}
      </div>
      <div className="shrink-0 border-t border-border/60 pt-2">
        <InlineButton tone="muted" onClick={onOpenLimits}>
          Open limits
          <ArrowRightIcon aria-hidden className="size-3" />
        </InlineButton>
      </div>
    </div>
  );
}
