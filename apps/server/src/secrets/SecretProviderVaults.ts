import {
  type ListSecretProviderVaultsResult,
  type SecretProviderId,
  SecretProviderVaultsError,
} from "@t3tools/contracts";
import type {
  SecretProviderDriver,
  SecretProviderDriverServices,
} from "@t3tools/secret-provider-core/server/driver";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Settings from "../serverSettings.ts";
import { BUILT_IN_SECRET_PROVIDER_DRIVER_LIST } from "./secretProviderDefinitions.ts";

/** The vaults a secret provider can open, for choosing which of them it may read. */
export class SecretProviderVaults extends Context.Service<
  SecretProviderVaults,
  {
    /**
     * Every vault the provider's saved config can open, whatever is chosen, by name. Listing opens
     * the password manager, which may ask to unlock on this machine.
     */
    readonly list: (
      secretProviderId: SecretProviderId,
    ) => Effect.Effect<ListSecretProviderVaultsResult, SecretProviderVaultsError>;
  }
>()("t3/secrets/SecretProviderVaults") {}

const failed = (message: string) => new SecretProviderVaultsError({ message });

export const make = Effect.fn("SecretProviderVaults.make")(function* (
  drivers: ReadonlyArray<SecretProviderDriver>,
) {
  const settings = yield* Settings.ServerSettingsService;
  const driverServices = yield* Effect.context<SecretProviderDriverServices>();

  const list: SecretProviderVaults["Service"]["list"] = Effect.fn("SecretProviderVaults.list")(
    function* (secretProviderId) {
      const { secretProviders } = yield* settings.getSettings.pipe(
        Effect.mapError(() => failed("Settings could not be read.")),
      );
      const provider = Object.hasOwn(secretProviders, secretProviderId)
        ? secretProviders[secretProviderId]
        : undefined;
      if (provider === undefined) {
        return yield* failed("That password manager is no longer set up on this machine.");
      }
      const driver = drivers.find((candidate) => candidate.kind === provider.kind);
      const listVaults = driver?.vaults?.list;
      if (driver === undefined || listVaults === undefined) {
        return yield* failed(
          `${driver?.definition.label ?? "This password manager"} cannot be limited to chosen vaults.`,
        );
      }
      const vaults = yield* listVaults(provider.config).pipe(Effect.provideContext(driverServices));
      if (vaults === undefined) {
        return yield* failed(
          `${driver.definition.label} on this machine did not list its vaults. It may be locked or waiting for approval, or the service account token may be wrong.`,
        );
      }
      return {
        vaults: [...vaults].sort(
          (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
        ),
      };
    },
  );

  return SecretProviderVaults.of({ list });
});

export const layer = Layer.effect(SecretProviderVaults, make(BUILT_IN_SECRET_PROVIDER_DRIVER_LIST));
