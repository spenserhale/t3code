import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });

  it("offers snoozing until a thread only on servers that can link threads", () => {
    const snoozeChildren = (state: Partial<ThreadActionMenuState>) =>
      buildThreadActionMenuItems({ ...baseState, ...state })
        .find((item) => item.id === "snooze")
        ?.children?.map((child) => child.id);
    expect(snoozeChildren({})).toEqual(["snooze:hour", "snooze:custom"]);
    expect(snoozeChildren({ threadWait: { waiting: false } })).toEqual([
      "snooze:hour",
      "snooze:custom",
      "snooze-until-thread",
    ]);
  });

  it("offers Stop waiting instead of Wake thread on a waiting thread", () => {
    const ids = (threadWait: ThreadActionMenuState["threadWait"]) =>
      buildThreadActionMenuItems({ ...baseState, isSnoozed: true, threadWait }).map(
        (item) => item.id,
      );
    expect(ids({ waiting: true })).toContain("stop-waiting");
    expect(ids({ waiting: true })).not.toContain("unsnooze");
    expect(ids({ waiting: false })).toContain("unsnooze");
    expect(ids(undefined)).toContain("unsnooze");
  });
});
