import {
  JIRA_SEARCH_MAX_PAGE_SIZE,
  JiraAddCommentInput,
  JiraComment,
  JiraIssueInput,
  JiraIssueSummary,
  JiraSearchPreset,
  JiraSearchResult,
  JiraSearchSort,
  JiraStatusCategoryFilter,
  JiraTransitionInput,
  JiraTransitionList,
  NonNegativeInt,
  OrchestratorMcpFailure,
  PositiveInt,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import {
  JIRA_AGENT_DEFAULT_COMMENTS,
  JIRA_AGENT_DEFAULT_MAX_CHARS,
  JIRA_AGENT_DESCRIPTION_FACTOR,
  JIRA_AGENT_MAX_CHARS,
  JIRA_AGENT_MAX_COMMENTS,
  JiraAgentIssue,
} from "../../../jira/jiraAgentIssue.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const JIRA_SEARCH_DEFAULT_PAGE_SIZE = 20;

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
};

const key = JiraIssueInput.fields.key.annotate({ description: "Issue key, e.g. PROJ-123." });

const JiraSearchTool = Tool.make("jira_issue_search", {
  ...shared,
  description:
    "Search Jira issues; results are summaries. `preset`: assigned (mine, unresolved), sprint (mine, open sprints), reported (by me), recent (updated in 14 days), custom (all issues, from `jql` and/or the filters). Filters narrow every preset. `nextPageToken` goes back as `pageToken`.",
  parameters: Schema.Struct({
    preset: JiraSearchPreset,
    jql: Schema.optional(
      Schema.String.annotate({ description: "For custom. May end with ORDER BY." }),
    ),
    text: Schema.optional(
      Schema.String.annotate({ description: "Words to match. An issue key finds that issue." }),
    ),
    projectKeys: Schema.optional(Schema.Array(Schema.String)),
    statusCategories: Schema.optional(Schema.Array(JiraStatusCategoryFilter)),
    sort: Schema.optional(
      JiraSearchSort.annotate({ description: "Best first. Default: the preset's own order." }),
    ),
    pageToken: Schema.optional(Schema.String),
    pageSize: Schema.optional(
      Schema.Int.check(
        Schema.isBetween({ minimum: 1, maximum: JIRA_SEARCH_MAX_PAGE_SIZE }),
      ).annotate({ description: `Default ${JIRA_SEARCH_DEFAULT_PAGE_SIZE}.` }),
    ),
  }),
  success: JiraSearchResult,
})
  .annotate(Tool.Title, "Search Jira issues")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const JiraReadTool = Tool.make("jira_issue_read", {
  ...shared,
  description:
    "Read one Jira issue: description, acceptance criteria, labels, newest comments. Text is limited: size it with `comments` and `maxChars`; `note` says what was left out. To link a thread to it, put the key in capitals in the thread title (`PROJ-123: Fix login`) with `t3_thread_update`. Start work on it with `t3_thread_launch`.",
  parameters: Schema.Struct({
    key,
    comments: Schema.optional(
      NonNegativeInt.annotate({
        description: `Newest comments to return, 0 to ${JIRA_AGENT_MAX_COMMENTS}. Default ${JIRA_AGENT_DEFAULT_COMMENTS}.`,
      }),
    ),
    maxChars: Schema.optional(
      PositiveInt.annotate({
        description: `Characters kept per text, up to ${JIRA_AGENT_MAX_CHARS}. Default ${JIRA_AGENT_DEFAULT_MAX_CHARS}; the description keeps ${JIRA_AGENT_DESCRIPTION_FACTOR}x.`,
      }),
    ),
  }),
  success: JiraAgentIssue,
})
  .annotate(Tool.Title, "Read a Jira issue")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const JiraTransitionTool = Tool.make("jira_issue_transition", {
  ...shared,
  description:
    "Move a Jira issue to another status. Without `transitionId`: lists the moves available from its current status (id, name, resulting status). With a listed `id`: makes the move and returns the updated issue.",
  parameters: Schema.Struct({
    key,
    transitionId: Schema.optional(JiraTransitionInput.fields.transitionId),
  }),
  success: Schema.Union([JiraTransitionList, JiraIssueSummary]),
})
  .annotate(Tool.Title, "Move a Jira issue")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const JiraCommentTool = Tool.make("jira_issue_comment", {
  ...shared,
  description:
    "Comment on a Jira issue as the connected account. Plain text: blank lines start paragraphs and web addresses become links; Markdown is not rendered.",
  parameters: Schema.Struct({ key, body: JiraAddCommentInput.fields.body }),
  success: JiraComment,
})
  .annotate(Tool.Title, "Comment on a Jira issue")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const JiraToolkit = Toolkit.make(
  JiraSearchTool,
  JiraReadTool,
  JiraTransitionTool,
  JiraCommentTool,
);
