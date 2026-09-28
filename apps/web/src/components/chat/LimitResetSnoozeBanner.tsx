import {
  findThreadProvider,
  limitWindowName,
  resolveLimitHitSnooze,
} from "@t3tools/client-runtime/state/limit-reset-snooze";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { canSnooze } from "@t3tools/client-runtime/state/thread-settled";
import type {
  OrchestrationThreadActivity,
  ScopedThreadRef,
  ServerProvider,
} from "@t3tools/contracts";
import { AlarmClockIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import { snoozeWakeDescription } from "../Sidebar.snooze";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/**
 * Offers to snooze the open thread until its provider's usage limit resets,
 * once a turn has stopped on that limit. Snoozing hands off to the parked
 * banner, which carries the way back ("Wake now").
 */
export function useLimitResetSnoozeBannerItem(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly thread: EnvironmentThreadShell | null;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly supportsSnooze: boolean;
  readonly snoozed: boolean;
  /** Re-evaluates as time passes, so the offer lapses once the limit resets. */
  readonly nowMinute: string;
}): ComposerBannerStackItem | null {
  const { threadRef, thread, activities, providers, supportsSnooze, snoozed, nowMinute } = input;
  const enabled = useClientSettings((settings) => settings.limitResetSnoozeEnabled);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const { snoozeThread } = useThreadActions();
  // Keyed like the banner, so a snooze still in flight on one thread never
  // disables the button on the next.
  const [snoozingKey, setSnoozingKey] = useState<string | null>(null);
  // Session-scoped, one key per (thread, wake time): a later limit offers again.
  const [dismissedKeys, setDismissedKeys] = useState<ReadonlySet<string>>(new Set());

  const wake = useMemo(() => {
    if (!enabled || !supportsSnooze || snoozed || thread === null) return null;
    const now = new Date(`${nowMinute}:00.000Z`);
    if (!canSnooze(thread, { now: now.toISOString() })) return null;
    return resolveLimitHitSnooze({
      shell: thread,
      activities,
      usageLimits: findThreadProvider(thread, providers)?.usageLimits,
      now,
    });
  }, [activities, enabled, nowMinute, providers, snoozed, supportsSnooze, thread]);

  return useMemo(() => {
    if (wake === null || threadRef === null) return null;
    const key = `${threadRef.threadId}:${wake.snoozedUntil}`;
    if (dismissedKeys.has(key)) return null;
    const when = snoozeWakeDescription(wake.snoozedUntil, new Date(), timestampFormat);
    const snoozing = snoozingKey === key;
    const snooze = async () => {
      setSnoozingKey(key);
      const result = await snoozeThread(threadRef, wake.snoozedUntil);
      setSnoozingKey((current) => (current === key ? null : current));
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to snooze thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    };
    return {
      id: `limit-reset-snooze:${key}`,
      variant: "warning",
      icon: <AlarmClockIcon />,
      title: "Usage limit reached",
      description: `Snooze this thread until the ${limitWindowName(wake.window).toLowerCase()} limit resets (${when}).`,
      actions: (
        <Button size="xs" variant="ghost" disabled={snoozing} onClick={() => void snooze()}>
          {snoozing ? "Snoozing..." : "Snooze"}
        </Button>
      ),
      dismissLabel: "Not now",
      onDismiss: () => setDismissedKeys((keys) => new Set(keys).add(key)),
    };
  }, [dismissedKeys, snoozeThread, snoozingKey, threadRef, timestampFormat, wake]);
}
