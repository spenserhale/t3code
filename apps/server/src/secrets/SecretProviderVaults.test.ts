import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { SecretProviderId, SecretProviderKind } from "@t3tools/contracts";
import { defineSecretProviderDriver } from "@t3tools/secret-provider-core/server/driver";
import { defineSecretProvider } from "@t3tools/secret-provider-core/shared/definition";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Settings from "../serverSettings.ts";
import * as SecretProviderVaults from "./SecretProviderVaults.ts";

const listing = SecretProviderKind.make("listing_vault");
const plain = SecretProviderKind.make("plain_vault");
const definition = (kind: SecretProviderKind, label: string) =>
  defineSecretProvider({
    kind,
    label,
    configSchema: Schema.Struct({ account: Schema.String }),
    isReference: () => true,
    referencePlaceholder: "",
    invalidReferenceMessage: "",
  });
const readNothing = (_config: unknown, references: ReadonlyArray<string>) =>
  Effect.succeed(references.map(() => undefined));

describe("SecretProviderVaults", () => {
  it.effect("lists every vault a provider can open by name, or says plainly why not", () => {
    const drivers = [
      defineSecretProviderDriver({
        kind: listing,
        definition: definition(listing, "Listing Vault"),
        read: readNothing,
        vaults: {
          // `locked` stands for a password manager waiting to be unlocked.
          list: ({ account }) =>
            Effect.succeed(
              account === "locked"
                ? undefined
                : [
                    { id: "v3", name: "Secode" },
                    { id: "v1", name: "AWS Servers" },
                    { id: "v2", name: "Private" },
                  ],
            ),
        },
      }),
      defineSecretProviderDriver({
        kind: plain,
        definition: definition(plain, "Plain Vault"),
        read: readNothing,
      }),
    ];
    const provider = (kind: SecretProviderKind, account: string) => ({
      kind,
      label: account,
      config: { account },
    });
    const layer = Layer.effect(
      SecretProviderVaults.SecretProviderVaults,
      SecretProviderVaults.make(drivers),
    ).pipe(
      Layer.provide(
        Settings.layerTest({
          secretProviders: {
            [SecretProviderId.make("personal")]: provider(listing, "personal"),
            [SecretProviderId.make("locked")]: provider(listing, "locked"),
            [SecretProviderId.make("other")]: provider(plain, "other"),
          },
          // What is chosen does not narrow the list it is chosen from.
          secretProviderVaults: {
            [SecretProviderId.make("personal")]: { vaults: [{ id: "v3", name: "Secode" }] },
          },
        }),
      ),
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    );
    return Effect.gen(function* () {
      const vaults = yield* SecretProviderVaults.SecretProviderVaults;
      assert.deepStrictEqual(yield* vaults.list(SecretProviderId.make("personal")), {
        vaults: [
          { id: "v1", name: "AWS Servers" },
          { id: "v2", name: "Private" },
          { id: "v3", name: "Secode" },
        ],
      });
      const failures = yield* Effect.forEach(["missing", "other", "locked"], (id) =>
        vaults.list(SecretProviderId.make(id)).pipe(Effect.flip),
      );
      assert.deepStrictEqual(
        failures.map((error) => [error._tag, error.message]),
        [
          [
            "SecretProviderVaultsError",
            "That password manager is no longer set up on this machine.",
          ],
          ["SecretProviderVaultsError", "Plain Vault cannot be limited to chosen vaults."],
          [
            "SecretProviderVaultsError",
            "Listing Vault on this machine did not list its vaults. It may be locked or waiting for approval, or the service account token may be wrong.",
          ],
        ],
      );
    }).pipe(Effect.provide(layer));
  });
});
