import type { JiraStatus, JiraUser } from "@t3tools/contracts";

/**
 * What the Jira settings say about the saved connection. Whether credentials are saved does not
 * depend on Jira accepting them: a token that has expired is still saved, and still has to be
 * replaced or removed. A failed check is shown ahead of an account an earlier check confirmed,
 * which a query keeps holding after a refresh fails.
 */
export function jiraConnectionSummary(input: {
  readonly saved: JiraStatus | null;
  readonly account: JiraUser | null;
  readonly error: string | null;
}): { readonly configured: boolean; readonly message: string } {
  if (input.saved?.configured !== true) return { configured: false, message: "Not connected." };
  if (input.error !== null) {
    return {
      configured: true,
      message: `Saved, but Jira did not confirm it: ${input.error}`,
    };
  }
  if (input.account !== null) {
    return { configured: true, message: `Connected as ${input.account.displayName}.` };
  }
  return { configured: true, message: "Checking with Jira..." };
}
