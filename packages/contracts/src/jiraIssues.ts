import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** `PROJ-123`: an uppercase project key, a hyphen, then the issue number. */
export const JIRA_ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,24}-[1-9][0-9]{0,9}$/;
export const JiraIssueKey = Schema.String.check(Schema.isPattern(JIRA_ISSUE_KEY_PATTERN));
export type JiraIssueKey = typeof JiraIssueKey.Type;

/** Jira's status categories: To Do, In Progress and Done. Anything else reads as unknown. */
export const JiraStatusCategory = Schema.Literals(["todo", "in-progress", "done", "unknown"]);
export type JiraStatusCategory = typeof JiraStatusCategory.Type;

export const JiraStatusCategoryFilter = Schema.Literals(["todo", "in-progress", "done"]);
export type JiraStatusCategoryFilter = typeof JiraStatusCategoryFilter.Type;

export const JiraUser = Schema.Struct({
  accountId: Schema.String,
  displayName: Schema.String,
});
export type JiraUser = typeof JiraUser.Type;

export const JiraProject = Schema.Struct({
  key: Schema.String,
  name: Schema.String,
});
export type JiraProject = typeof JiraProject.Type;

export const JiraProjectList = Schema.Struct({ projects: Schema.Array(JiraProject) });
export type JiraProjectList = typeof JiraProjectList.Type;

export const JiraIssueStatus = Schema.Struct({
  name: Schema.String,
  category: JiraStatusCategory,
});
export type JiraIssueStatus = typeof JiraIssueStatus.Type;

/** One row of a list or a status chip. */
export const JiraIssueSummary = Schema.Struct({
  key: JiraIssueKey,
  summary: Schema.String,
  /** The issue in Jira's own UI. */
  url: Schema.String,
  status: JiraIssueStatus,
  issueType: Schema.String,
  priority: Schema.NullOr(Schema.String),
  assignee: Schema.NullOr(JiraUser),
  projectKey: Schema.String,
  projectName: Schema.String,
  updatedAt: Schema.String,
});
export type JiraIssueSummary = typeof JiraIssueSummary.Type;

export const JiraComment = Schema.Struct({
  id: Schema.String,
  author: Schema.NullOr(JiraUser),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  bodyMarkdown: Schema.String,
});
export type JiraComment = typeof JiraComment.Type;

export const JiraIssueDetail = Schema.Struct({
  ...JiraIssueSummary.fields,
  reporter: Schema.NullOr(JiraUser),
  createdAt: Schema.String,
  labels: Schema.Array(Schema.String),
  /** Jira's rich text, converted to Markdown. */
  descriptionMarkdown: Schema.String,
  /** The newest comments, oldest first. */
  comments: Schema.Array(JiraComment),
  commentCount: NonNegativeInt,
});
export type JiraIssueDetail = typeof JiraIssueDetail.Type;

export const JiraSearchPreset = Schema.Literals([
  "assigned",
  "sprint",
  "reported",
  "recent",
  "custom",
]);
export type JiraSearchPreset = typeof JiraSearchPreset.Type;

export const JIRA_SEARCH_MAX_PAGE_SIZE = 100;
const JIRA_LOOKUP_MAX_KEYS = 200;
export const JIRA_COMMENT_MAX_LENGTH = 32_000;

export const JiraSearchInput = Schema.Struct({
  preset: JiraSearchPreset,
  /** The query to run when `preset` is `custom`; otherwise ignored. */
  jql: Schema.optionalKey(Schema.String),
  projectKeys: Schema.optionalKey(Schema.Array(Schema.String)),
  statusCategories: Schema.optionalKey(Schema.Array(JiraStatusCategoryFilter)),
  text: Schema.optionalKey(Schema.String),
  pageToken: Schema.optionalKey(Schema.String),
  pageSize: Schema.optionalKey(PositiveInt),
});
export type JiraSearchInput = typeof JiraSearchInput.Type;

export const JiraSearchResult = Schema.Struct({
  issues: Schema.Array(JiraIssueSummary),
  /** `null` on the last page. */
  nextPageToken: Schema.NullOr(Schema.String),
  /** The query that ran, so a preset's result can be copied into Jira. */
  jql: Schema.String,
});
export type JiraSearchResult = typeof JiraSearchResult.Type;

export const JiraIssueInput = Schema.Struct({ key: JiraIssueKey });
export type JiraIssueInput = typeof JiraIssueInput.Type;

export const JiraTransition = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  to: JiraIssueStatus,
});
export type JiraTransition = typeof JiraTransition.Type;

export const JiraTransitionList = Schema.Struct({ transitions: Schema.Array(JiraTransition) });
export type JiraTransitionList = typeof JiraTransitionList.Type;

export const JiraTransitionInput = Schema.Struct({
  key: JiraIssueKey,
  transitionId: TrimmedNonEmptyString,
});
export type JiraTransitionInput = typeof JiraTransitionInput.Type;

export const JiraAddCommentInput = Schema.Struct({
  key: JiraIssueKey,
  /** Plain text. Blank lines start paragraphs and web addresses become links. */
  body: TrimmedNonEmptyString.check(Schema.isMaxLength(JIRA_COMMENT_MAX_LENGTH)),
});
export type JiraAddCommentInput = typeof JiraAddCommentInput.Type;

export const JiraLookupInput = Schema.Struct({
  keys: Schema.Array(JiraIssueKey).check(Schema.isMaxLength(JIRA_LOOKUP_MAX_KEYS)),
});
export type JiraLookupInput = typeof JiraLookupInput.Type;

/** The issues that exist and are visible to the saved account; any other key is left out. */
export const JiraLookupResult = Schema.Struct({ issues: Schema.Array(JiraIssueSummary) });
export type JiraLookupResult = typeof JiraLookupResult.Type;

export const JiraStatusInput = Schema.Struct({
  /** Checks the saved credentials with Jira instead of only reporting that they exist. */
  verify: Schema.optionalKey(Schema.Boolean),
});
export type JiraStatusInput = typeof JiraStatusInput.Type;

export const JiraStatus = Schema.Struct({
  configured: Schema.Boolean,
  siteUrl: Schema.optionalKey(Schema.String),
  email: Schema.optionalKey(Schema.String),
  /** Present once Jira has confirmed the credentials. */
  account: Schema.optionalKey(JiraUser),
});
export type JiraStatus = typeof JiraStatus.Type;

export const JiraConfigureInput = Schema.Struct({
  /** `https://<site>.atlassian.net`; anything after the host is dropped. */
  siteUrl: TrimmedNonEmptyString,
  email: TrimmedNonEmptyString,
  apiToken: Schema.RedactedFromValue(TrimmedNonEmptyString),
});
export type JiraConfigureInput = typeof JiraConfigureInput.Type;

export class JiraNotConfiguredError extends Schema.TaggedError<JiraNotConfiguredError>()(
  "JiraNotConfiguredError",
  {},
) {
  override get message(): string {
    return "Jira is not set up on this environment.";
  }
}

export class JiraAuthFailedError extends Schema.TaggedError<JiraAuthFailedError>()(
  "JiraAuthFailedError",
  { status: Schema.Int },
) {
  override get message(): string {
    return `Jira did not accept the email and API token (HTTP ${this.status}).`;
  }
}

export class JiraNotFoundError extends Schema.TaggedError<JiraNotFoundError>()(
  "JiraNotFoundError",
  { key: Schema.optionalKey(Schema.String) },
) {
  override get message(): string {
    return this.key === undefined
      ? "Jira could not find that."
      : `Jira has no issue ${this.key}, or the saved account cannot see it.`;
  }
}

export class JiraRateLimitedError extends Schema.TaggedError<JiraRateLimitedError>()(
  "JiraRateLimitedError",
  { retryAfterSeconds: Schema.optionalKey(NonNegativeInt) },
) {
  override get message(): string {
    return this.retryAfterSeconds === undefined
      ? "Jira is rate limiting requests."
      : `Jira is rate limiting requests. Try again in ${this.retryAfterSeconds} seconds.`;
  }
}

export const JiraRequestOperation = Schema.Literals([
  "credentials",
  "verifyAccount",
  "listProjects",
  "search",
  "getIssue",
  "listTransitions",
  "transition",
  "addComment",
  "lookupIssues",
]);
export type JiraRequestOperation = typeof JiraRequestOperation.Type;

/**
 * Jira refused the request or could not be reached. `status` is absent when no
 * answer came. `detail` is Jira's own explanation of a refusal (for example a
 * JQL syntax error), cut to a bounded length.
 */
export class JiraRequestError extends Schema.TaggedError<JiraRequestError>()("JiraRequestError", {
  operation: JiraRequestOperation,
  status: Schema.optionalKey(Schema.Int),
  detail: Schema.optionalKey(Schema.String),
}) {
  override get message(): string {
    if (this.operation === "credentials") return "The saved Jira credentials could not be read.";
    if (this.detail !== undefined) return `Jira refused the request: ${this.detail}`;
    return this.status === undefined
      ? `Could not reach Jira (${this.operation}).`
      : `Jira answered with HTTP ${this.status} (${this.operation}).`;
  }
}

export const JiraError = Schema.Union([
  JiraNotConfiguredError,
  JiraAuthFailedError,
  JiraNotFoundError,
  JiraRateLimitedError,
  JiraRequestError,
]);
export type JiraError = typeof JiraError.Type;
