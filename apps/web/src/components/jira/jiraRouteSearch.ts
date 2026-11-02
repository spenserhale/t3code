import {
  JIRA_ISSUE_KEY_PATTERN,
  type EnvironmentId,
  type JiraSearchInput,
  type JiraSearchPreset,
  type JiraStatusCategoryFilter,
} from "@t3tools/contracts";

/** What the Jira page keeps in its address, so a view survives a reload and the back button. */
export interface JiraSearch {
  /** Left out for "assigned", the view a visit starts with. */
  readonly preset?: JiraSearchPreset;
  readonly jql?: string;
  readonly projects?: ReadonlyArray<string>;
  readonly status?: ReadonlyArray<JiraStatusCategoryFilter>;
  readonly q?: string;
  readonly issue?: string;
  readonly environmentId?: EnvironmentId;
}

const PRESETS: ReadonlyArray<JiraSearchPreset> = [
  "assigned",
  "sprint",
  "reported",
  "recent",
  "custom",
];
const DEFAULT_PRESET = "assigned" satisfies JiraSearchPreset;
const STATUS_CATEGORIES: ReadonlyArray<JiraStatusCategoryFilter> = ["todo", "in-progress", "done"];
const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,24}$/u;
const MAX_PROJECTS = 20;
const MAX_JQL_LENGTH = 2_000;
const MAX_TEXT_LENGTH = 200;

const asList = (raw: unknown): ReadonlyArray<unknown> =>
  Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];

/** Reads a view out of an address, dropping anything that is not one. */
export function parseJiraSearch(raw: Record<string, unknown>): JiraSearch {
  const preset = PRESETS.find((candidate) => candidate === raw.preset) ?? DEFAULT_PRESET;
  const projects = [
    ...new Set(
      asList(raw.projects)
        .filter((value): value is string => typeof value === "string" && PROJECT_KEY.test(value))
        .map((value) => value.toUpperCase()),
    ),
  ].slice(0, MAX_PROJECTS);
  const status = STATUS_CATEGORIES.filter((category) => asList(raw.status).includes(category));
  const jql = typeof raw.jql === "string" ? raw.jql.trim().slice(0, MAX_JQL_LENGTH) : "";
  const q = typeof raw.q === "string" ? raw.q.trim().slice(0, MAX_TEXT_LENGTH) : "";
  const issue = typeof raw.issue === "string" ? raw.issue.trim().toUpperCase() : "";
  return {
    ...(preset === DEFAULT_PRESET ? {} : { preset }),
    ...(preset === "custom" && jql.length > 0 ? { jql } : {}),
    ...(projects.length > 0 ? { projects } : {}),
    ...(status.length > 0 ? { status } : {}),
    ...(q.length > 0 ? { q } : {}),
    ...(JIRA_ISSUE_KEY_PATTERN.test(issue) ? { issue } : {}),
    ...(typeof raw.environmentId === "string" && raw.environmentId.length > 0
      ? { environmentId: raw.environmentId.slice(0, 200) as EnvironmentId }
      : {}),
  };
}

const JIRA_PAGE_SIZE = 50;

/** The request for a view, built the same way every time so equal views share a cache entry. */
export function jiraSearchInput(search: JiraSearch): JiraSearchInput {
  const preset = search.preset ?? DEFAULT_PRESET;
  return {
    preset,
    ...(preset === "custom" && search.jql !== undefined ? { jql: search.jql } : {}),
    ...(search.projects === undefined ? {} : { projectKeys: search.projects }),
    ...(search.status === undefined ? {} : { statusCategories: search.status }),
    ...(search.q === undefined ? {} : { text: search.q }),
    pageSize: JIRA_PAGE_SIZE,
  };
}

export type JiraSearchPatch = { readonly [Key in keyof JiraSearch]?: JiraSearch[Key] | undefined };

/** The view with the patch applied; a key patched to `undefined` leaves the address. */
export function applyJiraSearchPatch(search: JiraSearch, patch: JiraSearchPatch): JiraSearch {
  return Object.fromEntries(
    Object.entries({ ...search, ...patch }).filter(([, value]) => value !== undefined),
  ) as JiraSearch;
}
