import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  createInboxWakeTracker,
  sortInboxThreadsByOrder,
  type InboxOrderOptions,
  type InboxOrderThreadInput,
} from "./threadOrder.ts";

const environmentId = EnvironmentId.make("environment-1");
const now = "2026-06-01T12:00:00.000Z";

function thread(id: string, overrides: Partial<InboxOrderThreadInput> = {}): InboxOrderThreadInput {
  return {
    id: ThreadId.make(id),
    environmentId,
    createdAt: "2026-06-01T00:00:00.000Z",
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    latestRun: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  };
}

function run(requestedAt: string, completedAt: string | null) {
  return { requestedAt, startedAt: requestedAt, completedAt };
}

function asking(kind: "approval" | "input", createdAt: string): Partial<InboxOrderThreadInput> {
  return {
    hasPendingApprovals: kind === "approval",
    hasPendingUserInput: kind === "input",
    source: {
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("request-1"),
        kind: kind === "approval" ? "command" : "user_input",
        createdAt: DateTime.makeUnsafe(createdAt),
      },
    },
  };
}

const ids = (threads: readonly InboxOrderThreadInput[]) => threads.map((entry) => entry.id);

function order(
  threads: readonly InboxOrderThreadInput[],
  by: Parameters<typeof sortInboxThreadsByOrder>[1],
  options: Partial<InboxOrderOptions<InboxOrderThreadInput>> = {},
) {
  return ids(sortInboxThreadsByOrder(threads, by, { now, ...options }));
}

describe("sortInboxThreadsByOrder", () => {
  // A thread the user wrote to an hour ago must outrank one whose agent
  // finished more recently but that the user has not touched for two hours.
  const chattedRecently = thread("chatted-recently", {
    latestUserAuthoredMessageAt: "2026-06-01T11:00:00.000Z",
    latestRun: run("2026-06-01T11:00:00.000Z", "2026-06-01T11:05:00.000Z"),
  });
  const finishedRecently = thread("finished-recently", {
    latestUserAuthoredMessageAt: "2026-06-01T10:00:00.000Z",
    latestRun: run("2026-06-01T10:00:00.000Z", "2026-06-01T11:30:00.000Z"),
  });

  it("orders by the last message the user wrote", () => {
    expect(order([finishedRecently, chattedRecently], "last_user_message")).toEqual([
      "chatted-recently",
      "finished-recently",
    ]);
  });

  it("ignores agent-sent messages when the server reports authored ones", () => {
    const agentPinged = thread("agent-pinged", {
      latestUserMessageAt: "2026-06-01T11:50:00.000Z",
      latestUserAuthoredMessageAt: "2026-06-01T09:00:00.000Z",
    });
    expect(order([agentPinged, chattedRecently], "last_user_message")).toEqual([
      "chatted-recently",
      "agent-pinged",
    ]);
  });

  it("falls back to creation time for a thread with no user message", () => {
    const fresh = thread("fresh", { createdAt: "2026-06-01T11:59:00.000Z" });
    expect(order([chattedRecently, fresh], "last_user_message")).toEqual([
      "fresh",
      "chatted-recently",
    ]);
  });

  it("orders by the last run, wake, or unsettle for last status change", () => {
    const woke = thread("woke", { unsettledAt: "2026-06-01T11:45:00.000Z" });
    const snoozeWoke = thread("snooze-woke", { snoozedUntil: "2026-06-01T11:40:00.000Z" });
    expect(
      order([chattedRecently, snoozeWoke, finishedRecently, woke], "last_status_change"),
    ).toEqual(["woke", "snooze-woke", "finished-recently", "chatted-recently"]);
  });

  it("does not count a snooze wake time that is still in the future", () => {
    const stillSnoozing = thread("still-snoozing", { snoozedUntil: "2026-06-01T13:00:00.000Z" });
    expect(order([stillSnoozing, chattedRecently], "last_status_change")).toEqual([
      "chatted-recently",
      "still-snoozing",
    ]);
  });

  it("counts an early wake by its request, and the deadline passing later does not promote it", () => {
    // It asked at 11:20 while snoozed until 15:00. The thread's updatedAt moves
    // with every event, so it must not stand in for the wake time.
    const earlyWake = thread("early-wake", {
      ...asking("approval", "2026-06-01T11:20:00.000Z"),
      snoozedUntil: "2026-06-01T15:00:00.000Z",
      snoozedAt: "2026-06-01T08:00:00.000Z",
      runtime: { status: "waiting", updatedAt: "2026-06-01T11:59:00.000Z" },
    });
    expect(order([chattedRecently, earlyWake, finishedRecently], "last_status_change")).toEqual([
      "finished-recently",
      "early-wake",
      "chatted-recently",
    ]);

    const finishedLater = thread("finished-later", {
      latestRun: run("2026-06-01T13:00:00.000Z", "2026-06-01T14:00:00.000Z"),
    });
    expect(
      order([earlyWake, finishedLater], "last_status_change", { now: "2026-06-01T16:00:00.000Z" }),
    ).toEqual(["finished-later", "early-wake"]);
  });

  // The run began at 09:00 and the thread asked at 11:45; a completion at 11:30
  // must not outrank the question.
  it.each([{ kind: "approval" as const }, { kind: "input" as const }])(
    "counts when a thread asked for $kind, not just its run times",
    ({ kind }) => {
      const asked = thread("asked", {
        ...asking(kind, "2026-06-01T11:45:00.000Z"),
        latestRun: run("2026-06-01T09:00:00.000Z", null),
      });
      expect(order([chattedRecently, finishedRecently, asked], "last_status_change")).toEqual([
        "asked",
        "finished-recently",
        "chatted-recently",
      ]);
    },
  );

  it("uses what this client saw only for requests the shell cannot date", () => {
    const delegated = thread("delegated", {
      pendingSubagentRequest: "approval",
      latestRun: run("2026-06-01T09:00:00.000Z", null),
    });
    const returnedAt = (entry: InboxOrderThreadInput) =>
      entry.id === "delegated"
        ? Date.parse("2026-06-01T11:55:00.000Z")
        : entry.id === "finished-recently"
          ? Date.parse("2026-06-01T11:58:00.000Z")
          : undefined;
    expect(
      order([chattedRecently, finishedRecently, delegated], "last_status_change", { returnedAt }),
    ).toEqual(["delegated", "finished-recently", "chatted-recently"]);
  });

  it("groups by status rank, newest activity first within a group", () => {
    const needsInput = thread("needs-input");
    const rank = (entry: InboxOrderThreadInput) => (entry.id === "needs-input" ? 0 : 1);
    expect(
      order([chattedRecently, finishedRecently, needsInput], "status", { statusRank: rank }),
    ).toEqual(["needs-input", "finished-recently", "chatted-recently"]);
  });

  it("orders a status group by its latest request, not by when its run started", () => {
    const askedLate = thread("asked-late", {
      ...asking("approval", "2026-06-01T11:45:00.000Z"),
      latestRun: run("2026-06-01T09:00:00.000Z", null),
    });
    const askedEarly = thread("asked-early", {
      ...asking("approval", "2026-06-01T10:30:00.000Z"),
      latestRun: run("2026-06-01T10:00:00.000Z", null),
    });
    const rank = (entry: InboxOrderThreadInput) => (entry.hasPendingApprovals ? 0 : 1);
    expect(
      order([chattedRecently, askedEarly, finishedRecently, askedLate], "status", {
        statusRank: rank,
      }),
    ).toEqual(["asked-late", "asked-early", "finished-recently", "chatted-recently"]);
  });
});

describe("createInboxWakeTracker", () => {
  const finishedRecently = thread("finished-recently", {
    latestRun: run("2026-06-01T10:00:00.000Z", "2026-06-01T11:30:00.000Z"),
  });
  const sleeper = thread("sleeper", {
    snoozedUntil: "2026-06-01T15:00:00.000Z",
    snoozedAt: "2026-06-01T08:00:00.000Z",
    latestRun: run("2026-06-01T09:00:00.000Z", "2026-06-01T09:30:00.000Z"),
  });
  const awakened = { ...sleeper, snoozedUntil: null, snoozedAt: null };

  it("counts a manual unsnooze, which leaves no wake time on the shell", () => {
    const tracker = createInboxWakeTracker();
    tracker.observe([sleeper], "2026-06-01T11:00:00.000Z");
    tracker.observe([awakened], "2026-06-01T11:50:00.000Z");
    expect(
      order([finishedRecently, awakened], "last_status_change", { wokeAt: tracker.wokeAt }),
    ).toEqual(["sleeper", "finished-recently"]);
  });

  it("counts a thread dragged out of Snoozed from the drop, before and after the server confirms", () => {
    const tracker = createInboxWakeTracker();
    tracker.observe([sleeper], "2026-06-01T11:00:00.000Z");
    tracker.noteWake(sleeper, Date.parse("2026-06-01T11:55:00.000Z"));
    const inInbox = () =>
      order([finishedRecently, awakened], "last_status_change", { wokeAt: tracker.wokeAt });
    expect(inInbox()).toEqual(["sleeper", "finished-recently"]);

    tracker.observe([awakened], "2026-06-01T11:55:01.000Z");
    expect(inInbox()).toEqual(["sleeper", "finished-recently"]);
  });

  it("counts a guest message that woke a snoozed thread, which the shell cannot date", () => {
    const tracker = createInboxWakeTracker();
    const guestWoke = { ...sleeper, pendingGuestMessageCount: 1 };
    tracker.observe([sleeper], "2026-06-01T11:00:00.000Z");
    tracker.observe([guestWoke], "2026-06-01T11:40:00.000Z");
    expect(
      order([finishedRecently, guestWoke], "last_status_change", { wokeAt: tracker.wokeAt }),
    ).toEqual(["sleeper", "finished-recently"]);
  });

  it("stamps neither a first sighting nor a wake the shell dates itself", () => {
    const tracker = createInboxWakeTracker();
    const seenAwake = thread("seen-awake");
    const scheduled = thread("scheduled", {
      snoozedUntil: "2026-06-01T12:30:00.000Z",
      snoozedAt: "2026-06-01T08:00:00.000Z",
    });
    const asked = thread("asked", {
      snoozedUntil: "2026-06-01T15:00:00.000Z",
      snoozedAt: "2026-06-01T08:00:00.000Z",
    });
    tracker.observe([seenAwake, scheduled, asked], now);
    tracker.observe(
      [seenAwake, scheduled, { ...asked, ...asking("approval", "2026-06-01T12:10:00.000Z") }],
      "2026-06-01T12:31:00.000Z",
    );
    expect(tracker.wokeAt(seenAwake)).toBeUndefined();
    expect(tracker.wokeAt(scheduled)).toBeUndefined();
    expect(tracker.wokeAt(asked)).toBeUndefined();
  });
});
