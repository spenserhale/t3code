import { parseJiraSearch, type JiraSearch } from "./jiraRouteSearch";

const STORAGE_KEY = "t3code:jira:view:v1";

type ViewStorage = Pick<Storage, "getItem" | "setItem">;

const resolveStorage = (storage: ViewStorage | undefined): ViewStorage | undefined =>
  storage ?? (typeof window === "undefined" ? undefined : window.localStorage);

/** The view the page was last left in, so the sidebar button returns to it. */
export function readJiraView(storage?: ViewStorage): JiraSearch {
  try {
    const raw = resolveStorage(storage)?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const { issue: _issue, ...view } = parseJiraSearch(parsed as Record<string, unknown>);
    return view;
  } catch {
    return {};
  }
}

/** Remembers the filters, order and environment of a view; the issue that happens to be open is not part of it. */
export function rememberJiraView(search: JiraSearch, storage?: ViewStorage): void {
  const { issue: _issue, ...view } = search;
  try {
    resolveStorage(storage)?.setItem(STORAGE_KEY, JSON.stringify(view));
  } catch {
    // A page that cannot remember its view still works.
  }
}
