import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as JiraCredentials from "./JiraCredentials.ts";

const layer = JiraCredentials.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-jira-credentials-test-" }),
  ),
);

it.layer(NodeServices.layer)("JiraCredentials", (it) => {
  it.effect(
    "keeps the token in the secret store, apart from settings, and forgets it on clear",
    () =>
      Effect.gen(function* () {
        const credentials = yield* JiraCredentials.JiraCredentials;
        assert.isTrue(Option.isNone(yield* credentials.get));

        yield* credentials.set({
          siteUrl: "https://acme.atlassian.net",
          email: "sam@example.com",
          apiToken: Redacted.make("token-123"),
        });
        const read = yield* credentials.get;
        assert.isTrue(Option.isSome(read));
        if (Option.isSome(read)) {
          assert.strictEqual(read.value.siteUrl, "https://acme.atlassian.net");
          assert.strictEqual(read.value.email, "sam@example.com");
          assert.strictEqual(Redacted.value(read.value.apiToken), "token-123");
          assert.notInclude(String(read.value.apiToken), "token-123");
        }

        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const mode = (yield* fileSystem.stat(
          path.join(secrets.directory ?? "", "jira-credentials.bin"),
        )).mode;
        assert.strictEqual(mode & 0o077, 0);

        yield* credentials.clear;
        assert.isTrue(Option.isNone(yield* credentials.get));
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "reads a secret that no longer decodes as not set up, so saving again replaces it",
    () =>
      Effect.gen(function* () {
        const credentials = yield* JiraCredentials.JiraCredentials;
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        yield* secrets.set("jira-credentials", new TextEncoder().encode("{not json"));
        assert.isTrue(Option.isNone(yield* credentials.get));
      }).pipe(Effect.provide(layer)),
  );

  it.effect("reports a secret store failure as a request error that names no secret", () =>
    Effect.gen(function* () {
      const credentials = yield* JiraCredentials.JiraCredentials;
      const error = yield* credentials.get.pipe(Effect.flip);
      assert.strictEqual(error._tag, "JiraRequestError");
      assert.strictEqual(error.message, "The saved Jira credentials could not be read.");
    }).pipe(
      Effect.provide(
        JiraCredentials.layer.pipe(
          Layer.provide(
            Layer.succeed(
              ServerSecretStore.ServerSecretStore,
              ServerSecretStore.ServerSecretStore.of({
                get: () =>
                  Effect.fail(
                    new ServerSecretStore.SecretStoreReadError({
                      resource: "secret jira-credentials",
                      cause: "denied",
                    }),
                  ),
                set: () => Effect.die("not expected"),
                create: () => Effect.die("not expected"),
                getOrCreateRandom: () => Effect.die("not expected"),
                remove: () => Effect.die("not expected"),
              }),
            ),
          ),
        ),
      ),
    ),
  );
});
