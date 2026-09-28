// @effect-diagnostics globalDate:off -- Wake times compare against the local clock and use Intl labels.
import type {
  OrchestrationThreadActivity,
  OrchestrationThreadShell,
  ServerProvider,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";

import type { SnoozePreset } from "./threadSettled.ts";

export interface LimitResetWake {
  readonly window: ServerProviderUsageWindow;
  /** ISO wake time: the chosen window's reset. */
  readonly snoozedUntil: string;
  /** The chosen window is used up, so the provider refuses turns until it resets. */
  readonly exhausted: boolean;
}

// Fallback lengths for windows that do not report their duration.
const KIND_MINUTES: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 5 * 60,
  weekly: 7 * 24 * 60,
  monthly: 30 * 24 * 60,
  other: Number.POSITIVE_INFINITY,
};

function windowMinutes(window: ServerProviderUsageWindow): number {
  return window.windowDurationMins ?? KIND_MINUTES[window.kind];
}

/**
 * When a subscription's limits next reset, for "snooze until the limit
 * resets". A used-up window blocks the account until it resets, so the
 * latest such reset wins (waking at the five-hour reset is pointless while
 * the weekly one is spent). Otherwise the shortest window is the one the user
 * runs into first. Null for accounts without subscription limits (API key,
 * Bedrock) and when no window reports a future reset.
 */
export function resolveLimitResetWake(
  usageLimits: ServerProviderUsageLimits | undefined,
  now: Date,
): LimitResetWake | null {
  if (!usageLimits || usageLimits.unavailable?.reason === "unsupported") return null;
  const nowMs = now.getTime();
  const candidates = usageLimits.windows.flatMap((window) => {
    const resetsAtMs = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
    return resetsAtMs > nowMs ? [{ window, resetsAtMs }] : [];
  });
  const exhausted = candidates.filter(({ window }) => window.usedPercent >= 100);
  let pick: (typeof candidates)[number] | null = null;
  for (const candidate of exhausted.length > 0 ? exhausted : candidates) {
    if (pick === null) {
      pick = candidate;
    } else if (exhausted.length > 0) {
      if (candidate.resetsAtMs > pick.resetsAtMs) pick = candidate;
    } else {
      const lengthDelta = windowMinutes(candidate.window) - windowMinutes(pick.window);
      if (lengthDelta < 0 || (lengthDelta === 0 && candidate.resetsAtMs < pick.resetsAtMs)) {
        pick = candidate;
      }
    }
  }
  if (pick === null) return null;
  return {
    window: pick.window,
    snoozedUntil: new Date(pick.resetsAtMs).toISOString(),
    exhausted: exhausted.length > 0,
  };
}

/** "5-hour", "Weekly", "Monthly": how menus and banners name a window. */
export function limitWindowName(window: ServerProviderUsageWindow): string {
  if (window.kind === "weekly") return "Weekly";
  if (window.kind === "monthly") return "Monthly";
  const minutes = window.windowDurationMins;
  if (minutes !== undefined && minutes > 0 && minutes < 24 * 60 && minutes % 60 === 0) {
    return `${minutes / 60}-hour`;
  }
  return window.kind === "session" ? "Session" : "Usage";
}

function wakeLabel(wake: Date, now: Date): string {
  const time = wake.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (wake.toDateString() === now.toDateString()) return time;
  return `${wake.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

/**
 * The "until the limit resets" snooze choice for a thread's provider, meant
 * to lead the preset list. Null when the account has no subscription limits.
 */
export function resolveLimitResetSnoozePreset(
  usageLimits: ServerProviderUsageLimits | undefined,
  now: Date,
): SnoozePreset | null {
  const wake = resolveLimitResetWake(usageLimits, now);
  if (wake === null) return null;
  return {
    id: "limit-reset",
    label: `${limitWindowName(wake.window)} limit reset`,
    whenLabel: wakeLabel(new Date(wake.snoozedUntil), now),
    snoozedUntil: wake.snoozedUntil,
  };
}

/**
 * The provider a thread runs on: the live session's instance, else the one
 * its model selection names.
 */
export function findThreadProvider(
  shell: Pick<OrchestrationThreadShell, "session" | "modelSelection">,
  providers: ReadonlyArray<ServerProvider> | undefined,
): ServerProvider | undefined {
  const instanceId = shell.session?.providerInstanceId ?? shell.modelSelection.instanceId;
  return providers?.find((provider) => provider.instanceId === instanceId);
}

// Every driver words its limit stop this way: "Claude usage limit reached.",
// "Codex usage limit reached.", "Grok usage limit reached.".
const USAGE_LIMIT_MESSAGE = /usage limit reached/i;

function activityMessage(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || !("message" in payload)) return "";
  return typeof payload.message === "string" ? payload.message : "";
}

/**
 * When the thread's current work stopped on a usage limit, or null. A failed
 * turn carries the limit in `session.lastError`; Claude instead parks the
 * running turn and leaves a warning row on it.
 */
function limitHitAt(
  shell: Pick<OrchestrationThreadShell, "session" | "latestTurn">,
  activities: ReadonlyArray<
    Pick<OrchestrationThreadActivity, "kind" | "payload" | "turnId" | "createdAt">
  >,
): string | null {
  const session = shell.session;
  if (session === null) return null;
  if (session.status === "error" || shell.latestTurn?.state === "error") {
    return session.lastError !== null && USAGE_LIMIT_MESSAGE.test(session.lastError)
      ? session.updatedAt
      : null;
  }
  if (session.status !== "running" || session.activeTurnId === null) return null;
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]!;
    if (activity.turnId === null) continue;
    // The active turn's rows are the newest; an older turn means none matched.
    if (activity.turnId !== session.activeTurnId) return null;
    if (
      activity.kind === "runtime.warning" &&
      USAGE_LIMIT_MESSAGE.test(activityMessage(activity.payload))
    ) {
      return activity.createdAt;
    }
  }
  return null;
}

/**
 * The wake time to offer when a thread stopped on its provider's usage limit,
 * or null when it did not, or when the account reports no subscription limits.
 * A hit from before the chosen window started is stale: that limit already
 * reset, and a later failure would carry a newer timestamp.
 */
export function resolveLimitHitSnooze(input: {
  readonly shell: Pick<OrchestrationThreadShell, "session" | "latestTurn">;
  readonly activities: ReadonlyArray<
    Pick<OrchestrationThreadActivity, "kind" | "payload" | "turnId" | "createdAt">
  >;
  readonly usageLimits: ServerProviderUsageLimits | undefined;
  readonly now: Date;
}): LimitResetWake | null {
  const hitAt = limitHitAt(input.shell, input.activities);
  if (hitAt === null) return null;
  const wake = resolveLimitResetWake(input.usageLimits, input.now);
  if (wake === null) return null;
  const minutes = wake.window.windowDurationMins;
  if (
    !wake.exhausted &&
    minutes !== undefined &&
    Date.parse(hitAt) < Date.parse(wake.snoozedUntil) - minutes * 60_000
  ) {
    return null;
  }
  return wake;
}
