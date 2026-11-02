import { describe, expect, it } from "vite-plus/test";

import { jiraConnectionSummary } from "./jiraConnectionSummary";

const saved = { configured: true, siteUrl: "https://acme.atlassian.net", email: "sam@example.com" };

describe("jiraConnectionSummary", () => {
  it("reports no connection when nothing is saved", () => {
    expect(
      jiraConnectionSummary({ saved: { configured: false }, account: null, error: null }),
    ).toEqual({
      configured: false,
      message: "Not connected.",
    });
    expect(jiraConnectionSummary({ saved: null, account: null, error: null })).toEqual({
      configured: false,
      message: "Not connected.",
    });
  });

  it("names the account Jira confirmed", () => {
    expect(
      jiraConnectionSummary({
        saved,
        account: { accountId: "a", displayName: "Sam Rivera" },
        error: null,
      }),
    ).toEqual({ configured: true, message: "Connected as Sam Rivera." });
  });

  it("still counts saved credentials Jira refuses, and says why, so they can be removed", () => {
    expect(
      jiraConnectionSummary({
        saved,
        account: null,
        error: "Jira did not accept the email and API token (HTTP 401).",
      }),
    ).toEqual({
      configured: true,
      message:
        "Saved, but Jira did not confirm it: Jira did not accept the email and API token (HTTP 401).",
    });
  });

  it("says the check is running while Jira has not answered yet", () => {
    expect(jiraConnectionSummary({ saved, account: null, error: null })).toEqual({
      configured: true,
      message: "Checking with Jira...",
    });
  });
});
