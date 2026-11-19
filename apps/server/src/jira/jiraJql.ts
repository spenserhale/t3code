import {
  JIRA_ISSUE_KEY_PATTERN,
  type JiraSearchInput,
  type JiraSearchSort,
  type JiraStatusCategoryFilter,
} from "@t3tools/contracts";

type JqlFilters = Pick<JiraSearchInput, "projectKeys" | "statusCategories" | "text">;

const PRESET_QUERIES = {
  assigned: {
    where: "assignee = currentUser() AND resolution = Unresolved",
    orderBy: "updated DESC",
  },
  sprint: { where: "assignee = currentUser() AND sprint in openSprints()", orderBy: "rank" },
  reported: { where: "reporter = currentUser()", orderBy: "created DESC" },
  recent: { where: "updated >= -14d", orderBy: "updated DESC" },
} as const;

const DEFAULT_CUSTOM_ORDER = "updated DESC";

// Each order puts the most useful issue first.
const SORT_ORDERS: Record<JiraSearchSort, string> = {
  updated: "updated DESC",
  created: "created DESC",
  priority: "priority DESC, updated DESC",
  key: "key ASC",
};

// Jira names the three categories in JQL.
const STATUS_CATEGORY_NAMES: Record<JiraStatusCategoryFilter, string> = {
  todo: "To Do",
  "in-progress": "In Progress",
  done: "Done",
};

const PROJECT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const ISSUE_KEY_ANYCASE_PATTERN = new RegExp(JIRA_ISSUE_KEY_PATTERN.source, "i");

/** A JQL string literal: control characters dropped, backslash and quote escaped. */
export const jqlQuote = (value: string): string =>
  `"${value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"')}"`;

/**
 * Splits a trailing `ORDER BY` off a query. Quoted text is skipped, so a phrase
 * such as "order by" inside a string does not count.
 */
export function splitOrderBy(jql: string): { readonly where: string; readonly orderBy: string } {
  let quote: string | null = null;
  let orderAt = -1;
  for (let index = 0; index < jql.length; index += 1) {
    const char = jql[index]!;
    if (quote !== null) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (
      /^order\s+by\b/iu.test(jql.slice(index)) &&
      (index === 0 || /[\s)]/u.test(jql[index - 1]!))
    ) {
      orderAt = index;
      break;
    }
  }
  if (orderAt === -1) return { where: jql.trim(), orderBy: "" };
  return {
    where: jql.slice(0, orderAt).trim(),
    orderBy: jql
      .slice(orderAt)
      .replace(/^order\s+by\s*/iu, "")
      .trim(),
  };
}

// Words only: the characters that steer Jira's text search are dropped from what a person types.
const textSearchTerms = (text: string): string =>
  text
    .replace(/[+\-&|!(){}[\]^~*?\\:/"'`<>=,;@#$%]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

function filterClauses(filters: JqlFilters): ReadonlyArray<string> {
  const clauses: string[] = [];
  const projects = [
    ...new Set(
      (filters.projectKeys ?? [])
        .map((key) => key.trim().toUpperCase())
        .filter((key) => PROJECT_KEY_PATTERN.test(key)),
    ),
  ];
  if (projects.length > 0) {
    clauses.push(`project in (${projects.map(jqlQuote).join(", ")})`);
  }
  const categories = [...new Set(filters.statusCategories ?? [])];
  if (categories.length > 0) {
    clauses.push(
      `statusCategory in (${categories.map((category) => jqlQuote(STATUS_CATEGORY_NAMES[category])).join(", ")})`,
    );
  }
  const text = (filters.text ?? "").trim();
  if (text.length > 0) {
    // A pasted key finds that issue; comments that merely mention it are not wanted.
    if (ISSUE_KEY_ANYCASE_PATTERN.test(text)) {
      clauses.push(`key = ${jqlQuote(text.toUpperCase())}`);
    } else {
      const terms = textSearchTerms(text);
      if (terms.length > 0) clauses.push(`text ~ ${jqlQuote(terms)}`);
    }
  }
  return clauses;
}

export type JqlBuild =
  | { readonly _tag: "Query"; readonly jql: string }
  | { readonly _tag: "EmptyCustomQuery" };

/**
 * The JQL a search runs: the preset (or the person's own query), then the
 * project, status category and text filters, then the ordering.
 */
export function buildJql(
  input: Pick<JiraSearchInput, "preset" | "jql" | "sort"> & JqlFilters,
): JqlBuild {
  const base =
    input.preset === "custom"
      ? splitOrderBy(input.jql ?? "")
      : {
          where: PRESET_QUERIES[input.preset].where,
          orderBy: PRESET_QUERIES[input.preset].orderBy,
        };
  const clauses = filterClauses(input);
  if (base.where.length === 0 && clauses.length === 0) return { _tag: "EmptyCustomQuery" };
  const orderBy =
    input.sort !== undefined
      ? SORT_ORDERS[input.sort]
      : base.orderBy.length > 0
        ? base.orderBy
        : DEFAULT_CUSTOM_ORDER;
  const where = [
    ...(base.where.length > 0 ? [clauses.length > 0 ? `(${base.where})` : base.where] : []),
    ...clauses,
  ].join(" AND ");
  return { _tag: "Query", jql: `${where} ORDER BY ${orderBy}` };
}

/** Matches several issues by key, for the status chips. */
export const jqlForKeys = (keys: ReadonlyArray<string>): string =>
  `key in (${keys.map(jqlQuote).join(", ")})`;
