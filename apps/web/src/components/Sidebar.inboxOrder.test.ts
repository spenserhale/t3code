import { sortInboxThreadsByOrder } from "@t3tools/client-runtime/state/thread-order";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../test-fixtures";
import { projectSidebarInboxDrop, sortSidebarInboxThreads } from "./Sidebar.inboxOrder";

const now = "2026-06-01T12:00:00.000Z";

const shell = {
  environmentId: EnvironmentId.make("environment-1"),
  createdAt: "2026-06-01T00:00:00.000Z",
  unsettledAt: null,
  settledAt: null,
  settledOverride: null,
  pinnedAt: null,
  pinOrderKey: null,
  activeOrderKey: null,
  snoozedAt: null,
  snoozedUntil: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
};

describe("projectSidebarInboxDrop", () => {
  it("sorts a thread dropped out of Snoozed as woken at the drop, even after an older failure", () => {
    // Snoozed at 10:00, after its last run failed at 09:00.
    const snoozed = {
      ...shell,
      id: ThreadId.make("snoozed"),
      latestRun: {
        status: "failed",
        requestedAt: "2026-06-01T08:50:00.000Z",
        startedAt: "2026-06-01T08:50:00.000Z",
        completedAt: "2026-06-01T09:00:00.000Z",
      },
      runtime: { status: "failed", updatedAt: "2026-06-01T09:00:00.000Z" },
      snoozedAt: "2026-06-01T10:00:00.000Z",
      snoozedUntil: "2026-06-01T15:00:00.000Z",
    };
    const finished = {
      ...shell,
      id: ThreadId.make("finished"),
      latestRun: {
        status: "completed",
        requestedAt: "2026-06-01T10:00:00.000Z",
        startedAt: "2026-06-01T10:00:00.000Z",
        completedAt: "2026-06-01T11:30:00.000Z",
      },
    };
    expect(
      sortInboxThreadsByOrder(
        [finished, projectSidebarInboxDrop(snoozed, now)],
        "last_status_change",
        {
          now,
        },
      ).map((entry) => entry.id),
    ).toEqual(["snoozed", "finished"]);
  });
});

describe("sortSidebarInboxThreads", () => {
  it("ranks a preparing thread with running work, between broken runs and idle threads", () => {
    const make = (
      id: string,
      runtimeStatus: "failed" | "preparing" | null,
      userMessageAt: string,
    ) =>
      makeThreadFixture({
        id: ThreadId.make(id),
        environmentId: shell.environmentId,
        runtime: runtimeStatus && {
          status: runtimeStatus,
          activeRunId: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerName: null,
          lastError: null,
          updatedAt: userMessageAt,
        },
        latestUserMessageAt: userMessageAt,
      });
    const failed = make("failed", "failed", "2026-06-01T08:00:00.000Z");
    const preparing = make("preparing", "preparing", "2026-06-01T07:00:00.000Z");
    const idle = make("idle", null, "2026-06-01T11:00:00.000Z");
    expect(
      sortSidebarInboxThreads([idle, preparing, failed], "status", now).map((entry) => entry.id),
    ).toEqual(["failed", "preparing", "idle"]);
  });
});
