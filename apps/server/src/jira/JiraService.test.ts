import { assert, it, vi } from "@effect/vitest";
import {
  JiraNotFoundError,
  JiraRateLimitedError,
  JiraAuthFailedError,
  JiraRequestError,
  type JiraIssueSummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as JiraClient from "./JiraClient.ts";
import * as JiraCredentials from "./JiraCredentials.ts";
import * as JiraService from "./JiraService.ts";
import { plainTextToAdf } from "./jiraAdf.ts";

const saved: JiraClient.JiraCredential = {
  siteUrl: "https://acme.atlassian.net",
  email: "sam@example.com",
  apiToken: Redacted.make("token-123"),
};

const issue = (key: string, status = "To Do"): JiraIssueSummary => ({
  key,
  summary: `Summary of ${key}`,
  url: `https://acme.atlassian.net/browse/${key}`,
  status: { name: status, category: status === "To Do" ? "todo" : "in-progress" },
  issueType: "Task",
  priority: null,
  assignee: null,
  projectKey: key.slice(0, key.lastIndexOf("-")),
  projectName: "Platform",
  updatedAt: "2026-11-01T09:30:00.000+0000",
});

const die = (name: string) => () => Effect.die(`${name} was not expected`);

const fakeClient = (partial: Partial<JiraClient.JiraClient["Service"]>) =>
  JiraClient.JiraClient.of({
    myself: die("myself"),
    listProjects: die("listProjects"),
    listAcceptanceCriteriaFields: () => Effect.succeed([]),
    searchIssues: die("searchIssues"),
    getIssue: die("getIssue"),
    getIssueSummary: die("getIssueSummary"),
    listTransitions: die("listTransitions"),
    transition: die("transition"),
    addComment: die("addComment"),
    ...partial,
  });

const memoryCredentials = (initial: Option.Option<JiraClient.JiraCredential>) =>
  Layer.effect(
    JiraCredentials.JiraCredentials,
    Effect.gen(function* () {
      const ref = yield* Ref.make(initial);
      return JiraCredentials.JiraCredentials.of({
        get: Ref.get(ref),
        set: (credential) => Ref.set(ref, Option.some(credential)),
        clear: Ref.set(ref, Option.none()),
      });
    }),
  );

const serviceLayer = (
  client: JiraClient.JiraClient["Service"],
  credentials: Option.Option<JiraClient.JiraCredential> = Option.some(saved),
) =>
  JiraService.layer.pipe(
    Layer.provide(Layer.succeed(JiraClient.JiraClient, client)),
    Layer.provide(memoryCredentials(credentials)),
  );

const page = (...issues: ReadonlyArray<JiraIssueSummary>) => ({ issues, nextPageToken: null });

it.effect("answers a repeated search from memory for 30 seconds, then asks Jira again", () => {
  const searchIssues = vi.fn(
    (_credential: JiraClient.JiraCredential, _request: JiraClient.JiraSearchRequest) =>
      Effect.succeed(page(issue("PROJ-1"))),
  );
  return Effect.gen(function* () {
    const jira = yield* JiraService.JiraService;
    const first = yield* jira.search({ preset: "assigned" });
    yield* jira.search({ preset: "assigned" });
    assert.strictEqual(searchIssues.mock.calls.length, 1);
    assert.strictEqual(
      first.jql,
      "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC",
    );
    assert.deepStrictEqual(searchIssues.mock.calls[0]?.[1], { jql: first.jql, pageSize: 50 });
    yield* jira.search({ preset: "recent" });
    assert.strictEqual(searchIssues.mock.calls.length, 2);
    yield* TestClock.adjust("31 seconds");
    yield* jira.search({ preset: "assigned" });
    assert.strictEqual(searchIssues.mock.calls.length, 3);
  }).pipe(Effect.provide(serviceLayer(fakeClient({ searchIssues }))));
});

it.effect("never keeps a failure, so the next ask reaches Jira again", () => {
  let calls = 0;
  const searchIssues = vi.fn(() =>
    ++calls === 1
      ? Effect.fail(new JiraRateLimitedError({ retryAfterSeconds: 5 }))
      : Effect.succeed(page(issue("PROJ-1"))),
  );
  return Effect.gen(function* () {
    const jira = yield* JiraService.JiraService;
    const error = yield* jira.search({ preset: "assigned" }).pipe(Effect.flip);
    assert.strictEqual(error._tag, "JiraRateLimitedError");
    const result = yield* jira.search({ preset: "assigned" });
    assert.strictEqual(result.issues.length, 1);
  }).pipe(Effect.provide(serviceLayer(fakeClient({ searchIssues }))));
});

it.effect("asks for a JQL query instead of sending an unbounded one", () =>
  Effect.gen(function* () {
    const jira = yield* JiraService.JiraService;
    const error = yield* jira.search({ preset: "custom", jql: "  " }).pipe(Effect.flip);
    assert.instanceOf(error, JiraRequestError);
    assert.strictEqual(
      error._tag === "JiraRequestError" ? error.detail : "",
      "Enter a JQL query to search with.",
    );
  }).pipe(Effect.provide(serviceLayer(fakeClient({})))),
);

it.effect("reports a missing setup as not configured and Jira as not asked", () =>
  Effect.gen(function* () {
    const jira = yield* JiraService.JiraService;
    assert.deepStrictEqual(yield* jira.status({}), { configured: false });
    const error = yield* jira.getIssue({ key: "PROJ-1" }).pipe(Effect.flip);
    assert.strictEqual(error._tag, "JiraNotConfiguredError");
  }).pipe(Effect.provide(serviceLayer(fakeClient({}), Option.none()))),
);

it.effect("checks the saved account only when asked, and remembers it for five minutes", () => {
  const myself = vi.fn(() => Effect.succeed({ accountId: "acc-1", displayName: "Sam Rivera" }));
  return Effect.gen(function* () {
    const jira = yield* JiraService.JiraService;
    assert.deepStrictEqual(yield* jira.status({}), {
      configured: true,
      siteUrl: "https://acme.atlassian.net",
      email: "sam@example.com",
    });
    assert.strictEqual(myself.mock.calls.length, 0);
    const verified = yield* jira.status({ verify: true });
    assert.deepStrictEqual(verified.account, { accountId: "acc-1", displayName: "Sam Rivera" });
    yield* jira.status({ verify: true });
    assert.strictEqual(myself.mock.calls.length, 1);
    yield* TestClock.adjust("6 minutes");
    yield* jira.status({ verify: true });
    assert.strictEqual(myself.mock.calls.length, 2);
  }).pipe(Effect.provide(serviceLayer(fakeClient({ myself }))));
});

it.effect(
  "saves credentials only after Jira accepts them, and reduces the site to its host",
  () => {
    const myself = vi.fn((_credential: JiraClient.JiraCredential) =>
      Effect.succeed({ accountId: "acc-1", displayName: "Sam Rivera" }),
    );
    return Effect.gen(function* () {
      const jira = yield* JiraService.JiraService;
      const status = yield* jira.configure({
        siteUrl: "acme.atlassian.net/jira/software/projects/PROJ",
        email: " sam@example.com ",
        apiToken: Redacted.make("token-456"),
      });
      assert.deepStrictEqual(status, {
        configured: true,
        siteUrl: "https://acme.atlassian.net",
        email: "sam@example.com",
        account: { accountId: "acc-1", displayName: "Sam Rivera" },
      });
      const credential = myself.mock.calls[0]![0];
      assert.strictEqual(credential.siteUrl, "https://acme.atlassian.net");
      assert.strictEqual(Redacted.value(credential.apiToken), "token-456");
      assert.strictEqual((yield* jira.status({})).configured, true);
    }).pipe(Effect.provide(serviceLayer(fakeClient({ myself }), Option.none())));
  },
);

it.effect(
  "saves nothing when Jira refuses the credentials or the input cannot be sent safely",
  () => {
    const myself = vi.fn(() => Effect.fail(new JiraAuthFailedError({ status: 401 })));
    return Effect.gen(function* () {
      const jira = yield* JiraService.JiraService;
      const input = { siteUrl: "https://acme.atlassian.net", email: "sam@example.com" };
      const refused = yield* jira
        .configure({ ...input, apiToken: Redacted.make("wrong") })
        .pipe(Effect.flip);
      assert.strictEqual(refused._tag, "JiraAuthFailedError");
      for (const bad of [
        { siteUrl: "http://acme.atlassian.net", apiToken: Redacted.make("ok") },
        { siteUrl: "https://user:pw@acme.atlassian.net", apiToken: Redacted.make("ok") },
        { siteUrl: "https://acme.atlassian.net", apiToken: Redacted.make("two\nlines") },
        { siteUrl: "https://acme.atlassian.net", apiToken: Redacted.make("tökén") },
      ]) {
        const error = yield* jira.configure({ ...input, ...bad }).pipe(Effect.flip);
        assert.strictEqual(error._tag, "JiraRequestError");
      }
      assert.strictEqual(myself.mock.calls.length, 1);
      assert.deepStrictEqual(yield* jira.status({}), { configured: false });
    }).pipe(Effect.provide(serviceLayer(fakeClient({ myself }), Option.none())));
  },
);

it.effect("disconnecting forgets the credentials and what was cached with them", () => {
  const getIssue = vi.fn(() => Effect.die("unexpected"));
  const searchIssues = vi.fn(() => Effect.succeed(page(issue("PROJ-1"))));
  return Effect.gen(function* () {
    const jira = yield* JiraService.JiraService;
    yield* jira.search({ preset: "assigned" });
    yield* jira.disconnect;
    const error = yield* jira.search({ preset: "assigned" }).pipe(Effect.flip);
    assert.strictEqual(error._tag, "JiraNotConfiguredError");
    assert.deepStrictEqual(yield* jira.status({}), { configured: false });
  }).pipe(Effect.provide(serviceLayer(fakeClient({ getIssue, searchIssues }))));
});

it.effect("moving an issue refreshes what lists, chips and the detail knew about it", () => {
  let status = "To Do";
  const getIssue = vi.fn(() =>
    Effect.succeed({
      ...issue("PROJ-1", status),
      reporter: null,
      createdAt: "",
      labels: [],
      descriptionMarkdown: "",
      comments: [],
      commentCount: 0,
    }),
  );
  const searchIssues = vi.fn(() => Effect.succeed(page(issue("PROJ-1", status))));
  const getIssueSummary = vi.fn(() => Effect.succeed(issue("PROJ-1", status)));
  const transition = vi.fn(() => {
    status = "In Review";
    return Effect.void;
  });
  return Effect.gen(function* () {
    const jira = yield* JiraService.JiraService;
    assert.strictEqual(
      (yield* jira.search({ preset: "assigned" })).issues[0]?.status.name,
      "To Do",
    );
    assert.strictEqual((yield* jira.getIssue({ key: "PROJ-1" })).status.name, "To Do");
    assert.strictEqual(
      (yield* jira.lookupIssues({ keys: ["PROJ-1"] })).issues[0]?.status.name,
      "To Do",
    );

    const moved = yield* jira.transition({ key: "PROJ-1", transitionId: "31" });
    assert.strictEqual(moved.status.name, "In Review");
    assert.deepStrictEqual(transition.mock.calls[0]?.slice(1), ["PROJ-1", "31"]);

    assert.strictEqual(
      (yield* jira.search({ preset: "assigned" })).issues[0]?.status.name,
      "In Review",
    );
    assert.strictEqual((yield* jira.getIssue({ key: "PROJ-1" })).status.name, "In Review");
    assert.strictEqual(
      (yield* jira.lookupIssues({ keys: ["PROJ-1"] })).issues[0]?.status.name,
      "In Review",
    );
  }).pipe(
    Effect.provide(
      serviceLayer(fakeClient({ getIssue, getIssueSummary, searchIssues, transition })),
    ),
  );
});

it.effect("sends a comment as ADF and drops the cached detail so the new comment shows", () => {
  const getIssue = vi.fn(() =>
    Effect.succeed({
      ...issue("PROJ-1"),
      reporter: null,
      createdAt: "",
      labels: [],
      descriptionMarkdown: "",
      comments: [],
      commentCount: 0,
    }),
  );
  const addComment = vi.fn(() =>
    Effect.succeed({
      id: "9",
      author: null,
      createdAt: "",
      updatedAt: "",
      bodyMarkdown: "Linked",
    }),
  );
  return Effect.gen(function* () {
    const jira = yield* JiraService.JiraService;
    yield* jira.getIssue({ key: "PROJ-1" });
    yield* jira.getIssue({ key: "PROJ-1" });
    assert.strictEqual(getIssue.mock.calls.length, 1);
    const comment = yield* jira.addComment({
      key: "PROJ-1",
      body: "Linked\n\nhttps://example.com/pr/1",
    });
    assert.strictEqual(comment.id, "9");
    assert.deepStrictEqual(addComment.mock.calls[0]?.slice(1), [
      "PROJ-1",
      plainTextToAdf("Linked\n\nhttps://example.com/pr/1"),
    ]);
    yield* jira.getIssue({ key: "PROJ-1" });
    assert.strictEqual(getIssue.mock.calls.length, 2);
  }).pipe(Effect.provide(serviceLayer(fakeClient({ getIssue, addComment }))));
});

it.effect("looks keys up in sorted chunks of fifty, once each", () => {
  const searchIssues = vi.fn(
    (_credential: JiraClient.JiraCredential, request: JiraClient.JiraSearchRequest) =>
      Effect.succeed(
        page(...[...request.jql.matchAll(/"([A-Z]+-\d+)"/gu)].map((match) => issue(match[1]!))),
      ),
  );
  return Effect.gen(function* () {
    const jira = yield* JiraService.JiraService;
    const keys = Array.from({ length: 120 }, (_, index) => `PROJ-${index + 1}`);
    const result = yield* jira.lookupIssues({ keys: [...keys, ...keys.slice(0, 5)] });
    assert.strictEqual(result.issues.length, 120);
    assert.strictEqual(searchIssues.mock.calls.length, 3);
    assert.deepStrictEqual(
      searchIssues.mock.calls.map((call) => call[1].pageSize),
      [50, 50, 20],
    );
    yield* jira.lookupIssues({ keys: keys.toReversed() });
    assert.strictEqual(searchIssues.mock.calls.length, 3);
  }).pipe(Effect.provide(serviceLayer(fakeClient({ searchIssues }))));
});

it.effect("falls back to one lookup per key when Jira rejects the batch for an unknown key", () => {
  const searchIssues = vi.fn(() =>
    Effect.fail(
      new JiraRequestError({
        operation: "search",
        status: 400,
        detail: "An issue with key 'PROJ-9' does not exist for field 'key'.",
      }),
    ),
  );
  const getIssueSummary = vi.fn((_credential: JiraClient.JiraCredential, key: string) =>
    key === "PROJ-9" ? Effect.fail(new JiraNotFoundError({ key })) : Effect.succeed(issue(key)),
  );
  return Effect.gen(function* () {
    const jira = yield* JiraService.JiraService;
    const result = yield* jira.lookupIssues({ keys: ["PROJ-1", "PROJ-9", "PROJ-2"] });
    assert.deepStrictEqual(
      result.issues.map((found) => found.key),
      ["PROJ-1", "PROJ-2"],
    );
    assert.strictEqual(getIssueSummary.mock.calls.length, 3);
  }).pipe(Effect.provide(serviceLayer(fakeClient({ searchIssues, getIssueSummary }))));
});

it.effect("lists projects once for ten minutes", () => {
  const listProjects = vi.fn(() => Effect.succeed([{ key: "PROJ", name: "Platform" }]));
  return Effect.gen(function* () {
    const jira = yield* JiraService.JiraService;
    assert.deepStrictEqual(yield* jira.listProjects, {
      projects: [{ key: "PROJ", name: "Platform" }],
    });
    yield* jira.listProjects;
    assert.strictEqual(listProjects.mock.calls.length, 1);
    yield* TestClock.adjust("11 minutes");
    yield* jira.listProjects;
    assert.strictEqual(listProjects.mock.calls.length, 2);
  }).pipe(Effect.provide(serviceLayer(fakeClient({ listProjects }))));
});

const detailOf = (key: string) => ({
  ...issue(key),
  reporter: null,
  createdAt: "",
  labels: [],
  descriptionMarkdown: "",
  comments: [],
  commentCount: 0,
});

it.effect(
  "reads the site's acceptance criteria fields along with each issue, finding them once",
  () => {
    const field = { id: "customfield_10050", name: "Acceptance Criteria" };
    const listAcceptanceCriteriaFields = vi.fn(() => Effect.succeed([field]));
    const getIssue = vi.fn(
      (
        _credential: JiraClient.JiraCredential,
        key: string,
        _fields: ReadonlyArray<{ readonly id: string; readonly name: string }>,
      ) => Effect.succeed(detailOf(key)),
    );
    return Effect.gen(function* () {
      const jira = yield* JiraService.JiraService;
      yield* jira.getIssue({ key: "PROJ-1" });
      yield* jira.getIssue({ key: "PROJ-2" });
      assert.deepStrictEqual(getIssue.mock.calls[0]?.[2], [field]);
      assert.deepStrictEqual(getIssue.mock.calls[1]?.[2], [field]);
      assert.strictEqual(listAcceptanceCriteriaFields.mock.calls.length, 1);
      yield* TestClock.adjust("11 minutes");
      yield* jira.getIssue({ key: "PROJ-3" });
      assert.strictEqual(listAcceptanceCriteriaFields.mock.calls.length, 2);
    }).pipe(Effect.provide(serviceLayer(fakeClient({ getIssue, listAcceptanceCriteriaFields }))));
  },
);

it.effect(
  "still shows an issue when the field list cannot be read, and asks again next time",
  () => {
    let calls = 0;
    const listAcceptanceCriteriaFields = vi.fn(() =>
      ++calls === 1
        ? Effect.fail(new JiraRequestError({ operation: "listFields", status: 500 }))
        : Effect.succeed([{ id: "customfield_10050", name: "Acceptance Criteria" }]),
    );
    const getIssue = vi.fn(
      (
        _credential: JiraClient.JiraCredential,
        key: string,
        _fields: ReadonlyArray<{ readonly id: string; readonly name: string }>,
      ) => Effect.succeed(detailOf(key)),
    );
    return Effect.gen(function* () {
      const jira = yield* JiraService.JiraService;
      assert.strictEqual((yield* jira.getIssue({ key: "PROJ-1" })).key, "PROJ-1");
      assert.deepStrictEqual(getIssue.mock.calls[0]?.[2], []);
      yield* jira.getIssue({ key: "PROJ-2" });
      assert.strictEqual(getIssue.mock.calls[1]?.[2].length, 1);
    }).pipe(Effect.provide(serviceLayer(fakeClient({ getIssue, listAcceptanceCriteriaFields }))));
  },
);

it.effect("follows the continuation token until a batch lookup has every issue", () => {
  const searchIssues = vi.fn(
    (_credential: JiraClient.JiraCredential, request: JiraClient.JiraSearchRequest) =>
      Effect.succeed(
        request.pageToken === undefined
          ? { issues: [issue("PROJ-1"), issue("PROJ-2")], nextPageToken: "t2" }
          : request.pageToken === "t2"
            ? { issues: [issue("PROJ-3")], nextPageToken: "t3" }
            : { issues: [issue("PROJ-4")], nextPageToken: null },
      ),
  );
  return Effect.gen(function* () {
    const jira = yield* JiraService.JiraService;
    const result = yield* jira.lookupIssues({ keys: ["PROJ-1", "PROJ-2", "PROJ-3", "PROJ-4"] });
    assert.deepStrictEqual(
      result.issues.map((found) => found.key),
      ["PROJ-1", "PROJ-2", "PROJ-3", "PROJ-4"],
    );
    assert.deepStrictEqual(
      searchIssues.mock.calls.map((call) => call[1].pageToken),
      [undefined, "t2", "t3"],
    );
  }).pipe(Effect.provide(serviceLayer(fakeClient({ searchIssues }))));
});

it.effect("stops following continuation tokens that never end", () => {
  const searchIssues = vi.fn(() =>
    Effect.succeed({ issues: [issue("PROJ-1")], nextPageToken: "again" }),
  );
  return Effect.gen(function* () {
    const jira = yield* JiraService.JiraService;
    const result = yield* jira.lookupIssues({ keys: ["PROJ-1"] });
    assert.deepStrictEqual(
      result.issues.map((found) => found.key),
      ["PROJ-1"],
    );
    assert.isAtMost(searchIssues.mock.calls.length, 20);
  }).pipe(Effect.provide(serviceLayer(fakeClient({ searchIssues }))));
});

it.effect("answers a move from the issue itself, and keeps its status over a lagging index", () => {
  const stale = (updatedAt: string, status: string) => ({ ...issue("PROJ-1", status), updatedAt });
  let indexed = stale("2026-11-01T09:30:00.000Z", "To Do");
  const searchIssues = vi.fn(() => Effect.succeed(page(indexed)));
  const getIssueSummary = vi.fn(() =>
    Effect.succeed(stale("2026-11-01T09:31:00.000Z", "In Review")),
  );
  const transition = vi.fn(() => Effect.void);
  return Effect.gen(function* () {
    const jira = yield* JiraService.JiraService;
    const moved = yield* jira.transition({ key: "PROJ-1", transitionId: "31" });
    assert.strictEqual(moved.status.name, "In Review");
    assert.strictEqual(getIssueSummary.mock.calls.length, 1);
    assert.strictEqual(searchIssues.mock.calls.length, 0);

    // The search index has not seen the move yet and still reports the old status.
    assert.strictEqual(
      (yield* jira.lookupIssues({ keys: ["PROJ-1"] })).issues[0]?.status.name,
      "In Review",
    );
    assert.strictEqual(
      (yield* jira.search({ preset: "assigned" })).issues[0]?.status.name,
      "In Review",
    );

    // Once the index catches up, what it says wins again.
    indexed = stale("2026-11-01T09:32:00.000Z", "Done");
    yield* jira.refresh;
    assert.strictEqual(
      (yield* jira.lookupIssues({ keys: ["PROJ-1"] })).issues[0]?.status.name,
      "Done",
    );
  }).pipe(Effect.provide(serviceLayer(fakeClient({ searchIssues, getIssueSummary, transition }))));
});

it.effect("forgets a move after two minutes, when the index has certainly caught up", () => {
  let indexed: JiraIssueSummary = {
    ...issue("PROJ-1", "To Do"),
    updatedAt: "2026-11-01T09:30:00.000Z",
  };
  const searchIssues = vi.fn(() => Effect.succeed(page(indexed)));
  const getIssueSummary = vi.fn(() =>
    Effect.succeed({ ...issue("PROJ-1", "In Review"), updatedAt: "2026-11-01T09:31:00.000Z" }),
  );
  return Effect.gen(function* () {
    const jira = yield* JiraService.JiraService;
    yield* jira.transition({ key: "PROJ-1", transitionId: "31" });
    yield* TestClock.adjust("3 minutes");
    assert.strictEqual(
      (yield* jira.lookupIssues({ keys: ["PROJ-1"] })).issues[0]?.status.name,
      "To Do",
    );
  }).pipe(
    Effect.provide(
      serviceLayer(fakeClient({ searchIssues, getIssueSummary, transition: () => Effect.void })),
    ),
  );
});

it.effect("refreshing drops everything kept, so the next ask reaches Jira", () => {
  const searchIssues = vi.fn(() => Effect.succeed(page(issue("PROJ-1"))));
  const listProjects = vi.fn(() => Effect.succeed([{ key: "PROJ", name: "Platform" }]));
  return Effect.gen(function* () {
    const jira = yield* JiraService.JiraService;
    yield* jira.search({ preset: "assigned" });
    yield* jira.lookupIssues({ keys: ["PROJ-1"] });
    yield* jira.listProjects;
    assert.strictEqual(searchIssues.mock.calls.length, 2);
    yield* jira.refresh;
    yield* jira.search({ preset: "assigned" });
    yield* jira.lookupIssues({ keys: ["PROJ-1"] });
    yield* jira.listProjects;
    assert.strictEqual(searchIssues.mock.calls.length, 4);
    assert.strictEqual(listProjects.mock.calls.length, 2);
  }).pipe(Effect.provide(serviceLayer(fakeClient({ searchIssues, listProjects }))));
});

it.effect("searches in the order the person chose", () => {
  const searchIssues = vi.fn(
    (_credential: JiraClient.JiraCredential, _request: JiraClient.JiraSearchRequest) =>
      Effect.succeed(page(issue("PROJ-1"))),
  );
  return Effect.gen(function* () {
    const jira = yield* JiraService.JiraService;
    const result = yield* jira.search({ preset: "assigned", sort: "priority" });
    assert.strictEqual(
      result.jql,
      "assignee = currentUser() AND resolution = Unresolved ORDER BY priority DESC, updated DESC",
    );
    assert.strictEqual(searchIssues.mock.calls[0]?.[1].jql, result.jql);
  }).pipe(Effect.provide(serviceLayer(fakeClient({ searchIssues }))));
});
