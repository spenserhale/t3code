import {
  FORECAST_ALGORITHMS,
  burnDownChart,
  forecastSentence,
  forecastWindow,
  type BurnDownChart,
  type ForecastAlgorithm,
  type ForecastNote,
} from "@t3tools/shared/usageLimitForecast";
import {
  averageUtilization,
  currentLimitInstance,
  limitSeriesKey,
  pastLimitWindows,
  type PastLimitWindow,
} from "@t3tools/shared/usageLimitHistory";
import { resolveLimitSchedule } from "@t3tools/shared/usageLimitGroups";
import { windowSpan } from "@t3tools/shared/usageLimitPace";
import type { LimitPoolMember, LimitPoolWindow } from "@t3tools/shared/usageLimits";
import { ChevronRightIcon } from "lucide-react";
import { use, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { resolveHour12 } from "../../timestampFormat";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { DailyTokensSync } from "./DailyTokensSync";
import { useDailyTokens } from "./usageLimitDailyTokens";
import { useUsageLimitHistory } from "./usageLimitHistoryStore";
import { LimitGroupsContext } from "./UsageLimitPace";
import { FORECAST_ALGORITHM_LABELS, useReminderSettings } from "./usageLimitReminderPreferences";
import { AccountName } from "./UsageLimitsPooled";

const ALGORITHM_HELP: Record<ForecastAlgorithm, string> = {
  runRate: "Spending so far, carried on at the same rate over the time that counts.",
  weekday:
    "Counts busy weekdays for more, from your last 90 days of tokens with this provider across all its accounts.",
  trend: "Your recent spending rate, the last few days counting most.",
};

const NOTE_TEXT: Record<ForecastNote, string> = {
  weekdayNeedsTokens: "The weekday pattern needs 14 days of token history. Showing the run rate.",
  weekdayTooEarly: "Too early in the window for the weekday pattern. Showing the run rate.",
  trendNeedsReadings:
    "The recent trend needs a day or two of recorded readings. Showing the run rate.",
  tooEarly: "Too early in the window to forecast.",
  noReset: "This window reports no reset time, so there is nothing to forecast.",
  outsideSchedule: "None of this window falls in its schedule, so there is nothing to forecast.",
  ended: "This window has reset. Refresh to read the new one.",
};

const VIEW_WIDTH = 320;
const VIEW_HEIGHT = 112;
const PLOT_PAD = 4;

function BurnDownPlot({
  chart,
  now,
  color,
  label,
}: {
  readonly chart: BurnDownChart;
  readonly now: number;
  readonly color: string;
  readonly label: string;
}) {
  const x = (at: number) => ((at - chart.start) / (chart.end - chart.start)) * VIEW_WIDTH;
  const y = (remaining: number) =>
    PLOT_PAD + ((100 - remaining) / 100) * (VIEW_HEIGHT - 2 * PLOT_PAD);
  const points = (line: BurnDownChart["readings"]) =>
    line.map((point) => `${x(point.at)},${y(point.remainingPercent)}`).join(" ");
  const readings = points(chart.readings);
  const last = chart.readings.at(-1);
  // A single reading draws as a dot: a zero-length round-capped line.
  const dot =
    chart.readings.length === 1 && last ? `${x(last.at)},${y(last.remainingPercent)}` : null;
  return (
    <svg
      className="h-28 w-full"
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      {[0, 50, 100].map((tick) => (
        <line
          key={tick}
          x1={0}
          x2={VIEW_WIDTH}
          y1={y(tick)}
          y2={y(tick)}
          stroke="currentColor"
          strokeWidth={1}
          className="text-border"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      <polyline
        points={points(chart.ideal)}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.25}
        strokeDasharray="4 3"
        className="text-muted-foreground"
        vectorEffect="non-scaling-stroke"
      />
      {chart.readings.length > 1 ? (
        <polygon
          points={`${x(chart.readings[0]!.at)},${y(0)} ${readings} ${x(last!.at)},${y(0)}`}
          fill={color}
          fillOpacity={0.12}
        />
      ) : null}
      <polyline
        points={dot ? `${dot} ${dot}` : readings}
        fill="none"
        stroke={color}
        strokeWidth={dot ? 6 : 2}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      {chart.forecast.length > 1 ? (
        <polyline
          points={points(chart.forecast)}
          fill="none"
          stroke={color}
          strokeOpacity={0.7}
          strokeWidth={1.75}
          strokeDasharray="1 4"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      {[
        { marker: "now", at: x(now), className: "text-foreground/50" },
        { marker: "reset", at: VIEW_WIDTH, className: "text-border" },
      ].map(({ marker, at, className }) => (
        <line
          key={marker}
          x1={at}
          x2={at}
          y1={0}
          y2={VIEW_HEIGHT}
          stroke="currentColor"
          strokeWidth={1}
          className={className}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

function PastWindows({
  windows,
  color,
  formatDay,
}: {
  readonly windows: readonly PastLimitWindow[];
  readonly color: string;
  readonly formatDay: (at: number) => string;
}) {
  const average = averageUtilization(windows);
  if (average === null) {
    return (
      <p className="text-xs text-muted-foreground">
        No finished windows recorded yet. They are noted while T3 Code is open.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">
        Used {Math.round(average)}% on average over the last {windows.length}{" "}
        {windows.length === 1 ? "window" : "windows"}
      </span>
      <div
        role="img"
        aria-label={`Share used when each recent window ended: ${windows.map((window) => `${Math.round(window.usedPercent)}%`).join(", ")}`}
        className="flex items-end gap-1"
      >
        {windows.map((window) => (
          <Tooltip key={window.resetsAt}>
            <TooltipTrigger render={<div className="flex h-8 w-4 items-end rounded-sm bg-muted" />}>
              <div
                className={cn("w-full rounded-sm", !window.complete && "opacity-40")}
                style={{ height: `${Math.max(2, window.usedPercent)}%`, backgroundColor: color }}
              />
            </TooltipTrigger>
            <TooltipPopup side="top">
              <div className="flex flex-col gap-0.5">
                <span className="text-foreground">
                  {Math.round(window.usedPercent)}% used, reset {formatDay(window.resetsAt)}
                </span>
                {window.complete ? null : (
                  <span className="text-muted-foreground">
                    Last read before T3 Code saw the end of the window
                  </span>
                )}
              </div>
            </TooltipPopup>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}

function BurnDownPanel({
  members,
  kind,
  color,
  now,
}: {
  readonly members: readonly LimitPoolMember[];
  readonly kind: LimitPoolWindow["kind"];
  readonly color: string;
  readonly now: number;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [settings, updateSettings] = useReminderSettings();
  const history = useUsageLimitHistory();
  const groups = use(LimitGroupsContext);
  const tokens = useDailyTokens(now);
  const hour12 = usePrimarySettings((current) => resolveHour12(current.timestampFormat));
  const { account, window } = members.find((m) => m.account.key === selectedKey) ?? members[0]!;
  const schedule = resolveLimitSchedule(groups, account);
  const series = limitSeriesKey(account, window);
  const outcome = forecastWindow({
    window,
    now,
    schedule,
    algorithm: settings.algorithm,
    instances: history[series],
    dailyTokens: tokens(account),
  });
  const checkedAt = Date.parse(account.limits.checkedAt);
  const chart = burnDownChart({
    window,
    now,
    checkedAt: Number.isFinite(checkedAt) ? checkedAt : now,
    schedule,
    instance: currentLimitInstance(history, series, now),
    forecast: outcome.forecast,
  });
  const span = windowSpan(window);
  const past = span
    ? pastLimitWindows(history, series, now, kind === "monthly" ? 6 : 8, span.end - span.start)
    : [];
  const timeFormat = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12,
  });
  const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12,
  });
  const formatTime = (at: number) =>
    at - now < 6 * 24 * 3_600_000 ? timeFormat.format(at) : dateTimeFormat.format(at);
  const sentence = outcome.forecast ? forecastSentence(outcome.forecast, formatTime) : null;
  const note = outcome.note === null ? null : NOTE_TEXT[outcome.note];
  return (
    <div className="flex flex-col gap-3 pt-3">
      {settings.algorithm === "weekday" ? <DailyTokensSync /> : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {members.length > 1 ? (
          <ToggleGroup
            aria-label="Account"
            size="compact"
            value={[account.key]}
            onValueChange={(next) => {
              const key = next[0];
              if (key) setSelectedKey(key);
            }}
          >
            {members.map((member, index) => (
              <Toggle
                key={member.account.key}
                value={member.account.key}
                aria-label={`Account ${index + 1}`}
              >
                <AccountName account={member.account} className="max-w-24 truncate text-xs" />
              </Toggle>
            ))}
          </ToggleGroup>
        ) : (
          <span />
        )}
        <Select
          value={settings.algorithm}
          onValueChange={(next) => {
            const algorithm = FORECAST_ALGORITHMS.find((candidate) => candidate === next);
            if (algorithm) updateSettings({ algorithm });
          }}
        >
          <SelectTrigger size="compact" variant="ghost" aria-label="Forecast" className="w-auto">
            <SelectValue>{FORECAST_ALGORITHM_LABELS[settings.algorithm]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false} matchTriggerWidth={false}>
            {FORECAST_ALGORITHMS.map((algorithm) => (
              <SelectItem key={algorithm} value={algorithm}>
                <span className="flex flex-col">
                  <span>{FORECAST_ALGORITHM_LABELS[algorithm]}</span>
                  <span className="max-w-64 text-xs text-muted-foreground">
                    {ALGORITHM_HELP[algorithm]}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      {sentence ? <p className="text-sm font-medium text-foreground">{sentence}</p> : null}
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      {chart ? (
        <div className="flex flex-col gap-1">
          <div className="flex gap-2">
            <div className="relative h-28 w-8 shrink-0 text-end text-3xs text-muted-foreground tabular-nums">
              <span className="absolute top-0 right-0">100%</span>
              <span className="absolute top-1/2 right-0 -translate-y-1/2">50%</span>
              <span className="absolute right-0 bottom-0">0%</span>
            </div>
            <div className="min-w-0 flex-1">
              <BurnDownPlot
                chart={chart}
                now={now}
                color={color}
                label={`Burn-down: ${window.label} has ${Math.max(0, Math.round(100 - window.usedPercent))}% left${sentence ? `. ${sentence}` : ""}`}
              />
            </div>
          </div>
          <div className="flex justify-between ps-10 text-3xs text-muted-foreground">
            <span>{dateTimeFormat.format(chart.start)}</span>
            <span>Resets {dateTimeFormat.format(chart.end)}</span>
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 ps-10 text-3xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <span
                aria-hidden
                className="h-0.5 w-3 rounded-full"
                style={{ backgroundColor: color }}
              />
              Left
            </span>
            <span className="flex items-center gap-1">
              <span aria-hidden className="w-3 border-t border-dashed border-muted-foreground" />
              Even spending
            </span>
            <span className="flex items-center gap-1">
              <span
                aria-hidden
                className="w-3 border-t-2 border-dotted"
                style={{ borderColor: color }}
              />
              Forecast
            </span>
          </div>
        </div>
      ) : null}
      <PastWindows windows={past} color={color} formatDay={(at) => dayFormat.format(at)} />
    </div>
  );
}

/**
 * The window's burn-down behind a disclosure: what was left, even spending to
 * compare it with, where it is heading, and how much past windows used. Charts
 * are per account, as each has its own reset and schedule.
 */
export function BurnDownDisclosure({
  pool,
  color,
  now,
}: {
  readonly pool: LimitPoolWindow;
  readonly color: string;
  readonly now: number;
}) {
  const [settings] = useReminderSettings();
  const wanted =
    pool.kind === "weekly" ||
    pool.kind === "monthly" ||
    (pool.kind === "session" && settings.includeSession);
  const members = pool.members.filter((member) => windowSpan(member.window) !== null);
  if (!wanted || members.length === 0) return null;
  return (
    <Collapsible className="md:col-span-2">
      <CollapsibleTrigger className="group flex items-center gap-1 rounded-sm text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 shrink-0 transition-transform duration-150 group-data-panel-open:rotate-90 motion-reduce:transition-none"
        />
        Burn-down
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <BurnDownPanel members={members} kind={pool.kind} color={color} now={now} />
      </CollapsiblePanel>
    </Collapsible>
  );
}
