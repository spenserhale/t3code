import type { SecretProviderKind } from "@t3tools/contracts";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import type { ChildProcessSpawner } from "effect/process";

import type { SecretProviderDefinition } from "../shared/definition.ts";

/** What the server gives every driver. A driver builds anything else it needs itself. */
export type SecretProviderDriverServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | SecureRandom.SecureRandom;

export type SecretProviderLoginField = "username" | "password" | "totp";

/** A saved website login, without any of its secrets. */
export interface SecretProviderLogin {
  readonly id: string;
  readonly title: string;
  readonly vault?: string;
  /** For a provider that must name the vault to read the login. Server-side only. */
  readonly vaultId?: string;
  /** Websites the provider would autofill this login on. */
  readonly urls: ReadonlyArray<string>;
}

export type SecretProviderLoginValues = Partial<Record<SecretProviderLoginField, string>>;

/** What the provider's generator makes: letters always, digits and symbols when asked. */
export interface SecretProviderPasswordRecipe {
  readonly length: number;
  readonly digits: boolean;
  readonly symbols: boolean;
}

/** A login to save for a sign-up. The provider generates its password. */
export interface SecretProviderNewLogin {
  /** A vault name or id. */
  readonly vault: string;
  readonly title: string;
  readonly url: string;
  readonly username: string;
  readonly recipe: SecretProviderPasswordRecipe;
  readonly notes: string;
}

/** Optional: a provider that can sign the built-in browser in to websites. */
export interface SecretProviderLogins<Config = unknown> {
  /** `undefined` when the provider could not be read. */
  readonly list: (
    config: Config,
  ) => Effect.Effect<
    ReadonlyArray<SecretProviderLogin> | undefined,
    never,
    SecretProviderDriverServices
  >;
  readonly read: (
    config: Config,
    login: SecretProviderLogin,
    fields: ReadonlyArray<SecretProviderLoginField>,
  ) => Effect.Effect<SecretProviderLoginValues | undefined, never, SecretProviderDriverServices>;
  /**
   * Optional: saves a new login with a password the provider generates, so the password is never
   * on a command line. `undefined` when it was not saved. The password comes back only when the
   * save showed it; otherwise the caller reads it with `read`, keeping the saved login if that fails.
   */
  readonly create?: (
    config: Config,
    login: SecretProviderNewLogin,
  ) => Effect.Effect<
    { readonly login: SecretProviderLogin; readonly password: string | undefined } | undefined,
    never,
    SecretProviderDriverServices
  >;
  /**
   * Optional: replaces a login's password with a newly generated one. `undefined` when it was not
   * replaced; the password comes back only when the change showed it, as with `create`.
   */
  readonly regeneratePassword?: (
    config: Config,
    login: SecretProviderLogin,
    recipe: SecretProviderPasswordRecipe,
  ) => Effect.Effect<
    { readonly password: string | undefined } | undefined,
    never,
    SecretProviderDriverServices
  >;
}

export type SecretProviderIdentityField =
  | "firstName"
  | "middleInitial"
  | "lastName"
  | "email"
  | "phone"
  | "company"
  | "jobTitle"
  | "birthDate"
  | "address"
  | "street"
  | "city"
  | "state"
  | "postalCode"
  | "country"
  | "username";

/** A saved identity (name, contact details, address), without its values. */
export interface SecretProviderIdentity {
  readonly id: string;
  readonly title: string;
  readonly vault?: string;
  /** For a provider that must name the vault to read the identity. Server-side only. */
  readonly vaultId?: string;
}

/**
 * `birthDate` is `YYYY-MM-DD` when the provider stores a date; `country` is as stored. `address`
 * is the whole address on one line, given instead of its parts when the provider has no parts.
 */
export type SecretProviderIdentityValues = Partial<Record<SecretProviderIdentityField, string>>;

/** Optional: a provider that can fill personal details into sign-up forms. */
export interface SecretProviderIdentities<Config = unknown> {
  /** `undefined` when the provider could not be read. */
  readonly list: (
    config: Config,
  ) => Effect.Effect<
    ReadonlyArray<SecretProviderIdentity> | undefined,
    never,
    SecretProviderDriverServices
  >;
  readonly read: (
    config: Config,
    identity: SecretProviderIdentity,
  ) => Effect.Effect<SecretProviderIdentityValues | undefined, never, SecretProviderDriverServices>;
}

export interface SecretProviderDriver {
  readonly kind: SecretProviderKind;
  readonly definition: SecretProviderDefinition;
  /**
   * Values in input order; `undefined` marks a reference that could not be read. `config` has
   * decoded with the definition's `configSchema` and every reference passed its `isReference`.
   */
  readonly read: (
    config: unknown,
    references: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string | undefined>, never, SecretProviderDriverServices>;
  readonly logins?: SecretProviderLogins;
  readonly identities?: SecretProviderIdentities;
}

export const defineSecretProviderDriver = <Config>(driver: {
  readonly kind: SecretProviderKind;
  readonly definition: SecretProviderDefinition<Config>;
  readonly read: (
    config: Config,
    references: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string | undefined>, never, SecretProviderDriverServices>;
  readonly logins?: SecretProviderLogins<Config>;
  readonly identities?: SecretProviderIdentities<Config>;
}): SecretProviderDriver => {
  const isConfig = Schema.is(driver.definition.configSchema);
  const logins = driver.logins;
  const create = logins?.create;
  const regeneratePassword = logins?.regeneratePassword;
  const identities = driver.identities;
  return {
    kind: driver.kind,
    definition: driver.definition,
    read: (config, references) =>
      isConfig(config)
        ? driver.read(config, references)
        : Effect.succeed(references.map(() => undefined)),
    ...(logins === undefined
      ? {}
      : {
          logins: {
            list: (config) =>
              isConfig(config) ? logins.list(config) : Effect.sync(() => undefined),
            read: (config, login, fields) =>
              isConfig(config) ? logins.read(config, login, fields) : Effect.sync(() => undefined),
            ...(create === undefined
              ? {}
              : {
                  create: (config, login) =>
                    isConfig(config) ? create(config, login) : Effect.sync(() => undefined),
                }),
            ...(regeneratePassword === undefined
              ? {}
              : {
                  regeneratePassword: (config, login, recipe) =>
                    isConfig(config)
                      ? regeneratePassword(config, login, recipe)
                      : Effect.sync(() => undefined),
                }),
          },
        }),
    ...(identities === undefined
      ? {}
      : {
          identities: {
            list: (config) =>
              isConfig(config) ? identities.list(config) : Effect.sync(() => undefined),
            read: (config, identity) =>
              isConfig(config) ? identities.read(config, identity) : Effect.sync(() => undefined),
          },
        }),
  };
};
