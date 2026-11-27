import {
  EnvironmentAuthorizationError,
  requiredScopesForServerSettingsPatch,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import { persistClientSettingsPatch } from "../../hooks/useSettings";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { isConnectedWithConfig, persistScopedSettingsPatch } from "./scopedSettings";
import {
  type CompareEnvironment,
  type CompareItem,
  compareItemLabel,
  listLabels,
  planSettingsCopy,
} from "./settingsCompare.logic";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";

/** Every known environment: the connected ones with their own lists, and the rest by name. */
export function useCompareEnvironments() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const connected = environments.flatMap((environment): CompareEnvironment[] =>
    isConnectedWithConfig(environment) && environment.serverConfig
      ? [
          {
            environmentId: environment.environmentId,
            label: settingsScopeEnvironmentLabel(environment, environments),
            settings: environment.serverConfig.settings,
            capabilities: environment.serverConfig.environment.capabilities,
          },
        ]
      : [],
  );
  const offline = environments
    .filter((environment) => !isConnectedWithConfig(environment))
    .map((environment) => settingsScopeEnvironmentLabel(environment, environments));
  const defaultSource =
    connected.find((environment) => environment.environmentId === primaryEnvironmentId) ??
    connected[0] ??
    null;
  return { connected, offline, defaultSource, primaryEnvironmentId };
}

/**
 * Copies the source's lists to the named destinations. A copy writes only where it was sent, so
 * it reports on its own instead of through the Settings scope's save path.
 */
export function useCopySettings() {
  const persistServer = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  return (
    source: CompareEnvironment,
    destinations: readonly CompareEnvironment[],
    items: readonly CompareItem[],
  ) => {
    const plan = planSettingsCopy(source, destinations, items);
    if (plan.unavailableReason) {
      toastManager.add({
        type: "warning",
        title: "Nothing copied",
        description: plan.unavailableReason,
      });
      return;
    }
    const what =
      items.length <= 2 ? listLabels(items.map(compareItemLabel)) : `${items.length} settings`;
    void persistScopedSettingsPatch(
      plan,
      async (request) => {
        const missing = requiredScopesForServerSettingsPatch(request.input.patch).find(
          (scope) => !readEnvironmentScope(request.environmentId, scope),
        );
        if (missing)
          return AsyncResult.failure(
            Cause.fail(
              new EnvironmentAuthorizationError({
                requiredScope: missing,
                message: "This connection lacks permission to change these settings.",
              }),
            ),
          );
        return persistServer(request);
      },
      persistClientSettingsPatch,
    ).then(({ failedEnvironments, savedEnvironments }) => {
      const saved = listLabels(savedEnvironments.map(({ label }) => label));
      if (failedEnvironments.length === 0) {
        toastManager.add({ type: "success", title: `Copied ${what} to ${saved}.` });
        return;
      }
      toastManager.add({
        type: "error",
        title: savedEnvironments.length > 0 ? "Copied to some environments" : "Nothing copied",
        description: [
          ...failedEnvironments.map(
            ({ label, message }) => `Could not copy to ${label}: ${message}`,
          ),
          ...(savedEnvironments.length > 0 ? [`Copied to ${saved}.`] : []),
        ].join("\n"),
      });
    });
  };
}
