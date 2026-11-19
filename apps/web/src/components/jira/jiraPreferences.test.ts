import type { JiraTransition } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { transitionToStatus } from "./jiraPreferences";

describe("transitionToStatus", () => {
  const transitions: ReadonlyArray<JiraTransition> = [
    { id: "11", name: "Start progress", to: { name: "In Progress", category: "in-progress" } },
    { id: "21", name: "Done", to: { name: "Closed", category: "done" } },
  ];

  it("finds the move to a status by the status it lands on, then by the move's own name", () => {
    expect(transitionToStatus(transitions, " in progress ")?.id).toBe("11");
    expect(transitionToStatus(transitions, "done")?.id).toBe("21");
    expect(transitionToStatus(transitions, "Blocked")).toBeNull();
    expect(transitionToStatus(transitions, "  ")).toBeNull();
  });
});
