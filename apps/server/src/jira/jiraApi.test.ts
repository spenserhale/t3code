import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { RawIssue, acceptanceCriteriaFields, toIssueDetail } from "./jiraApi.ts";

const decodeIssue = Schema.decodeUnknownSync(RawIssue);

const adf = (...lines: ReadonlyArray<string>) => ({
  version: 1,
  type: "doc",
  content: lines.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })),
});

const issueWith = (fields: Record<string, unknown>) =>
  decodeIssue({
    key: "PROJ-12",
    fields: { summary: "Fix the login redirect", project: { key: "PROJ" }, ...fields },
  });

const SITE = "https://acme.atlassian.net";

describe("acceptanceCriteriaFields", () => {
  it("keeps the custom fields named like acceptance criteria", () => {
    assert.deepStrictEqual(
      acceptanceCriteriaFields([
        { id: "summary", name: "Summary" },
        { id: "customfield_10050", name: "Acceptance Criteria" },
        { id: "customfield_10051", name: "acceptance-criteria (draft)" },
        { id: "customfield_10052", name: "Acceptance criterion" },
        { id: "customfield_10060", name: "Story Points" },
        { id: "customfield_10061", name: "Acceptable losses" },
        { id: "description", name: "Acceptance criteria" },
        { id: "customfield_10062" },
      ]),
      [
        { id: "customfield_10050", name: "Acceptance Criteria" },
        { id: "customfield_10051", name: "acceptance-criteria (draft)" },
        { id: "customfield_10052", name: "Acceptance criterion" },
      ],
    );
  });

  it("lists a field once and stops at a handful", () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      id: `customfield_${index + 1}`,
      name: "Acceptance criteria",
    }));
    const found = acceptanceCriteriaFields([...many, ...many]);
    assert.strictEqual(found.length, 5);
    assert.strictEqual(new Set(found.map((field) => field.id)).size, 5);
  });
});

describe("toIssueDetail acceptance criteria", () => {
  const field = { id: "customfield_10050", name: "Acceptance Criteria" };

  it("keeps a custom field the schema does not name, and renders rich text", () => {
    const detail = toIssueDetail(
      issueWith({ customfield_10050: adf("Redirect returns to the page.", "Session survives.") }),
      SITE,
      [field],
    );
    assert.deepStrictEqual(detail?.acceptanceCriteria, [
      {
        name: "Acceptance Criteria",
        markdown: "Redirect returns to the page.\n\nSession survives.",
      },
    ]);
  });

  it("reads plain text and lists of text", () => {
    const detail = toIssueDetail(
      issueWith({
        customfield_10050: "  Given a session\nThen it stays  ",
        customfield_10051: ["Works on Safari", "  ", "Works on Firefox"],
      }),
      SITE,
      [field, { id: "customfield_10051", name: "Acceptance criteria (extra)" }],
    );
    assert.deepStrictEqual(detail?.acceptanceCriteria, [
      { name: "Acceptance Criteria", markdown: "Given a session\nThen it stays" },
      {
        name: "Acceptance criteria (extra)",
        markdown: "- Works on Safari\n- Works on Firefox",
      },
    ]);
  });

  it("leaves the key out when every field is empty or not text", () => {
    const empty = toIssueDetail(
      issueWith({
        customfield_10050: null,
        customfield_10051: { value: "Yes" },
        customfield_10052: "   ",
      }),
      SITE,
      [
        field,
        { id: "customfield_10051", name: "Acceptance criteria met" },
        { id: "customfield_10052", name: "Acceptance criteria 2" },
      ],
    );
    assert.strictEqual(empty !== null && "acceptanceCriteria" in empty, false);
    const none = toIssueDetail(issueWith({}), SITE, []);
    assert.strictEqual(none !== null && "acceptanceCriteria" in none, false);
  });
});
