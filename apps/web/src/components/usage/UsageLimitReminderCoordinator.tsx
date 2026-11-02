// @effect-diagnostics globalDate:off globalTimers:off -- A background service on the wall clock, outside any Effect runtime.
import type { AnyRouter } from "@tanstack/react-router";
import { collectLimitAccounts, type LimitAccount } from "@t3tools/shared/usageLimits";
import {
  REMINDER_TITLE,
  markReminded,
  planReminders,
  pruneReminderState,
  reminderBody,
  reminderChannel,
  windowsToUseToday,
  type ReminderBatch,
} from "@t3tools/shared/usageLimitReminders";
import type { AtomRegistry } from "effect/reactivity";
import { TimerResetIcon } from "lucide-react";

import { getClientSettings } from "../../hooks/useSettings";
import { subscribeLocalStorageKey } from "../../hooks/useLocalStorage";
import { environmentPresentations } from "../../state/presentation";
import { hasDesktopNotifications } from "../../threadNotifications";
import { providerClients } from "../settings/providerDriverMeta";
import { toastManager } from "../ui/toast";
import { readDailyTokens } from "./usageLimitDailyTokens";
import { USAGE_LIMIT_GROUPS_STORAGE_KEY, readUsageLimitGroups } from "./usageLimitGroupPreferences";
import { readUsageLimitHistory, recordUsageLimitHistory } from "./usageLimitHistoryStore";
import {
  USAGE_LIMIT_REMINDER_SETTINGS_KEY,
  readReminderSettings,
  readReminderState,
  writeReminderState,
} from "./usageLimitReminderPreferences";
import { publishUseToday } from "./useTodayStore";
import { readUsagePagePreferences, saveUsagePagePreferences } from "./usagePagePreferences";

const EVALUATE_EVERY_MS = 60_000;

const nameOf = (account: LimitAccount) =>
  account.displayName ?? providerClients.get(account.driver)?.label ?? String(account.driver);

function openLimits(router: AnyRouter) {
  saveUsagePagePreferences({ ...readUsagePagePreferences(), metric: "limits" });
  void router.navigate({ to: "/usage" });
}

/**
 * Records what the accounts report, keeps the "Use today" list current and raises
 * the reminder, whenever the servers push limits and once a minute (a window can
 * come within its lead with no push). It reaches the user as thread notifications do.
 */
export function startUsageLimitReminders(
  registry: AtomRegistry.AtomRegistry,
  router: AnyRouter,
): () => void {
  let accounts: readonly LimitAccount[] = [];

  // Returns false when no channel is open right now, so the window is offered again later.
  const present = (batch: ReminderBatch, now: number): boolean => {
    const { notificationMode, inAppNotificationsEnabled } = getClientSettings();
    const channel = reminderChannel({
      focused: document.visibilityState === "visible" && document.hasFocus(),
      inAppEnabled: inAppNotificationsEnabled,
      systemEnabled: hasDesktopNotifications(notificationMode),
      systemPermitted: typeof Notification !== "undefined" && Notification.permission === "granted",
    });
    if (channel === null) return false;
    const body = reminderBody(batch.items, now, nameOf);
    if (channel === "toast") {
      const toastId = toastManager.add({
        type: "info",
        title: REMINDER_TITLE,
        description: (
          <>
            {body.split("\n").map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
          </>
        ),
        data: {
          hideCopyButton: true,
          leadingIcon: <TimerResetIcon aria-hidden className="size-4 text-info-foreground" />,
        },
        actionProps: {
          children: "Open limits",
          onClick: () => {
            toastManager.close(toastId);
            openLimits(router);
          },
        },
      });
      return true;
    }
    try {
      // One tag, so a newer reminder replaces an older one instead of stacking beside it.
      const notification = new Notification(REMINDER_TITLE, {
        body,
        tag: "t3code-usage-limits",
        silent: true,
      });
      notification.addEventListener("click", () => {
        notification.close();
        window.focus();
        void window.desktopBridge?.revealWindow().catch(() => undefined);
        openLimits(router);
      });
      return true;
    } catch {
      // Some browsers expose Notification but refuse to show one.
      return false;
    }
  };

  const evaluate = (record: boolean) => {
    const now = Date.now();
    const history = record ? recordUsageLimitHistory(accounts, now) : readUsageLimitHistory();
    const settings = readReminderSettings();
    if (settings.mode === "off") {
      publishUseToday([], now);
      return;
    }
    const items = windowsToUseToday({
      accounts,
      groups: readUsageLimitGroups(),
      settings,
      history,
      dailyTokens: readDailyTokens(now),
      now,
    });
    publishUseToday(items, now);
    const stored = readReminderState();
    let state = pruneReminderState(stored, now);
    for (const batch of planReminders(items, state, settings.mode, now)) {
      if (present(batch, now)) state = markReminded(state, batch);
    }
    if (state !== stored) writeReminderState(state);
  };

  const stopPresentations = registry.subscribe(
    environmentPresentations.presentationsWithProvidersAtom,
    (presentations) => {
      accounts = collectLimitAccounts(presentations);
      evaluate(true);
    },
    { immediate: true },
  );
  const reevaluate = () => evaluate(false);
  const stopGroups = subscribeLocalStorageKey(USAGE_LIMIT_GROUPS_STORAGE_KEY, reevaluate);
  const stopSettings = subscribeLocalStorageKey(USAGE_LIMIT_REMINDER_SETTINGS_KEY, reevaluate);
  const timer = setInterval(reevaluate, EVALUATE_EVERY_MS);

  return () => {
    stopPresentations();
    stopGroups();
    stopSettings();
    clearInterval(timer);
  };
}
