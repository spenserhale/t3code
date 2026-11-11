import { describe, expect, it } from "vite-plus/test";

import {
  issueAskPrompt,
  issueCommentDraft,
  issuePlanPrompt,
  issueThreadPrompt,
} from "./jiraThreadText";

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

const criteria = [{ name: "Acceptance Criteria", markdown: "- Redirect works.\n- Session stays." }];

describe("acceptance criteria in a prompt", () => {
  it("follow the description under the field's own name", () => {
    expect(issueThreadPrompt({ ...issue, acceptanceCriteria: criteria })).toBe(
      "Work on Jira issue PROJ-12: Fix the login redirect\n\nhttps://acme.atlassian.net/browse/PROJ-12\n\nDescription:\n\nUsers bounce back to login.\n\nAcceptance Criteria:\n\n- Redirect works.\n- Session stays.\n\n",
    );
  });

  it("stand alone when the description is empty, one section for each field", () => {
    const prompt = issueThreadPrompt({
      ...issue,
      descriptionMarkdown: "",
      acceptanceCriteria: [
        ...criteria,
        { name: "Acceptance criteria (QA)", markdown: "Smoke test." },
      ],
    });
    expect(prompt).not.toContain("Description");
    expect(prompt).toContain("Acceptance Criteria:\n\n- Redirect works.");
    expect(prompt).toContain("Acceptance criteria (QA):\n\nSmoke test.");
  });

  it("are cut when very long, without cutting the description", () => {
    const prompt = issueThreadPrompt({
      ...issue,
      acceptanceCriteria: [{ name: "Acceptance Criteria", markdown: "word ".repeat(5_000) }],
    });
    expect(prompt).toContain("Users bounce back to login.");
    expect(prompt).toContain("Acceptance Criteria cut short");
    expect(prompt.length).toBeLessThan(5_000);
  });
});

describe("issueAskPrompt", () => {
  it("gives the issue, asks for an answer only, and leaves room for the question", () => {
    expect(issueAskPrompt({ ...issue, acceptanceCriteria: criteria })).toBe(
      "Question about Jira issue PROJ-12: Fix the login redirect\n\nhttps://acme.atlassian.net/browse/PROJ-12\n\nDescription:\n\nUsers bounce back to login.\n\nAcceptance Criteria:\n\n- Redirect works.\n- Session stays.\n\nAnswer my question below. Do not change any code, and do not check anything out unless asked to.\n\nMy question:\n\n",
    );
  });
});

describe("issuePlanPrompt", () => {
  it("asks for a plan before any change", () => {
    expect(issuePlanPrompt(issue)).toBe(
      "Plan the work for Jira issue PROJ-12: Fix the login redirect\n\nhttps://acme.atlassian.net/browse/PROJ-12\n\nDescription:\n\nUsers bounce back to login.\n\nRead the code and write a plan for doing this. Do not change any code yet.\n\n",
    );
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
