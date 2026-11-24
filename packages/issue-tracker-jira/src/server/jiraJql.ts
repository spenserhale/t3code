import type { IssueInvolvement, IssueListSort, IssueListState } from "@t3tools/contracts";

/** A JQL string literal: control characters dropped, backslash and quote escaped. */
const jqlQuote = (value: string): string =>
  `"${value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"')}"`;

// Words only: the characters that steer Jira's text search are dropped from what a person types.
const textSearchTerms = (text: string): string =>
  text
    .replace(/[+\-&|!(){}[\]^~*?\\:/"'`<>=,;@#$%]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]*-[1-9][0-9]*$/u;
const ISSUE_NUMBER = /^#?([1-9][0-9]*)$/u;

// Jira has no clause for mentions; watchers are its "involved" list, as Linear's subscribers are.
const INVOLVEMENT_CLAUSES: Record<Exclude<IssueInvolvement, "all">, string> = {
  assigned: "assignee = currentUser()",
  authored: "reporter = currentUser()",
  mentioned: "watcher = currentUser()",
};

export interface IssueListingQuery {
  /** The bound project's key, already checked to be one. */
  readonly project: string;
  readonly state: IssueListState;
  readonly involvement: IssueInvolvement;
  readonly labels: ReadonlyArray<string>;
  /** Account ids the assignee filter named; absent when the listing has no assignee filter. */
  readonly assigneeIds?: ReadonlyArray<string> | undefined;
  readonly query?: string | undefined;
  readonly sort: IssueListSort;
}

/**
 * The JQL for one page of a project's issues. A query shaped like an issue key, or a bare issue
 * number, finds that issue; `byKey` says so, because Jira refuses a query naming a key it does not
 * have instead of matching nothing.
 */
export function issueListingJql(input: IssueListingQuery): {
  readonly jql: string;
  readonly byKey: boolean;
} {
  const clauses = [`project = ${jqlQuote(input.project)}`];
  if (input.state === "open") clauses.push("statusCategory != Done");
  if (input.state === "closed") clauses.push("statusCategory = Done");
  if (input.involvement !== "all") clauses.push(INVOLVEMENT_CLAUSES[input.involvement]);
  for (const label of input.labels) clauses.push(`labels = ${jqlQuote(label)}`);
  if (input.assigneeIds !== undefined) {
    clauses.push(`assignee in (${input.assigneeIds.map(jqlQuote).join(", ")})`);
  }
  const query = input.query?.trim() ?? "";
  const number = ISSUE_NUMBER.exec(query)?.[1];
  const key = ISSUE_KEY.test(query)
    ? query.toUpperCase()
    : number === undefined
      ? null
      : `${input.project}-${number}`;
  if (key !== null) clauses.push(`key = ${jqlQuote(key)}`);
  const terms = key === null ? textSearchTerms(query) : "";
  if (terms !== "") clauses.push(`text ~ ${jqlQuote(terms)}`);
  const order = input.sort === "created" ? "created DESC" : "updated DESC";
  return { jql: `${clauses.join(" AND ")} ORDER BY ${order}`, byKey: key !== null };
}
