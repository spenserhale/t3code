import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { ServerProvider } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { getClientSettings } from "../../hooks/useSettings";
import { toastManager } from "../ui/toast";
import { startUsageLimitReminders } from "./UsageLimitReminderCoordinator";
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

// Thursday 5 November 2026, ten in the morning.
const start = Date.parse("2026-11-05T10:00:00.000Z");
const HOUR = 3_600_000;
const iso = (at: number) => new Date(at).toISOString();

function provider(driver: string, email: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email },
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
          windowDurationMins: 7 * 24 * 60,
          resetsAt: iso(start + 20 * HOUR),
        },
      ],
    },
  };
}

const presentations = new Map([
  [
    EnvironmentId.make("desk"),
    {
      entry: { target: { label: "Desk" } },
      serverConfig: {
        providers: [
          provider("claudeAgent", "work@example.com"),
          provider("codex", "me@example.com"),
        ],
      },
    },
  ],
]);

let values: Map<string, string>;
let focused: boolean;
let notifications: Array<{ title: string; body: string | undefined }>;
const stops: Array<() => void> = [];

const registry = {
  subscribe: (_atom: unknown, listener: (value: typeof presentations) => void) => {
    listener(presentations);
    return () => {};
  },
};

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
    constructor(title: string, options?: { body?: string }) {
      notifications.push({ title, body: options?.body });
    }
    addEventListener() {}
    close() {}
  }
  vi.stubGlobal("Notification", FakeNotification);
  vi.mocked(toastManager.add).mockClear();
  vi.mocked(publishUseToday).mockClear();
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
});
