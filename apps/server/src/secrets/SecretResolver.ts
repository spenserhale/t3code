import * as SecretResolverCore from "@t3tools/secret-provider-core/server/SecretResolver";
import { resolveSecretProviderVaults, type ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { BUILT_IN_SECRET_PROVIDER_DRIVER_LIST } from "./secretProviderDefinitions.ts";
import * as Settings from "../serverSettings.ts";

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const serverSettings = yield* Settings.ServerSettingsService;
    return SecretResolverCore.layer({
      drivers: BUILT_IN_SECRET_PROVIDER_DRIVER_LIST,
      secretProviders: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.secretProviders),
        Effect.orElseSucceed((): ServerSettings["secretProviders"] => ({})),
      ),
      // Settings secrets are read for the environment, so its vault choice applies. Settings that
      // cannot be read open no vault.
      vaults: serverSettings.getSettings.pipe(
        Effect.map(
          (settings) => (provider: string) =>
            resolveSecretProviderVaults(settings.secretProviderVaults, provider, null)?.map(
              (vault) => vault.id,
            ),
        ),
        Effect.orElseSucceed(() => () => []),
      ),
    });
  }),
);
