import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { ServerProvider } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { getClientSettings } from "../../hooks/useSettings";
import { toastManager } from "../ui/toast";
import { startUsageLimitReminders } from "./UsageLimitReminderCoordinator";
import { loadDailyTokens } from "./usageLimitDailyTokensLoader";
import { updateReminderSettings } from "./usageLimitReminderPreferences";
import { publishUseToday } from "./useTodayStore";

vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn(() => "toast"), close: vi.fn() } }));
vi.mock("../../hooks/useSettings", () => ({ getClientSettings: vi.fn() }));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationsWithProvidersAtom: {} },
}));
vi.mock("../../threadNotifications", () => ({
  hasDesktopNotifications: (mode: string) =>
    mode === "notifications" || mode === "notifications-and-sound",
}));
vi.mock("../settings/providerDriverMeta", () => ({ providerClients: new Map() }));
vi.mock("./useTodayStore", () => ({ publishUseToday: vi.fn() }));
vi.mock("./usageLimitDailyTokensLoader", () => ({
  loadDailyTokens: vi.fn(async () => ({ attempted: false, daily: null })),
}));

// Thursday 5 November 2026, ten in the morning.
const start = Date.parse("2026-11-05T10:00:00.000Z");
const HOUR = 3_600_000;
const iso = (at: number) => new Date(at).toISOString();

function provider(
  driver: string,
  email: string,
  options: { instanceId?: string; workspaceId?: string; withLength?: boolean } = {},
): ServerProvider {
  const { instanceId = driver, workspaceId, withLength = true } = options;
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email, ...(workspaceId ? { workspaceId } : {}) },
    checkedAt: iso(start - 60_000),
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: iso(start - 60_000),
      windows: [
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 40,
          ...(withLength ? { windowDurationMins: 7 * 24 * 60 } : {}),
          resetsAt: iso(start + 20 * HOUR),
        },
      ],
    },
  };
}

const environmentOf = (...providers: ServerProvider[]) =>
  new Map([
    [
      EnvironmentId.make("desk"),
      { entry: { target: { label: "Desk" } }, serverConfig: { providers } },
    ],
  ]);

const presentations = environmentOf(
  provider("claudeAgent", "work@example.com"),
  provider("codex", "me@example.com"),
);

let values: Map<string, string>;
let focused: boolean;
let notifications: Array<{ title: string; body: string | undefined; tag: string | undefined }>;
let pushLimits: (next: typeof presentations) => void;
const stops: Array<() => void> = [];

const registry = {
  subscribe: (_atom: unknown, listener: (value: typeof presentations) => void) => {
    pushLimits = listener;
    listener(presentations);
    return () => {};
  },
};

const GROUPS_KEY = "t3code:usage-limit-groups:v1";
const TOKENS_KEY = "t3code:usage-limit-daily-tokens:v1";

const run = () => {
  const stop = startUsageLimitReminders(registry as never, { navigate: vi.fn() } as never);
  stops.push(stop);
  return stop;
};

const settings = (notificationMode: string, inAppNotificationsEnabled: boolean) =>
  vi
    .mocked(getClientSettings)
    .mockReturnValue({ notificationMode, inAppNotificationsEnabled } as never);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  values = new Map();
  focused = true;
  notifications = [];
  // A real event target, so a settings change reaches the coordinator as it does in a page.
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      localStorage: {
        getItem: (name: string) => values.get(name) ?? null,
        setItem: (name: string, value: string) => {
          values.set(name, value);
        },
      },
      focus: vi.fn(),
    }),
  );
  vi.stubGlobal("document", {
    visibilityState: "visible",
    hasFocus: () => focused,
  });
  class FakeNotification {
    static permission = "granted";
    constructor(title: string, options?: { body?: string; tag?: string }) {
      notifications.push({ title, body: options?.body, tag: options?.tag });
    }
    addEventListener() {}
    close() {}
  }
  vi.stubGlobal("Notification", FakeNotification);
  vi.mocked(toastManager.add).mockClear();
  vi.mocked(publishUseToday).mockClear();
  vi.mocked(loadDailyTokens).mockReset();
  vi.mocked(loadDailyTokens).mockResolvedValue({ attempted: false, daily: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("use-it-or-lose-it reminders", () => {
  it("raises one toast for every window that qualifies, and never repeats it after a reload", () => {
    settings("off", true);
    run();
    expect(toastManager.add).toHaveBeenCalledTimes(1);
    expect(toastManager.add).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Use it or lose it" }),
    );
    expect(publishUseToday).toHaveBeenLastCalledWith(
      [
        expect.objectContaining({ remainingPercent: 60 }),
        expect.objectContaining({ remainingPercent: 60 }),
      ],
      start,
    );
    // A reload starts everything again from what the page remembered.
    for (const stop of stops.splice(0)) stop();
    run();
    vi.advanceTimersByTime(5 * 60_000);
    expect(toastManager.add).toHaveBeenCalledTimes(1);
  });

  it("holds back, and keeps the windows for later, while no channel is open", () => {
    settings("off", false);
    run();
    expect(toastManager.add).not.toHaveBeenCalled();
    expect(notifications).toEqual([]);
    expect(vi.mocked(publishUseToday).mock.lastCall?.[0]).toHaveLength(2);
    // The user turns in-app notifications on; the next look on the minute delivers.
    settings("off", true);
    vi.advanceTimersByTime(60_000);
    expect(toastManager.add).toHaveBeenCalledTimes(1);
  });

  it("uses one system notification, with a line for each window, when the app is not in focus", () => {
    focused = false;
    settings("notifications", true);
    run();
    expect(toastManager.add).not.toHaveBeenCalled();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.title).toBe("Use it or lose it");
    expect(notifications[0]!.body?.split("\n")).toEqual([
      "claudeAgent, Weekly: 60% left, resets in 20h 0m",
      "codex, Weekly: 60% left, resets in 20h 0m",
      "Switch to them today to use them before they reset.",
    ]);
  });

  it("lists the windows but says nothing in the app-only mode, and nothing at all when off", () => {
    settings("notifications-and-sound", true);
    updateReminderSettings({ mode: "inApp" });
    run();
    expect(toastManager.add).not.toHaveBeenCalled();
    expect(vi.mocked(publishUseToday).mock.lastCall?.[0]).toHaveLength(2);
    updateReminderSettings({ mode: "off" });
    expect(vi.mocked(publishUseToday).mock.lastCall?.[0]).toEqual([]);
  });

  it("reminds again for the same window only after it resets", () => {
    settings("off", true);
    run();
    vi.setSystemTime(start + 2 * 24 * HOUR);
    vi.advanceTimersByTime(60_000);
    // Both windows have reset by now and the servers have pushed nothing new.
    expect(toastManager.add).toHaveBeenCalledTimes(1);
  });

  it("joins the digests that fall due together into one notice, and records both", () => {
    settings("off", true);
    values.set(
      GROUPS_KEY,
      JSON.stringify({
        enabled: true,
        assignments: { "claudeAgent:work@example.com": "Work", "codex:me@example.com": "Home" },
      }),
    );
    updateReminderSettings({ mode: "digest" });
    run();
    // Work and Home both come due on this look: one toast, with a line for each.
    expect(toastManager.add).toHaveBeenCalledTimes(1);
    for (const stop of stops.splice(0)) stop();
    run();
    vi.advanceTimersByTime(5 * 60_000);
    expect(toastManager.add).toHaveBeenCalledTimes(1);
  });

  it("names each notice by its windows, so a later one does not replace an earlier", () => {
    focused = false;
    settings("notifications", false);
    pushLimits = () => {};
    const only = (...entries: ServerProvider[]) => environmentOf(...entries);
    const registryOf = {
      subscribe: (_atom: unknown, listener: (value: typeof presentations) => void) => {
        pushLimits = listener;
        listener(only(provider("claudeAgent", "work@example.com")));
        return () => {};
      },
    };
    stops.push(startUsageLimitReminders(registryOf as never, { navigate: vi.fn() } as never));
    expect(notifications).toHaveLength(1);
    pushLimits(
      only(provider("claudeAgent", "work@example.com"), provider("codex", "me@example.com")),
    );
    expect(notifications).toHaveLength(2);
    expect(notifications[1]!.body).toContain("codex");
    expect(notifications[1]!.body).not.toContain("claudeAgent");
    expect(notifications[0]!.tag).toMatch(/^usage-limits-[0-9a-f]{8}$/);
    expect(notifications[1]!.tag).not.toBe(notifications[0]!.tag);
  });

  it("leaves a window it cannot forecast alone and unsent, and speaks once it can", () => {
    settings("off", true);
    const unknown = environmentOf(provider("codex", "me@example.com", { withLength: false }));
    const registryOf = {
      subscribe: (_atom: unknown, listener: (value: typeof presentations) => void) => {
        pushLimits = listener;
        listener(unknown);
        return () => {};
      },
    };
    stops.push(startUsageLimitReminders(registryOf as never, { navigate: vi.fn() } as never));
    expect(toastManager.add).not.toHaveBeenCalled();
    expect(vi.mocked(publishUseToday).mock.lastCall?.[0]).toEqual([]);
    vi.advanceTimersByTime(5 * 60_000);
    expect(toastManager.add).not.toHaveBeenCalled();
    // The server learns the window's length.
    pushLimits(environmentOf(provider("codex", "me@example.com")));
    expect(toastManager.add).toHaveBeenCalledTimes(1);
  });

  it("gives each workspace under one email its own copy of a group made before they were told apart", () => {
    settings("off", false);
    values.set(
      GROUPS_KEY,
      JSON.stringify({ enabled: true, assignments: { "codex:same@example.com": "Work" } }),
    );
    const workspaces = environmentOf(
      provider("codex", "same@example.com", { instanceId: "business", workspaceId: "ws-business" }),
      provider("codex", "same@example.com", { instanceId: "personal", workspaceId: "ws-plus" }),
    );
    const registryOf = {
      subscribe: (_atom: unknown, listener: (value: typeof presentations) => void) => {
        listener(workspaces);
        return () => {};
      },
    };
    stops.push(startUsageLimitReminders(registryOf as never, { navigate: vi.fn() } as never));
    expect(JSON.parse(values.get(GROUPS_KEY)!).assignments).toEqual({
      "codex:same@example.com:ws-business": "Work",
      "codex:same@example.com:ws-plus": "Work",
    });
  });
});

describe("the token history the usual pattern needs", () => {
  const day = {
    day: "2026-11-04",
    costUsd: 0,
    totalTokens: 100,
    byProvider: new Map([["codex" as const, { costUsd: 0, totalTokens: 100 }]]),
  };

  it("is fetched once when none is kept, wherever the user is, and kept", async () => {
    settings("off", false);
    vi.mocked(loadDailyTokens).mockResolvedValue({ attempted: true, daily: [day] });
    run();
    await vi.advanceTimersByTimeAsync(1);
    expect(loadDailyTokens).toHaveBeenCalledTimes(1);
    expect(JSON.parse(values.get(TOKENS_KEY)!)).toMatchObject({
      at: start,
      byProvider: { codex: [["2026-11-04", 100]] },
    });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(loadDailyTokens).toHaveBeenCalledTimes(1);
    // Half a day on, it is fetched again.
    await vi.advanceTimersByTimeAsync(12 * HOUR);
    expect(loadDailyTokens).toHaveBeenCalledTimes(2);
  });

  it("is tried again at the next look when no environment was ready, but waits half an hour after a failure", async () => {
    settings("off", false);
    vi.mocked(loadDailyTokens).mockResolvedValueOnce({ attempted: false, daily: null });
    run();
    await vi.advanceTimersByTimeAsync(1);
    expect(loadDailyTokens).toHaveBeenCalledTimes(1);
    vi.mocked(loadDailyTokens).mockRejectedValueOnce(new Error("offline"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(loadDailyTokens).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(25 * 60_000);
    expect(loadDailyTokens).toHaveBeenCalledTimes(2);
    vi.mocked(loadDailyTokens).mockResolvedValue({ attempted: true, daily: [day] });
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(loadDailyTokens).toHaveBeenCalledTimes(3);
    expect(values.has(TOKENS_KEY)).toBe(true);
  });

  it("is not fetched with no account to judge", async () => {
    settings("off", false);
    const none = {
      subscribe: (_atom: unknown, listener: (value: typeof presentations) => void) => {
        listener(new Map());
        return () => {};
      },
    };
    stops.push(startUsageLimitReminders(none as never, { navigate: vi.fn() } as never));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(loadDailyTokens).not.toHaveBeenCalled();
  });
});
