import * as Schema from "effect/Schema";

import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { SecretProviderId } from "./secretReference.ts";

/**
 * Which vaults of a secret provider are read: per environment, with per-project overrides. A
 * provider with no entry opens every vault it can. Kept apart from the provider's config, so a
 * client that rebuilds that config without knowing this setting cannot clear it.
 */

const SECRET_PROVIDER_VAULTS_MAX = 100;
const SECRET_PROVIDER_VAULT_ID_MAX_LENGTH = 256;
const SECRET_PROVIDER_VAULT_NAME_MAX_LENGTH = 256;

export const SecretProviderVault = Schema.Struct({
  /** The provider's own id for the vault. Reads are checked against it, never the name. */
  id: TrimmedNonEmptyString,
  /** The vault's name when it was chosen, shown when the vault cannot be listed. */
  name: Schema.String,
});
export type SecretProviderVault = typeof SecretProviderVault.Type;

export const SecretProviderVaultScope = Schema.Struct({
  /** The vaults this environment reads. Absent opens every vault; empty opens none. */
  vaults: Schema.optionalKey(Schema.Array(SecretProviderVault)),
  /** A project's own choice replaces `vaults` for its threads. Null opens every vault. */
  projects: Schema.optionalKey(
    Schema.Record(ProjectId, Schema.NullOr(Schema.Array(SecretProviderVault))),
  ),
});
export type SecretProviderVaultScope = typeof SecretProviderVaultScope.Type;

// Like the other settings' limits, the caps apply to writes only, so they can change later.
const SecretProviderVaultListWrite = Schema.Array(
  Schema.Struct({
    id: TrimmedNonEmptyString.check(Schema.isMaxLength(SECRET_PROVIDER_VAULT_ID_MAX_LENGTH)),
    name: Schema.String.check(Schema.isMaxLength(SECRET_PROVIDER_VAULT_NAME_MAX_LENGTH)),
  }),
).check(Schema.isMaxLength(SECRET_PROVIDER_VAULTS_MAX));

export const SecretProviderVaultScopeWrite = Schema.Struct({
  vaults: Schema.optionalKey(SecretProviderVaultListWrite),
  projects: Schema.optionalKey(
    Schema.Record(ProjectId, Schema.NullOr(SecretProviderVaultListWrite)),
  ),
});
export type SecretProviderVaultScopeWrite = typeof SecretProviderVaultScopeWrite.Type;

export const SecretProviderVaultSettings = Schema.Record(
  SecretProviderId,
  SecretProviderVaultScope,
);
export type SecretProviderVaultSettings = typeof SecretProviderVaultSettings.Type;

/**
 * The vaults a provider may read for a thread of `projectId`, or for the environment itself when
 * `projectId` is null: the project's own choice, else the environment's, else every vault
 * (`undefined`).
 */
export const resolveSecretProviderVaults = (
  settings: SecretProviderVaultSettings,
  providerId: string,
  projectId: string | null,
): ReadonlyArray<SecretProviderVault> | undefined => {
  const scope = Object.hasOwn(settings, providerId)
    ? settings[providerId as SecretProviderId]
    : undefined;
  if (scope === undefined) return undefined;
  const projects = scope.projects;
  if (projectId !== null && projects !== undefined && Object.hasOwn(projects, projectId)) {
    return projects[projectId as ProjectId] ?? undefined;
  }
  return scope.vaults;
};

export const ListSecretProviderVaultsInput = Schema.Struct({
  secretProviderId: SecretProviderId,
});
export type ListSecretProviderVaultsInput = typeof ListSecretProviderVaultsInput.Type;

/** Every vault the provider's saved config can open, whatever the vault settings choose. */
export const ListSecretProviderVaultsResult = Schema.Struct({
  vaults: Schema.Array(SecretProviderVault),
});
export type ListSecretProviderVaultsResult = typeof ListSecretProviderVaultsResult.Type;

export class SecretProviderVaultsError extends Schema.TaggedError<SecretProviderVaultsError>()(
  "SecretProviderVaultsError",
  { message: Schema.String },
) {}
