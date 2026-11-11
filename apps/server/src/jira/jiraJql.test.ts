import { assert, describe, it } from "@effect/vitest";

import { buildJql, jqlForKeys, jqlQuote, splitOrderBy } from "./jiraJql.ts";

const query = (input: Parameters<typeof buildJql>[0]) => {
  const built = buildJql(input);
  assert.strictEqual(built._tag, "Query");
  return built._tag === "Query" ? built.jql : "";
};

describe("buildJql", () => {
  it.each([
    ["assigned", "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC"],
    ["sprint", "assignee = currentUser() AND sprint in openSprints() ORDER BY rank"],
    ["reported", "reporter = currentUser() ORDER BY created DESC"],
    ["recent", "updated >= -14d ORDER BY updated DESC"],
  ] as const)("builds the %s preset", (preset, expected) => {
    assert.strictEqual(query({ preset }), expected);
  });

  it("adds the project, status category and text filters before the ordering", () => {
    assert.strictEqual(
      query({
        preset: "assigned",
        projectKeys: ["proj", "OPS", "proj", "bad key", '"; DROP'],
        statusCategories: ["todo", "in-progress", "todo"],
        text: "login: redirect (broken)",
      }),
      '(assignee = currentUser() AND resolution = Unresolved) AND project in ("PROJ", "OPS") AND statusCategory in ("To Do", "In Progress") AND text ~ "login redirect broken" ORDER BY updated DESC',
    );
  });

  it("looks up a pasted issue key instead of searching text", () => {
    assert.strictEqual(
      query({ preset: "recent", text: " proj-123 " }),
      '(updated >= -14d) AND key = "PROJ-123" ORDER BY updated DESC',
    );
  });

  it("drops text that is only search syntax", () => {
    assert.strictEqual(
      query({ preset: "reported", text: "(*) ~ -" }),
      "reporter = currentUser() ORDER BY created DESC",
    );
  });

  it("keeps a custom query's own ordering and wraps it when filters follow", () => {
    assert.strictEqual(
      query({
        preset: "custom",
        jql: "project = A OR project = B order by priority DESC, created",
        statusCategories: ["done"],
      }),
      '(project = A OR project = B) AND statusCategory in ("Done") ORDER BY priority DESC, created',
    );
    assert.strictEqual(
      query({ preset: "custom", jql: "labels = urgent" }),
      "labels = urgent ORDER BY updated DESC",
    );
  });

  it("refuses an empty custom query, which Jira would reject as unbounded", () => {
    assert.deepStrictEqual(buildJql({ preset: "custom", jql: "  " }), {
      _tag: "EmptyCustomQuery",
    });
    assert.deepStrictEqual(buildJql({ preset: "custom", jql: "ORDER BY created" }), {
      _tag: "EmptyCustomQuery",
    });
    assert.strictEqual(
      query({ preset: "custom", jql: "", projectKeys: ["OPS"] }),
      'project in ("OPS") ORDER BY updated DESC',
    );
  });
});

describe("buildJql sorting", () => {
  it.each([
    ["updated", "ORDER BY updated DESC"],
    ["created", "ORDER BY created DESC"],
    ["priority", "ORDER BY priority DESC, updated DESC"],
    ["key", "ORDER BY key ASC"],
  ] as const)("orders by %s in place of the preset's own ordering", (sort, order) => {
    assert.strictEqual(
      query({ preset: "sprint", sort }),
      `assignee = currentUser() AND sprint in openSprints() ${order}`,
    );
  });

  it("replaces a custom query's ordering and keeps its conditions", () => {
    assert.strictEqual(
      query({
        preset: "custom",
        jql: "labels = urgent order by created",
        sort: "key",
        projectKeys: ["OPS"],
      }),
      '(labels = urgent) AND project in ("OPS") ORDER BY key ASC',
    );
  });

  it("leaves the ordering alone when no sort is chosen", () => {
    assert.strictEqual(
      query({ preset: "reported" }),
      "reporter = currentUser() ORDER BY created DESC",
    );
  });
});

describe("splitOrderBy", () => {
  it("does not split inside quoted text", () => {
    assert.deepStrictEqual(splitOrderBy('summary ~ "sort order by name" ORDER BY created'), {
      where: 'summary ~ "sort order by name"',
      orderBy: "created",
    });
    assert.deepStrictEqual(splitOrderBy("summary ~ 'a \\' order by b'"), {
      where: "summary ~ 'a \\' order by b'",
      orderBy: "",
    });
  });
});

describe("jqlQuote", () => {
  it("escapes quotes and backslashes and drops control characters", () => {
    assert.strictEqual(jqlQuote('a "b" \\ c\nd'), '"a \\"b\\" \\\\ c d"');
  });

  it("lists keys for a lookup", () => {
    assert.strictEqual(jqlForKeys(["A-1", "B-22"]), 'key in ("A-1", "B-22")');
  });
});
