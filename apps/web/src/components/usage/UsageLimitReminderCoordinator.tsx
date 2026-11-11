// @effect-diagnostics globalDate:off globalTimers:off -- A background service on the wall clock, outside any Effect runtime.
import type { AnyRouter } from "@tanstack/react-router";
import { migrateLegacyAccountKeys } from "@t3tools/shared/usageLimitGroups";
import { collectLimitAccounts, type LimitAccount } from "@t3tools/shared/usageLimits";
import {
  REMINDER_TITLE,
  markReminded,
  planReminders,
  pruneReminderState,
  reminderBody,
  reminderChannel,
  reminderItems,
  reminderNotificationTag,
  windowsToUseToday,
  type UseItItem,
} from "@t3tools/shared/usageLimitReminders";
import type { AtomRegistry } from "effect/reactivity";
import { TimerResetIcon } from "lucide-react";

import { getClientSettings } from "../../hooks/useSettings";
import { subscribeLocalStorageKey } from "../../hooks/useLocalStorage";
import { environmentPresentations } from "../../state/presentation";
import { hasDesktopNotifications } from "../../threadNotifications";
import { providerClients } from "../settings/providerDriverMeta";
import { toastManager } from "../ui/toast";
import {
  DAILY_TOKENS_STORAGE_KEY,
  type TokenMiss,
  cacheEnvironmentDailyTokens,
  dailyTokensHeld,
  environmentsDueForTokens,
  onDailyTokensHeld,
  readDailyTokens,
  readDailyTokensFetchedAt,
} from "./usageLimitDailyTokens";
import { loadEnvironmentDailyTokens, readyUsageEnvironments } from "./usageLimitDailyTokensLoader";
import {
  USAGE_LIMIT_GROUPS_STORAGE_KEY,
  readUsageLimitGroups,
  updateUsageLimitGroups,
} from "./usageLimitGroupPreferences";
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

  // Returns false when no channel is open right now, so the windows are offered again later.
  const present = (items: readonly UseItItem[], now: number): boolean => {
    const { notificationMode, inAppNotificationsEnabled } = getClientSettings();
    const channel = reminderChannel({
      focused: document.visibilityState === "visible" && document.hasFocus(),
      inAppEnabled: inAppNotificationsEnabled,
      systemEnabled: hasDesktopNotifications(notificationMode),
      systemPermitted: typeof Notification !== "undefined" && Notification.permission === "granted",
    });
    if (channel === null) return false;
    const body = reminderBody(items, now, nameOf);
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
      // Named by its windows: another set stands beside this notice, the same one replaces it.
      const notification = new Notification(REMINDER_TITLE, {
        body,
        tag: reminderNotificationTag(items),
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

  const misses = new Map<string, TokenMiss>();
  const asking = new Set<string>();
  // The usual pattern and the weekday forecast need 90 days of token totals, wherever the user is in the app.
  // Each environment is asked on its own, so one that fails is asked again without the others.
  const refreshDailyTokens = (now: number) => {
    if (accounts.length === 0) return;
    const ready = readyUsageEnvironments(registry);
    const due = new Set(
      environmentsDueForTokens({
        ready: ready.map((environment) => environment.environmentId),
        fetchedAt: readDailyTokensFetchedAt(),
        misses,
        now,
      }),
    );
    for (const environment of ready) {
      const id = environment.environmentId;
      if (!due.has(id) || asking.has(id)) continue;
      asking.add(id);
      const miss = () =>
        misses.set(id, { at: Date.now(), count: (misses.get(id)?.count ?? 0) + 1 });
      void (async () => {
        try {
          const daily = await loadEnvironmentDailyTokens(registry, environment);
          if (daily === null) {
            miss();
            return;
          }
          misses.delete(id);
          cacheEnvironmentDailyTokens(id, daily, Date.now());
        } catch (error) {
          miss();
          console.error("Could not load daily token totals.", error);
        } finally {
          asking.delete(id);
        }
      })();
    }
  };

  let recorded: readonly LimitAccount[] | null = null;
  const evaluate = () => {
    const now = Date.now();
    // Readings go in first, so a window is always named by its recorded instance, even when
    // a look begins inside this one (the migration's write below tells the groups' subscribers).
    const history =
      recorded === accounts ? readUsageLimitHistory() : recordUsageLimitHistory(accounts, now);
    recorded = accounts;
    // Accounts told workspaces apart only lately; what was stored for the login is theirs now.
    const savedGroups = readUsageLimitGroups();
    if (migrateLegacyAccountKeys(savedGroups, accounts) !== savedGroups) {
      updateUsageLimitGroups((current) => migrateLegacyAccountKeys(current, accounts));
    }
    const settings = readReminderSettings();
    if (settings.mode !== "off" || dailyTokensHeld()) refreshDailyTokens(now);
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
    // Whatever falls due on this look is one notice, and each batch is recorded as said.
    const batches = planReminders(items, state, settings.mode, now);
    if (batches.length > 0 && present(reminderItems(batches), now)) {
      for (const batch of batches) state = markReminded(state, batch);
    }
    if (state !== stored) writeReminderState(state);
  };

  const stopPresentations = registry.subscribe(
    environmentPresentations.presentationsWithProvidersAtom,
    (presentations) => {
      accounts = collectLimitAccounts(presentations);
      evaluate();
    },
    { immediate: true },
  );
  const stopGroups = subscribeLocalStorageKey(USAGE_LIMIT_GROUPS_STORAGE_KEY, evaluate);
  const stopSettings = subscribeLocalStorageKey(USAGE_LIMIT_REMINDER_SETTINGS_KEY, evaluate);
  const stopTokens = subscribeLocalStorageKey(DAILY_TOKENS_STORAGE_KEY, evaluate);
  const stopHolds = onDailyTokensHeld(evaluate);
  const timer = setInterval(evaluate, EVALUATE_EVERY_MS);

  return () => {
    stopPresentations();
    stopGroups();
    stopSettings();
    stopTokens();
    stopHolds();
    clearInterval(timer);
  };
}
