import {
  EVERY_DAY,
  LIMIT_WEEKDAYS,
  WEEKDAYS,
  WORK_HOURS,
  deviceTimeZone,
  limitSchedulePreset,
  normalizeLimitSchedule,
  type LimitSchedule,
  type LimitWeekday,
} from "@t3tools/shared/usageLimitSchedule";
import { useState } from "react";

import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

type Choice = "inherit" | "everyDay" | "weekdays" | "workHours" | "custom";

const CHOICE_LABELS: Record<Choice, string> = {
  inherit: "Same as group",
  everyDay: "Every day",
  weekdays: "Mon to Fri",
  workHours: "Mon to Fri, 9 to 5",
  custom: "Custom",
};

const DAY_LABELS: Record<LimitWeekday, { readonly short: string; readonly full: string }> = {
  1: { short: "Mon", full: "Monday" },
  2: { short: "Tue", full: "Tuesday" },
  3: { short: "Wed", full: "Wednesday" },
  4: { short: "Thu", full: "Thursday" },
  5: { short: "Fri", full: "Friday" },
  6: { short: "Sat", full: "Saturday" },
  7: { short: "Sun", full: "Sunday" },
};

const clock = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

function minutesOf(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes <= 24 * 60 ? minutes : null;
}

function CustomSchedule({
  label,
  schedule,
  onChange,
}: {
  readonly label: string;
  readonly schedule: LimitSchedule;
  readonly onChange: (schedule: LimitSchedule) => void;
}) {
  const [problem, setProblem] = useState<"hours" | "zone" | null>(null);
  const hours = schedule.hours;
  const apply = (next: LimitSchedule) => {
    const valid = normalizeLimitSchedule(next);
    if (valid) onChange(valid);
  };
  const setHours = (start: number, end: number) => {
    if (end <= start) {
      setProblem("hours");
      return;
    }
    setProblem(null);
    apply({ ...schedule, hours: { start, end } });
  };
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 p-3">
      <ToggleGroup
        aria-label={`Days for ${label}`}
        multiple
        size="compact"
        value={schedule.days.map(String)}
        onValueChange={(next) => {
          const days = LIMIT_WEEKDAYS.filter((day) => next.includes(String(day)));
          if (days.length > 0) apply({ ...schedule, days });
        }}
      >
        {LIMIT_WEEKDAYS.map((day) => (
          <Toggle key={day} value={String(day)} aria-label={DAY_LABELS[day].full}>
            {DAY_LABELS[day].short}
          </Toggle>
        ))}
      </ToggleGroup>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
        <label className="flex items-center gap-2 text-foreground">
          <Switch
            size="sm"
            checked={hours !== undefined}
            onCheckedChange={(checked) => {
              setProblem(null);
              const { hours: _hours, ...rest } = schedule;
              apply(checked ? { ...rest, hours: WORK_HOURS.hours } : rest);
            }}
          />
          Only between
        </label>
        {hours ? (
          <>
            <div className="w-24">
              <DraftInput
                size="compact"
                type="time"
                aria-label={`Start time for ${label}`}
                value={clock(hours.start)}
                onCommit={(next) => {
                  const start = minutesOf(next);
                  if (start !== null) setHours(start, hours.end);
                }}
              />
            </div>
            <span className="text-muted-foreground">and</span>
            <div className="w-24">
              <DraftInput
                size="compact"
                type="time"
                aria-label={`End time for ${label}`}
                value={clock(hours.end === 24 * 60 ? 0 : hours.end)}
                onCommit={(next) => {
                  const end = minutesOf(next);
                  if (end !== null) setHours(hours.start, end === 0 ? 24 * 60 : end);
                }}
              />
            </div>
          </>
        ) : null}
      </div>
      <label className="flex flex-wrap items-center gap-2 text-xs text-foreground">
        Time zone
        <div className="w-52">
          <DraftInput
            size="compact"
            aria-label={`Time zone for ${label}`}
            aria-invalid={problem === "zone" ? true : undefined}
            placeholder={`This device (${deviceTimeZone()})`}
            value={schedule.timeZone ?? ""}
            autoComplete="off"
            spellCheck={false}
            onCommit={(next) => {
              const zone = next.trim();
              if (zone === "") {
                setProblem(null);
                const { timeZone: _zone, ...rest } = schedule;
                apply(rest);
                return;
              }
              if (normalizeLimitSchedule({ ...schedule, timeZone: zone })?.timeZone !== zone) {
                setProblem("zone");
                return;
              }
              setProblem(null);
              apply({ ...schedule, timeZone: zone });
            }}
          />
        </div>
      </label>
      {problem === null ? null : (
        <p role="alert" className="text-xs text-destructive-foreground">
          {problem === "zone"
            ? "That is not a time zone name, such as Europe/Berlin."
            : "The end must be after the start."}
        </p>
      )}
    </div>
  );
}

/**
 * A schedule picked from presets or built by hand. `value` is what is set
 * here; undefined is unset, which reads as "Every day" or, when
 * `inheritLabel` is given, as that. Renders the picker and, below it in a
 * wrapping row, the custom editor, so put it in a row that can wrap.
 */
export function LimitScheduleField({
  label,
  value,
  inherits,
  onChange,
}: {
  /** Names the thing scheduled, for screen readers: `Work`, `Claude`. */
  readonly label: string;
  readonly value: LimitSchedule | undefined;
  /** True for a field that can defer to its group. */
  readonly inherits?: boolean;
  /** Null unsets the schedule. */
  readonly onChange: (schedule: LimitSchedule | null) => void;
}) {
  const [customOpen, setCustomOpen] = useState(false);
  const choice: Choice =
    value === undefined
      ? inherits
        ? "inherit"
        : "everyDay"
      : (limitSchedulePreset(value) as Exclude<Choice, "inherit">);
  const showCustom = choice === "custom" || customOpen;
  const choices: Choice[] = inherits
    ? ["inherit", "everyDay", "weekdays", "workHours", "custom"]
    : ["everyDay", "weekdays", "workHours", "custom"];
  const shown: Choice = showCustom ? "custom" : choice;
  return (
    <>
      <div className="w-44 shrink-0">
        <Select
          value={shown}
          onValueChange={(next) => {
            const picked = choices.find((candidate) => candidate === next);
            if (picked === undefined) return;
            setCustomOpen(picked === "custom");
            if (picked === "inherit") onChange(null);
            else if (picked === "everyDay") onChange(inherits ? EVERY_DAY : null);
            else if (picked === "weekdays") onChange(WEEKDAYS);
            else if (picked === "workHours") onChange(WORK_HOURS);
            else if (value === undefined) onChange(WEEKDAYS);
          }}
        >
          <SelectTrigger size="compact" aria-label={`Schedule for ${label}`}>
            <SelectValue>{CHOICE_LABELS[shown]}</SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {choices.map((candidate) => (
              <SelectItem key={candidate} value={candidate}>
                {CHOICE_LABELS[candidate]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      {showCustom ? (
        <div className="basis-full">
          <CustomSchedule
            label={label}
            schedule={value ?? WEEKDAYS}
            onChange={(next) => onChange(next)}
          />
        </div>
      ) : null}
    </>
  );
}
