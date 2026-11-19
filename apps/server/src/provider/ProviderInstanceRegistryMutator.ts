/** Reconcile closes removed/replaced scopes before creating replacements: at most one live instance per id. */
import type { ProviderInstanceConfigMap, ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ProviderInstanceRegistryMutatorShape {
  readonly reconcile: (configMap: ProviderInstanceConfigMap) => Effect.Effect<void>;
  /**
   * Re-reads the secrets of every instance, or one, and rebuilds those whose secrets changed. A
   * failed re-read keeps a working instance, unless it uses a secret provider in `narrowed`, which
   * now opens fewer vaults: that instance stops rather than keep a value from a vault it lost.
   */
  readonly reloadSecrets: (
    instanceId?: ProviderInstanceId,
    narrowed?: ReadonlySet<string>,
  ) => Effect.Effect<void>;
}

export class ProviderInstanceRegistryMutator extends Context.Service<
  ProviderInstanceRegistryMutator,
  ProviderInstanceRegistryMutatorShape
>()("t3/provider/ProviderInstanceRegistryMutator") {}
