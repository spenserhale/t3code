/**
 * JiraCredentials - the Jira site, email and API token this environment uses,
 * kept in the server secret store as one entry. Nothing is written to settings.
 *
 * @module JiraCredentials
 */
import { JiraRequestError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import type { JiraCredential } from "./JiraClient.ts";

const SECRET_NAME = "jira-credentials";

const StoredCredential = Schema.Struct({
  siteUrl: Schema.String,
  email: Schema.String,
  apiToken: Schema.String,
});
const decodeStored = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredCredential));
const encodeStored = Schema.encodeEffect(Schema.fromJsonString(StoredCredential));

export class JiraCredentials extends Context.Service<
  JiraCredentials,
  {
    readonly get: Effect.Effect<Option.Option<JiraCredential>, JiraRequestError>;
    readonly set: (credential: JiraCredential) => Effect.Effect<void, JiraRequestError>;
    readonly clear: Effect.Effect<void, JiraRequestError>;
  }
>()("t3/jira/JiraCredentials") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const failed = () => new JiraRequestError({ operation: "credentials" });

  const get = Effect.gen(function* () {
    const stored = yield* secrets.get(SECRET_NAME);
    if (Option.isNone(stored)) return Option.none<JiraCredential>();
    // A file that no longer decodes is treated as not set up; saving again replaces it.
    return yield* decodeStored(new TextDecoder().decode(stored.value)).pipe(
      Effect.map((credential) =>
        Option.some<JiraCredential>({
          siteUrl: credential.siteUrl,
          email: credential.email,
          apiToken: Redacted.make(credential.apiToken),
        }),
      ),
      Effect.catchTags({ SchemaError: () => Effect.succeed(Option.none<JiraCredential>()) }),
    );
  }).pipe(Effect.mapError(failed), Effect.withSpan("JiraCredentials.get"));

  const set = Effect.fn("JiraCredentials.set")(function* (credential: JiraCredential) {
    const encoded = yield* encodeStored({
      siteUrl: credential.siteUrl,
      email: credential.email,
      apiToken: Redacted.value(credential.apiToken),
    });
    yield* secrets.set(SECRET_NAME, new TextEncoder().encode(encoded));
  }, Effect.mapError(failed));

  const clear = secrets
    .remove(SECRET_NAME)
    .pipe(Effect.mapError(failed), Effect.withSpan("JiraCredentials.clear"));

  return JiraCredentials.of({ get, set, clear });
});

export const layer = Layer.effect(JiraCredentials, make);
