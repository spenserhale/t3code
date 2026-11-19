/**
 * JiraClient - the Jira Cloud REST v3 requests the app makes, each with the
 * credential it is given, so a new credential can be tried before it is saved.
 *
 * @module JiraClient
 */
import {
  JiraAuthFailedError,
  JiraNotFoundError,
  JiraRateLimitedError,
  JiraRequestError,
  type JiraComment,
  type JiraError,
  type JiraIssueDetail,
  type JiraIssueSummary,
  type JiraProject,
  type JiraRequestOperation,
  type JiraTransition,
  type JiraUser,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import type { AdfDocument } from "./jiraAdf.ts";
import {
  DETAIL_FIELDS,
  RawFieldsResponse,
  RawIssue,
  RawMyself,
  RawProjectsResponse,
  RawSearchResponse,
  RawComment,
  RawTransitionsResponse,
  SUMMARY_FIELDS,
  acceptanceCriteriaFields,
  jiraErrorDetail,
  toComment,
  toIssueDetail,
  toIssueSummary,
  toTransition,
  userFromMyself,
  type JiraFieldRef,
} from "./jiraApi.ts";

export interface JiraCredential {
  readonly siteUrl: string;
  readonly email: string;
  readonly apiToken: Redacted.Redacted<string>;
}

const REQUEST_TIMEOUT = "20 seconds";
/** A page of lists, a detail and a few chips can all be in flight at once; Jira is not hit harder. */
const CONCURRENT_REQUESTS = 4;
const PROJECT_PAGE_SIZE = 100;
const MAX_PROJECTS = 1_000;
const MAX_ERROR_BODY_CHARS = 64_000;

export interface JiraSearchRequest {
  readonly jql: string;
  readonly pageSize: number;
  readonly pageToken?: string;
}

export class JiraClient extends Context.Service<
  JiraClient,
  {
    readonly myself: (credential: JiraCredential) => Effect.Effect<JiraUser, JiraError>;
    readonly listProjects: (
      credential: JiraCredential,
    ) => Effect.Effect<ReadonlyArray<JiraProject>, JiraError>;
    readonly listAcceptanceCriteriaFields: (
      credential: JiraCredential,
    ) => Effect.Effect<ReadonlyArray<JiraFieldRef>, JiraError>;
    readonly searchIssues: (
      credential: JiraCredential,
      request: JiraSearchRequest,
    ) => Effect.Effect<
      { readonly issues: ReadonlyArray<JiraIssueSummary>; readonly nextPageToken: string | null },
      JiraError
    >;
    /** `extraFields` are the site's own fields to read along with the standard ones. */
    readonly getIssue: (
      credential: JiraCredential,
      key: string,
      extraFields: ReadonlyArray<JiraFieldRef>,
    ) => Effect.Effect<JiraIssueDetail, JiraError>;
    readonly getIssueSummary: (
      credential: JiraCredential,
      key: string,
    ) => Effect.Effect<JiraIssueSummary, JiraError>;
    readonly listTransitions: (
      credential: JiraCredential,
      key: string,
    ) => Effect.Effect<ReadonlyArray<JiraTransition>, JiraError>;
    readonly transition: (
      credential: JiraCredential,
      key: string,
      transitionId: string,
    ) => Effect.Effect<void, JiraError>;
    readonly addComment: (
      credential: JiraCredential,
      key: string,
      body: AdfDocument,
    ) => Effect.Effect<JiraComment, JiraError>;
  }
>()("t3/jira/JiraClient") {}

const retryAfterSeconds = (header: string | undefined): number | undefined => {
  if (header === undefined) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : undefined;
};

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const slots = yield* Semaphore.make(CONCURRENT_REQUESTS);

  const fail = Effect.fn("JiraClient.fail")(function* (
    operation: JiraRequestOperation,
    response: HttpClientResponse.HttpClientResponse,
    key: string | undefined,
  ) {
    const status = response.status;
    const loginReason = response.headers["x-seraph-loginreason"];
    if (status === 401 || (status === 403 && loginReason?.startsWith("AUTHENTICATION") === true)) {
      return yield* new JiraAuthFailedError({ status });
    }
    if (status === 404) return yield* new JiraNotFoundError(key === undefined ? {} : { key });
    if (status === 429) {
      const seconds = retryAfterSeconds(response.headers["retry-after"]);
      return yield* new JiraRateLimitedError(
        seconds === undefined ? {} : { retryAfterSeconds: seconds },
      );
    }
    const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    const detail = jiraErrorDetail(body.slice(0, MAX_ERROR_BODY_CHARS));
    return yield* new JiraRequestError({
      operation,
      status,
      ...(detail === undefined ? {} : { detail }),
    });
  });

  const send = Effect.fn("JiraClient.send")(function* (
    credential: JiraCredential,
    operation: JiraRequestOperation,
    request: HttpClientRequest.HttpClientRequest,
    key?: string,
  ) {
    const response = yield* slots
      .withPermit(
        httpClient
          .execute(
            request.pipe(
              HttpClientRequest.basicAuth(credential.email, credential.apiToken),
              HttpClientRequest.acceptJson,
            ),
          )
          .pipe(Effect.timeout(REQUEST_TIMEOUT)),
      )
      .pipe(Effect.mapError(() => new JiraRequestError({ operation })));
    if (response.status >= 200 && response.status < 300) return response;
    return yield* fail(operation, response, key);
  });

  const sendJson = <S extends Schema.Top & { readonly DecodingServices: never }>(
    credential: JiraCredential,
    operation: JiraRequestOperation,
    request: HttpClientRequest.HttpClientRequest,
    schema: S,
    key?: string,
  ): Effect.Effect<S["Type"], JiraError> =>
    send(credential, operation, request, key).pipe(
      Effect.flatMap((response) =>
        HttpClientResponse.schemaBodyJson(schema)(response).pipe(
          Effect.mapError(() => new JiraRequestError({ operation, status: response.status })),
        ),
      ),
    );

  const api = (credential: JiraCredential, path: string) =>
    `${credential.siteUrl}/rest/api/3${path}`;
  const issuePath = (key: string) => `/issue/${encodeURIComponent(key)}`;

  const myself = Effect.fn("JiraClient.myself")(function* (credential: JiraCredential) {
    const raw = yield* sendJson(
      credential,
      "verifyAccount",
      HttpClientRequest.get(api(credential, "/myself")),
      RawMyself,
    );
    const user = userFromMyself(raw);
    if (user === null) return yield* new JiraRequestError({ operation: "verifyAccount" });
    return user;
  });

  const listProjects = Effect.fn("JiraClient.listProjects")(function* (credential: JiraCredential) {
    const projects: JiraProject[] = [];
    while (projects.length < MAX_PROJECTS) {
      const page = yield* sendJson(
        credential,
        "listProjects",
        HttpClientRequest.get(api(credential, "/project/search")).pipe(
          HttpClientRequest.setUrlParams({
            startAt: String(projects.length),
            maxResults: String(PROJECT_PAGE_SIZE),
            orderBy: "key",
          }),
        ),
        RawProjectsResponse,
      );
      projects.push(
        ...page.values.map((project) => ({ key: project.key, name: project.name ?? project.key })),
      );
      if (page.isLast !== false || page.values.length === 0) break;
    }
    return projects;
  });

  const listAcceptanceCriteriaFields = Effect.fn("JiraClient.listAcceptanceCriteriaFields")(
    function* (credential: JiraCredential) {
      const fields = yield* sendJson(
        credential,
        "listFields",
        HttpClientRequest.get(api(credential, "/field")),
        RawFieldsResponse,
      );
      return acceptanceCriteriaFields(fields);
    },
  );

  const searchIssues = Effect.fn("JiraClient.searchIssues")(function* (
    credential: JiraCredential,
    request: JiraSearchRequest,
  ) {
    const response = yield* sendJson(
      credential,
      "search",
      HttpClientRequest.post(api(credential, "/search/jql")).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          jql: request.jql,
          fields: SUMMARY_FIELDS,
          maxResults: request.pageSize,
          ...(request.pageToken === undefined ? {} : { nextPageToken: request.pageToken }),
        }),
      ),
      RawSearchResponse,
    );
    return {
      issues: response.issues.flatMap((raw) => {
        const issue = toIssueSummary(raw, credential.siteUrl);
        return issue === null ? [] : [issue];
      }),
      nextPageToken: response.nextPageToken ?? null,
    };
  });

  const getIssue = Effect.fn("JiraClient.getIssue")(function* (
    credential: JiraCredential,
    key: string,
    extraFields: ReadonlyArray<JiraFieldRef>,
  ) {
    const raw = yield* sendJson(
      credential,
      "getIssue",
      HttpClientRequest.get(api(credential, issuePath(key))).pipe(
        HttpClientRequest.setUrlParams({
          fields: [...DETAIL_FIELDS, ...extraFields.map((field) => field.id)].join(","),
        }),
      ),
      RawIssue,
      key,
    );
    const issue = toIssueDetail(raw, credential.siteUrl, extraFields);
    if (issue === null) return yield* new JiraNotFoundError({ key });
    return issue;
  });

  const getIssueSummary = Effect.fn("JiraClient.getIssueSummary")(function* (
    credential: JiraCredential,
    key: string,
  ) {
    const raw = yield* sendJson(
      credential,
      "lookupIssues",
      HttpClientRequest.get(api(credential, issuePath(key))).pipe(
        HttpClientRequest.setUrlParams({ fields: SUMMARY_FIELDS.join(",") }),
      ),
      RawIssue,
      key,
    );
    const issue = toIssueSummary(raw, credential.siteUrl);
    if (issue === null) return yield* new JiraNotFoundError({ key });
    return issue;
  });

  const listTransitions = Effect.fn("JiraClient.listTransitions")(function* (
    credential: JiraCredential,
    key: string,
  ) {
    const response = yield* sendJson(
      credential,
      "listTransitions",
      HttpClientRequest.get(api(credential, `${issuePath(key)}/transitions`)),
      RawTransitionsResponse,
      key,
    );
    return response.transitions
      .filter((transition) => transition.isAvailable !== false)
      .map(toTransition);
  });

  const transition = Effect.fn("JiraClient.transition")(function* (
    credential: JiraCredential,
    key: string,
    transitionId: string,
  ) {
    yield* send(
      credential,
      "transition",
      HttpClientRequest.post(api(credential, `${issuePath(key)}/transitions`)).pipe(
        HttpClientRequest.bodyJsonUnsafe({ transition: { id: transitionId } }),
      ),
      key,
    );
  });

  const addComment = Effect.fn("JiraClient.addComment")(function* (
    credential: JiraCredential,
    key: string,
    body: AdfDocument,
  ) {
    const raw = yield* sendJson(
      credential,
      "addComment",
      HttpClientRequest.post(api(credential, `${issuePath(key)}/comment`)).pipe(
        HttpClientRequest.bodyJsonUnsafe({ body }),
      ),
      RawComment,
      key,
    );
    return toComment(raw);
  });

  return JiraClient.of({
    myself,
    listProjects,
    listAcceptanceCriteriaFields,
    searchIssues,
    getIssue,
    getIssueSummary,
    listTransitions,
    transition,
    addComment,
  });
});

export const layer = Layer.effect(JiraClient, make);
