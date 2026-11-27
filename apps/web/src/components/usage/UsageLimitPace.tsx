import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import type { DailyTokens } from "@t3tools/shared/usageLimitForecast";
import { paceDetailFor } from "@t3tools/shared/usageLimitForecast";
import {
  NO_LIMIT_GROUPS,
  resolveLimitSchedule,
  type LimitGroupState,
} from "@t3tools/shared/usageLimitGroups";
import { type LimitHistory, NO_LIMIT_HISTORY } from "@t3tools/shared/usageLimitHistory";
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

/** What pace is judged by, for the bars and cards that show it. */
export interface LimitPaceInputs {
  /** The groups, with their schedules. */
  readonly groups: LimitGroupState;
  /** The recorded readings, which know where a reset credit cleared a window. */
  readonly history: LimitHistory;
  /** Daily token totals for an account's provider, which give the usual pattern. */
  readonly dailyTokens: (account: LimitAccount) => readonly DailyTokens[] | undefined;
}

export const LimitPaceContext = createContext<LimitPaceInputs>({
  groups: NO_LIMIT_GROUPS,
  history: NO_LIMIT_HISTORY,
  dailyTokens: () => undefined,
});

/** When this account is meant to be used, and what else its pace is judged by. */
export function useWindowPaceInputs(
  account: LimitAccount,
  window: ServerProviderUsageWindow,
  now: number,
) {
  const { groups, history, dailyTokens } = use(LimitPaceContext);
  const schedule = resolveLimitSchedule(groups, account);
  return {
    schedule,
    detail: paceDetailFor({ account, window, schedule, now, history, dailyTokens }),
  };
}

/** The pace of a pooled bar, each account judged against its own schedule and reference line. */
export function usePoolPace(pool: LimitPoolWindow, now: number): WindowPace | null {
  const { groups, history, dailyTokens } = use(LimitPaceContext);
  return pooledPace(
    pool.members.map(({ account, window }) => {
      const schedule = resolveLimitSchedule(groups, account);
      return {
        window,
        schedule,
        ...paceDetailFor({ account, window, schedule, now, history, dailyTokens }),
      };
    }),
    now,
  );
}

/** The line pace is judged against, as it is named in a row and in a sentence. */
export const PACE_REFERENCE_NAME = { pattern: "Usual pattern", even: "Even spending" } as const;
export const PACE_REFERENCE_TEXT = {
  pattern: "Against your usual pattern",
  even: "Against even spending",
} as const;

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
            aria-label={`${paceSummary(pace)} | ${PACE_REFERENCE_TEXT[pace.reference]}`}
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
          <span className="text-muted-foreground">{PACE_REFERENCE_TEXT[pace.reference]}</span>
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
