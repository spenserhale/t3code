import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadActionMenuItems,
  threadActionRequiresOperate,
  type ThreadActionMenuState,
} from "./threadActionMenu.logic";

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

  it("lists the machines a thread can continue on, and omits the submenu with none", () => {
    const continueOn = [
      { environmentId: "laptop", label: "Laptop", disabled: false },
      { environmentId: "server", label: "Server (offline)", disabled: true },
    ];
    const submenu = buildThreadActionMenuItems({ ...baseState, continueOn }).find(
      (item) => item.id === "continue-on",
    );
    expect(submenu?.children?.map(({ id, label, disabled }) => ({ id, label, disabled }))).toEqual([
      { id: "continue-on:laptop", label: "Laptop", disabled: false },
      { id: "continue-on:server", label: "Server (offline)", disabled: true },
    ]);
    for (const state of [baseState, { ...baseState, continueOn: [] }]) {
      expect(buildThreadActionMenuItems(state).some((item) => item.id === "continue-on")).toBe(
        false,
      );
    }
  });

  it("keeps a read-only connection from handing a thread off", () => {
    const submenu = buildThreadActionMenuItems({
      ...baseState,
      canOperate: false,
      continueOn: [{ environmentId: "laptop", label: "Laptop", disabled: false }],
    }).find((item) => item.id === "continue-on");
    expect(submenu?.disabled).toBe(true);
    expect(submenu?.children?.every((child) => child.disabled)).toBe(true);
    expect(threadActionRequiresOperate("continue-on:laptop")).toBe(true);
  });
});
