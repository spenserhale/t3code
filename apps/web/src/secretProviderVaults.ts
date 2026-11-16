import type { EnvironmentId, SecretProviderId, SecretProviderVault } from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";

import { appAtomRegistry } from "./rpc/atomRegistry";
import { formatEnvironmentQueryError } from "./state/query";
import { serverEnvironment } from "./state/server";

/**
 * Asks the server for every vault the provider can open. The server may have to unlock the
 * password manager, so callers run this only when the user asks. Resolves to the server's message
 * on failure.
 */
export async function listSecretProviderVaults(
  environmentId: EnvironmentId,
  secretProviderId: SecretProviderId,
): Promise<{ readonly vaults: ReadonlyArray<SecretProviderVault> } | { readonly error: string }> {
  const result = await runAtomCommand(
    appAtomRegistry,
    serverEnvironment.listSecretProviderVaults,
    { environmentId, input: { secretProviderId } },
    { reportFailure: false },
  );
  return result._tag === "Success"
    ? { vaults: result.value.vaults }
    : { error: formatEnvironmentQueryError(result.cause) };
}
