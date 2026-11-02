import {
  FORECAST_ALGORITHMS,
  type BurnDownChart,
  type DailyBurn,
  type ForecastAlgorithm,
  type ForecastNote,
  burnDownChart,
  dailyBurn,
  forecastSentence,
  forecastWindow,
  paceDetailFor,
} from "@t3tools/shared/usageLimitForecast";
import { resolveLimitSchedule } from "@t3tools/shared/usageLimitGroups";
import {
  type PastLimitWindow,
  averageUtilization,
  currentLimitInstance,
  limitSeriesKey,
  pastLimitWindows,
} from "@t3tools/shared/usageLimitHistory";
import { paceLabel, windowPace, windowSpan } from "@t3tools/shared/usageLimitPace";
import { resolveTimeZone } from "@t3tools/shared/usageLimitSchedule";
import type { LimitPoolMember, LimitPoolWindow } from "@t3tools/shared/usageLimits";
import { ChevronRightIcon } from "lucide-react";
import { use, useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { resolveHour12 } from "../../timestampFormat";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { LimitPaceContext, PACE_REFERENCE_TEXT } from "./UsageLimitPace";
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

/** Shown when the usual pattern is not known, so the reference line is even spending. */
const EVEN_REFERENCE_NOTE =
  "No usual pattern yet: it needs 14 days of token use with this provider. The line is even spending.";

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
        points={points(chart.reference)}
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

function DailyBurnView({
  days,
  color,
  timeZone,
  windowDays,
}: {
  readonly days: readonly DailyBurn[];
  readonly color: string;
  readonly timeZone: string;
  readonly windowDays: number;
}) {
  const todayAt = days.findIndex((entry) => entry.today);
  const center = todayAt < 0 ? days.length - 1 : todayAt;
  const first = Math.max(0, Math.min(center - 9, days.length - 14));
  const shown = days.length <= 14 ? days : days.slice(first, first + 14);
  const scale = Math.max(
    1,
    ...shown.flatMap((entry) => [entry.budgetPercent, entry.consumedPercent ?? 0]),
  );
  const name = new Intl.DateTimeFormat(undefined, {
    timeZone,
    ...(windowDays <= 8 ? { weekday: "short" } : { day: "numeric" }),
  });
  const full = new Intl.DateTimeFormat(undefined, {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const points = (value: number) => (Math.round(value * 10) / 10).toString();
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">
        Each day: points of the window used (bar) against what the line allows (mark)
      </span>
      <div
        role="img"
        aria-label={`Points used each day against what the line allows: ${shown
          .map(
            (entry) =>
              `${full.format(entry.from)} ${entry.consumedPercent === null ? "no readings" : points(entry.consumedPercent)} of ${points(entry.budgetPercent)}`,
          )
          .join(", ")}`}
        className="flex items-end gap-1"
      >
        {shown.map((entry) => {
          const over =
            entry.consumedPercent !== null && entry.consumedPercent > entry.budgetPercent + 0.5;
          return (
            <Tooltip key={entry.day}>
              <TooltipTrigger
                render={
                  <div className="flex min-w-4 max-w-10 flex-1 flex-col items-center gap-0.5" />
                }
              >
                <div className="relative h-10 w-full rounded-sm bg-muted">
                  {entry.consumedPercent === null ? null : (
                    <div
                      className={cn("absolute inset-x-0 bottom-0 rounded-sm", over && "bg-warning")}
                      style={{
                        height: `${(entry.consumedPercent / scale) * 100}%`,
                        ...(over ? {} : { backgroundColor: color }),
                      }}
                    />
                  )}
                  <div
                    className="absolute inset-x-0 border-t-2 border-foreground/70"
                    style={{ bottom: `${(entry.budgetPercent / scale) * 100}%` }}
                  />
                </div>
                <span
                  className={cn(
                    "text-3xs text-muted-foreground tabular-nums",
                    entry.today && "font-semibold text-foreground",
                  )}
                >
                  {name.format(entry.from)}
                </span>
              </TooltipTrigger>
              <TooltipPopup side="top">
                <div className="flex flex-col gap-0.5">
                  <span className="text-foreground">{full.format(entry.from)}</span>
                  <span className="text-muted-foreground">
                    {entry.consumedPercent === null
                      ? `No readings. The line allows ${points(entry.budgetPercent)} points.`
                      : `Used ${points(entry.consumedPercent)} of ${points(entry.budgetPercent)} points`}
                  </span>
                  {entry.partial ? (
                    <span className="text-muted-foreground">From the first reading of the day</span>
                  ) : null}
                </div>
              </TooltipPopup>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

function BurnDownPanel({
  members,
  kind,
  color,
}: {
  readonly members: readonly LimitPoolMember[];
  readonly kind: LimitPoolWindow["kind"];
  readonly color: string;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [settings, updateSettings] = useReminderSettings();
  const { groups, history, dailyTokens } = use(LimitPaceContext);
  // The page keeps the time it was opened or refreshed at; a chart left open must not.
  const minute = useNowMinute();
  const clock = Date.parse(`${minute}:00Z`);
  const hour12 = usePrimarySettings((current) => resolveHour12(current.timestampFormat));
  const { account, window } = members.find((m) => m.account.key === selectedKey) ?? members[0]!;
  const schedule = resolveLimitSchedule(groups, account);
  const detail = paceDetailFor({ account, window, schedule, now: clock, history, dailyTokens });
  const series = limitSeriesKey(account, window);
  const outcome = forecastWindow({
    window,
    now: clock,
    schedule,
    algorithm: settings.algorithm,
    instances: history[series],
    dailyTokens: dailyTokens(account),
  });
  const checkedAt = Date.parse(account.limits.checkedAt);
  const reading = {
    window,
    checkedAt: Number.isFinite(checkedAt) ? checkedAt : clock,
    instance: currentLimitInstance(history, series, clock),
    ...detail,
  };
  const chart = burnDownChart({ ...reading, schedule, forecast: outcome.forecast });
  const span = windowSpan(window);
  const days =
    span !== null && span.end - span.start > 36 * 3_600_000
      ? dailyBurn({ ...reading, schedule, now: clock })
      : null;
  const pace = windowPace(window, clock, schedule, detail);
  const past = span
    ? pastLimitWindows(history, series, clock, kind === "monthly" ? 6 : 8, span.end - span.start)
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
    at - clock < 6 * 24 * 3_600_000 ? timeFormat.format(at) : dateTimeFormat.format(at);
  const sentence = outcome.forecast ? forecastSentence(outcome.forecast, formatTime) : null;
  const note = outcome.note === null ? null : NOTE_TEXT[outcome.note];
  const referenceName = chart?.referenceKind === "pattern" ? "Usual pattern" : "Even spending";
  return (
    <div className="flex flex-col gap-3 pt-3">
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
      {pace ? (
        <p className="text-xs text-muted-foreground">
          {paceLabel(pace)}. {PACE_REFERENCE_TEXT[pace.reference]}
        </p>
      ) : null}
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
                now={clock}
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
              {referenceName}
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
          {chart.referenceKind === "even" && detail.weights == null ? (
            <p className="ps-10 text-3xs text-muted-foreground">{EVEN_REFERENCE_NOTE}</p>
          ) : null}
        </div>
      ) : null}
      {days && span ? (
        <DailyBurnView
          days={days}
          color={color}
          timeZone={resolveTimeZone(schedule)}
          windowDays={(span.end - span.start) / (24 * 3_600_000)}
        />
      ) : null}
      <PastWindows windows={past} color={color} formatDay={(at) => dayFormat.format(at)} />
    </div>
  );
}

/**
 * The window's burn-down behind a disclosure: what was left against the usual
 * pattern, where it is heading, each day's use, and how much past windows used.
 * Charts are per account, as each has its own reset and schedule.
 */
export function BurnDownDisclosure({
  pool,
  color,
}: {
  readonly pool: LimitPoolWindow;
  readonly color: string;
}) {
  const members = pool.members.filter((member) => windowSpan(member.window) !== null);
  if (pool.kind === "other" || members.length === 0) return null;
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
        <BurnDownPanel members={members} kind={pool.kind} color={color} />
      </CollapsiblePanel>
    </Collapsible>
  );
}
