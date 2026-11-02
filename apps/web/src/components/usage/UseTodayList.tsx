import { formatDuration, remainingPercent } from "@t3tools/shared/usageLimits";
import type { UseItItem } from "@t3tools/shared/usageLimitReminders";
import { TimerResetIcon } from "lucide-react";
import { useId } from "react";

import { providerClients } from "../settings/providerDriverMeta";
import { useUseToday } from "./useTodayStore";
import { AccountAvatar } from "./UsageLimitsPooled";

function accountName(item: UseItItem): string {
  const { account } = item;
  return (
    account.displayName ?? providerClients.get(account.driver)?.label ?? String(account.driver)
  );
}

/** Round to the nearest five so a forecast reads as the estimate it is. */
function unusedHint(item: UseItItem): string | null {
  return item.forecastUnusedPercent === null
    ? null
    : `On course to leave about ${Math.round(item.forecastUnusedPercent / 5) * 5}% unused`;
}

function UseTodayRows({
  items,
  now,
  detailed,
}: {
  readonly items: readonly UseItItem[];
  readonly now: number;
  readonly detailed: boolean;
}) {
  return (
    <ul className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-2 gap-y-1 text-xs">
      {items.map((item) => {
        const hint = detailed ? unusedHint(item) : null;
        return (
          <li key={item.tag} className="col-span-full grid grid-cols-subgrid items-center">
            <span className="flex size-5 items-center justify-center">
              <AccountAvatar account={item.account} />
            </span>
            <span className="min-w-0 truncate">
              <span className="font-medium text-foreground">{accountName(item)}</span>
              {item.group.kind === "named" ? (
                <span className="text-muted-foreground"> ({item.group.name})</span>
              ) : null}
              <span className="text-muted-foreground"> {item.window.label}</span>
            </span>
            <span className="text-end font-medium whitespace-nowrap text-foreground tabular-nums">
              {remainingPercent(item.window)}% left
            </span>
            <span className="text-end text-2xs whitespace-nowrap text-muted-foreground tabular-nums">
              ↻ {formatDuration(item.resetsAt - now)}
            </span>
            {hint ? (
              <span className="col-span-3 col-start-2 text-muted-foreground">{hint}</span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The subscriptions whose allowance resets soon with a good share unused, at
 * the top of Limits. It follows the tracker, so it is as current as the last
 * time the servers reported or the last minute, whichever is later.
 */
export function UseTodayCard() {
  const { items, now } = useUseToday();
  const headingId = useId();
  if (items.length === 0) return null;
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-2 rounded-lg border border-border/60 p-4"
    >
      <h2 id={headingId} className="flex items-center gap-2 text-sm font-medium text-foreground">
        <TimerResetIcon aria-hidden className="size-4 text-muted-foreground" />
        Use today
      </h2>
      <p className="text-xs text-muted-foreground">
        These reset soon with allowance to spare. Switch to them today to use it before it goes.
      </p>
      <UseTodayRows items={items} now={now} detailed />
    </section>
  );
}

/** The same list, sized for the hover card in the sidebar. */
export function UseTodayGlance() {
  const { items, now } = useUseToday();
  if (items.length === 0) return null;
  return (
    <section
      aria-label="Use today"
      className="flex shrink-0 flex-col gap-1 border-b border-border/60 pb-2"
    >
      <span className="text-2xs font-medium text-muted-foreground">Use today</span>
      <UseTodayRows items={items} now={now} detailed={false} />
    </section>
  );
}
