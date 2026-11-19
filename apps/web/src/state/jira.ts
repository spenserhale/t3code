/**
 * Jira issues for the Jira page, and the status chips of threads linked to them. Each environment
 * with Jira set up is its own site; a thread's chip reads the one its key belongs to. Nothing here
 * asks for Jira until a server advertises `capabilities.jiraIssues` and reports it set up.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  runAtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import {
  WS_METHODS,
  type EnvironmentId,
  type JiraIssueSummary,
  type JiraSearchInput,
  type JiraSearchResult,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import { jiraEnvironmentForThread, threadUsesJiraSite } from "../components/jira/jiraEnvironments";
import { extractIssueKeys } from "../components/jira/jiraIssueKeys";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { environmentThreadShells } from "./threads";

/** Counts the Jira writes this client has made, so what is on screen asks again. */
export const jiraRevisionAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(0).pipe(Atom.withLabel(`web:jira:revision:${environmentId}`)),
);

const refreshOnWrite = ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
  jiraRevisionAtom(environmentId);

/** Counts the refreshes of linked issues' statuses alone, on the chips' own schedule. */
const jiraChipRevisionAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(0).pipe(Atom.withLabel(`web:jira:chip-revision:${environmentId}`)),
);

/** What the status lookup watches: every write and page refresh, and the chips' own refreshes. */
export const jiraLookupSignalAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) => get(jiraRevisionAtom(environmentId)) + get(jiraChipRevisionAtom(environmentId)),
  ).pipe(Atom.withLabel(`web:jira:lookup-signal:${environmentId}`)),
);

/** Asks again for the statuses of linked issues only, leaving the page's lists and details be. */
export function refreshJiraChips(environmentId: EnvironmentId): void {
  appAtomRegistry.update(jiraChipRevisionAtom(environmentId), (count) => count + 1);
}

const writeDone = (
  target: { readonly environmentId: EnvironmentId },
  registry: AtomRegistry.AtomRegistry,
) =>
  Effect.sync(() => registry.update(jiraRevisionAtom(target.environmentId), (count) => count + 1));

/** Asks again for everything shown from this environment, as after a change made elsewhere. */
export function refreshJira(environmentId: EnvironmentId): void {
  appAtomRegistry.update(jiraRevisionAtom(environmentId), (count) => count + 1);
}

const jiraForget = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "web:jira:forget",
  tag: WS_METHODS.jiraRefresh,
});

/**
 * Like `refreshJira`, but the server first forgets what it kept from Jira, so the answers come
 * from Jira itself. For a person who pressed Refresh, not for the periodic refresh.
 */
export async function refreshJiraFromSource(environmentId: EnvironmentId): Promise<void> {
  // A server that cannot forget still answers, from what it kept.
  await runAtomCommand(
    appAtomRegistry,
    jiraForget,
    { environmentId, input: {} },
    { reportFailure: false, reportDefect: false },
  );
  refreshJira(environmentId);
}

const NO_INPUT = {} as const;

export const jiraStatusQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "web:jira:status",
  tag: WS_METHODS.jiraStatus,
  staleTimeMs: 5 * 60_000,
  idleTtlMs: 10 * 60_000,
  refreshTrigger: refreshOnWrite,
});

export const jiraProjectsQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "web:jira:projects",
  tag: WS_METHODS.jiraListProjects,
  staleTimeMs: 10 * 60_000,
  idleTtlMs: 30 * 60_000,
  refreshTrigger: refreshOnWrite,
});

const jiraSearchQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "web:jira:search",
  tag: WS_METHODS.jiraSearch,
  staleTimeMs: 30_000,
  idleTtlMs: 2 * 60_000,
  refreshTrigger: refreshOnWrite,
});

export const jiraIssueQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "web:jira:issue",
  tag: WS_METHODS.jiraGetIssue,
  staleTimeMs: 30_000,
  idleTtlMs: 5 * 60_000,
  refreshTrigger: refreshOnWrite,
});

export const jiraTransitionsQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "web:jira:transitions",
  tag: WS_METHODS.jiraListTransitions,
  staleTimeMs: 15_000,
  idleTtlMs: 30_000,
  refreshTrigger: refreshOnWrite,
});

// Not polled by the query itself, which would go on while the window is hidden; `JiraHost` asks
// again through `refreshJiraChips` while the app is in view.
const jiraLookupQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "web:jira:lookup",
  tag: WS_METHODS.jiraLookupIssues,
  staleTimeMs: 60_000,
  idleTtlMs: 30_000,
  refreshTrigger: ({ environmentId }) => jiraLookupSignalAtom(environmentId),
});

export const jiraConfigure = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "web:jira:configure",
  tag: WS_METHODS.jiraConfigure,
  onSuccess: writeDone,
});

/** One read of an issue's moves, where no view keeps the query mounted. */
export const jiraReadTransitions = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "web:jira:read-transitions",
  tag: WS_METHODS.jiraListTransitions,
});

export const jiraDisconnect = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "web:jira:disconnect",
  tag: WS_METHODS.jiraDisconnect,
  onSuccess: writeDone,
});

export const jiraTransition = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "web:jira:transition",
  tag: WS_METHODS.jiraTransition,
  onSuccess: writeDone,
});

export const jiraAddComment = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "web:jira:add-comment",
  tag: WS_METHODS.jiraAddComment,
  onSuccess: writeDone,
});

/** An array that keeps its identity while its elements do, so readers skip no-op recomputes. */
function reuseArray<A>(
  previous: ReadonlyArray<A> | null,
  next: ReadonlyArray<A>,
): ReadonlyArray<A> {
  return previous !== null &&
    previous.length === next.length &&
    next.every((element, index) => element === previous[index])
    ? previous
    : next;
}

const jiraCapableEnvironmentIdsAtom = Atom.make((get) => {
  const ids: EnvironmentId[] = [];
  for (const [environmentId, config] of get(environmentPresentations.serverConfigsAtom)) {
    if (config.environment.capabilities.jiraIssues === true) ids.push(environmentId);
  }
  return reuseArray(Option.getOrNull(get.self<ReadonlyArray<EnvironmentId>>()), ids);
}).pipe(Atom.withLabel("web:jira:capable-environments"));

/** Environments whose server has Jira set up. */
export const jiraConfiguredEnvironmentIdsAtom = Atom.make((get) => {
  const ids = get(jiraCapableEnvironmentIdsAtom).filter(
    (environmentId) =>
      Option.getOrNull(AsyncResult.value(get(jiraStatusQuery({ environmentId, input: NO_INPUT }))))
        ?.configured === true,
  );
  return reuseArray(Option.getOrNull(get.self<ReadonlyArray<EnvironmentId>>()), ids);
}).pipe(Atom.withLabel("web:jira:configured-environments"));

/** The environment the Jira page and the chips read from; `null` while none has Jira. */
const jiraEnvironmentIdAtom = Atom.make((get) => {
  const configured = get(jiraConfiguredEnvironmentIdsAtom);
  const primary = get(primaryEnvironmentIdAtom);
  return primary !== null && configured.includes(primary) ? primary : (configured[0] ?? null);
}).pipe(Atom.withLabel("web:jira:environment"));

export function useJiraEnvironmentId(): EnvironmentId | null {
  return useAtomValue(jiraEnvironmentIdAtom);
}

const EMPTY_PROJECT_KEYS: ReadonlySet<string> = new Set();

/** One site's project keys; text only counts as an issue key when its project is one of these. */
const jiraProjectKeysAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlySet<string> => {
    const previous = Option.getOrNull(get.self<ReadonlySet<string>>()) ?? EMPTY_PROJECT_KEYS;
    const projects = Option.getOrNull(
      AsyncResult.value(get(jiraProjectsQuery({ environmentId, input: NO_INPUT }))),
    );
    if (projects === null) return previous;
    const next = new Set(projects.projects.map((project) => project.key.toUpperCase()));
    return next.size === previous.size && [...next].every((key) => previous.has(key))
      ? previous
      : next;
  }).pipe(Atom.withLabel(`web:jira:project-keys:${environmentId}`)),
);

const NO_PROJECT_KEYS_ATOM = Atom.make<ReadonlySet<string>>(EMPTY_PROJECT_KEYS).pipe(
  Atom.withLabel("web:jira:project-keys:none"),
);

const EMPTY_LINKED: ReadonlyMap<string, ReadonlyArray<ScopedThreadRef>> = new Map();

const linkedSignature = (linked: ReadonlyMap<string, ReadonlyArray<ScopedThreadRef>>) =>
  [...linked]
    .map(
      ([key, refs]) =>
        `${key}=${refs.map((ref) => `${ref.environmentId}/${ref.threadId}`).join(",")}`,
    )
    .join(";");

/**
 * The threads whose title or branch names each issue of one site: those of every connected
 * environment that belong to that site, as `jiraEnvironmentForThread` decides.
 */
export const jiraLinkedThreadsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyMap<string, ReadonlyArray<ScopedThreadRef>> => {
    const projectKeys = get(jiraProjectKeysAtom(environmentId));
    const previous = Option.getOrNull(
      get.self<ReadonlyMap<string, ReadonlyArray<ScopedThreadRef>>>(),
    );
    if (projectKeys.size === 0) return EMPTY_LINKED;
    const configured = get(jiraConfiguredEnvironmentIdsAtom);
    const linked = new Map<string, ScopedThreadRef[]>();
    for (const shell of get(environmentThreadShells.threadShellsAtom)) {
      if (shell.archivedAt !== null || shell.deletedAt !== null) continue;
      if (!threadUsesJiraSite(shell.environmentId, configured, environmentId)) continue;
      for (const key of extractIssueKeys(shell, projectKeys)) {
        const refs = linked.get(key) ?? [];
        refs.push(scopeThreadRef(shell.environmentId, shell.id));
        linked.set(key, refs);
      }
    }
    return previous !== null && linkedSignature(previous) === linkedSignature(linked)
      ? previous
      : linked;
  }).pipe(Atom.withLabel(`web:jira:linked-threads:${environmentId}`)),
);

const MAX_LOOKUP_KEYS = 200;

/** Every linked issue's current status, in one request however many threads there are. */
const jiraLinkedIssuesAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyMap<string, JiraIssueSummary> => {
    const keys = [...get(jiraLinkedThreadsAtom(environmentId)).keys()]
      .toSorted()
      .slice(0, MAX_LOOKUP_KEYS);
    const previous = Option.getOrNull(get.self<ReadonlyMap<string, JiraIssueSummary>>());
    if (keys.length === 0) return new Map();
    const found = Option.getOrNull(
      AsyncResult.value(get(jiraLookupQuery({ environmentId, input: { keys } }))),
    );
    if (found === null) return previous ?? new Map();
    return new Map(found.issues.map((issue) => [issue.key, issue]));
  }).pipe(Atom.withLabel(`web:jira:linked-issues:${environmentId}`)),
);

const jiraIssueByKeyAtom = Atom.family((target: string) => {
  const [environmentId, key] = JSON.parse(target) as [EnvironmentId, string];
  return Atom.make((get) => get(jiraLinkedIssuesAtom(environmentId)).get(key) ?? null).pipe(
    Atom.withLabel(`web:jira:linked-issue:${target}`),
  );
});

const NO_ISSUE_ATOM = Atom.make<JiraIssueSummary | null>(null).pipe(
  Atom.withLabel("web:jira:linked-issue:none"),
);

export interface ThreadJiraLink {
  /** The environment whose Jira site the key is on. */
  readonly environmentId: EnvironmentId;
  readonly key: string;
  /** `null` until Jira has answered for this key. */
  readonly issue: JiraIssueSummary | null;
}

/**
 * The issue a thread is about, from its title or branch, or `null`. The key is looked up on the
 * thread's own Jira site, or the only one there is; with several to choose from and none the
 * thread's own, the thread has no chip rather than a chip from the wrong site.
 */
export function useThreadJiraLink(
  thread: {
    readonly environmentId: EnvironmentId;
    readonly title: string;
    readonly branch: string | null;
  } | null,
): ThreadJiraLink | null {
  const configured = useAtomValue(jiraConfiguredEnvironmentIdsAtom);
  const environmentId =
    thread === null ? null : jiraEnvironmentForThread(thread.environmentId, configured);
  const projectKeys = useAtomValue(
    environmentId === null ? NO_PROJECT_KEYS_ATOM : jiraProjectKeysAtom(environmentId),
  );
  const key =
    thread === null || environmentId === null
      ? null
      : (extractIssueKeys(thread, projectKeys)[0] ?? null);
  const issue = useAtomValue(
    key === null || environmentId === null
      ? NO_ISSUE_ATOM
      : jiraIssueByKeyAtom(JSON.stringify([environmentId, key])),
  );
  return key === null || environmentId === null ? null : { environmentId, key, issue };
}

interface JiraSearchView {
  readonly issues: ReadonlyArray<JiraIssueSummary>;
  readonly hasMore: boolean;
  /** Something is loading: the first page, a further page, or a refresh behind what shows. */
  readonly pending: boolean;
  readonly failure: Cause.Cause<unknown> | null;
  /** The query that ran, once the first page is in. */
  readonly jql: string | null;
}

interface JiraPageRead {
  readonly found: JiraSearchResult | null;
  readonly waiting: boolean;
  readonly failure: Cause.Cause<unknown> | null;
}

/**
 * The first `pages` pages of one search, read page after page: each page's token
 * comes from the one before. Earlier pages stay cached, so asking for one more
 * shows the others at once.
 */
export const jiraSearchViewAtom = Atom.family((key: string) =>
  Atom.make((get): JiraSearchView => {
    const { environmentId, input, pages } = JSON.parse(key) as {
      readonly environmentId: EnvironmentId;
      readonly input: JiraSearchInput;
      readonly pages: number;
    };
    const readPage = (pageInput: JiraSearchInput): JiraPageRead => {
      const result = get(jiraSearchQuery({ environmentId, input: pageInput }));
      return {
        found: Option.getOrNull(AsyncResult.value(result)),
        waiting: result.waiting,
        failure: result._tag === "Failure" ? result.cause : null,
      };
    };
    const issues: JiraIssueSummary[] = [];
    let jql: string | null = null;
    let pageToken: string | null = null;
    for (let page = 0; page < pages; page += 1) {
      const read: JiraPageRead = readPage(pageToken === null ? input : { ...input, pageToken });
      if (read.found === null) {
        return {
          issues,
          hasMore: false,
          pending: read.failure === null,
          failure: read.failure,
          jql,
        };
      }
      issues.push(...read.found.issues);
      jql = read.found.jql;
      pageToken = read.found.nextPageToken;
      if (pageToken === null || page === pages - 1) {
        return {
          issues,
          hasMore: pageToken !== null,
          pending: read.waiting,
          failure: read.failure,
          jql,
        };
      }
    }
    return { issues, hasMore: false, pending: false, failure: null, jql };
  }).pipe(Atom.withLabel(`web:jira:search-view:${key}`)),
);
