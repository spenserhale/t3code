/**
 * JiraService - reads and updates Jira issues for this environment with the
 * saved credential, and keeps recent answers briefly so a list, a detail and a
 * row of status chips do not each ask Jira again.
 *
 * @module JiraService
 */
import {
  JIRA_SEARCH_MAX_PAGE_SIZE,
  JiraNotConfiguredError,
  JiraNotFoundError,
  JiraRequestError,
  type JiraAddCommentInput,
  type JiraComment,
  type JiraConfigureInput,
  type JiraError,
  type JiraIssueDetail,
  type JiraIssueInput,
  type JiraIssueSummary,
  type JiraLookupInput,
  type JiraLookupResult,
  type JiraProjectList,
  type JiraSearchInput,
  type JiraSearchResult,
  type JiraStatus,
  type JiraStatusInput,
  type JiraTransitionInput,
  type JiraTransitionList,
  type JiraUser,
} from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import { JiraClient, type JiraCredential } from "./JiraClient.ts";
import { JiraCredentials } from "./JiraCredentials.ts";
import { plainTextToAdf } from "./jiraAdf.ts";
import { normalizeSiteUrl } from "./jiraApi.ts";
import { buildJql, jqlForKeys } from "./jiraJql.ts";

const SEARCH_CACHE_TTL = Duration.seconds(30);
const DETAIL_CACHE_TTL = Duration.seconds(60);
const LOOKUP_CACHE_TTL = Duration.seconds(60);
const TRANSITIONS_CACHE_TTL = Duration.seconds(15);
const PROJECTS_CACHE_TTL = Duration.minutes(10);
const ACCOUNT_CACHE_TTL = Duration.minutes(5);
const DEFAULT_PAGE_SIZE = 50;
/** `key in (...)` stays well inside Jira's query length for this many keys. */
const LOOKUP_CHUNK_SIZE = 50;
const PER_KEY_LOOKUP_CONCURRENCY = 4;

// Printable ASCII only: the Basic header is latin-1, and a stray newline must not reach it.
const HEADER_SAFE = /^[!-~]+$/u;

export class JiraService extends Context.Service<
  JiraService,
  {
    readonly status: (input: JiraStatusInput) => Effect.Effect<JiraStatus, JiraError>;
    readonly configure: (input: JiraConfigureInput) => Effect.Effect<JiraStatus, JiraError>;
    readonly disconnect: Effect.Effect<void, JiraError>;
    readonly listProjects: Effect.Effect<JiraProjectList, JiraError>;
    readonly search: (input: JiraSearchInput) => Effect.Effect<JiraSearchResult, JiraError>;
    readonly getIssue: (input: JiraIssueInput) => Effect.Effect<JiraIssueDetail, JiraError>;
    readonly listTransitions: (
      input: JiraIssueInput,
    ) => Effect.Effect<JiraTransitionList, JiraError>;
    readonly transition: (input: JiraTransitionInput) => Effect.Effect<JiraIssueSummary, JiraError>;
    readonly addComment: (input: JiraAddCommentInput) => Effect.Effect<JiraComment, JiraError>;
    readonly lookupIssues: (input: JiraLookupInput) => Effect.Effect<JiraLookupResult, JiraError>;
  }
>()("t3/jira/JiraService") {}

interface TtlCache<I, A> {
  readonly get: (input: I) => Effect.Effect<A, JiraError>;
  readonly invalidate: (input: I) => Effect.Effect<void>;
  readonly invalidateAll: Effect.Effect<void>;
}

/** A failed lookup is never kept, so the next ask goes to Jira again. */
const makeTtlCache = <I, A>(options: {
  readonly capacity: number;
  readonly timeToLive: Duration.Duration;
  readonly lookup: (input: I) => Effect.Effect<A, JiraError>;
}) =>
  Cache.makeWith((key: string) => options.lookup(JSON.parse(key) as I), {
    capacity: options.capacity,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? options.timeToLive : Duration.zero),
  }).pipe(
    Effect.map((cache): TtlCache<I, A> => ({
      get: (input) => Cache.get(cache, JSON.stringify(input)),
      invalidate: (input) => Cache.invalidate(cache, JSON.stringify(input)),
      invalidateAll: Cache.invalidateAll(cache),
    })),
  );

const invalidRequest = (operation: "verifyAccount" | "search", detail: string) =>
  new JiraRequestError({ operation, detail });

const make = Effect.gen(function* () {
  const client = yield* JiraClient;
  const credentials = yield* JiraCredentials;

  const requireCredential: Effect.Effect<JiraCredential, JiraError> = credentials.get.pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new JiraNotConfiguredError()),
        onSome: Effect.succeed,
      }),
    ),
  );

  /** Whole lists of keys that a single `key in (...)` query could not answer fall back to one by one. */
  const lookupOneByOne = (credential: JiraCredential, keys: ReadonlyArray<string>) =>
    Effect.forEach(
      keys,
      (key) =>
        client.getIssueSummary(credential, key).pipe(
          Effect.asSome,
          Effect.catchTags({
            JiraNotFoundError: () => Effect.succeedNone,
            JiraRequestError: (error) =>
              error.status === 400 || error.status === 403
                ? Effect.succeedNone
                : Effect.fail(error),
          }),
        ),
      { concurrency: PER_KEY_LOOKUP_CONCURRENCY },
    ).pipe(Effect.map(Arr.getSomes));

  const lookupCache = yield* makeTtlCache({
    capacity: 200,
    timeToLive: LOOKUP_CACHE_TTL,
    lookup: Effect.fn("JiraService.lookupChunk")(function* (keys: ReadonlyArray<string>) {
      const credential = yield* requireCredential;
      return yield* client
        .searchIssues(credential, { jql: jqlForKeys(keys), pageSize: keys.length })
        .pipe(
          Effect.map((page) => page.issues),
          // One key Jira does not know makes the whole query invalid.
          Effect.catchTags({
            JiraRequestError: (error) =>
              error.status === 400 ? lookupOneByOne(credential, keys) : Effect.fail(error),
          }),
        );
    }),
  });

  const searchCache = yield* makeTtlCache({
    capacity: 100,
    timeToLive: SEARCH_CACHE_TTL,
    lookup: Effect.fn("JiraService.searchPage")(function* (request: {
      readonly jql: string;
      readonly pageSize: number;
      readonly pageToken: string | null;
    }) {
      const credential = yield* requireCredential;
      return yield* client.searchIssues(credential, {
        jql: request.jql,
        pageSize: request.pageSize,
        ...(request.pageToken === null ? {} : { pageToken: request.pageToken }),
      });
    }),
  });

  const detailCache = yield* makeTtlCache({
    capacity: 100,
    timeToLive: DETAIL_CACHE_TTL,
    lookup: Effect.fn("JiraService.issueDetail")(function* (request: { readonly key: string }) {
      return yield* client.getIssue(yield* requireCredential, request.key);
    }),
  });

  const transitionsCache = yield* makeTtlCache({
    capacity: 100,
    timeToLive: TRANSITIONS_CACHE_TTL,
    lookup: Effect.fn("JiraService.issueTransitions")(function* (request: {
      readonly key: string;
    }) {
      return yield* client.listTransitions(yield* requireCredential, request.key);
    }),
  });

  const projectsCache = yield* makeTtlCache({
    capacity: 1,
    timeToLive: PROJECTS_CACHE_TTL,
    lookup: Effect.fn("JiraService.projects")(function* (_request: Record<string, never>) {
      return yield* client.listProjects(yield* requireCredential);
    }),
  });

  const accountCache = yield* makeTtlCache({
    capacity: 1,
    timeToLive: ACCOUNT_CACHE_TTL,
    lookup: Effect.fn("JiraService.account")(function* (_request: Record<string, never>) {
      return yield* client.myself(yield* requireCredential);
    }),
  });

  const forgetEverything = Effect.all(
    [
      lookupCache.invalidateAll,
      searchCache.invalidateAll,
      detailCache.invalidateAll,
      transitionsCache.invalidateAll,
      projectsCache.invalidateAll,
      accountCache.invalidateAll,
    ],
    { discard: true },
  );

  /** A change to one issue also changes every list and chip that shows it. */
  const forgetIssue = (key: string) =>
    Effect.all(
      [
        detailCache.invalidate({ key }),
        transitionsCache.invalidate({ key }),
        lookupCache.invalidateAll,
        searchCache.invalidateAll,
      ],
      { discard: true },
    );

  const status = Effect.fn("JiraService.status")(function* (input: { readonly verify?: boolean }) {
    const saved = yield* credentials.get;
    if (Option.isNone(saved)) return { configured: false } satisfies JiraStatus;
    const base = { configured: true, siteUrl: saved.value.siteUrl, email: saved.value.email };
    if (input.verify !== true) return base satisfies JiraStatus;
    const account: JiraUser = yield* accountCache.get({});
    return { ...base, account } satisfies JiraStatus;
  });

  const configure = Effect.fn("JiraService.configure")(function* (input: JiraConfigureInput) {
    const siteUrl = normalizeSiteUrl(input.siteUrl);
    if (siteUrl === null) {
      return yield* invalidRequest(
        "verifyAccount",
        "Enter the site address, like https://your-team.atlassian.net.",
      );
    }
    const email = input.email.trim();
    if (!HEADER_SAFE.test(email) || !HEADER_SAFE.test(Redacted.value(input.apiToken))) {
      return yield* invalidRequest(
        "verifyAccount",
        "The email and API token can only use letters, digits and symbols found on a keyboard.",
      );
    }
    const credential: JiraCredential = { siteUrl, email, apiToken: input.apiToken };
    // Saved only once Jira has accepted it.
    const account = yield* client.myself(credential);
    yield* credentials.set(credential);
    yield* forgetEverything;
    return { configured: true, siteUrl, email, account } satisfies JiraStatus;
  });

  const disconnect = credentials.clear.pipe(
    Effect.andThen(forgetEverything),
    Effect.withSpan("JiraService.disconnect"),
  );

  const listProjects = Effect.fn("JiraService.listProjects")(function* () {
    return { projects: yield* projectsCache.get({}) } satisfies JiraProjectList;
  });

  const search = Effect.fn("JiraService.search")(function* (input: JiraSearchInput) {
    const built = buildJql(input);
    if (built._tag === "EmptyCustomQuery") {
      return yield* invalidRequest("search", "Enter a JQL query to search with.");
    }
    const page = yield* searchCache.get({
      jql: built.jql,
      pageSize: Math.min(input.pageSize ?? DEFAULT_PAGE_SIZE, JIRA_SEARCH_MAX_PAGE_SIZE),
      pageToken: input.pageToken ?? null,
    });
    return {
      issues: page.issues,
      nextPageToken: page.nextPageToken,
      jql: built.jql,
    } satisfies JiraSearchResult;
  });

  const getIssue = Effect.fn("JiraService.getIssue")(function* (input: JiraIssueInput) {
    return yield* detailCache.get({ key: input.key });
  });

  const listTransitions = Effect.fn("JiraService.listTransitions")(function* (
    input: JiraIssueInput,
  ) {
    return {
      transitions: yield* transitionsCache.get({ key: input.key }),
    } satisfies JiraTransitionList;
  });

  const lookupIssues = Effect.fn("JiraService.lookupIssues")(function* (input: JiraLookupInput) {
    const keys = [...new Set(input.keys)].toSorted();
    const found = yield* Effect.forEach(Arr.chunksOf(keys, LOOKUP_CHUNK_SIZE), lookupCache.get, {
      concurrency: 2,
    });
    return { issues: found.flat() } satisfies JiraLookupResult;
  });

  const transition = Effect.fn("JiraService.transition")(function* (input: JiraTransitionInput) {
    yield* client.transition(yield* requireCredential, input.key, input.transitionId);
    yield* forgetIssue(input.key);
    const [issue] = yield* lookupCache.get([input.key]);
    if (issue === undefined) return yield* new JiraNotFoundError({ key: input.key });
    return issue;
  });

  const addComment = Effect.fn("JiraService.addComment")(function* (input: JiraAddCommentInput) {
    const comment = yield* client.addComment(
      yield* requireCredential,
      input.key,
      plainTextToAdf(input.body),
    );
    yield* detailCache.invalidate({ key: input.key });
    return comment;
  });

  return JiraService.of({
    status,
    configure,
    disconnect,
    listProjects: listProjects(),
    search,
    getIssue,
    listTransitions,
    transition,
    addComment,
    lookupIssues,
  });
});

export const layer = Layer.effect(JiraService, make);
