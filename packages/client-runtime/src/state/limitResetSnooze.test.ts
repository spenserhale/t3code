// @effect-diagnostics globalDate:off -- Tests pin wake times against a fixed clock.
import type {
  OrchestrationThreadActivity,
  OrchestrationThreadShell,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  limitWindowName,
  resolveLimitHitSnooze,
  resolveLimitResetSnoozePreset,
  resolveLimitResetWake,
} from "./limitResetSnooze.ts";

const now = new Date("2026-09-28T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1_000;
const at = (hours: number) => new Date(now.getTime() + hours * HOUR_MS).toISOString();

function window(
  overrides: Partial<ServerProviderUsageWindow> & Pick<ServerProviderUsageWindow, "id" | "kind">,
): ServerProviderUsageWindow {
  return { label: overrides.id, usedPercent: 40, ...overrides };
}

const session = window({
  id: "five_hour",
  kind: "session",
  windowDurationMins: 300,
  resetsAt: at(2),
});
const weekly = window({
  id: "seven_day",
  kind: "weekly",
  windowDurationMins: 7 * 24 * 60,
  resetsAt: at(50),
});

function limits(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  extra: Partial<ServerProviderUsageLimits> = {},
): ServerProviderUsageLimits {
  return { checkedAt: now.toISOString(), windows, ...extra };
}

type Shell = Pick<OrchestrationThreadShell, "session" | "latestTurn">;

function shell(overrides: Partial<NonNullable<Shell["session"]>>): Shell {
  return {
    session: {
      threadId: "thread-1" as never,
      status: "ready",
      providerName: "claudeAgent",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: at(-0.5),
      ...overrides,
    },
    latestTurn: null,
  };
}

function warning(turnId: string, message: string, createdAt = at(-0.25)) {
  return {
    kind: "runtime.warning",
    payload: { message },
    turnId: turnId as never,
    createdAt,
  } satisfies Pick<OrchestrationThreadActivity, "kind" | "payload" | "turnId" | "createdAt">;
}

describe("resolveLimitResetWake", () => {
  it("picks the shortest window while none is used up", () => {
    expect(resolveLimitResetWake(limits([weekly, session]), now)).toEqual({
      window: session,
      snoozedUntil: at(2),
      exhausted: false,
    });
  });

  it("waits for the latest used-up window, since that one blocks the account", () => {
    const spentWeekly = { ...weekly, usedPercent: 100 };
    expect(resolveLimitResetWake(limits([session, spentWeekly]), now)).toEqual({
      window: spentWeekly,
      snoozedUntil: at(50),
      exhausted: true,
    });
  });

  it("offers nothing for accounts without subscription limits", () => {
    expect(resolveLimitResetWake(undefined, now)).toBeNull();
    expect(
      resolveLimitResetWake(limits([], { unavailable: { reason: "unsupported" } }), now),
    ).toBeNull();
  });

  it("ignores windows without a future reset", () => {
    const past = { ...session, resetsAt: at(-1) };
    const unknown = window({ id: "monthly", kind: "monthly" });
    expect(resolveLimitResetWake(limits([past, unknown]), now)).toBeNull();
  });

  it("falls back to the window kind when a duration is missing", () => {
    const monthly = window({ id: "monthly", kind: "monthly", resetsAt: at(300) });
    const weeklyNoDuration = window({ id: "weekly", kind: "weekly", resetsAt: at(400) });
    expect(resolveLimitResetWake(limits([monthly, weeklyNoDuration]), now)?.window).toBe(
      weeklyNoDuration,
    );
  });
});

describe("resolveLimitResetSnoozePreset", () => {
  it("names the window it waits for", () => {
    expect(resolveLimitResetSnoozePreset(limits([session, weekly]), now)).toMatchObject({
      id: "limit-reset",
      label: "5-hour limit reset",
      snoozedUntil: at(2),
    });
  });

  it("names windows by kind and duration", () => {
    expect(limitWindowName(weekly)).toBe("Weekly");
    expect(limitWindowName(window({ id: "m", kind: "monthly" }))).toBe("Monthly");
    expect(limitWindowName(window({ id: "s", kind: "session" }))).toBe("Session");
    expect(limitWindowName(window({ id: "o", kind: "other" }))).toBe("Usage");
  });
});

describe("resolveLimitHitSnooze", () => {
  const exhaustedSession = { ...session, usedPercent: 100 };

  it("offers the reset after a turn failed on the usage limit", () => {
    expect(
      resolveLimitHitSnooze({
        shell: shell({
          status: "error",
          lastError: "Codex usage limit reached. The session limit resets in 2h.",
        }),
        activities: [],
        usageLimits: limits([exhaustedSession, weekly]),
        now,
      })?.snoozedUntil,
    ).toBe(at(2));
  });

  it("offers the reset while Claude parks the running turn", () => {
    expect(
      resolveLimitHitSnooze({
        shell: shell({ status: "running", activeTurnId: "turn-2" as never }),
        activities: [
          warning("turn-1", "unrelated"),
          warning(
            "turn-2",
            "Claude usage limit reached. This turn is paused until the 5-hour limit resets in 2h.",
          ),
        ],
        usageLimits: limits([exhaustedSession, weekly]),
        now,
      })?.snoozedUntil,
    ).toBe(at(2));
  });

  it("ignores a limit warning from an earlier turn", () => {
    expect(
      resolveLimitHitSnooze({
        shell: shell({ status: "running", activeTurnId: "turn-2" as never }),
        activities: [warning("turn-1", "Claude usage limit reached.")],
        usageLimits: limits([exhaustedSession]),
        now,
      }),
    ).toBeNull();
  });

  it("ignores failures that are not usage limits", () => {
    expect(
      resolveLimitHitSnooze({
        shell: shell({ status: "error", lastError: "Provider crashed" }),
        activities: [],
        usageLimits: limits([exhaustedSession]),
        now,
      }),
    ).toBeNull();
  });

  it("drops a hit from a window that has since reset", () => {
    // Failed 4 hours ago; the current 5-hour window started 3 hours ago.
    expect(
      resolveLimitHitSnooze({
        shell: shell({
          status: "error",
          lastError: "Claude usage limit reached. Send the message again once the limit resets.",
          updatedAt: at(-4),
        }),
        activities: [],
        usageLimits: limits([session, weekly]),
        now,
      }),
    ).toBeNull();
  });

  it("offers nothing without subscription limits", () => {
    expect(
      resolveLimitHitSnooze({
        shell: shell({ status: "error", lastError: "Grok usage limit reached. Try again later." }),
        activities: [],
        usageLimits: undefined,
        now,
      }),
    ).toBeNull();
  });
});
