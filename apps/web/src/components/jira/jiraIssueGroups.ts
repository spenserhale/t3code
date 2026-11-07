import type { JiraIssueSummary, JiraStatusCategory } from "@t3tools/contracts";

export interface JiraIssueGroup {
  readonly category: JiraStatusCategory;
  readonly label: string;
  readonly issues: ReadonlyArray<JiraIssueSummary>;
}

// Work in progress comes first: it is what a person comes back to.
const GROUPS: ReadonlyArray<{ readonly category: JiraStatusCategory; readonly label: string }> = [
  { category: "in-progress", label: "In progress" },
  { category: "todo", label: "To do" },
  { category: "done", label: "Done" },
  { category: "unknown", label: "Other" },
];

/** Issues by status category, each in the order Jira gave them; empty groups are left out. */
export function groupIssuesByStatus(
  issues: ReadonlyArray<JiraIssueSummary>,
): ReadonlyArray<JiraIssueGroup> {
  return GROUPS.map(({ category, label }) => ({
    category,
    label,
    issues: issues.filter((issue) => issue.status.category === category),
  })).filter((group) => group.issues.length > 0);
}
