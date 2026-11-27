/**
 * Jira Cloud as an issue tracker. A scope is a project key (`PROJ`) and an issue key `PROJ-123`. A
 * status is closed when its category is Done. An issue moves only through the transitions its
 * workflow offers, so its states are its current status and the statuses those transitions reach.
 */
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type {
  IssueActor,
  IssueCapabilities,
  IssueComment,
  IssueState,
  IssueViewerPermissions,
  StandaloneIssueTrackerDescriptor,
} from "@t3tools/contracts";
import {
  IssueTrackerError,
  type StandaloneIssueTrackerApi,
  type TrackerIssueSummary,
} from "@t3tools/source-control-core/server/IssueTracker";

import { JIRA_HOST, parseJiraIssueUrl } from "../shared/issueUrl.ts";
import { adfToMarkdown, plainTextToAdf } from "./jiraAdf.ts";
import * as JiraApi from "./JiraApi.ts";
import { issueListingJql } from "./jiraJql.ts";

const DESCRIPTOR: StandaloneIssueTrackerDescriptor = {
  tracker: JiraApi.KIND,
  displayName: "Jira",
  host: JIRA_HOST,
  scopeNoun: "project",
  credential: {
    label: "Personal API token",
    helpUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
    fields: [
      { key: "site", label: "Site address", placeholder: "https://your-site.atlassian.net" },
      { key: "email", label: "Account email", placeholder: "you@example.com" },
    ],
  },
};

/** Reading, commenting and moving issues; filing and editing them stay in Jira for now. */
const CAPABILITIES: IssueCapabilities = {
  create: false,
  edit: false,
  comment: true,
  labels: false,
  assignees: false,
  reactions: false,
  templates: false,
  linkedPullRequests: false,
  events: false,
  search: true,
};

/** Granted: Jira refuses a move or a comment the account may not make, and says why. */
const VIEWER_PERMISSIONS: IssueViewerPermissions = {
  setState: true,
  comment: true,
  edit: true,
  labels: true,
  assignees: true,
};

const SUMMARY_FIELDS = [
  "summary",
  "status",
  "resolution",
  "assignee",
  "reporter",
  "labels",
  "project",
  "created",
  "updated",
  "resolutiondate",
  "statuscategorychangedate",
];
const DETAIL_FIELDS = [...SUMMARY_FIELDS, "description"];
const COMMENTS_PAGE = 50;
/** The most issues with fields the enhanced search returns in one page. */
const MAX_PAGE = 100;
const FIELD_LIST_TTL_MILLIS = 10 * 60_000;
const EPOCH = "1970-01-01T00:00:00.000Z";
/** Jira's default resolutions that mean the work was done; any other one is how it stopped. */
const COMPLETED_RESOLUTIONS = new Set(["done", "fixed", "resolved", "complete", "completed"]);

const ACCEPTANCE_CRITERIA_NAME = /\bacceptance[\s_-]*criteri(?:a|on)\b/iu;
const CUSTOM_FIELD_ID = /^customfield_\d+$/u;
const MAX_ACCEPTANCE_FIELDS = 5;

interface FieldRef {
  readonly id: string;
  readonly name: string;
}

/** `PROJ-123`, or null for anything that is not a Jira issue key. */
function parseKey(key: string): string | null {
  const trimmed = key.trim();
  return /^[A-Za-z][A-Za-z0-9_]*-[1-9]\d*$/u.test(trimmed) ? trimmed.toUpperCase() : null;
}

function projectOf(issue: JiraApi.RawIssue): string {
  const key = issue.fields?.project?.key?.trim();
  return (key || issue.key.slice(0, issue.key.lastIndexOf("-"))).toUpperCase();
}

/** Jira writes offsets as `+0000`, which Safari cannot read; this is the same instant in ISO 8601. */
function isoTimestamp(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return Option.match(DateTime.make(value), { onNone: () => null, onSome: DateTime.formatIso });
}

/**
 * The login is the display name, which is what people read; Jira Cloud has no handles, and the
 * account id stays inside this adapter.
 */
function toActor(user: JiraApi.RawUser | null | undefined): IssueActor | null {
  const name = user?.displayName?.trim();
  const login = name || user?.accountId?.trim();
  if (user === null || user === undefined || !login) return null;
  return {
    ...(user.accountType === "app" ? { isBot: true } : {}),
    login,
    name: name || null,
    avatarUrl: user.avatarUrls?.["48x48"] ?? null,
  };
}

/** A resolution, where the issue has one, says how a closed status ended. */
function toState(
  status: JiraApi.RawStatus | null | undefined,
  resolution?: { readonly name?: string | undefined } | null,
): IssueState {
  const name = status?.name?.trim() || "Unknown";
  if (status?.statusCategory?.key !== "done") return { category: "open", name };
  const reason = resolution?.name?.trim();
  if (!reason) return { category: "closed", name };
  return {
    category: "closed",
    name,
    closeReason: COMPLETED_RESOLUTIONS.has(reason.toLowerCase()) ? "completed" : reason,
  };
}

function toSummary(
  site: JiraApi.JiraSession["site"],
  issue: JiraApi.RawIssue,
): TrackerIssueSummary {
  const fields = issue.fields ?? undefined;
  const state = toState(fields?.status, fields?.resolution);
  const createdAt = isoTimestamp(fields?.created) ?? EPOCH;
  const assignee = toActor(fields?.assignee);
  return {
    key: issue.key,
    displayKey: issue.key,
    title: fields?.summary?.trim() || issue.key,
    url: `${site.origin}/browse/${issue.key}`,
    author: toActor(fields?.reporter),
    state,
    createdAt,
    updatedAt: isoTimestamp(fields?.updated) ?? createdAt,
    closedAt:
      state.category === "closed"
        ? (isoTimestamp(fields?.resolutiondate) ?? isoTimestamp(fields?.statuscategorychangedate))
        : null,
    assignees: assignee === null ? [] : [assignee],
    labels: (fields?.labels ?? []).flatMap((label) =>
      label.trim() === "" ? [] : [{ name: label.trim(), color: null }],
    ),
    // Totals would mean downloading every comment of every row; a listing shows none.
    commentCount: 0,
  };
}

/** The current status first, then each status a transition reaches, each named once. */
function issueStates(
  issue: JiraApi.RawIssue,
  transitions: ReadonlyArray<JiraApi.RawTransition>,
): IssueState[] {
  const states = [toState(issue.fields?.status, issue.fields?.resolution)];
  for (const transition of transitions) {
    if (!transition.to?.name?.trim()) continue;
    const state = toState(transition.to);
    if (!states.some((known) => known.name === state.name)) states.push(state);
  }
  return states;
}

function toComments(
  site: JiraApi.JiraSession["site"],
  key: string,
  comments: ReadonlyArray<JiraApi.RawComment>,
): IssueComment[] {
  return comments.flatMap((comment) =>
    comment.id.trim() === ""
      ? []
      : [
          {
            id: comment.id,
            author: toActor(comment.author),
            body: adfToMarkdown(comment.body),
            createdAt: isoTimestamp(comment.created) ?? EPOCH,
            url: `${site.origin}/browse/${key}?focusedCommentId=${encodeURIComponent(comment.id)}`,
          },
        ],
  );
}

/** Comment pages are offsets into the newest-first list; the cursor is where the next one starts. */
function commentsCursorAfter(startAt: number, page: JiraApi.RawCommentPage): string | null {
  const next = startAt + page.comments.length;
  return page.comments.length > 0 && next < (page.total ?? 0) ? String(next) : null;
}

/** Sites keep acceptance criteria in a custom field of their own, so the fields are found by name. */
function acceptanceCriteriaFields(
  fields: ReadonlyArray<JiraApi.RawField>,
): ReadonlyArray<FieldRef> {
  const found = new Map<string, FieldRef>();
  for (const field of fields) {
    if (found.size === MAX_ACCEPTANCE_FIELDS) break;
    const name = field.name?.trim();
    if (name && CUSTOM_FIELD_ID.test(field.id) && ACCEPTANCE_CRITERIA_NAME.test(name)) {
      found.set(field.id, { id: field.id, name });
    }
  }
  return [...found.values()];
}

/** Rich text, plain text or a list of text; anything else (an option, a user) holds no prose. */
function customFieldMarkdown(value: unknown): string | null {
  const markdown = Array.isArray(value)
    ? value
        .flatMap((item: unknown) =>
          typeof item === "string" && item.trim() !== "" ? [`- ${item.trim()}`] : [],
        )
        .join("\n")
    : adfToMarkdown(value).trim();
  return markdown.length > 0 ? markdown : null;
}

/** The description, then each acceptance criteria field that has text, under its own name. */
function issueBody(issue: JiraApi.RawIssue, criteria: ReadonlyArray<FieldRef>): string {
  const description = adfToMarkdown(issue.fields?.description);
  const sections = criteria.flatMap((field) => {
    const markdown = customFieldMarkdown(issue.fields?.[field.id]);
    return markdown === null ? [] : [`## ${field.name}\n\n${markdown}`];
  });
  return [...(description.trim() === "" ? [] : [description]), ...sections].join("\n\n");
}

const failed = (operation: string, detail: string) =>
  new IssueTrackerError({ tracker: JiraApi.KIND, operation, reason: "failed", detail });

export const make: Effect.Effect<StandaloneIssueTrackerApi, never, JiraApi.JiraApi> = Effect.gen(
  function* () {
    const jira = yield* JiraApi.JiraApi;
    const fieldLists = new Map<
      string,
      { readonly at: number; readonly fields: ReadonlyArray<FieldRef> }
    >();

    const requireKey = (operation: string, key: string) => {
      const parsed = parseKey(key);
      return parsed === null ? Effect.fail(JiraApi.notFound(operation)) : Effect.succeed(parsed);
    };

    const requireProjectKey = (operation: string, scope: string) => {
      const key = scope.trim().toUpperCase();
      return /^[A-Z][A-Z0-9_]*$/u.test(key)
        ? Effect.succeed(key)
        : Effect.fail(failed(operation, `"${scope}" is not a Jira project key.`));
    };

    /**
     * The issue a write names, refused unless it sits in the bound project: a key from another
     * project, or one whose issue moved away, still resolves in Jira.
     */
    const requireProjectIssue = Effect.fn("JiraIssueTracker.requireProjectIssue")(function* (
      session: JiraApi.JiraSession,
      operation: string,
      input: { readonly scope: string; readonly key: string },
    ) {
      const key = yield* requireKey(operation, input.key);
      const issue = yield* session.issue(key, ["project", "status"]);
      if (issue === null) return yield* JiraApi.notFound(operation);
      const project = projectOf(issue);
      const bound = input.scope.trim().toUpperCase();
      if (project !== bound) {
        return yield* failed(
          operation,
          `${issue.key} belongs to Jira project ${project}, not ${bound}.`,
        );
      }
      return issue;
    });

    /** Read once per site and kept a while; a list that cannot be read leaves the criteria out. */
    const acceptanceFields = Effect.fn("JiraIssueTracker.acceptanceFields")(function* (
      session: JiraApi.JiraSession,
    ) {
      const now = yield* Clock.currentTimeMillis;
      const cached = fieldLists.get(session.site.origin);
      if (cached !== undefined && now - cached.at < FIELD_LIST_TTL_MILLIS) return cached.fields;
      const fields = yield* session.fields.pipe(
        Effect.map(acceptanceCriteriaFields),
        Effect.orElseSucceed(() => null),
      );
      if (fields === null) return [];
      fieldLists.set(session.site.origin, { at: now, fields });
      return fields;
    });

    /** Jira filters by account id; the display names its issues carry are matched to people here. */
    const accountIdsNamed = (session: JiraApi.JiraSession, login: string) =>
      session
        .findUsers(login.trim())
        .pipe(
          Effect.map((users) =>
            users.flatMap((user) =>
              user.accountId !== undefined &&
              (user.displayName?.trim().toLowerCase() === login.trim().toLowerCase() ||
                user.accountId === login.trim())
                ? [user.accountId]
                : [],
            ),
          ),
        );

    const api: StandaloneIssueTrackerApi = {
      kind: JiraApi.KIND,
      capabilities: CAPABILITIES,
      standalone: DESCRIPTOR,
      parseIssueUrl: parseJiraIssueUrl,

      probeCredential: Effect.fn("JiraIssueTracker.probeCredential")(function* (token) {
        const session = yield* jira.session("probeCredential", token);
        const [me, projects] = yield* Effect.all([session.myself, session.projects], {
          concurrency: 2,
        });
        const email = me.emailAddress?.trim() || session.email;
        return {
          // Which site matters as much as who: the settings row shows it beside the account.
          account: `${email} on ${session.site.host}`,
          workspace: session.site.host,
          scopes: projects.map((project) => ({
            key: project.key,
            name: project.name?.trim() || project.key,
          })),
        };
      }),

      getViewer: () =>
        jira.session("getViewer").pipe(
          Effect.flatMap((session) => session.myself),
          Effect.flatMap((me) => {
            const login = toActor(me)?.login;
            return login === undefined
              ? Effect.fail(failed("getViewer", "Jira did not say who this account is."))
              : Effect.succeed(login);
          }),
        ),

      listIssues: Effect.fn("JiraIssueTracker.listIssues")(function* (input) {
        const project = yield* requireProjectKey("listIssues", input.scope);
        const session = yield* jira.session("listIssues");
        const assigneeIds =
          input.assignee === undefined
            ? undefined
            : yield* accountIdsNamed(session, input.assignee);
        // Nobody by that name: nothing is assigned to them here, and `assignee in ()` is not JQL.
        if (assigneeIds !== undefined && assigneeIds.length === 0) {
          return { items: [], nextCursor: null };
        }
        const { jql, byKey } = issueListingJql({
          project,
          state: input.state,
          involvement: input.involvement,
          labels: input.labels ?? [],
          assigneeIds,
          query: input.query,
          sort: input.sort,
        });
        const page = yield* session.search({
          jql,
          fields: SUMMARY_FIELDS,
          maxResults: Math.min(Math.max(input.limit, 1), MAX_PAGE),
          nextPageToken: input.cursor,
          emptyWhenRefused: byKey,
        });
        return {
          items: page.issues.flatMap((issue) =>
            issue.key.trim() === "" ? [] : [toSummary(session.site, issue)],
          ),
          nextCursor: page.isLast === true ? null : (page.nextPageToken ?? null),
        };
      }),

      getIssue: Effect.fn("JiraIssueTracker.getIssue")(function* (input) {
        const key = yield* requireKey("getIssue", input.key);
        const session = yield* jira.session("getIssue");
        const criteria = yield* acceptanceFields(session);
        const [issue, comments, transitions, viewer] = yield* Effect.all(
          [
            session.issue(key, [...DETAIL_FIELDS, ...criteria.map((field) => field.id)]),
            session.comments(key, { startAt: 0, maxResults: COMMENTS_PAGE }),
            session.transitions(key),
            session.myself.pipe(
              Effect.map((me) => toActor(me)?.login ?? null),
              Effect.orElseSucceed(() => null),
            ),
          ],
          { concurrency: "unbounded" },
        );
        if (issue === null) return yield* JiraApi.notFound("getIssue");
        return {
          ...toSummary(session.site, issue),
          commentCount: Math.max(comments.total ?? 0, comments.comments.length),
          body: issueBody(issue, criteria),
          viewer,
          viewerPermissions: VIEWER_PERMISSIONS,
          states: issueStates(issue, transitions),
          comments: toComments(session.site, issue.key, comments.comments),
          commentsCursor: commentsCursorAfter(0, comments),
          events: [],
          linkedPullRequests: [],
        };
      }),

      getComments: Effect.fn("JiraIssueTracker.getComments")(function* (input) {
        const key = yield* requireKey("getComments", input.key);
        const startAt = /^\d{1,9}$/u.test(input.cursor) ? Number(input.cursor) : null;
        if (startAt === null) {
          return yield* failed("getComments", "That page of comments is not one Jira handed out.");
        }
        const session = yield* jira.session("getComments");
        const page = yield* session.comments(key, { startAt, maxResults: COMMENTS_PAGE });
        return {
          comments: toComments(session.site, key, page.comments),
          nextCursor: commentsCursorAfter(startAt, page),
        };
      }),

      comment: Effect.fn("JiraIssueTracker.comment")(function* (input) {
        const session = yield* jira.session("comment");
        const issue = yield* requireProjectIssue(session, "comment", input);
        const body = plainTextToAdf(input.body);
        if (body.content.length === 0)
          return yield* failed("comment", "A comment needs some text.");
        yield* session.addComment(issue.key, body);
      }),

      setState: Effect.fn("JiraIssueTracker.setState")(function* (input) {
        const session = yield* jira.session("setState");
        const issue = yield* requireProjectIssue(session, "setState", input);
        const wanted = input.state.trim();
        if (issue.fields?.status?.name?.trim() === wanted) return;
        const transitions = yield* session.transitions(issue.key);
        const reaching = (matches: (name: string) => boolean) =>
          transitions.filter((transition) => matches(transition.to?.name?.trim() ?? ""));
        const exact = reaching((name) => name === wanted);
        const loose = reaching((name) => name.toLowerCase() === wanted.toLowerCase());
        // Two transitions may reach one status; the workflow lists the usual one first.
        const transition = exact[0] ?? (loose.length === 1 ? loose[0] : undefined);
        if (transition === undefined) {
          return yield* failed(
            "setState",
            `Jira offers no move to "${wanted}" for ${issue.key} right now.`,
          );
        }
        yield* session.transition(issue.key, transition.id);
      }),
    };
    return api;
  },
);
