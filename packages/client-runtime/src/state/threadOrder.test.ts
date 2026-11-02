import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sortInboxThreadsByOrder, type InboxOrderThreadInput } from "./threadOrder.ts";

const environmentId = EnvironmentId.make("environment-1");
const nowMs = Date.parse("2026-06-01T12:00:00.000Z");

function thread(id: string, overrides: Partial<InboxOrderThreadInput> = {}): InboxOrderThreadInput {
  return {
    id: ThreadId.make(id),
    environmentId,
    createdAt: "2026-06-01T00:00:00.000Z",
    unsettledAt: null,
    snoozedUntil: null,
    latestRun: null,
    latestUserMessageAt: null,
    ...overrides,
  };
}

function run(requestedAt: string, completedAt: string | null) {
  return {
    requestedAt,
    startedAt: requestedAt,
    completedAt,
  } as unknown as InboxOrderThreadInput["latestRun"];
}

const ids = (threads: readonly InboxOrderThreadInput[]) => threads.map((entry) => entry.id);

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
    expect(
      ids(
        sortInboxThreadsByOrder([finishedRecently, chattedRecently], "last_user_message", {
          nowMs,
        }),
      ),
    ).toEqual(["chatted-recently", "finished-recently"]);
  });

  it("ignores agent-sent messages when the server reports authored ones", () => {
    const agentPinged = thread("agent-pinged", {
      latestUserMessageAt: "2026-06-01T11:50:00.000Z",
      latestUserAuthoredMessageAt: "2026-06-01T09:00:00.000Z",
    });
    expect(
      ids(sortInboxThreadsByOrder([agentPinged, chattedRecently], "last_user_message", { nowMs })),
    ).toEqual(["chatted-recently", "agent-pinged"]);
  });

  it("falls back to creation time for a thread with no user message", () => {
    const fresh = thread("fresh", { createdAt: "2026-06-01T11:59:00.000Z" });
    expect(
      ids(sortInboxThreadsByOrder([chattedRecently, fresh], "last_user_message", { nowMs })),
    ).toEqual(["fresh", "chatted-recently"]);
  });

  it("orders by the last run, wake, or unsettle for last status change", () => {
    const woke = thread("woke", { unsettledAt: "2026-06-01T11:45:00.000Z" });
    const snoozeWoke = thread("snooze-woke", { snoozedUntil: "2026-06-01T11:40:00.000Z" });
    expect(
      ids(
        sortInboxThreadsByOrder(
          [chattedRecently, snoozeWoke, finishedRecently, woke],
          "last_status_change",
          {
            nowMs,
          },
        ),
      ),
    ).toEqual(["woke", "snooze-woke", "finished-recently", "chatted-recently"]);
  });

  it("does not count a snooze wake time that is still in the future", () => {
    const stillSnoozing = thread("still-snoozing", { snoozedUntil: "2026-06-01T13:00:00.000Z" });
    expect(
      ids(
        sortInboxThreadsByOrder([stillSnoozing, chattedRecently], "last_status_change", { nowMs }),
      ),
    ).toEqual(["chatted-recently", "still-snoozing"]);
  });

  it("groups by status rank, newest activity first within a group", () => {
    const needsInput = thread("needs-input");
    const rank = (entry: InboxOrderThreadInput) => (entry.id === "needs-input" ? 0 : 1);
    expect(
      ids(
        sortInboxThreadsByOrder([chattedRecently, finishedRecently, needsInput], "status", {
          nowMs,
          statusRank: rank,
        }),
      ),
    ).toEqual(["needs-input", "finished-recently", "chatted-recently"]);
  });
});
