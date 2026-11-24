import type { StandaloneIssueTrackerDescriptor } from "@t3tools/contracts";

/**
 * The connect token for a tracker: the secret alone, or, when the tracker asks for plain fields
 * too, one JSON object of their values by key with the secret under `token`. A blank field is
 * sent blank, so the tracker can say which one it needs.
 */
export function issueTrackerConnectToken(
  credential: StandaloneIssueTrackerDescriptor["credential"],
  values: Readonly<Record<string, string>>,
  secret: string,
): string {
  const fields = credential.fields ?? [];
  if (fields.length === 0) return secret;
  return JSON.stringify({
    ...Object.fromEntries(fields.map((field) => [field.key, values[field.key]?.trim() ?? ""])),
    token: secret,
  });
}
