import { assert, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as UrlParams from "effect/http/UrlParams";

import { plainTextToAdf } from "./jiraAdf.ts";
import * as JiraClient from "./JiraClient.ts";

const credential: JiraClient.JiraCredential = {
  siteUrl: "https://acme.atlassian.net",
  email: "sam@example.com",
  apiToken: Redacted.make("token-123"),
};

const rawIssue = (key: string, overrides: Record<string, unknown> = {}) => ({
  id: "10001",
  key,
  self: "https://acme.atlassian.net/rest/api/3/issue/10001",
  fields: {
    summary: "Fix the login redirect",
    status: { name: "In Progress", statusCategory: { key: "indeterminate", name: "In Progress" } },
    issuetype: { name: "Bug", iconUrl: "https://acme.atlassian.net/icon.png" },
    priority: { name: "High" },
    assignee: { accountId: "acc-1", displayName: "Sam Rivera", emailAddress: "sam@example.com" },
    project: { key: "PROJ", name: "Platform" },
    updated: "2026-11-01T09:30:00.000+0000",
    created: "2026-10-20T08:00:00.000+0000",
    ...overrides,
  },
});

function makeClient(respond: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const execute = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, respond(request))),
  );
  const layer = JiraClient.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => execute(request)),
      ),
    ),
  );
  const lastRequest = () => {
    const request = execute.mock.calls.at(-1)?.[0];
    assert.ok(request);
    return request;
  };
  const lastBody = () => {
    const raw = (lastRequest().body as { readonly body?: Uint8Array }).body;
    assert.ok(raw);
    return JSON.parse(new TextDecoder().decode(raw)) as unknown;
  };
  return { execute, layer, lastRequest, lastBody };
}

/** The address a request goes to, query parameters included. */
const addressOf = (request: HttpClientRequest.HttpClientRequest) => {
  const query = UrlParams.toString(request.urlParams);
  return query.length === 0 ? request.url : `${request.url}?${query}`;
};

const run = <A, E>(
  layer: Layer.Layer<JiraClient.JiraClient>,
  use: (client: JiraClient.JiraClient["Service"]) => Effect.Effect<A, E>,
) => JiraClient.JiraClient.pipe(Effect.flatMap(use), Effect.provide(layer));

it.effect("signs requests with Basic auth and reads the account behind them", () => {
  const { layer, lastRequest } = makeClient(() =>
    Response.json({
      accountId: "acc-1",
      displayName: "Sam Rivera",
      emailAddress: "sam@example.com",
    }),
  );
  return run(layer, (client) => client.myself(credential)).pipe(
    Effect.map((user) => {
      assert.deepStrictEqual(user, { accountId: "acc-1", displayName: "Sam Rivera" });
      const request = lastRequest();
      assert.strictEqual(request.url, "https://acme.atlassian.net/rest/api/3/myself");
      assert.strictEqual(request.method, "GET");
      assert.strictEqual(
        request.headers.authorization,
        `Basic ${btoa("sam@example.com:token-123")}`,
      );
      assert.strictEqual(request.headers.accept, "application/json");
    }),
  );
});

it.effect("searches with the enhanced JQL endpoint and maps issues to rows", () => {
  const { layer, lastRequest, lastBody } = makeClient(() =>
    Response.json({
      issues: [
        rawIssue("PROJ-12"),
        rawIssue("PROJ-13", { assignee: null, priority: null, status: null }),
        { id: "3", key: "not a key", fields: {} },
      ],
      nextPageToken: "next-1",
    }),
  );
  return run(layer, (client) =>
    client.searchIssues(credential, { jql: "project = PROJ", pageSize: 25, pageToken: "abc" }),
  ).pipe(
    Effect.map((page) => {
      const request = lastRequest();
      assert.strictEqual(request.url, "https://acme.atlassian.net/rest/api/3/search/jql");
      assert.strictEqual(request.method, "POST");
      assert.deepStrictEqual(lastBody(), {
        jql: "project = PROJ",
        fields: [
          "summary",
          "status",
          "issuetype",
          "priority",
          "assignee",
          "project",
          "updated",
          "created",
        ],
        maxResults: 25,
        nextPageToken: "abc",
      });
      assert.strictEqual(page.nextPageToken, "next-1");
      assert.deepStrictEqual(page.issues, [
        {
          key: "PROJ-12",
          summary: "Fix the login redirect",
          url: "https://acme.atlassian.net/browse/PROJ-12",
          status: { name: "In Progress", category: "in-progress" },
          issueType: "Bug",
          priority: "High",
          assignee: { accountId: "acc-1", displayName: "Sam Rivera" },
          projectKey: "PROJ",
          projectName: "Platform",
          updatedAt: "2026-11-01T09:30:00.000Z",
        },
        {
          key: "PROJ-13",
          summary: "Fix the login redirect",
          url: "https://acme.atlassian.net/browse/PROJ-13",
          status: { name: "Unknown", category: "unknown" },
          issueType: "Bug",
          priority: null,
          assignee: null,
          projectKey: "PROJ",
          projectName: "Platform",
          updatedAt: "2026-11-01T09:30:00.000Z",
        },
      ]);
    }),
  );
});

it.effect("reads an issue with its description and newest comments as Markdown", () => {
  const { layer, lastRequest } = makeClient(() =>
    Response.json(
      rawIssue("PROJ-12", {
        reporter: { accountId: "acc-2", displayName: "Alex Kim" },
        labels: ["auth", "web"],
        description: {
          version: 1,
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Users bounce back to login." }] },
          ],
        },
        comment: {
          total: 61,
          comments: [
            {
              id: "9001",
              author: { accountId: "acc-2", displayName: "Alex Kim" },
              body: {
                version: 1,
                type: "doc",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Reproduced." }] }],
              },
              created: "2026-10-21T10:00:00.000+0000",
              updated: "2026-10-21T10:05:00.000+0000",
            },
          ],
        },
      }),
    ),
  );
  return run(layer, (client) => client.getIssue(credential, "PROJ-12", [])).pipe(
    Effect.map((issue) => {
      assert.strictEqual(
        addressOf(lastRequest()),
        "https://acme.atlassian.net/rest/api/3/issue/PROJ-12?fields=summary%2Cstatus%2Cissuetype%2Cpriority%2Cassignee%2Cproject%2Cupdated%2Ccreated%2Creporter%2Clabels%2Cdescription%2Ccomment",
      );
      assert.strictEqual(issue.descriptionMarkdown, "Users bounce back to login.");
      assert.deepStrictEqual(issue.reporter, { accountId: "acc-2", displayName: "Alex Kim" });
      assert.deepStrictEqual(issue.labels, ["auth", "web"]);
      assert.strictEqual(issue.commentCount, 61);
      assert.deepStrictEqual(issue.comments, [
        {
          id: "9001",
          author: { accountId: "acc-2", displayName: "Alex Kim" },
          createdAt: "2026-10-21T10:00:00.000Z",
          updatedAt: "2026-10-21T10:05:00.000Z",
          bodyMarkdown: "Reproduced.",
        },
      ]);
    }),
  );
});

it.effect("finds the acceptance criteria fields among the site's fields", () => {
  const { layer, lastRequest } = makeClient(() =>
    Response.json([
      { id: "summary", name: "Summary", custom: false },
      { id: "customfield_10050", name: "Acceptance Criteria", custom: true },
      { id: "customfield_10060", name: "Story Points", custom: true },
    ]),
  );
  return run(layer, (client) => client.listAcceptanceCriteriaFields(credential)).pipe(
    Effect.map((fields) => {
      assert.strictEqual(addressOf(lastRequest()), "https://acme.atlassian.net/rest/api/3/field");
      assert.deepStrictEqual(fields, [{ id: "customfield_10050", name: "Acceptance Criteria" }]);
    }),
  );
});

it.effect("asks for the acceptance criteria fields it is given and reads them as Markdown", () => {
  const { layer, lastRequest } = makeClient(() =>
    Response.json(
      rawIssue("PROJ-12", {
        customfield_10050: {
          version: 1,
          type: "doc",
          content: [
            {
              type: "bulletList",
              content: [
                {
                  type: "listItem",
                  content: [
                    { type: "paragraph", content: [{ type: "text", text: "Redirect works." }] },
                  ],
                },
              ],
            },
          ],
        },
      }),
    ),
  );
  return run(layer, (client) =>
    client.getIssue(credential, "PROJ-12", [
      { id: "customfield_10050", name: "Acceptance Criteria" },
    ]),
  ).pipe(
    Effect.map((issue) => {
      assert.strictEqual(
        addressOf(lastRequest()),
        "https://acme.atlassian.net/rest/api/3/issue/PROJ-12?fields=summary%2Cstatus%2Cissuetype%2Cpriority%2Cassignee%2Cproject%2Cupdated%2Ccreated%2Creporter%2Clabels%2Cdescription%2Ccomment%2Ccustomfield_10050",
      );
      assert.deepStrictEqual(issue.acceptanceCriteria, [
        { name: "Acceptance Criteria", markdown: "- Redirect works." },
      ]);
    }),
  );
});

it.effect("lists only the transitions that are available and posts the chosen one", () => {
  const { layer, lastRequest, lastBody } = makeClient((request) =>
    request.method === "GET"
      ? Response.json({
          transitions: [
            {
              id: "31",
              name: "Start review",
              isAvailable: true,
              to: { name: "In Review", statusCategory: { key: "indeterminate" } },
            },
            {
              id: "41",
              name: "Done",
              isAvailable: false,
              to: { name: "Done", statusCategory: { key: "done" } },
            },
            { id: "51", name: "Close", to: { name: "Closed", statusCategory: { key: "done" } } },
          ],
        })
      : new Response(null, { status: 204 }),
  );
  return Effect.gen(function* () {
    const client = yield* JiraClient.JiraClient;
    const transitions = yield* client.listTransitions(credential, "PROJ-12");
    assert.strictEqual(
      lastRequest().url,
      "https://acme.atlassian.net/rest/api/3/issue/PROJ-12/transitions",
    );
    assert.deepStrictEqual(transitions, [
      { id: "31", name: "Start review", to: { name: "In Review", category: "in-progress" } },
      { id: "51", name: "Close", to: { name: "Closed", category: "done" } },
    ]);
    yield* client.transition(credential, "PROJ-12", "31");
    assert.strictEqual(lastRequest().method, "POST");
    assert.deepStrictEqual(lastBody(), { transition: { id: "31" } });
  }).pipe(Effect.provide(layer));
});

it.effect("sends a comment as an ADF document and reads the created comment back", () => {
  const { layer, lastRequest, lastBody } = makeClient(() =>
    Response.json(
      {
        id: "9002",
        author: { accountId: "acc-1", displayName: "Sam Rivera" },
        body: plainTextToAdf("PR: https://github.com/acme/app/pull/9"),
        created: "2026-11-02T08:00:00.000+0000",
        updated: "2026-11-02T08:00:00.000+0000",
      },
      { status: 201 },
    ),
  );
  return run(layer, (client) =>
    client.addComment(
      credential,
      "PROJ-12",
      plainTextToAdf("PR: https://github.com/acme/app/pull/9"),
    ),
  ).pipe(
    Effect.map((comment) => {
      assert.strictEqual(
        lastRequest().url,
        "https://acme.atlassian.net/rest/api/3/issue/PROJ-12/comment",
      );
      assert.deepStrictEqual(lastBody(), {
        body: plainTextToAdf("PR: https://github.com/acme/app/pull/9"),
      });
      assert.strictEqual(comment.id, "9002");
      assert.strictEqual(
        comment.bodyMarkdown,
        "PR: [https://github.com/acme/app/pull/9](https://github.com/acme/app/pull/9)",
      );
    }),
  );
});

it.effect("pages through every project", () => {
  const { layer, execute } = makeClient((request) =>
    UrlParams.toRecord(request.urlParams).startAt === "0"
      ? Response.json({
          values: [{ key: "AAA", name: "Alpha" }, { key: "BBB" }],
          isLast: false,
        })
      : Response.json({ values: [{ key: "CCC", name: "Gamma" }], isLast: true }),
  );
  return run(layer, (client) => client.listProjects(credential)).pipe(
    Effect.map((projects) => {
      assert.deepStrictEqual(projects, [
        { key: "AAA", name: "Alpha" },
        { key: "BBB", name: "BBB" },
        { key: "CCC", name: "Gamma" },
      ]);
      assert.strictEqual(UrlParams.toRecord(execute.mock.calls[1]![0].urlParams).startAt, "2");
    }),
  );
});

it.effect.each([
  { status: 401, headers: {}, tag: "JiraAuthFailedError" },
  { status: 404, headers: {}, tag: "JiraNotFoundError" },
  { status: 429, headers: { "retry-after": "30" }, tag: "JiraRateLimitedError" },
  { status: 400, headers: {}, tag: "JiraRequestError" },
  { status: 500, headers: {}, tag: "JiraRequestError" },
])("maps an HTTP $status answer to a typed error", ({ status, headers, tag }) => {
  const { layer } = makeClient(
    () => new Response(JSON.stringify({ errorMessages: ["nope"] }), { status, headers }),
  );
  return run(layer, (client) => client.getIssue(credential, "PROJ-12", [])).pipe(
    Effect.flip,
    Effect.map((error) => {
      assert.strictEqual(error._tag, tag);
      if (error._tag === "JiraNotFoundError") assert.strictEqual(error.key, "PROJ-12");
      if (error._tag === "JiraRateLimitedError") assert.strictEqual(error.retryAfterSeconds, 30);
      if (error._tag === "JiraRequestError") {
        assert.strictEqual(error.status, status);
        assert.strictEqual(error.operation, "getIssue");
      }
    }),
  );
});

it.effect(
  "passes Jira's explanation of a refused query on, and keeps raw bodies out of errors",
  () => {
    const { layer } = makeClient(
      () =>
        new Response(
          JSON.stringify({
            errorMessages: ["Error in the JQL Query: Expecting ')' before the end of the query."],
            errors: {},
          }),
          { status: 400 },
        ),
    );
    return run(layer, (client) => client.searchIssues(credential, { jql: "(", pageSize: 10 })).pipe(
      Effect.flip,
      Effect.map((error) => {
        assert.strictEqual(error._tag, "JiraRequestError");
        if (error._tag !== "JiraRequestError") return;
        assert.strictEqual(
          error.detail,
          "Error in the JQL Query: Expecting ')' before the end of the query.",
        );
        assert.notInclude(error.message, "token-123");
      }),
    );
  },
);

it.effect(
  "treats a login throttle on a 403 as bad credentials, but a missing permission as a refusal",
  () => {
    const { layer } = makeClient((request) =>
      request.url.endsWith("/myself")
        ? new Response("{}", {
            status: 403,
            headers: { "x-seraph-loginreason": "AUTHENTICATION_DENIED" },
          })
        : new Response(
            JSON.stringify({ errorMessages: ["You do not have permission to comment."] }),
            {
              status: 403,
            },
          ),
    );
    return Effect.gen(function* () {
      const client = yield* JiraClient.JiraClient;
      const denied = yield* client.myself(credential).pipe(Effect.flip);
      assert.strictEqual(denied._tag, "JiraAuthFailedError");
      const refused = yield* client
        .addComment(credential, "PROJ-12", plainTextToAdf("hi"))
        .pipe(Effect.flip);
      assert.strictEqual(refused._tag, "JiraRequestError");
      if (refused._tag === "JiraRequestError") {
        assert.strictEqual(refused.status, 403);
        assert.strictEqual(refused.detail, "You do not have permission to comment.");
      }
    }).pipe(Effect.provide(layer));
  },
);

it.effect("reports a transport failure without a status", () => {
  const layer = JiraClient.layer.pipe(
    Layer.provide(
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
    ),
  );
  return run(layer, (client) => client.myself(credential)).pipe(
    Effect.flip,
    Effect.map((error) => {
      assert.strictEqual(error._tag, "JiraRequestError");
      if (error._tag === "JiraRequestError") {
        assert.strictEqual(error.status, undefined);
        assert.strictEqual(error.operation, "verifyAccount");
      }
    }),
  );
});

it.effect("reports an answer it cannot read as a request error with the status", () => {
  const { layer } = makeClient(() => Response.json({ unexpected: true }));
  return run(layer, (client) =>
    client.searchIssues(credential, { jql: "x = 1", pageSize: 5 }),
  ).pipe(
    Effect.flip,
    Effect.map((error) => {
      assert.strictEqual(error._tag, "JiraRequestError");
      if (error._tag === "JiraRequestError") assert.strictEqual(error.status, 200);
    }),
  );
});
