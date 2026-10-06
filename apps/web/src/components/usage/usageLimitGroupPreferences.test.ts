import { assignLimitGroup, setLimitGroupsEnabled } from "@t3tools/shared/usageLimitGroups";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { readUsageLimitGroups, updateUsageLimitGroups } from "./usageLimitGroupPreferences";

const key = "t3code:usage-limit-groups:v1";
const ungrouped = { enabled: false, assignments: {} };
const grouped = { enabled: true, assignments: { "codex:me@example.com": "Work" } };
let values: Map<string, string>;
let storage: Pick<Storage, "getItem" | "setItem">;
let dispatchEvent: ReturnType<typeof vi.fn>;

beforeEach(() => {
  values = new Map();
  storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
  dispatchEvent = vi.fn();
  vi.stubGlobal("window", { localStorage: storage, dispatchEvent });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Limits group preferences", () => {
  it("leaves Limits ungrouped until groups have been saved", () => {
    expect(readUsageLimitGroups()).toEqual(ungrouped);
  });

  it("round-trips assignments, including while the grouped view is off", () => {
    updateUsageLimitGroups(() => grouped);
    expect(readUsageLimitGroups()).toEqual(grouped);
    updateUsageLimitGroups((groups) => setLimitGroupsEnabled(groups, false));
    expect(readUsageLimitGroups()).toEqual({ ...grouped, enabled: false });
  });

  it("applies a change to the groups stored now, not to an older snapshot", () => {
    // Another window saves an assignment after this one read its snapshot.
    const staleSnapshot = readUsageLimitGroups();
    updateUsageLimitGroups((groups) => assignLimitGroup(groups, "codex:a@example.com", "Work"));

    updateUsageLimitGroups((groups) => assignLimitGroup(groups, "claude:b@example.com", "Home"));
    updateUsageLimitGroups((groups) => setLimitGroupsEnabled(groups, false));

    expect(staleSnapshot).toEqual(ungrouped);
    expect(readUsageLimitGroups()).toEqual({
      enabled: false,
      assignments: { "codex:a@example.com": "Work", "claude:b@example.com": "Home" },
    });
  });

  it("tells subscribed windows about a save", () => {
    updateUsageLimitGroups(() => grouped);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect(dispatchEvent.mock.calls[0]?.[0].detail).toEqual({ key });
  });

  it.each(["not-json", '{"enabled":"yes","assignments":{}}', '{"enabled":true,"assignments":[1]}'])(
    "replaces invalid groups on the next change: %s",
    (value) => {
      values.set(key, value);
      expect(readUsageLimitGroups()).toEqual(ungrouped);
      updateUsageLimitGroups((groups) => assignLimitGroup(groups, "codex:me@example.com", "Work"));
      expect(readUsageLimitGroups()).toEqual(grouped);
    },
  );

  it("contains failures when the browser blocks storage access", () => {
    vi.stubGlobal("window", {
      get localStorage() {
        throw new Error("SecurityError");
      },
    });
    expect(readUsageLimitGroups()).toEqual(ungrouped);
    expect(() => updateUsageLimitGroups(() => grouped)).not.toThrow();
  });
});
