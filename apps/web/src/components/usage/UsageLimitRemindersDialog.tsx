import { REMINDER_TITLE, type ReminderMode } from "@t3tools/shared/usageLimitReminders";
import { FORECAST_ALGORITHMS } from "@t3tools/shared/usageLimitForecast";
import { useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { FORECAST_ALGORITHM_LABELS, useReminderSettings } from "./usageLimitReminderPreferences";

const MODE_LABELS: Record<ReminderMode, string> = {
  perWindow: "As windows come up",
  digest: "Once a day for each group",
  inApp: "In the app only",
  off: "Off",
};

const MODE_HELP: Record<ReminderMode, string> = {
  perWindow:
    "One notice lists every window that qualifies together, and mentions each window once per reset.",
  digest: "One notice a day for each group, the first time something in it qualifies.",
  inApp: "No notices. Only the Use today list on Limits and the dot on the sidebar's Usage button.",
  off: "No reminders, no Use today list and no dot.",
};

const MODES = Object.keys(MODE_LABELS) as ReminderMode[];

function RemindersDialog({ onOpenChange }: { readonly onOpenChange: (open: boolean) => void }) {
  const [settings, update] = useReminderSettings();
  const alertsAvailable = useClientSettings(
    (client) => client.notificationMode !== "off" || client.inAppNotificationsEnabled,
  );
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Reminders</DialogTitle>
          <DialogDescription>
            Allowance you do not spend is gone when a window resets. Get a nudge when a subscription
            is about to reset with plenty left and you are on course to leave it. Reminders appear
            only while T3 Code is open, and follow your notification settings.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>Remind me</span>
              <Select
                value={settings.mode}
                onValueChange={(next) => {
                  const mode = MODES.find((candidate) => candidate === next);
                  if (mode) update({ mode });
                }}
              >
                <SelectTrigger size="compact" aria-label="Remind me" className="w-56">
                  <SelectValue>{MODE_LABELS[settings.mode]}</SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {MODES.map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {MODE_LABELS[mode]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </label>
            <p className="text-xs text-muted-foreground">{MODE_HELP[settings.mode]}</p>
            {settings.mode !== "off" && settings.mode !== "inApp" && !alertsAvailable ? (
              <p role="status" className="text-xs text-warning-foreground">
                Thread notifications and in-app notifications are both off in Settings, so &ldquo;
                {REMINDER_TITLE}&rdquo; shows only in the Use today list and the sidebar dot.
              </p>
            ) : null}
          </div>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="flex flex-col">
              <span>At least this much left</span>
              <span className="text-xs text-muted-foreground">
                And at least this much on course to go unused, when a forecast can be made.
              </span>
            </span>
            <span className="flex w-20 shrink-0 items-center gap-1">
              <DraftInput
                size="compact"
                inputMode="numeric"
                aria-label="Percent left that triggers a reminder"
                value={String(settings.thresholdPercent)}
                maxLength={2}
                autoComplete="off"
                onCommit={(next) => {
                  const percent = Number(next.trim());
                  if (Number.isFinite(percent)) update({ thresholdPercent: percent });
                }}
              />
              <span className="text-sm text-muted-foreground">%</span>
            </span>
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="flex flex-col">
              <span>Include session windows</span>
              <span className="text-xs text-muted-foreground">
                The 5-hour windows, reminded an hour before they reset. Off by default, as they come
                around every day.
              </span>
            </span>
            <Switch
              checked={settings.includeSession}
              onCheckedChange={(includeSession) => update({ includeSession })}
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="flex flex-col">
              <span>Forecast</span>
              <span className="text-xs text-muted-foreground">
                Also chosen in the burn-down on each window.
              </span>
            </span>
            <Select
              value={settings.algorithm}
              onValueChange={(next) => {
                const algorithm = FORECAST_ALGORITHMS.find((candidate) => candidate === next);
                if (algorithm) update({ algorithm });
              }}
            >
              <SelectTrigger size="compact" aria-label="Forecast" className="w-56">
                <SelectValue>{FORECAST_ALGORITHM_LABELS[settings.algorithm]}</SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {FORECAST_ALGORITHMS.map((algorithm) => (
                  <SelectItem key={algorithm} value={algorithm}>
                    {FORECAST_ALGORITHM_LABELS[algorithm]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </label>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

export function UsageLimitRemindersButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="compact" variant="ghost" onClick={() => setOpen(true)}>
        Reminders
      </Button>
      {open ? <RemindersDialog onOpenChange={setOpen} /> : null}
    </>
  );
}
