import {
  JiraIssueKey,
  type JiraComment,
  type JiraIssueDetail,
  type JiraIssueSummary,
  type JiraStatusCategory,
  type JiraTransition,
  type JiraUser,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { adfToMarkdown } from "./jiraAdf.ts";

/** The parts of Jira Cloud's REST v3 answers the app reads. Anything else is ignored. */

const RawUser = Schema.Struct({
  accountId: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
});

const RawStatus = Schema.Struct({
  name: Schema.optional(Schema.String),
  statusCategory: Schema.optional(Schema.Struct({ key: Schema.optional(Schema.String) })),
});

const RawComment = Schema.Struct({
  id: Schema.String,
  author: Schema.optional(Schema.NullOr(RawUser)),
  body: Schema.optional(Schema.Unknown),
  created: Schema.optional(Schema.String),
  updated: Schema.optional(Schema.String),
});

// The rest of the keys are the site's custom fields, read only when a request names them.
const RawIssueFields = Schema.StructWithRest(
  Schema.Struct({
    summary: Schema.optional(Schema.NullOr(Schema.String)),
    status: Schema.optional(Schema.NullOr(RawStatus)),
    issuetype: Schema.optional(
      Schema.NullOr(Schema.Struct({ name: Schema.optional(Schema.String) })),
    ),
    priority: Schema.optional(
      Schema.NullOr(Schema.Struct({ name: Schema.optional(Schema.String) })),
    ),
    assignee: Schema.optional(Schema.NullOr(RawUser)),
    reporter: Schema.optional(Schema.NullOr(RawUser)),
    project: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          key: Schema.optional(Schema.String),
          name: Schema.optional(Schema.String),
        }),
      ),
    ),
    created: Schema.optional(Schema.NullOr(Schema.String)),
    updated: Schema.optional(Schema.NullOr(Schema.String)),
    labels: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
    description: Schema.optional(Schema.Unknown),
    comment: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          total: Schema.optional(Schema.Number),
          comments: Schema.optional(Schema.Array(RawComment)),
        }),
      ),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

export const RawIssue = Schema.Struct({
  key: Schema.String,
  fields: Schema.optional(Schema.NullOr(RawIssueFields)),
});
type RawIssue = typeof RawIssue.Type;
type RawComment = typeof RawComment.Type;
type RawUser = typeof RawUser.Type;

export const RawSearchResponse = Schema.Struct({
  issues: Schema.Array(RawIssue),
  nextPageToken: Schema.optional(Schema.NullOr(Schema.String)),
});

export const RawTransitionsResponse = Schema.Struct({
  transitions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      isAvailable: Schema.optional(Schema.Boolean),
      to: Schema.optional(Schema.NullOr(RawStatus)),
    }),
  ),
});

export const RawProjectsResponse = Schema.Struct({
  values: Schema.Array(Schema.Struct({ key: Schema.String, name: Schema.optional(Schema.String) })),
  isLast: Schema.optional(Schema.Boolean),
});

export const RawFieldsResponse = Schema.Array(
  Schema.Struct({ id: Schema.String, name: Schema.optional(Schema.String) }),
);

export const RawMyself = RawUser;
export { RawComment };

const isJiraIssueKey = Schema.is(JiraIssueKey);

/** `https://<site>.atlassian.net` only: the host the credentials belong to. */
export function normalizeSiteUrl(value: string): string | null {
  const parsed = URL.parse(value.trim().includes("://") ? value.trim() : `https://${value.trim()}`);
  if (parsed === null || parsed.username !== "" || parsed.password !== "") return null;
  // A mock server on this machine may speak plain HTTP; anything else carries a token and must not.
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) return null;
  if (parsed.hostname.length === 0) return null;
  return parsed.origin;
}

const STATUS_CATEGORY_BY_KEY: Readonly<Record<string, JiraStatusCategory>> = {
  new: "todo",
  indeterminate: "in-progress",
  done: "done",
};

const statusOf = (status: typeof RawStatus.Type | null | undefined) => ({
  name: status?.name ?? "Unknown",
  category: STATUS_CATEGORY_BY_KEY[status?.statusCategory?.key ?? ""] ?? ("unknown" as const),
});

/** Jira writes offsets as `+0000`, which Safari does not read; this is the same instant as ISO 8601. */
const isoTimestamp = (value: string | null | undefined): string =>
  value === null || value === undefined
    ? ""
    : Option.match(DateTime.make(value), { onNone: () => value, onSome: DateTime.formatIso });

const userOf = (user: RawUser | null | undefined): JiraUser | null =>
  user === null || user === undefined || user.accountId === undefined
    ? null
    : { accountId: user.accountId, displayName: user.displayName ?? user.accountId };

export const userFromMyself = (raw: RawUser): JiraUser | null => userOf(raw);

/** `null` for a key this app cannot name, which no list could show. */
export function toIssueSummary(raw: RawIssue, siteUrl: string): JiraIssueSummary | null {
  if (!isJiraIssueKey(raw.key)) return null;
  const fields = raw.fields ?? undefined;
  const project = fields?.project ?? undefined;
  return {
    key: raw.key,
    summary: fields?.summary ?? "",
    url: `${siteUrl}/browse/${raw.key}`,
    status: statusOf(fields?.status),
    issueType: fields?.issuetype?.name ?? "Issue",
    priority: fields?.priority?.name ?? null,
    assignee: userOf(fields?.assignee),
    projectKey: project?.key ?? raw.key.slice(0, raw.key.lastIndexOf("-")),
    projectName: project?.name ?? project?.key ?? raw.key.slice(0, raw.key.lastIndexOf("-")),
    updatedAt: isoTimestamp(fields?.updated ?? fields?.created),
  };
}

export function toComment(raw: RawComment): JiraComment {
  return {
    id: raw.id,
    author: userOf(raw.author),
    createdAt: isoTimestamp(raw.created),
    updatedAt: isoTimestamp(raw.updated ?? raw.created),
    bodyMarkdown: adfToMarkdown(raw.body),
  };
}

const COMMENTS_SHOWN = 50;

/** A site's own field that the app asks for by id, with the name people know it by. */
export interface JiraFieldRef {
  readonly id: string;
  readonly name: string;
}

const ACCEPTANCE_CRITERIA_NAME = /\bacceptance[\s_-]*criteri(?:a|on)\b/iu;
const CUSTOM_FIELD_ID = /^customfield_\d+$/u;
const MAX_ACCEPTANCE_FIELDS = 5;

/** Sites keep acceptance criteria in a custom field of their own, so the fields are found by name. */
export function acceptanceCriteriaFields(
  fields: ReadonlyArray<{ readonly id: string; readonly name?: string | undefined }>,
): ReadonlyArray<JiraFieldRef> {
  const found = new Map<string, JiraFieldRef>();
  for (const field of fields) {
    if (found.size === MAX_ACCEPTANCE_FIELDS) break;
    if (
      field.name !== undefined &&
      CUSTOM_FIELD_ID.test(field.id) &&
      ACCEPTANCE_CRITERIA_NAME.test(field.name) &&
      !found.has(field.id)
    ) {
      found.set(field.id, { id: field.id, name: field.name });
    }
  }
  return [...found.values()];
}

/** Rich text, plain text or a list of text; anything else (an option, a user) holds no prose. */
function customFieldMarkdown(value: unknown): string | null {
  const markdown = Array.isArray(value)
    ? value
        .flatMap((item: unknown) =>
          typeof item === "string" && item.trim() !== "" ? [item.trim()] : [],
        )
        .map((item) => `- ${item}`)
        .join("\n")
    : adfToMarkdown(value).trim();
  return markdown.length > 0 ? markdown : null;
}

export function toIssueDetail(
  raw: RawIssue,
  siteUrl: string,
  extraFields: ReadonlyArray<JiraFieldRef> = [],
): JiraIssueDetail | null {
  const summary = toIssueSummary(raw, siteUrl);
  if (summary === null) return null;
  const fields = raw.fields ?? undefined;
  const comments = fields?.comment?.comments ?? [];
  const acceptanceCriteria = extraFields.flatMap((field) => {
    const markdown = customFieldMarkdown(fields?.[field.id]);
    return markdown === null ? [] : [{ name: field.name, markdown }];
  });
  return {
    ...summary,
    reporter: userOf(fields?.reporter),
    createdAt: isoTimestamp(fields?.created),
    labels: fields?.labels ?? [],
    descriptionMarkdown: adfToMarkdown(fields?.description),
    ...(acceptanceCriteria.length === 0 ? {} : { acceptanceCriteria }),
    comments: comments.slice(-COMMENTS_SHOWN).map(toComment),
    commentCount: Math.max(fields?.comment?.total ?? 0, comments.length),
  };
}

export function toTransition(
  raw: (typeof RawTransitionsResponse.Type)["transitions"][number],
): JiraTransition {
  return { id: raw.id, name: raw.name, to: statusOf(raw.to) };
}

/** The first thing Jira said was wrong, short enough to show a person. */
export function jiraErrorDetail(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { errorMessages, errors, message } = parsed as {
      errorMessages?: unknown;
      errors?: unknown;
      message?: unknown;
    };
    const candidates: unknown[] = [
      ...(Array.isArray(errorMessages) ? errorMessages : []),
      ...(typeof errors === "object" && errors !== null ? Object.values(errors) : []),
      message,
    ];
    const first = candidates.find(
      (candidate): candidate is string => typeof candidate === "string" && candidate.trim() !== "",
    );
    return first === undefined ? undefined : first.trim().slice(0, 300);
  } catch {
    return undefined;
  }
}

/** The fields a list row needs, so a long description or comment thread is not downloaded for it. */
export const SUMMARY_FIELDS = [
  "summary",
  "status",
  "issuetype",
  "priority",
  "assignee",
  "project",
  "updated",
  "created",
] as const;

export const DETAIL_FIELDS = [
  ...SUMMARY_FIELDS,
  "reporter",
  "labels",
  "description",
  "comment",
] as const;
