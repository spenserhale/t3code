import {
  AuthDiagnosticsReadScope,
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
} from "@t3tools/contracts";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { makeWindow } from "@t3tools/shared/usageFormat";
import { type DailyTotals, mergeUsage } from "@t3tools/shared/usageMerge";
import type { AtomRegistry } from "effect/reactivity";

import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";

/** An environment that has not answered by now is given up on, and asked again later. */
const REQUEST_TIMEOUT_MS = 2 * 60_000;

export interface UsageEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/** The connected environments that let this client read usage. */
export function readyUsageEnvironments(
  registry: AtomRegistry.AtomRegistry,
): readonly UsageEnvironment[] {
  return [...registry.get(environmentPresentations.presentationsAtom)]
    .filter(
      ([environmentId, presentation]) =>
        presentation.connection.phase === "connected" &&
        readEnvironmentScope(environmentId, AuthDiagnosticsReadScope),
    )
    .map(([environmentId, presentation]) => ({
      environmentId,
      label: presentation.entry.target.label,
    }));
}

/**
 * The last 90 days of one environment's token totals; null when it did not answer.
 * It asks once and has the server wait for slow sources, where the Usage page's
 * query would take the cached answer and then ask a second time.
 */
export async function loadEnvironmentDailyTokens(
  registry: AtomRegistry.AtomRegistry,
  environment: UsageEnvironment,
): Promise<readonly DailyTotals[] | null> {
  const result = await executeAtomQuery(
    registry,
    serverEnvironment.usageSummary({
      environmentId: environment.environmentId,
      input: { ...makeWindow(90), awaitRefresh: true },
    }),
    {
      reportFailure: false,
      reportDefect: false,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (result._tag !== "Success") return null;
  return mergeUsage([{ ...environment, summary: result.value }], USAGE_CONTRACT_VERSION).daily;
}
