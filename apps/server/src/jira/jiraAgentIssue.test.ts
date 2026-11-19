import { assert, describe, it } from "@effect/vitest";
import type { JiraComment, JiraIssueDetail } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  JiraAgentIssue,
  shapeIssueForAgent,
  type JiraAgentIssueOptions,
} from "./jiraAgentIssue.ts";

const encodeAgentIssue = Schema.encodeSync(JiraAgentIssue);

const comment = (id: number, bodyMarkdown = `Comment ${id}.`): JiraComment => ({
  id: String(id),
  author: { accountId: "acct-1", displayName: "Sam" },
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-01T10:00:00.000Z",
  bodyMarkdown,
});

const issue = (overrides: Partial<JiraIssueDetail> = {}): JiraIssueDetail => ({
  key: "PROJ-1",
  summary: "Fix the login redirect",
  url: "https://acme.atlassian.net/browse/PROJ-1",
  status: { name: "To Do", category: "todo" },
  issueType: "Task",
  priority: null,
  assignee: null,
  projectKey: "PROJ",
  projectName: "Platform",
  updatedAt: "2026-11-01T09:30:00.000+0000",
  reporter: null,
  createdAt: "2026-10-30T09:30:00.000Z",
  labels: [],
  descriptionMarkdown: "Short.",
  comments: [],
  commentCount: 0,
  ...overrides,
});

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);

const withComments = (count: number, body?: string) =>
  issue({
    comments: range(1, count).map((id) => comment(id, body)),
    commentCount: count,
  });

describe("shapeIssueForAgent comments", () => {
  const thirty = withComments(30);

  it.each([
    { asked: undefined, ids: range(21, 30), hidden: 20 },
    { asked: 3, ids: [28, 29, 30], hidden: 27 },
    { asked: 0, ids: [], hidden: 30 },
    { asked: 50, ids: range(1, 30), hidden: 0 },
    { asked: 500, ids: range(1, 30), hidden: 0 },
  ])("returns the newest comments, oldest first, when $asked are asked for", (row) => {
    const shaped = shapeIssueForAgent(thirty, { comments: row.asked });
    assert.deepStrictEqual(
      shaped.comments.map(({ id }) => Number(id)),
      row.ids,
    );
    // The total stays, so the agent can tell that more exist.
    assert.strictEqual(shaped.commentCount, 30);
    if (row.hidden === 0) return assert.isUndefined(shaped.note);
    assert.include(
      shaped.note,
      `Not shown: ${row.hidden} ${row.ids.length > 0 ? "older " : ""}comments.`,
    );
    assert.include(shaped.note, "Pass `comments` or `maxChars` for more.");
  });

  it("counts the comments beyond the ones the issue holds, which asking cannot reach", () => {
    const shaped = shapeIssueForAgent(
      issue({ comments: range(1, 50).map((id) => comment(id)), commentCount: 80 }),
      { comments: 50 },
    );
    assert.strictEqual(shaped.comments.length, 50);
    assert.strictEqual(shaped.commentCount, 80);
    assert.strictEqual(shaped.note, "Not shown: 30 older comments.");
  });

  it("takes the newest comments that fit the text allowance when long ones are asked for", () => {
    const shaped = shapeIssueForAgent(withComments(50, "c".repeat(32_000)), { comments: 50 });
    assert.deepStrictEqual(
      shaped.comments.map(({ id }) => Number(id)),
      range(41, 50),
    );
    assert.isTrue(shaped.comments.every(({ truncated }) => truncated === true));
    assert.include(shaped.note, "Not shown: 40 older comments.");
  });
});

describe("shapeIssueForAgent text", () => {
  it("cuts each text at its cap, flags what it cut and says how to get more", () => {
    const shaped = shapeIssueForAgent(
      issue({
        descriptionMarkdown: "d".repeat(12_001),
        acceptanceCriteria: [
          { name: "Acceptance criteria", markdown: "a".repeat(4_001) },
          { name: "Edge cases", markdown: "Short." },
        ],
        comments: [comment(1, "c".repeat(4_001)), comment(2)],
        commentCount: 2,
      }),
    );
    assert.strictEqual(shaped.descriptionMarkdown, "d".repeat(12_000));
    assert.isTrue(shaped.descriptionTruncated);
    assert.deepStrictEqual(
      shaped.acceptanceCriteria?.map(({ markdown }) => markdown.length),
      [4_000, 6],
    );
    assert.deepStrictEqual(
      shaped.comments.map(({ bodyMarkdown }) => bodyMarkdown.length),
      [4_000, 10],
    );
    assert.isTrue(shaped.acceptanceCriteria?.[0]?.truncated);
    assert.notProperty(shaped.acceptanceCriteria?.[1] ?? {}, "truncated");
    assert.isTrue(shaped.comments[0]?.truncated);
    assert.notProperty(shaped.comments[1] ?? {}, "truncated");
    assert.strictEqual(
      shaped.note,
      "Cut short: the description, 1 comment body, 1 acceptance criterion. Pass `comments` or `maxChars` for more.",
    );
  });

  it("returns an issue that fits as it is, without a note", () => {
    const small = issue({ comments: [comment(1)], commentCount: 1 });
    assert.deepStrictEqual(shapeIssueForAgent(small), small);
  });

  it.each([
    { maxChars: undefined, comment: 4_000, description: 12_000 },
    { maxChars: 100, comment: 100, description: 300 },
    { maxChars: 8_000, comment: 8_000, description: 24_000 },
    { maxChars: 1_000_000, comment: 8_000, description: 24_000 },
  ])("keeps $comment and $description characters for maxChars $maxChars", (row) => {
    const shaped = shapeIssueForAgent(
      issue({
        descriptionMarkdown: "d".repeat(100_000),
        comments: [comment(1, "c".repeat(32_000))],
        commentCount: 1,
      }),
      { maxChars: row.maxChars },
    );
    assert.strictEqual(shaped.descriptionMarkdown.length, row.description);
    assert.strictEqual(shaped.comments[0]?.bodyMarkdown.length, row.comment);
  });

  it("does not end a cut text on half a surrogate pair", () => {
    const shaped = shapeIssueForAgent(
      issue({ comments: [comment(1, "a\u{1F600}b")], commentCount: 1 }),
      { maxChars: 2 },
    );
    assert.strictEqual(shaped.comments[0]?.bodyMarkdown, "a");
  });
});

describe("shapeIssueForAgent size", () => {
  const worstCase = issue({
    descriptionMarkdown: "d".repeat(100_000),
    acceptanceCriteria: range(1, 5).map((id) => ({
      name: `Acceptance criteria ${id}`,
      markdown: "a".repeat(100_000),
    })),
    comments: range(1, 50).map((id) => comment(id, "c".repeat(32_000))),
    commentCount: 50,
  });
  const bytes = (options: JiraAgentIssueOptions) =>
    Buffer.byteLength(JSON.stringify(encodeAgentIssue(shapeIssueForAgent(worstCase, options))));

  it.each([
    { options: {}, below: 100_000 },
    { options: { comments: 50 }, below: 100_000 },
    { options: { comments: 50, maxChars: 8_000 }, below: 160_000 },
  ])("keeps the worst-case issue below $below bytes for $options", (row) => {
    assert.isBelow(bytes(row.options), row.below);
  });
});
