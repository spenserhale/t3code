import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import * as UrlParams from "effect/http/UrlParams";
import type { StandaloneIssueTrackerApi } from "@t3tools/source-control-core/server/IssueTracker";
import * as IssueTrackerHost from "@t3tools/source-control-core/server/IssueTrackerHost";

import * as JiraApi from "./JiraApi.ts";
import * as JiraIssueTracker from "./JiraIssueTracker.ts";

const SITE = "https://acme.atlassian.net";
const STORED = JSON.stringify({ site: SITE, email: "sam@example.com", token: "tok-123" });

const user = (accountId: string, displayName: string) => ({
  accountId,
  accountType: "atlassian",
  displayName,
  avatarUrls: { "48x48": `${SITE}/avatar/${accountId}.png` },
});
const SAM = user("acc-sam", "Sam Rivera");
const ALEX = user("acc-alex", "Alex Kim");

const status = (name: string, category: "new" | "indeterminate" | "done") => ({
  name,
  statusCategory: { key: category },
});

const issue = (key: string, fields: Record<string, unknown> = {}) => ({
  id: "10001",
  key,
  fields: {
    summary: `Issue ${key}`,
    status: status("In Progress", "indeterminate"),
    resolution: null,
    assignee: ALEX,
    reporter: SAM,
    labels: ["backend"],
    project: { key: key.split("-")[0] },
    created: "2026-10-20T08:00:00.000+0000",
    updated: "2026-11-01T09:30:00.000+0200",
    resolutiondate: null,
    ...fields,
  },
});

const comment = (id: number) => ({
  id: String(id),
  author: ALEX,
  body: {
    version: 1,
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: `Comment ${id}` }] }],
  },
  created: "2026-11-02T10:00:00.000+0000",
});

interface SentRequest {
  readonly method: string;
  readonly path: string;
  readonly params: URLSearchParams;
  readonly body: unknown;
  readonly authorization: string | undefined;
}

const jqlOf = (request: SentRequest | undefined) =>
  (request?.body as { readonly jql?: string } | undefined)?.jql;

/** Answers each request by method and path, the way a Jira site would. */
function fakeJira(
  routes: Record<string, (request: SentRequest) => unknown>,
  stored: string | null = STORED,
) {
  const requests: SentRequest[] = [];
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const url = new URL(request.url);
        const body =
          request.body._tag === "Uint8Array"
            ? (JSON.parse(new TextDecoder().decode(request.body.body)) as unknown)
            : undefined;
        const sent: SentRequest = {
          method: request.method,
          path: `${url.origin}${url.pathname}`,
          params: new URLSearchParams(UrlParams.toString(request.urlParams)),
          body,
          authorization: request.headers.authorization,
        };
        requests.push(sent);
        const route = routes[`${sent.method} ${sent.path.slice(sent.path.indexOf("/rest/"))}`];
        const answer = route?.(sent);
        const response =
          answer instanceof Response
            ? answer
            : route === undefined
              ? Response.json({ errorMessages: [`No answer for ${sent.path}`] }, { status: 404 })
              : answer === undefined
                ? new Response(null, { status: 204 })
                : Response.json(answer);
        return HttpClientResponse.fromWeb(request, response);
      }),
    ),
  );
  const host = Layer.succeed(
    IssueTrackerHost.IssueTrackerHost,
    IssueTrackerHost.IssueTrackerHost.of({
      credentials: { get: () => Effect.succeed(Option.fromNullishOr(stored)) },
    }),
  );
  // Every optional write the tracker offers is implemented; the type says so for the calls below.
  const tracker = JiraIssueTracker.make.pipe(
    Effect.map((api) => api as Required<StandaloneIssueTrackerApi>),
    Effect.provide(JiraApi.layer.pipe(Layer.provide(Layer.merge(http, host)))),
  );
  return { tracker, requests };
}

const target = { cwd: "/w/web", host: "atlassian.net", scope: "PROJ" };
const listing = {
  ...target,
  state: "open" as const,
  involvement: "all" as const,
  sort: "updated" as const,
  limit: 50,
};

describe("JiraIssueTracker", () => {
  it.effect("parses Jira issue links with the site they are on", () =>
    Effect.gen(function* () {
      const api = yield* fakeJira({}).tracker;
      for (const url of [
        `${SITE}/browse/PROJ-7`,
        `${SITE}/browse/proj-7/`,
        `${SITE}/browse/PROJ-7?focusedCommentId=10001#comment`,
        `${SITE}/jira/software/projects/PROJ/boards/1?selectedIssue=PROJ-7`,
        `${SITE}/jira/software/c/projects/PROJ/boards/1/backlog?selectedIssue=PROJ-7`,
        `${SITE}/secure/RapidBoard.jspa?rapidView=1&selectedIssue=PROJ-7`,
      ]) {
        expect(api.parseIssueUrl(new URL(url)), url).toEqual({
          host: "atlassian.net",
          workspace: "acme.atlassian.net",
          scope: "PROJ",
          key: "PROJ-7",
        });
      }
      // The site is the workspace, so a namesake project on another site is told apart.
      expect(api.parseIssueUrl(new URL("https://other.atlassian.net/browse/PROJ-7"))).toMatchObject(
        {
          workspace: "other.atlassian.net",
        },
      );
      expect(api.parseIssueUrl(new URL("http://127.0.0.1:4010/browse/MOCK_2-1"))).toMatchObject({
        workspace: "127.0.0.1:4010",
        scope: "MOCK_2",
      });
      for (const url of [
        "http://acme.atlassian.net/browse/PROJ-7",
        "https://sam:pw@acme.atlassian.net/browse/PROJ-7",
        `${SITE}/browse/PROJ-0`,
        `${SITE}/browse/PROJ`,
        `${SITE}/browse/7-PROJ`,
        `${SITE}/browse/PROJ-7/comments`,
        `${SITE}/projects/PROJ/issues/PROJ-7`,
        `${SITE}/wiki/spaces/ENG?selectedIssue=PROJ-7`,
        `${SITE}/jira/software/projects/PROJ/boards/1`,
      ]) {
        expect(api.parseIssueUrl(new URL(url)), url).toBeNull();
      }
    }),
  );

  it.effect("lists a project's issues through JQL built from every filter", () =>
    Effect.gen(function* () {
      const { tracker, requests } = fakeJira({
        "GET /rest/api/3/user/search": ({ params }) =>
          params.get("query") === "Alex Kim" ? [ALEX, user("acc-alexa", "Alex Kimball")] : [],
        "POST /rest/api/3/search/jql": ({ body }) => {
          const { nextPageToken } = body as { nextPageToken?: string };
          return nextPageToken === undefined
            ? {
                issues: [
                  issue("PROJ-2", {
                    status: status("Won't Do", "done"),
                    resolution: { name: "Won't Do" },
                    resolutiondate: "2026-11-03T12:00:00.000+0000",
                  }),
                  issue("PROJ-1", { assignee: null, labels: null, summary: "  " }),
                ],
                nextPageToken: "page-2",
                isLast: false,
              }
            : { issues: [issue("PROJ-3")], isLast: true };
        },
      });
      const api = yield* tracker;
      expect(api.kind).toBe("jira");
      expect(api.standalone).toMatchObject({ host: "atlassian.net", scopeNoun: "project" });

      const page = yield* api.listIssues({
        ...listing,
        scope: "proj",
        involvement: "assigned",
        viewer: "Sam Rivera",
        labels: ["backend", 'say "hi"'],
        assignee: "Alex Kim",
        query: "login: redirect",
        sort: "created",
        limit: 500,
      });
      const search = requests.find((request) => request.path.endsWith("/search/jql"));
      expect(search?.body).toEqual({
        jql:
          'project = "PROJ" AND statusCategory != Done AND assignee = currentUser() AND ' +
          'labels = "backend" AND labels = "say \\"hi\\"" AND assignee in ("acc-alex") AND ' +
          'text ~ "login redirect" ORDER BY created DESC',
        fields: expect.arrayContaining(["summary", "status", "resolution", "reporter", "labels"]),
        // The enhanced search returns at most 100 issues with their fields.
        maxResults: 100,
      });
      expect(search?.authorization).toBe(`Basic ${btoa("sam@example.com:tok-123")}`);
      expect(page.nextCursor).toBe("page-2");
      expect(page.items).toEqual([
        {
          key: "PROJ-2",
          displayKey: "PROJ-2",
          title: "Issue PROJ-2",
          url: `${SITE}/browse/PROJ-2`,
          author: {
            login: "Sam Rivera",
            name: "Sam Rivera",
            avatarUrl: `${SITE}/avatar/acc-sam.png`,
          },
          state: { category: "closed", name: "Won't Do", closeReason: "Won't Do" },
          createdAt: "2026-10-20T08:00:00.000Z",
          // Jira's `+0200` offset becomes the same instant in UTC.
          updatedAt: "2026-11-01T07:30:00.000Z",
          closedAt: "2026-11-03T12:00:00.000Z",
          assignees: [expect.objectContaining({ login: "Alex Kim" })],
          labels: [{ name: "backend", color: null }],
          commentCount: 0,
        },
        expect.objectContaining({
          key: "PROJ-1",
          title: "PROJ-1",
          state: { category: "open", name: "In Progress" },
          closedAt: null,
          assignees: [],
          labels: [],
        }),
      ]);

      const next = yield* api.listIssues({ ...listing, cursor: "page-2" });
      expect(next).toEqual({
        items: [expect.objectContaining({ key: "PROJ-3" })],
        nextCursor: null,
      });
      expect(requests.at(-1)?.body).toMatchObject({
        jql: 'project = "PROJ" AND statusCategory != Done ORDER BY updated DESC',
        nextPageToken: "page-2",
      });

      // Jira has no mentions clause; watching is its nearest notion of being involved.
      yield* api.listIssues({
        ...listing,
        state: "closed",
        involvement: "mentioned",
        viewer: "Sam",
      });
      yield* api.listIssues({ ...listing, state: "all", involvement: "authored", viewer: "Sam" });
      expect(requests.slice(-2).map((request) => (request.body as { jql: string }).jql)).toEqual([
        'project = "PROJ" AND statusCategory = Done AND watcher = currentUser() ORDER BY updated DESC',
        'project = "PROJ" AND reporter = currentUser() ORDER BY updated DESC',
      ]);

      // Nobody goes by that name: nothing is assigned to them, and no search is sent.
      const searches = requests.length;
      expect(yield* api.listIssues({ ...listing, assignee: "octocat" })).toEqual({
        items: [],
        nextCursor: null,
      });
      expect(requests.length).toBe(searches + 1);

      const invalid = yield* Effect.flip(api.listIssues({ ...listing, scope: "acme/web" }));
      expect(invalid.detail).toContain("not a Jira project key");
    }),
  );

  it.effect("finds an issue by key, and reads a key Jira does not have as no match", () =>
    Effect.gen(function* () {
      const { tracker, requests } = fakeJira({
        "POST /rest/api/3/search/jql": ({ body }) =>
          (body as { jql: string }).jql.includes('"PROJ-404"')
            ? Response.json(
                { errorMessages: ["An issue with key 'PROJ-404' does not exist for field 'key'."] },
                { status: 400 },
              )
            : { issues: [issue("PROJ-12")], isLast: true },
      });
      const api = yield* tracker;
      for (const query of ["proj-12", "#12", "12"]) {
        const page = yield* api.listIssues({ ...listing, query });
        expect(
          page.items.map((item) => item.key),
          query,
        ).toEqual(["PROJ-12"]);
        expect(jqlOf(requests.at(-1))).toContain('key = "PROJ-12"');
      }
      expect(yield* api.listIssues({ ...listing, query: "PROJ-404" })).toEqual({
        items: [],
        nextCursor: null,
      });
    }),
  );

  it.effect("reads an issue with its criteria, newest comments and the moves it offers", () =>
    Effect.gen(function* () {
      const comments = Array.from({ length: 60 }, (_, index) => comment(60 - index));
      const { tracker, requests } = fakeJira({
        "GET /rest/api/3/field": () => [
          { id: "summary", name: "Summary" },
          { id: "customfield_10020", name: "Acceptance Criteria" },
          { id: "customfield_10021", name: "Acceptance criterion (legacy)" },
          { id: "customfield_10030", name: "Story points" },
        ],
        "GET /rest/api/3/issue/PROJ-7": () =>
          issue("PROJ-7", {
            description: {
              type: "doc",
              version: 1,
              content: [
                { type: "paragraph", content: [{ type: "text", text: "Fix the redirect." }] },
              ],
            },
            customfield_10020: {
              type: "doc",
              version: 1,
              content: [
                {
                  type: "bulletList",
                  content: [
                    {
                      type: "listItem",
                      content: [
                        { type: "paragraph", content: [{ type: "text", text: "Signs in" }] },
                      ],
                    },
                  ],
                },
              ],
            },
            customfield_10021: ["Works offline", " "],
            customfield_10030: 3,
          }),
        "GET /rest/api/3/issue/PROJ-7/comment": ({ params }) => {
          const startAt = Number(params.get("startAt"));
          const maxResults = Number(params.get("maxResults"));
          return {
            comments: comments.slice(startAt, startAt + maxResults),
            total: comments.length,
            startAt,
          };
        },
        "GET /rest/api/3/issue/PROJ-7/transitions": () => ({
          transitions: [
            { id: "11", name: "Stop", to: status("To Do", "new") },
            { id: "31", name: "Resolve", to: status("Done", "done") },
            { id: "41", name: "Close", to: status("Done", "done") },
            {
              id: "51",
              name: "Review",
              to: status("In Review", "indeterminate"),
              isAvailable: false,
            },
          ],
        }),
        "GET /rest/api/3/myself": () => ({ ...SAM, emailAddress: "sam@example.com" }),
      });
      const api = yield* tracker;
      const detail = yield* api.getIssue({ ...target, key: "proj-7" });
      expect(detail.body).toBe(
        [
          "Fix the redirect.",
          "## Acceptance Criteria\n\n- Signs in",
          "## Acceptance criterion (legacy)\n\n- Works offline",
        ].join("\n\n"),
      );
      const read = requests.find((request) => request.path.endsWith("/issue/PROJ-7"));
      expect(read?.params.get("fields")?.split(",")).toEqual(
        expect.arrayContaining(["description", "customfield_10020", "customfield_10021"]),
      );
      expect(read?.params.get("fields")).not.toContain("customfield_10030");
      // The current status, then each status a move reaches, once; an unavailable move is left out.
      expect(detail.states).toEqual([
        { category: "open", name: "In Progress" },
        { category: "open", name: "To Do" },
        { category: "closed", name: "Done" },
      ]);
      expect(detail.viewer).toBe("Sam Rivera");
      expect(detail.commentCount).toBe(60);
      // The newest page comes with the issue; the cursor carries on into older comments.
      expect(detail.comments.map((entry) => entry.id).slice(0, 2)).toEqual(["60", "59"]);
      expect(detail.comments).toHaveLength(50);
      expect(detail.comments[0]).toEqual({
        id: "60",
        author: expect.objectContaining({ login: "Alex Kim" }),
        body: "Comment 60",
        createdAt: "2026-11-02T10:00:00.000Z",
        url: `${SITE}/browse/PROJ-7?focusedCommentId=60`,
      });
      expect(detail.commentsCursor).toBe("50");
      const firstPage = requests.find((request) => request.path.endsWith("/comment"));
      expect(firstPage?.params.get("orderBy")).toBe("-created");

      const older = yield* api.getComments({ ...target, key: "PROJ-7", cursor: "50" });
      expect(older.comments.map((entry) => entry.id)).toEqual([
        "10",
        "9",
        "8",
        "7",
        "6",
        "5",
        "4",
        "3",
        "2",
        "1",
      ]);
      expect(older.nextCursor).toBeNull();
      expect(requests.at(-1)?.params.get("startAt")).toBe("50");
      const forged = yield* Effect.flip(
        api.getComments({ ...target, key: "PROJ-7", cursor: "abc" }),
      );
      expect(forged.reason).toBe("failed");

      // The site's field list is read once, not with every issue.
      yield* api.getIssue({ ...target, key: "PROJ-7" });
      expect(requests.filter((request) => request.path.endsWith("/field"))).toHaveLength(1);

      for (const key of ["PROJ-8", "not a key"]) {
        const missing = yield* Effect.flip(api.getIssue({ ...target, key }));
        expect(missing.reason, key).toBe("not-found");
      }
    }),
  );

  it.effect("moves an issue through the transition that reaches the named status", () =>
    Effect.gen(function* () {
      const moves: unknown[] = [];
      const routes = {
        "GET /rest/api/3/issue/PROJ-7": () => issue("PROJ-7"),
        "GET /rest/api/3/issue/OPS-3": () => issue("OPS-3"),
        "GET /rest/api/3/issue/PROJ-7/transitions": () => ({
          transitions: [
            { id: "11", name: "Stop", to: status("To Do", "new") },
            { id: "31", name: "Resolve", to: status("Done", "done") },
            { id: "41", name: "Close", to: status("Done", "done") },
          ],
        }),
        "POST /rest/api/3/issue/PROJ-7/transitions": ({ body }: SentRequest) => {
          moves.push(body);
        },
      };
      const api = yield* fakeJira(routes).tracker;
      yield* api.setState({ ...target, key: "PROJ-7", state: "Done" });
      yield* api.setState({ ...target, key: "PROJ-7", state: "to do" });
      // Already there: nothing to move.
      yield* api.setState({ ...target, key: "PROJ-7", state: "In Progress" });
      expect(moves).toEqual([{ transition: { id: "31" } }, { transition: { id: "11" } }]);

      const unoffered = yield* Effect.flip(
        api.setState({ ...target, key: "PROJ-7", state: "closed" }),
      );
      expect(unoffered.detail).toBe('Jira offers no move to "closed" for PROJ-7 right now.');
      // A key from another project resolves in Jira, so the project is checked before writing.
      const foreign = yield* Effect.flip(api.setState({ ...target, key: "OPS-3", state: "Done" }));
      expect(foreign.detail).toBe("OPS-3 belongs to Jira project OPS, not PROJ.");
      expect(moves).toHaveLength(2);

      const disconnected = yield* Effect.flip(
        (yield* fakeJira(routes, null).tracker).setState({
          ...target,
          key: "PROJ-7",
          state: "Done",
        }),
      );
      expect([disconnected.reason, disconnected.detail]).toEqual([
        "unauthenticated",
        "Jira is not connected on this server.",
      ]);
    }),
  );

  it.effect("comments as rich text, and only on the bound project's issues", () =>
    Effect.gen(function* () {
      const posted: unknown[] = [];
      const api = yield* fakeJira({
        "GET /rest/api/3/issue/PROJ-7": () => issue("PROJ-7"),
        "GET /rest/api/3/issue/OPS-3": () => issue("OPS-3"),
        "POST /rest/api/3/issue/PROJ-7/comment": ({ body }) => {
          posted.push(body);
          return comment(61);
        },
      }).tracker;
      yield* api.comment({
        ...target,
        key: "PROJ-7",
        body: "Fixed in https://github.com/acme/web/pull/12.\nThanks",
      });
      expect(posted).toEqual([
        {
          body: {
            version: 1,
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "Fixed in " },
                  {
                    type: "text",
                    text: "https://github.com/acme/web/pull/12",
                    marks: [
                      { type: "link", attrs: { href: "https://github.com/acme/web/pull/12" } },
                    ],
                  },
                  { type: "text", text: "." },
                  { type: "hardBreak" },
                  { type: "text", text: "Thanks" },
                ],
              },
            ],
          },
        },
      ]);
      const foreign = yield* Effect.flip(api.comment({ ...target, key: "OPS-3", body: "hi" }));
      expect(foreign.detail).toContain("belongs to Jira project OPS");
      expect(posted).toHaveLength(1);
    }),
  );

  it.effect(
    "vets a credential against its own site and names the site and account it reached",
    () =>
      Effect.gen(function* () {
        const { tracker, requests } = fakeJira(
          {
            "GET /rest/api/3/myself": ({ authorization }) =>
              authorization === `Basic ${btoa("lee@example.com:new-token")}`
                ? { ...user("acc-lee", "Lee Park"), emailAddress: "lee@example.com" }
                : Response.json({}, { status: 401 }),
            "GET /rest/api/3/project/search": ({ params }) =>
              params.get("startAt") === "0"
                ? { values: [{ key: "PROJ", name: "Platform" }], isLast: false }
                : { values: [{ key: "OPS", name: " " }], isLast: true },
          },
          // The stored credential is another site's; a new one is tried before it replaces it.
          JSON.stringify({
            site: "https://old.atlassian.net",
            email: "sam@example.com",
            token: "tok",
          }),
        );
        const api = yield* tracker;
        const probe = yield* api.probeCredential(
          JSON.stringify({
            site: "acme.atlassian.net",
            email: "lee@example.com",
            token: "new-token",
          }),
        );
        expect(probe).toEqual({
          account: "lee@example.com on acme.atlassian.net",
          workspace: "acme.atlassian.net",
          scopes: [
            { key: "PROJ", name: "Platform" },
            { key: "OPS", name: "OPS" },
          ],
        });
        expect(requests.every((request) => request.path.startsWith(`${SITE}/rest/api/3/`))).toBe(
          true,
        );
        expect(
          requests
            .find((request) => request.path.endsWith("/project/search"))
            ?.params.get("action"),
        ).toBe("browse");

        const rejected = yield* Effect.flip(
          api.probeCredential(
            JSON.stringify({ site: SITE, email: "lee@example.com", token: "stale" }),
          ),
        );
        expect([rejected.reason, rejected.detail]).toEqual([
          "unauthenticated",
          expect.stringContaining("created without scopes"),
        ]);
        // What a client that draws no fields sends, which never reaches Jira.
        const sent = requests.length;
        const alone = yield* Effect.flip(api.probeCredential("new-token"));
        expect(alone.detail).toContain("only a token arrived");
        expect(requests.length).toBe(sent);
      }),
  );

  it.effect("reports Jira's refusals as the tracker's own failures", () =>
    Effect.gen(function* () {
      const refusing = (response: () => Response) =>
        fakeJira({ "POST /rest/api/3/search/jql": response }).tracker.pipe(
          Effect.flatMap((api) => Effect.flip(api.listIssues(listing))),
        );
      const limited = yield* refusing(
        () => new Response("{}", { status: 429, headers: { "retry-after": "30" } }),
      );
      // The test clock starts at zero, so the retry time is the delay itself.
      expect([limited.reason, limited.retryAt]).toEqual(["rate-limited", 30_000]);
      const captcha = yield* refusing(
        () =>
          new Response("{}", {
            status: 403,
            headers: { "x-seraph-loginreason": "AUTHENTICATION_DENIED" },
          }),
      );
      expect(captcha.reason).toBe("unauthenticated");
      const syntax = yield* refusing(() =>
        Response.json(
          {
            errorMessages: [],
            errors: { jql: "The value 'PROJ' does not exist for the field 'project'." },
          },
          { status: 400 },
        ),
      );
      expect([syntax.reason, syntax.detail]).toEqual([
        "failed",
        "The value 'PROJ' does not exist for the field 'project'.",
      ]);
      const broken = yield* refusing(() => new Response("<html>", { status: 502 }));
      expect(broken.detail).toBe("Jira answered HTTP 502.");

      const unreachable = JiraIssueTracker.make.pipe(
        Effect.provide(
          JiraApi.layer.pipe(
            Layer.provide(
              Layer.merge(
                Layer.succeed(
                  HttpClient.HttpClient,
                  HttpClient.make((request) =>
                    Effect.fail(
                      new HttpClientError.HttpClientError({
                        reason: new HttpClientError.TransportError({ request }),
                      }),
                    ),
                  ),
                ),
                Layer.succeed(
                  IssueTrackerHost.IssueTrackerHost,
                  IssueTrackerHost.IssueTrackerHost.of({
                    credentials: { get: () => Effect.succeedSome(STORED) },
                  }),
                ),
              ),
            ),
          ),
        ),
      );
      const offline = yield* Effect.flip((yield* unreachable).listIssues(listing));
      expect([offline.reason, offline.detail]).toEqual([
        "failed",
        "Jira could not be reached at acme.atlassian.net.",
      ]);
    }),
  );
});
