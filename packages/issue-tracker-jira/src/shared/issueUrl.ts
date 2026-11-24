import { IssueTrackerKind } from "@t3tools/contracts";

export const JIRA_KIND = IssueTrackerKind.make("jira");
/**
 * The host every Jira issue reference carries. A site has a host of its own, but the service reads
 * a standalone tracker's host from its fixed descriptor, so the site travels as the workspace.
 */
export const JIRA_HOST = "atlassian.net";

const ISSUE_KEY = /^([A-Z][A-Z0-9_]*)-[1-9][0-9]*$/;
/** Board, backlog and list views name the open issue in their `selectedIssue` parameter. */
const SELECTED_ISSUE_PATHS = ["/jira/", "/secure/", "/issues"];

/** Plain http only reaches this machine, for a mock: anywhere else it would send the token in the clear. */
export function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

/**
 * `https://<site>/browse/KEY-1`, or a board's `?selectedIssue=KEY-1`, keeping the site's host as the
 * workspace: project keys repeat across sites.
 */
export function parseJiraIssueUrl(url: URL) {
  const secure = url.protocol === "https:";
  if (!secure && !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) return null;
  if (url.username !== "" || url.password !== "") return null;
  const browsed = /^\/browse\/([^/]+)\/?$/u.exec(url.pathname)?.[1];
  const selected = SELECTED_ISSUE_PATHS.some((prefix) => url.pathname.startsWith(prefix))
    ? url.searchParams.get("selectedIssue")
    : null;
  const key = (browsed ?? selected)?.toUpperCase();
  const scope = key === undefined ? undefined : ISSUE_KEY.exec(key)?.[1];
  if (key === undefined || scope === undefined) return null;
  return { host: JIRA_HOST, workspace: url.host.toLowerCase(), scope, key };
}

/** A cheap pre-check for text that may hold a link `parseJiraIssueUrl` reads. */
export function mayContainJiraIssueLink(text: string): boolean {
  return text.includes("/browse/") || text.includes("selectedIssue=");
}
