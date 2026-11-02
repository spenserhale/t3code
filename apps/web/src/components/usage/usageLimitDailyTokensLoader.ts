import { AuthDiagnosticsReadScope, USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { makeWindow } from "@t3tools/shared/usageFormat";
import { type EnvironmentUsage, type DailyTotals, mergeUsage } from "@t3tools/shared/usageMerge";
import type { AtomRegistry } from "effect/reactivity";

import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";

/**
 * The last 90 days of token totals from every connected environment that lets
 * this client read usage, as the Usage page merges them. `attempted` is false
 * when no environment was ready to ask, which is not worth waiting out a retry for.
 */
export async function loadDailyTokens(
  registry: AtomRegistry.AtomRegistry,
): Promise<{ readonly attempted: boolean; readonly daily: readonly DailyTotals[] | null }> {
  const input = makeWindow(90);
  const ready = [...registry.get(environmentPresentations.presentationsAtom)].filter(
    ([environmentId, presentation]) =>
      presentation.connection.phase === "connected" &&
      readEnvironmentScope(environmentId, AuthDiagnosticsReadScope),
  );
  if (ready.length === 0) return { attempted: false, daily: null };
  const answered: EnvironmentUsage[] = [];
  await Promise.all(
    ready.map(async ([environmentId, presentation]) => {
      const result = await executeAtomQuery(
        registry,
        serverEnvironment.usageSummary({ environmentId, input }),
        { reportFailure: false, reportDefect: false },
      );
      if (result._tag === "Success") {
        answered.push({
          environmentId,
          label: presentation.entry.target.label,
          summary: result.value,
        });
      }
    }),
  );
  return {
    attempted: true,
    daily: answered.length > 0 ? mergeUsage(answered, USAGE_CONTRACT_VERSION).daily : null,
  };
}
