import {
  NO_LIMIT_GROUPS,
  resolveLimitSchedule,
  type LimitGroupState,
} from "@t3tools/shared/usageLimitGroups";
import {
  paceExpected,
  paceLabel,
  paceOutlook,
  paceSummary,
  pooledPace,
  type WindowPace,
} from "@t3tools/shared/usageLimitPace";
import type { LimitAccount, LimitPoolWindow } from "@t3tools/shared/usageLimits";
import { GaugeIcon, TrendingDownIcon, TrendingUpIcon } from "lucide-react";
import { createContext, use } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** The groups, with their schedules, for the bars and cards that judge pace against them. */
export const LimitGroupsContext = createContext<LimitGroupState>(NO_LIMIT_GROUPS);

/** When this account is meant to be used; undefined counts every hour. */
export function useLimitSchedule(account: LimitAccount) {
  return resolveLimitSchedule(use(LimitGroupsContext), account);
}

/** The pace of a pooled bar, each account judged against its own schedule. */
export function usePoolPace(pool: LimitPoolWindow, now: number): WindowPace | null {
  const groups = use(LimitGroupsContext);
  return pooledPace(
    pool.members.map(({ account, window }) => ({
      window,
      schedule: resolveLimitSchedule(groups, account),
    })),
    now,
  );
}

const PACE_ICONS = {
  ahead: TrendingUpIcon,
  on: GaugeIcon,
  under: TrendingDownIcon,
} as const;

export function PaceBadge({ pace }: { readonly pace: WindowPace }) {
  const Icon = PACE_ICONS[pace.state];
  const outlook = paceOutlook(pace);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={paceSummary(pace)}
            className="inline-flex text-muted-foreground"
          />
        }
      >
        <Icon className="size-3.5" aria-hidden />
      </TooltipTrigger>
      <TooltipPopup side="top">
        <div className="flex flex-col gap-0.5">
          <span className="text-foreground">{paceLabel(pace)}</span>
          <span className="text-muted-foreground">{paceExpected(pace)}</span>
          {outlook ? <span className="text-muted-foreground">{outlook}</span> : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

/** How the window is pacing in words, with a warning when it is on course to run out. */
export function PaceText({ pace }: { readonly pace: WindowPace }) {
  const outlook = pace.outlook;
  return (
    <>
      <span className="text-xs text-muted-foreground">{paceLabel(pace)}</span>
      {outlook?.kind === "runsOut" ? (
        <span className="text-xs font-medium text-warning-foreground">{paceOutlook(pace)}</span>
      ) : null}
    </>
  );
}
