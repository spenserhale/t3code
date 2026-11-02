import { describe, expect, it } from "vite-plus/test";

import { issueCommentDraft, issueThreadPrompt } from "./jiraThreadText";

const issue = {
  key: "PROJ-12",
  summary: " Fix the login redirect ",
  url: "https://acme.atlassian.net/browse/PROJ-12",
  descriptionMarkdown: "Users bounce back to login.",
};

describe("issueThreadPrompt", () => {
  it("opens with the key, summary and link, then the description, and leaves room to type", () => {
    expect(issueThreadPrompt(issue)).toBe(
      "Work on Jira issue PROJ-12: Fix the login redirect\n\nhttps://acme.atlassian.net/browse/PROJ-12\n\nDescription:\n\nUsers bounce back to login.\n\n",
    );
  });

  it("leaves the description out when there is none, and cuts a very long one", () => {
    expect(issueThreadPrompt({ ...issue, descriptionMarkdown: "  " })).not.toContain("Description");
    const long = issueThreadPrompt({ ...issue, descriptionMarkdown: "word ".repeat(5_000) });
    expect(long.length).toBeLessThan(6_500);
    expect(long).toContain("Description cut short");
  });
});

describe("issueCommentDraft", () => {
  it("lists each thread's title with the pull requests it opened", () => {
    expect(
      issueCommentDraft([
        {
          title: "PROJ-12: Fix login",
          pullRequestUrls: [
            "https://github.com/acme/app/pull/9",
            "https://github.com/acme/app/pull/10",
          ],
        },
        { title: "Follow-up", pullRequestUrls: [] },
      ]),
    ).toBe(
      "PROJ-12: Fix login\nPull request: https://github.com/acme/app/pull/9\nPull request: https://github.com/acme/app/pull/10\n\nFollow-up",
    );
  });
});
