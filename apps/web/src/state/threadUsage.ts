/**
 * Per-turn tokens and estimated cost of one thread, from servers that record
 * them (`capabilities.threadUsage`), shown only while the Usage & cost setting
 * is on.
 *
 * Turns are priced on the server when read, so the query refetches when the
 * thread's shell reports another turn and when the environment's custom model
 * prices change; the answer then already reflects the new prices.
 */
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import {
  WS_METHODS,
  type ClientSettings,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadTurnUsage,
  type ThreadUsageTotals,
  type TurnId,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useClientSettings } from "../hooks/useSettings";
import { useServerConfigs, useThreadShell } from "./entities";
import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";
import { environmentThreadShells } from "./threads";

/** Changes when the thread records a turn or the environment's custom prices change. */
const usageRevisionAtom = Atom.family((key: string) => {
  const ref = JSON.parse(key) as ScopedThreadRef;
  return Atom.make((get) => {
    const usage = get(environmentThreadShells.threadShellAtom(ref))?.usage;
    const prices = get(serverEnvironment.settingsValueAtom(ref.environmentId))?.usagePriceOverrides;
    const priceKey = Object.keys(prices ?? {})
      .toSorted()
      .map((model) => [model, Object.values(prices![model]!).join(",")].join("="))
      .join("|");
    return `${usage?.turns ?? 0}:${usage?.totalTokens ?? 0}:${priceKey}`;
  }).pipe(Atom.withLabel(`web:thread-usage-revision:${key}`));
});

const threadUsageQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "web:thread-usage",
  tag: WS_METHODS.serverGetThreadUsage,
  staleTimeMs: 60_000,
  refreshTrigger: ({ environmentId, input }) =>
    usageRevisionAtom(JSON.stringify({ environmentId, threadId: input.threadId })),
});

const selectEnabled = (settings: ClientSettings) => settings.usageCostAnalysisEnabled;

export function useUsageCostAnalysisEnabled(environmentId: EnvironmentId | null): boolean {
  const enabled = useClientSettings(selectEnabled);
  const supported =
    useServerConfigs().get(environmentId!)?.environment.capabilities.threadUsage === true;
  return enabled && environmentId !== null && supported;
}

export interface ThreadUsageView {
  readonly totals: ThreadUsageTotals;
  readonly turns: ReadonlyMap<TurnId, ThreadTurnUsage>;
}

/**
 * `null` while the feature is off, the server cannot answer, or the thread has
 * no recorded usage. Before the first answer arrives, totals come from the
 * thread shell and `turns` is empty.
 */
export function useThreadUsage(ref: ScopedThreadRef | null): ThreadUsageView | null {
  const enabled = useUsageCostAnalysisEnabled(ref?.environmentId ?? null);
  const shellUsage = useThreadShell(enabled ? ref : null)?.usage ?? null;
  const query = useEnvironmentQuery(
    enabled && ref !== null && shellUsage !== null && shellUsage.turns > 0
      ? threadUsageQuery({ environmentId: ref.environmentId, input: { threadId: ref.threadId } })
      : null,
  );
  const detail = query.data;
  return useMemo(() => {
    if (!enabled || shellUsage === null || shellUsage.turns === 0) return null;
    if (detail === null) return { totals: shellUsage, turns: new Map() };
    const turns = new Map(detail.turns.map((turn) => [turn.turnId, turn]));
    let totals: ThreadUsageTotals = { totalTokens: 0, costUsd: 0, turns: 0, unpricedTurns: 0 };
    for (const turn of detail.turns) {
      totals = {
        totalTokens: totals.totalTokens + turn.totalTokens,
        costUsd: totals.costUsd + turn.costUsd,
        turns: totals.turns + 1,
        unpricedTurns:
          totals.unpricedTurns +
          (turn.models.every((model) => model.costSource === "unpriced") ? 1 : 0),
      };
    }
    return { totals, turns };
  }, [enabled, shellUsage, detail]);
}
