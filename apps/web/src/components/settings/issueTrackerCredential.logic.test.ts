import { describe, expect, it } from "vite-plus/test";

import { issueTrackerConnectToken } from "./issueTrackerCredential.logic.ts";

describe("issueTrackerConnectToken", () => {
  it("sends the secret alone to a tracker that asks for nothing else", () => {
    expect(issueTrackerConnectToken({ label: "API key", helpUrl: null }, {}, "lin_api_1")).toBe(
      "lin_api_1",
    );
    expect(
      issueTrackerConnectToken({ label: "API key", helpUrl: null, fields: [] }, { site: "x" }, "k"),
    ).toBe("k");
  });

  it("packs the fields a tracker asks for beside the secret, and nothing else", () => {
    const credential = {
      label: "Personal API token",
      helpUrl: null,
      fields: [
        { key: "site", label: "Site address" },
        { key: "email", label: "Account email" },
        // A field may not take the secret's place.
        { key: "token", label: "Not the secret" },
      ],
    };
    const token = issueTrackerConnectToken(
      credential,
      { site: " https://acme.atlassian.net ", token: "typed into a field", stray: "dropped" },
      "tok-123",
    );
    expect(JSON.parse(token)).toEqual({
      site: "https://acme.atlassian.net",
      // Left blank, so the tracker can say it needs an email.
      email: "",
      token: "tok-123",
    });
  });
});
