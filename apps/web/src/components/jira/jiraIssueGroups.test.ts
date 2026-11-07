import type { JiraIssueSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupIssuesByStatus } from "./jiraIssueGroups";

const issue = (
  key: string,
  category: JiraIssueSummary["status"]["category"],
): JiraIssueSummary => ({
  key,
  summary: key,
  url: `https://acme.atlassian.net/browse/${key}`,
  status: { name: category, category },
  issueType: "Task",
  priority: null,
  assignee: null,
  projectKey: "PROJ",
  projectName: "Platform",
  updatedAt: "2026-11-01T09:30:00.000+0000",
});

describe("groupIssuesByStatus", () => {
  it("puts work in progress first, keeps Jira's order inside a group and drops empty groups", () => {
    const groups = groupIssuesByStatus([
      issue("PROJ-1", "todo"),
      issue("PROJ-2", "done"),
      issue("PROJ-3", "in-progress"),
      issue("PROJ-4", "todo"),
    ]);
    expect(groups.map((group) => [group.label, group.issues.map((entry) => entry.key)])).toEqual([
      ["In progress", ["PROJ-3"]],
      ["To do", ["PROJ-1", "PROJ-4"]],
      ["Done", ["PROJ-2"]],
    ]);
  });
});
