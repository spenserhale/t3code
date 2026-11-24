/**
 * Jira Cloud's REST API v3, signed with Basic auth from the credential saved in Settings. Only the
 * parts of each answer the tracker reads are decoded; everything else Jira sends is ignored.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { IssueTrackerError } from "@t3tools/source-control-core/server/IssueTracker";
import * as IssueTrackerHost from "@t3tools/source-control-core/server/IssueTrackerHost";

import { JIRA_KIND } from "../shared/issueUrl.ts";
import type { AdfDocument } from "./jiraAdf.ts";
import { decodeJiraCredential, type JiraCredential } from "./jiraCredential.ts";

export const KIND = JIRA_KIND;

const REQUEST_TIMEOUT = "30 seconds";
const PROJECT_PAGE = 100;
const MAX_PROJECTS = 1_000;
const USER_SEARCH_LIMIT = 50;
const MAX_ERROR_BODY_CHARS = 64_000;

const RawUser = Schema.Struct({
  accountId: Schema.optional(Schema.String),
  accountType: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.NullOr(Schema.String)),
  emailAddress: Schema.optional(Schema.NullOr(Schema.String)),
  avatarUrls: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
});
export type RawUser = typeof RawUser.Type;

const RawStatus = Schema.Struct({
  name: Schema.optional(Schema.String),
  statusCategory: Schema.optional(
    Schema.NullOr(Schema.Struct({ key: Schema.optional(Schema.String) })),
  ),
});
export type RawStatus = typeof RawStatus.Type;

// The rest of the keys are the site's own fields, read only when a request names them.
const RawIssueFields = Schema.StructWithRest(
  Schema.Struct({
    summary: Schema.optional(Schema.NullOr(Schema.String)),
    status: Schema.optional(Schema.NullOr(RawStatus)),
    resolution: Schema.optional(
      Schema.NullOr(Schema.Struct({ name: Schema.optional(Schema.String) })),
    ),
    assignee: Schema.optional(Schema.NullOr(RawUser)),
    reporter: Schema.optional(Schema.NullOr(RawUser)),
    labels: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
    project: Schema.optional(Schema.NullOr(Schema.Struct({ key: Schema.optional(Schema.String) }))),
    created: Schema.optional(Schema.NullOr(Schema.String)),
    updated: Schema.optional(Schema.NullOr(Schema.String)),
    resolutiondate: Schema.optional(Schema.NullOr(Schema.String)),
    statuscategorychangedate: Schema.optional(Schema.NullOr(Schema.String)),
    description: Schema.optional(Schema.Unknown),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

const RawIssue = Schema.Struct({
  key: Schema.String,
  fields: Schema.optional(Schema.NullOr(RawIssueFields)),
});
export type RawIssue = typeof RawIssue.Type;

const RawSearchPage = Schema.Struct({
  issues: Schema.Array(RawIssue),
  nextPageToken: Schema.optional(Schema.NullOr(Schema.String)),
  isLast: Schema.optional(Schema.Boolean),
});
type RawSearchPage = typeof RawSearchPage.Type;

const RawComment = Schema.Struct({
  id: Schema.String,
  author: Schema.optional(Schema.NullOr(RawUser)),
  body: Schema.optional(Schema.Unknown),
  created: Schema.optional(Schema.String),
});
export type RawComment = typeof RawComment.Type;

const RawCommentPage = Schema.Struct({
  comments: Schema.Array(RawComment),
  total: Schema.optional(Schema.Number),
});
export type RawCommentPage = typeof RawCommentPage.Type;

const RawTransition = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  isAvailable: Schema.optional(Schema.Boolean),
  to: Schema.optional(Schema.NullOr(RawStatus)),
});
export type RawTransition = typeof RawTransition.Type;

const RawTransitions = Schema.Struct({ transitions: Schema.Array(RawTransition) });

const RawProject = Schema.Struct({ key: Schema.String, name: Schema.optional(Schema.String) });
type RawProject = typeof RawProject.Type;

const RawProjectPage = Schema.Struct({
  values: Schema.Array(RawProject),
  isLast: Schema.optional(Schema.Boolean),
});

const RawField = Schema.Struct({ id: Schema.String, name: Schema.optional(Schema.String) });
export type RawField = typeof RawField.Type;

/** Requests on one credential: the stored one, or a new one being vetted before it is stored. */
export interface JiraSession {
  readonly site: Pick<JiraCredential, "origin" | "host">;
  /** The email the credential was saved with. */
  readonly email: string;
  readonly myself: Effect.Effect<RawUser, IssueTrackerError>;
  /** Every project the account may browse, by key. */
  readonly projects: Effect.Effect<ReadonlyArray<RawProject>, IssueTrackerError>;
  readonly search: (input: {
    readonly jql: string;
    readonly fields: ReadonlyArray<string>;
    readonly maxResults: number;
    readonly nextPageToken?: string | undefined;
    /** Answer a refused query as an empty page, for a query whose refusal means "no such issue". */
    readonly emptyWhenRefused?: boolean | undefined;
  }) => Effect.Effect<RawSearchPage, IssueTrackerError>;
  /** Null when Jira has no issue by that key, or the account cannot see it. */
  readonly issue: (
    key: string,
    fields: ReadonlyArray<string>,
  ) => Effect.Effect<RawIssue | null, IssueTrackerError>;
  /** Newest first, so a later page holds older comments. */
  readonly comments: (
    key: string,
    page: { readonly startAt: number; readonly maxResults: number },
  ) => Effect.Effect<RawCommentPage, IssueTrackerError>;
  /** The moves the workflow offers this account now. */
  readonly transitions: (
    key: string,
  ) => Effect.Effect<ReadonlyArray<RawTransition>, IssueTrackerError>;
  readonly transition: (
    key: string,
    transitionId: string,
  ) => Effect.Effect<void, IssueTrackerError>;
  readonly addComment: (key: string, body: AdfDocument) => Effect.Effect<void, IssueTrackerError>;
  readonly fields: Effect.Effect<ReadonlyArray<RawField>, IssueTrackerError>;
  /** People whose name or email starts with `query`. */
  readonly findUsers: (query: string) => Effect.Effect<ReadonlyArray<RawUser>, IssueTrackerError>;
}

export class JiraApi extends Context.Service<
  JiraApi,
  {
    /** A session on the stored credential, or on `token` when one is vetted before it is stored. */
    readonly session: (
      operation: string,
      token?: string,
    ) => Effect.Effect<JiraSession, IssueTrackerError>;
  }
>()("@t3tools/issue-tracker-jira/server/JiraApi") {}

const fail = (
  operation: string,
  reason: IssueTrackerError["reason"],
  detail: string,
  extra: { readonly retryAt?: number; readonly cause?: unknown } = {},
) =>
  new IssueTrackerError({
    tracker: KIND,
    operation,
    reason,
    detail,
    ...(extra.retryAt === undefined ? {} : { retryAt: extra.retryAt }),
    ...(extra.cause === undefined ? {} : { cause: extra.cause }),
  });

export const notFound = (operation: string) =>
  fail(operation, "not-found", "Jira has no issue by that key, or this account cannot see it.");

/** The first thing Jira said was wrong, short enough to show a person. */
function jiraErrorDetail(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { errorMessages, errors, message } = parsed as {
      readonly errorMessages?: unknown;
      readonly errors?: unknown;
      readonly message?: unknown;
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

/** `Retry-After` is in seconds from now. */
function retryAtFromHeader(value: string | undefined, now: number): number | undefined {
  const seconds = /^\d+$/u.test(value?.trim() ?? "") ? Number(value) : Number.NaN;
  return Number.isSafeInteger(seconds) ? now + seconds * 1_000 : undefined;
}

const EMPTY_SEARCH_PAGE: RawSearchPage = { issues: [], isLast: true };

export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const host = yield* IssueTrackerHost.IssueTrackerHost;

  const storedToken = (operation: string) =>
    host.credentials
      .get(KIND)
      .pipe(
        Effect.flatMap(
          Effect.fromOption(() =>
            fail(operation, "unauthenticated", "Jira is not connected on this server."),
          ),
        ),
      );

  const open = (operation: string, credential: JiraCredential): JiraSession => {
    const url = (path: string) => `${credential.origin}/rest/api/3${path}`;
    const issuePath = (key: string) => `/issue/${encodeURIComponent(key)}`;

    /** The response, whatever its status; only an unreachable site fails here. */
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      httpClient
        .execute(
          request.pipe(
            HttpClientRequest.basicAuth(credential.email, credential.apiToken),
            HttpClientRequest.acceptJson,
          ),
        )
        .pipe(
          Effect.timeout(REQUEST_TIMEOUT),
          Effect.mapError((cause) =>
            fail(operation, "failed", `Jira could not be reached at ${credential.host}.`, {
              cause,
            }),
          ),
        );

    const refusal = Effect.fn("JiraApi.refusal")(function* (
      response: HttpClientResponse.HttpClientResponse,
    ) {
      const status = response.status;
      const loginReason = response.headers["x-seraph-loginreason"] ?? "";
      if (status === 401) {
        return yield* fail(
          operation,
          "unauthenticated",
          "Jira rejected the email and API token. Check both, and that the token was created without scopes.",
        );
      }
      if (status === 403 && loginReason.startsWith("AUTHENTICATION")) {
        return yield* fail(
          operation,
          "unauthenticated",
          "Jira wants this account to sign in through a browser before it accepts the API token again.",
        );
      }
      if (status === 404) return yield* notFound(operation);
      if (status === 429) {
        const now = yield* Clock.currentTimeMillis;
        const retryAt = retryAtFromHeader(response.headers["retry-after"], now);
        return yield* fail(
          operation,
          "rate-limited",
          "Jira's rate limit was reached.",
          retryAt === undefined ? {} : { retryAt },
        );
      }
      const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      return yield* fail(
        operation,
        "failed",
        jiraErrorDetail(body.slice(0, MAX_ERROR_BODY_CHARS)) ?? `Jira answered HTTP ${status}.`,
      );
    });

    const ok = (response: HttpClientResponse.HttpClientResponse) =>
      response.status >= 200 && response.status < 300
        ? Effect.succeed(response)
        : refusal(response);

    const readJson = <S extends Schema.Top & { readonly DecodingServices: never }>(
      schema: S,
      response: HttpClientResponse.HttpClientResponse,
    ) =>
      HttpClientResponse.schemaBodyJson(schema)(response).pipe(
        Effect.mapError((cause) =>
          fail(operation, "failed", "Jira answered with something this app cannot read.", {
            cause,
          }),
        ),
      );

    const get = <S extends Schema.Top & { readonly DecodingServices: never }>(
      path: string,
      params: Record<string, string>,
      schema: S,
    ) =>
      execute(HttpClientRequest.get(url(path)).pipe(HttpClientRequest.setUrlParams(params))).pipe(
        Effect.flatMap(ok),
        Effect.flatMap((response) => readJson(schema, response)),
      );

    const post = (path: string, body: unknown) =>
      execute(HttpClientRequest.post(url(path)).pipe(HttpClientRequest.bodyJsonUnsafe(body)));

    const projects = Effect.gen(function* () {
      const found: Array<RawProject> = [];
      while (found.length < MAX_PROJECTS) {
        const page = yield* get(
          "/project/search",
          {
            action: "browse",
            orderBy: "key",
            startAt: String(found.length),
            maxResults: String(PROJECT_PAGE),
          },
          RawProjectPage,
        );
        found.push(...page.values);
        if (page.isLast !== false || page.values.length === 0) break;
      }
      return found;
    });

    const search: JiraSession["search"] = Effect.fn("JiraApi.search")(function* (input) {
      const response = yield* post("/search/jql", {
        jql: input.jql,
        fields: input.fields,
        maxResults: input.maxResults,
        ...(input.nextPageToken === undefined ? {} : { nextPageToken: input.nextPageToken }),
      });
      if (response.status === 400 && input.emptyWhenRefused === true) return EMPTY_SEARCH_PAGE;
      return yield* readJson(RawSearchPage, yield* ok(response));
    });

    return {
      site: { origin: credential.origin, host: credential.host },
      email: credential.email,
      myself: get("/myself", {}, RawUser),
      projects,
      search,
      issue: (key, fields) =>
        get(issuePath(key), { fields: fields.join(",") }, RawIssue).pipe(
          Effect.catchIf(
            (error) => error.reason === "not-found",
            () => Effect.succeed(null),
          ),
        ),
      comments: (key, page) =>
        get(
          `${issuePath(key)}/comment`,
          {
            startAt: String(page.startAt),
            maxResults: String(page.maxResults),
            orderBy: "-created",
          },
          RawCommentPage,
        ),
      transitions: (key) =>
        get(`${issuePath(key)}/transitions`, {}, RawTransitions).pipe(
          Effect.map((answer) =>
            answer.transitions.filter((transition) => transition.isAvailable !== false),
          ),
        ),
      transition: (key, transitionId) =>
        post(`${issuePath(key)}/transitions`, { transition: { id: transitionId } }).pipe(
          Effect.flatMap(ok),
          Effect.asVoid,
        ),
      addComment: (key, body) =>
        post(`${issuePath(key)}/comment`, { body }).pipe(Effect.flatMap(ok), Effect.asVoid),
      fields: get("/field", {}, Schema.Array(RawField)),
      findUsers: (query) =>
        get(
          "/user/search",
          { query, maxResults: String(USER_SEARCH_LIMIT) },
          Schema.Array(RawUser),
        ),
    };
  };

  const session: JiraApi["Service"]["session"] = Effect.fn("JiraApi.session")(
    function* (operation, token) {
      yield* Effect.annotateCurrentSpan({ "jira.operation": operation });
      const credential = yield* decodeJiraCredential(
        operation,
        token ?? (yield* storedToken(operation)),
      );
      return open(operation, credential);
    },
  );

  return JiraApi.of({ session });
});

export const layer = Layer.effect(JiraApi, make);
