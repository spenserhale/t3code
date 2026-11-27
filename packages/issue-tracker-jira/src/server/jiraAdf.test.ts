import { assert, describe, it } from "@effect/vitest";

import { adfToMarkdown, plainTextToAdf } from "./jiraAdf.ts";

describe("plainTextToAdf", () => {
  it("starts paragraphs at blank lines and keeps single line breaks", () => {
    assert.deepStrictEqual(plainTextToAdf("First line\nsecond line\n\n\nNext paragraph").content, [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "First line" },
          { type: "hardBreak" },
          { type: "text", text: "second line" },
        ],
      },
      { type: "paragraph", content: [{ type: "text", text: "Next paragraph" }] },
    ]);
  });

  it("links web addresses without their trailing punctuation", () => {
    const [paragraph] = plainTextToAdf(
      "Opened https://github.com/acme/app/pull/12. See (https://example.com/a?b=1).",
    ).content;
    assert.deepStrictEqual(paragraph?.content, [
      { type: "text", text: "Opened " },
      {
        type: "text",
        text: "https://github.com/acme/app/pull/12",
        marks: [{ type: "link", attrs: { href: "https://github.com/acme/app/pull/12" } }],
      },
      { type: "text", text: ". See (" },
      {
        type: "text",
        text: "https://example.com/a?b=1",
        marks: [{ type: "link", attrs: { href: "https://example.com/a?b=1" } }],
      },
      { type: "text", text: ")." },
    ]);
  });

  it("never produces an empty text node, which Jira rejects", () => {
    const json = JSON.stringify(plainTextToAdf("  \n\nhi\n   \nthere  \n\n"));
    assert.notInclude(json, '"text":""');
    assert.strictEqual(plainTextToAdf("   ").content.length, 0);
  });
});

describe("adfToMarkdown", () => {
  const text = (value: string, marks?: ReadonlyArray<Record<string, unknown>>) => ({
    type: "text",
    text: value,
    ...(marks === undefined ? {} : { marks }),
  });
  const paragraph = (...content: ReadonlyArray<unknown>) => ({ type: "paragraph", content });
  const doc = (...content: ReadonlyArray<unknown>) => ({ version: 1, type: "doc", content });

  it("renders text marks, links and escapes what Markdown would read as formatting", () => {
    assert.strictEqual(
      adfToMarkdown(
        doc(
          paragraph(
            text("Fix "),
            text("the login ", [{ type: "strong" }]),
            text("redirect", [{ type: "em" }]),
            text(" in "),
            text("auth.ts", [{ type: "code" }]),
            text(" see "),
            text("docs", [{ type: "link", attrs: { href: "https://example.com/docs" } }]),
            text(" snake_case *star*"),
          ),
        ),
      ),
      "Fix **the login** _redirect_ in `auth.ts` see [docs](https://example.com/docs) snake\\_case \\*star\\*",
    );
  });

  it("drops links that are not web or mail addresses", () => {
    assert.strictEqual(
      adfToMarkdown(
        doc(paragraph(text("click", [{ type: "link", attrs: { href: "javascript:alert(1)" } }]))),
      ),
      "click",
    );
  });

  it("renders headings, nested lists, code, quotes, rules and panels", () => {
    const markdown = adfToMarkdown(
      doc(
        { type: "heading", attrs: { level: 2 }, content: [text("Steps")] },
        {
          type: "orderedList",
          attrs: { order: 3 },
          content: [
            {
              type: "listItem",
              content: [
                paragraph(text("Open the app")),
                {
                  type: "bulletList",
                  content: [{ type: "listItem", content: [paragraph(text("on mobile"))] }],
                },
              ],
            },
            { type: "listItem", content: [paragraph(text("Sign in"))] },
          ],
        },
        { type: "codeBlock", attrs: { language: "ts" }, content: [text("const a = 1;")] },
        { type: "blockquote", content: [paragraph(text("quoted"))] },
        { type: "rule" },
        {
          type: "panel",
          attrs: { panelType: "warning" },
          content: [paragraph(text("careful"))],
        },
      ),
    );
    assert.strictEqual(
      markdown,
      [
        "## Steps",
        "3. Open the app\n   - on mobile\n4. Sign in",
        "```ts\nconst a = 1;\n```",
        "> quoted",
        "---",
        "> **Warning**\n>\n> careful",
      ].join("\n\n"),
    );
  });

  it("renders a table and keeps pipes in cells from breaking it", () => {
    assert.strictEqual(
      adfToMarkdown(
        doc({
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                { type: "tableHeader", content: [paragraph(text("Name"))] },
                { type: "tableHeader", content: [paragraph(text("Value"))] },
              ],
            },
            {
              type: "tableRow",
              content: [
                { type: "tableCell", content: [paragraph(text("a"))] },
                { type: "tableCell", content: [paragraph(text("x | y"))] },
              ],
            },
          ],
        }),
      ),
      "| Name | Value |\n| --- | --- |\n| a | x \\| y |",
    );
  });

  it("renders mentions, statuses, task lists and attachments, and skips what it cannot read", () => {
    assert.strictEqual(
      adfToMarkdown(
        doc(
          paragraph({ type: "mention", attrs: { id: "1", text: "@Sam" } }, text(" moved it to "), {
            type: "status",
            attrs: { text: "In Review", color: "blue" },
          }),
          {
            type: "taskList",
            content: [
              { type: "taskItem", attrs: { state: "DONE" }, content: [text("ship")] },
              { type: "taskItem", attrs: { state: "TODO" }, content: [text("verify")] },
            ],
          },
          { type: "mediaSingle", content: [{ type: "media", attrs: { id: "x" } }] },
          { type: "somethingNew", content: [paragraph(text("still readable"))] },
        ),
      ),
      "@Sam moved it to [In Review]\n\n- [x] ship\n- [ ] verify\n\n_[attachment]_\n\nstill readable",
    );
  });

  it("passes a plain string through and reads anything else as empty", () => {
    assert.strictEqual(adfToMarkdown("already text"), "already text");
    assert.strictEqual(adfToMarkdown(null), "");
    assert.strictEqual(adfToMarkdown({ no: "type" }), "");
    assert.strictEqual(adfToMarkdown(42), "");
  });
});
