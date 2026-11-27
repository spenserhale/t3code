import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { SecretProviderKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { defineSecretProviderDriver, withSecretProviderVaults } from "./driver.ts";
import { defineSecretProvider } from "../shared/definition.ts";

const kind = SecretProviderKind.make("fake");

describe("defineSecretProviderDriver", () => {
  it.effect("passes a vault limit on, reads nothing with a malformed one, lists past it", () => {
    const seen: Array<unknown> = [];
    const driver = defineSecretProviderDriver({
      kind,
      definition: defineSecretProvider({
        kind,
        label: "Fake",
        configSchema: Schema.Struct({ account: Schema.String }),
        isReference: () => true,
        referencePlaceholder: "",
        invalidReferenceMessage: "",
      }),
      read: (config, references) =>
        Effect.sync(() => {
          seen.push(config);
          return references.map(() => "value");
        }),
      vaults: {
        list: (config) =>
          Effect.sync(() => {
            seen.push(config);
            return [{ id: "v1", name: "Work" }];
          }),
      },
    });
    const limited = withSecretProviderVaults({ account: "a", vaults: ["stored"] }, ["v1"]);
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* driver.read(limited, ["ref"]), ["value"]);
      for (const vaults of [3, ["v1", 2], null]) {
        assert.deepStrictEqual(yield* driver.read({ account: "a", vaults }, ["ref"]), [undefined]);
      }
      assert.deepStrictEqual(yield* driver.vaults!.list(limited), [{ id: "v1", name: "Work" }]);
      assert.deepStrictEqual(seen, [{ account: "a", vaults: ["v1"] }, { account: "a" }]);
      assert.deepStrictEqual(withSecretProviderVaults(limited, undefined), { account: "a" });
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
  });
});
