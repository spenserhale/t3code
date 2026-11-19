import { createFileRoute } from "@tanstack/react-router";

import { JiraPage } from "../components/jira/JiraPage";
import { parseJiraSearch } from "../components/jira/jiraRouteSearch";

export const Route = createFileRoute("/_chat/jira")({
  validateSearch: parseJiraSearch,
  component: JiraPage,
});
