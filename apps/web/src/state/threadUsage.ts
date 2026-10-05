/**
 * Tokens and estimated cost of threads and their runs, from servers that
 * report them (`capabilities.threadUsage`), shown only while the Usage and
 * cost setting is on.
 *
 * The server prices when it is asked, so a query refetches when its answer
 * could have changed: a thread's when one of its runs starts or finishes, and
 * every query when the environment's custom prices or model mappings change.
 * Queries are dropped as soon as nothing shows them, so none refetches unseen.
 */
import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import {
  WS_METHODS,
  type ClientSettings,
  type EnvironmentId,
  type ScopedThreadRef,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { threadUsageView, type ThreadUsageView } from "../components/usage/threadUsageFormat";
import {
  mergeThreadUsage,
  type EnvironmentThreadUsage,
  type ThreadUsageTotals,
} from "../components/usage/usageThreads";
import { connectionAtomRuntime } from "../connection/runtime";
import { useClientSettings } from "../hooks/useSettings";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useServerConfigs } from "./entities";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";
import { environmentThreadShells } from "./threads";

/** Stable however a settings snapshot happens to order its keys. */
const sortedEntries = (record: Readonly<Record<string, unknown>> | undefined) =>
  Object.keys(record ?? {})
    .toSorted()
    .map((key) => [key, record![key]]);

/** Changes when the environment's custom prices or model mappings do. */
const usagePricesRevisionAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const settings = get(serverEnvironment.settingsValueAtom(environmentId));
    return JSON.stringify([
      sortedEntries(settings?.usagePriceOverrides),
      sortedEntries(settings?.usageModelAliases),
    ]);
  }).pipe(Atom.withLabel(`web:thread-usage-prices:${environmentId}`)),
);

/** A run moves between these while it works; none of the moves changes what it has used. */
const IN_FLIGHT_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/**
 * Changes whenever one of the thread's runs starts or finishes. The latest run
 * alone would miss a run that finishes with a follow-up queued behind it: the
 * queued one is already the latest. The active run changes then.
 */
const usageRevisionAtom = Atom.family((key: string) => {
  const ref = JSON.parse(key) as ScopedThreadRef;
  return Atom.make((get) => {
    const shell = get(environmentThreadShells.threadShellAtom(ref));
    const run = shell?.latestRun;
    return JSON.stringify([
      shell?.runtime?.activeRunId,
      run?.runId,
      run && !IN_FLIGHT_RUN_STATUSES.has(run.status) ? run.status : null,
      run?.completedAt,
      get(usagePricesRevisionAtom(ref.environmentId)),
    ]);
  }).pipe(Atom.withLabel(`web:thread-usage-revision:${key}`));
});

const threadUsageQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "web:thread-usage",
  tag: WS_METHODS.serverGetThreadUsage,
  staleTimeMs: 60_000,
  idleTtlMs: 0,
  refreshTrigger: ({ environmentId, input }) =>
    usageRevisionAtom(JSON.stringify({ environmentId, threadId: input.threadId })),
});

/** Derived once per thread, so every "Worked for" row of a thread shares one lookup table. */
const threadUsageViewAtom = Atom.family((key: string) => {
  const ref = JSON.parse(key) as ScopedThreadRef;
  return Atom.make((get) => {
    const detail = Option.getOrNull(
      AsyncResult.value(
        get(
          threadUsageQuery({
            environmentId: ref.environmentId,
            input: { threadId: ref.threadId },
          }),
        ),
      ),
    );
    return detail === null ? null : threadUsageView(detail.turns);
  }).pipe(Atom.withLabel(`web:thread-usage-view:${key}`));
});

const NO_THREAD_USAGE_ATOM = Atom.make<ThreadUsageView | null>(null).pipe(
  Atom.withLabel("web:thread-usage-view:none"),
);

const selectEnabled = (settings: ClientSettings) => settings.usageCostAnalysisEnabled;

/** Whether the Usage and cost setting is on. A server may still not report thread usage. */
export function useUsageCostAnalysisSetting(): boolean {
  return useClientSettings(selectEnabled);
}

/**
 * `null` while the server cannot answer, the answer has not arrived, or the
 * thread has no reported usage. Mount it only while the setting is on, so a
 * thread is never asked about with the feature off.
 */
export function useThreadUsage(ref: ScopedThreadRef | null): ThreadUsageView | null {
  const configs = useServerConfigs();
  const supported =
    ref !== null && configs.get(ref.environmentId)?.environment.capabilities.threadUsage === true;
  return useAtomValue(
    supported
      ? threadUsageViewAtom(
          JSON.stringify({ environmentId: ref.environmentId, threadId: ref.threadId }),
        )
      : NO_THREAD_USAGE_ATOM,
  );
}

const threadUsageListQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "web:thread-usage-list",
  tag: WS_METHODS.serverListThreadUsage,
  staleTimeMs: 60_000,
  idleTtlMs: 0,
  refreshTrigger: ({ environmentId }) => usagePricesRevisionAtom(environmentId),
});

/**
 * Every connected environment's thread totals for one window, keyed by the
 * serialised window the way usage summaries are. A server without the
 * capability is listed but never asked.
 */
const threadUsageByWindowAtom = Atom.family((windowKey: string) =>
  Atom.make((get): readonly EnvironmentThreadUsage[] => {
    const input = JSON.parse(windowKey) as UsageSummaryInput;
    const environments: EnvironmentThreadUsage[] = [];
    for (const [environmentId, presentation] of get(environmentPresentations.presentationsAtom)) {
      const config = get(serverEnvironment.configValueAtom(environmentId));
      // Not connected yet: whether it can report is unknown, so say nothing of it.
      if (config === null) continue;
      const label = presentation.entry.target.label;
      if (config.environment.capabilities.threadUsage !== true) {
        environments.push({
          environmentId,
          label,
          supported: false,
          isPending: false,
          failed: false,
          threads: null,
        });
        continue;
      }
      const result = get(threadUsageListQuery({ environmentId, input }));
      environments.push({
        environmentId,
        label,
        supported: true,
        isPending: result.waiting,
        failed: result._tag === "Failure",
        threads: Option.getOrNull(AsyncResult.value(result))?.threads ?? null,
      });
    }
    return environments;
  }).pipe(Atom.withLabel(`web:thread-usage-window:${windowKey}`)),
);

const windowKeyOf = (input: UsageSummaryInput) =>
  JSON.stringify({
    sinceDay: input.sinceDay,
    untilDay: input.untilDay,
    timeZone: input.timeZone,
    resolution: input.resolution,
    sinceTime: input.sinceTime,
    untilTime: input.untilTime,
  });

export interface ThreadUsageTotalsView extends ThreadUsageTotals {
  /** Asks the selected environments again. */
  readonly refresh: () => void;
}

/**
 * Thread totals for a usage window across the selected environments (`null`
 * selects all, as on the Usage page). Mount it only while the totals are shown:
 * every capable environment is asked.
 */
export function useThreadUsageTotals(
  input: UsageSummaryInput,
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null,
): ThreadUsageTotalsView {
  const windowKey = windowKeyOf(input);
  const environments = useAtomValue(threadUsageByWindowAtom(windowKey));
  const selected = useMemo(
    () =>
      selectedEnvironmentIds === null
        ? environments
        : environments.filter((environment) =>
            selectedEnvironmentIds.has(environment.environmentId),
          ),
    [environments, selectedEnvironmentIds],
  );
  const totals = useMemo(() => mergeThreadUsage(selected), [selected]);
  const refresh = useCallback(() => {
    const window = JSON.parse(windowKey) as UsageSummaryInput;
    for (const environment of selected) {
      if (!environment.supported) continue;
      appAtomRegistry.refresh(
        threadUsageListQuery({ environmentId: environment.environmentId, input: window }),
      );
    }
  }, [selected, windowKey]);
  return useMemo(() => ({ ...totals, refresh }), [refresh, totals]);
}
