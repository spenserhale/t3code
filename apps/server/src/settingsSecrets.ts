import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  EasDeviceHostConfig,
  type ProviderInstanceConfig,
  type ServerSettings,
  type ServerSettingsPatch,
  type SettingsSecretValue,
  SimlockDeviceHostConfig,
  UsageLimitSourceConfig,
  isSecretReference,
  secretSettingsFields,
} from "@t3tools/contracts";
import { acpRegistryClient } from "@t3tools/provider-acp-registry/client";
import { cursorClient } from "@t3tools/provider-cursor/client";
import { grokClient } from "@t3tools/provider-grok/client";
import { kiroClient } from "@t3tools/provider-kiro/client";
import { museClient } from "@t3tools/provider-muse/client";
import { openCodeClient } from "@t3tools/provider-opencode/client";
import { piClient } from "@t3tools/provider-pi/client";
import { secretProviderDefinitions } from "./secrets/secretProviderDefinitions.ts";
import {
  readSecretFieldValues,
  SOURCE_CONTROL_HOST_SECRET_FIELDS,
  sourceControlHostSecretName,
  writeSecretFieldValues,
} from "./sourceControl/sourceControlHostSecrets.ts";

export const SECRET_REDACTED = "\u2022\u2022\u2022\u2022\u2022\u2022";

const providerSecretFields = new Map([
  ["codex", secretSettingsFields(CodexSettings)],
  ["claudeAgent", secretSettingsFields(ClaudeSettings)],
  ["antigravity", secretSettingsFields(AntigravitySettings)],
  ...[
    cursorClient,
    grokClient,
    kiroClient,
    museClient,
    openCodeClient,
    piClient,
    acpRegistryClient,
  ].map(
    (definition) =>
      [definition.driverKind, secretSettingsFields(definition.settingsSchema)] as const,
  ),
]);
const usageLimitSecretFields = secretSettingsFields(UsageLimitSourceConfig);
const easDeviceHostSecretFields = secretSettingsFields(EasDeviceHostConfig);
const simlockDeviceHostSecretFields = secretSettingsFields(SimlockDeviceHostConfig);
const secretProviderSecretFields = new Map(
  secretProviderDefinitions.definitions.map(
    (definition) => [definition.kind, secretSettingsFields(definition.configSchema)] as const,
  ),
);
const encode = (value: string) => Buffer.from(value, "utf8").toString("base64url");

export interface SettingsSecret {
  readonly secretName: string;
  readonly kind: "field" | "environment";
  readonly value: string;
  readonly redacted: boolean;
  readonly sensitive: boolean;
  readonly providerInstanceId?: string;
  readonly environmentVariable?: string;
}

type SecretValue = Pick<SettingsSecret, "value" | "redacted">;
type SecretSlotName = (field: string, serverHost: string | null) => string;
type SecretFieldsMapper = (
  fields: Readonly<Record<string, unknown>>,
  secretFields: ReadonlyArray<string>,
  name: SecretSlotName,
) => Record<string, unknown>;
type ProviderEnvironment = NonNullable<ProviderInstanceConfig["environment"]>;

export function mapSettingsSecrets(
  settings: ServerSettings,
  map: (secret: SettingsSecret) => SecretValue,
): ServerSettings {
  const mapFields: SecretFieldsMapper = (fields, secretFields, name) => {
    const next = { ...fields };
    for (const field of secretFields) {
      if (!(field in next) || isSecretReference(next[field])) continue;
      next[field] = writeSecretFieldValues(
        next[field],
        readSecretFieldValues(next[field]).map(([serverHost, value]) => {
          const result = map({
            secretName: name(field, serverHost),
            kind: "field",
            value,
            redacted: value === SECRET_REDACTED,
            sensitive: true,
          });
          return [serverHost, result.redacted ? SECRET_REDACTED : result.value] as const;
        }),
      );
    }
    return next;
  };

  return mapSecretFieldGroups(settings, mapFields, (instanceId, environment) =>
    environment.map((variable) => {
      const { valueRedacted: _omit, ...rest } = variable;
      // A secret reference is not itself secret; storage sees the value cleared.
      const reference = typeof variable.value === "string" ? undefined : variable.value;
      const result = map({
        secretName: `provider-env-${encode(instanceId)}-${encode(variable.name)}`,
        kind: "environment",
        value: typeof variable.value === "string" ? variable.value : "",
        redacted: reference === undefined && variable.valueRedacted === true,
        sensitive: variable.sensitive,
        providerInstanceId: instanceId,
        environmentVariable: variable.name,
      });
      if (reference !== undefined) return { ...rest, value: reference };
      return {
        ...rest,
        value: result.value,
        ...(result.redacted ? { valueRedacted: true } : {}),
      };
    }),
  );
}

const isFields = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * A secret provider rewritten without one of its secret fields keeps the saved value, so an older
 * client that does not know the field cannot delete it. Only an empty value clears it.
 */
export function keepOmittedSecretProviderSecrets(
  current: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettingsPatch {
  if (patch.secretProviders === undefined) return patch;
  const saved = new Map(Object.entries(current.secretProviders));
  const secretProviders = Object.fromEntries(
    Object.entries(patch.secretProviders).map(([id, entry]) => {
      const previous = saved.get(id);
      const previousConfig = previous?.config;
      const config = entry?.config;
      if (entry === null || previous?.kind !== entry.kind) return [id, entry];
      if (!isFields(previousConfig) || !isFields(config)) return [id, entry];
      const kept = (secretProviderSecretFields.get(entry.kind) ?? []).filter(
        (field) => field in previousConfig && !(field in config),
      );
      if (kept.length === 0) return [id, entry];
      return [
        id,
        {
          ...entry,
          config: {
            ...config,
            ...Object.fromEntries(kept.map((field) => [field, previousConfig[field]])),
          },
        },
      ];
    }),
  );
  return { ...patch, secretProviders };
}

/**
 * Maps each value a secret field holds, literal or reference, with the secret name of its slot.
 * Provider environment variables are left as they are.
 */
export function mapSettingsSecretValues(
  settings: ServerSettings,
  map: (value: SettingsSecretValue, secretName: string) => SettingsSecretValue,
): ServerSettings {
  const mapValue = (value: unknown, secretName: string) =>
    typeof value === "string" || isSecretReference(value) ? map(value, secretName) : value;
  return mapSecretFieldGroups(settings, (fields, secretFields, name) => {
    const next = { ...fields };
    for (const field of secretFields) {
      if (!(field in next)) continue;
      const value = next[field];
      next[field] =
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        !isSecretReference(value)
          ? Object.fromEntries(
              Object.entries(value).map(([serverHost, entry]) => [
                serverHost,
                mapValue(entry, name(field, serverHost.trim().toLowerCase())),
              ]),
            )
          : mapValue(value, name(field, null));
    }
    return next;
  });
}

function mapSecretFieldGroups(
  settings: ServerSettings,
  mapFields: SecretFieldsMapper,
  mapEnvironment: (instanceId: string, environment: ProviderEnvironment) => ProviderEnvironment = (
    _instanceId,
    environment,
  ) => environment,
): ServerSettings {
  const providerInstances = Object.fromEntries(
    Object.entries(settings.providerInstances).map(([instanceId, instance]) => {
      const config = instance.config;
      return [
        instanceId,
        {
          ...instance,
          ...(config !== null && typeof config === "object" && !Array.isArray(config)
            ? {
                config: mapFields(
                  config as Record<string, unknown>,
                  providerSecretFields.get(instance.driver) ?? [],
                  (field, serverHost) =>
                    `provider-config-${encode(instanceId)}-${encode(instance.driver)}-${encode(field)}` +
                    (serverHost === null ? "" : `-${encode(serverHost)}`),
                ),
              }
            : {}),
          ...(instance.environment
            ? { environment: mapEnvironment(instanceId, instance.environment) }
            : {}),
        },
      ];
    }),
  );

  const sourceControlHosts = Object.fromEntries(
    Object.entries(settings.sourceControlHosts).map(([kind, fields]) => [
      kind,
      mapFields(fields, SOURCE_CONTROL_HOST_SECRET_FIELDS.get(kind) ?? [], (field, serverHost) =>
        sourceControlHostSecretName({ kind, field, serverHost }),
      ),
    ]),
  ) as ServerSettings["sourceControlHosts"];

  const usageLimitSources = Object.fromEntries(
    Object.entries(settings.usageLimitSources).map(([id, source]) => [
      id,
      mapFields(
        source,
        usageLimitSecretFields,
        (field, serverHost) =>
          `usage-limit-source-${encode(id)}` +
          (field === "managementKey" && serverHost === null
            ? ""
            : `-${encode(field)}${serverHost === null ? "" : `-${encode(serverHost)}`}`),
      ),
    ]),
  ) as ServerSettings["usageLimitSources"];

  const easDeviceHosts = settings.easDeviceHosts.map(
    (host) =>
      mapFields(
        host,
        easDeviceHostSecretFields,
        (field, serverHost) =>
          `device-host-${encode(host.id)}-${encode(field)}` +
          (serverHost === null ? "" : `-${encode(serverHost)}`),
      ) as EasDeviceHostConfig,
  );

  // Its own prefix: an EAS and a Simlock host may share an id.
  const simlockDeviceHosts = settings.simlockDeviceHosts.map(
    (host) =>
      mapFields(
        host,
        simlockDeviceHostSecretFields,
        (field, serverHost) =>
          `simlock-device-host-${encode(host.id)}-${encode(field)}` +
          (serverHost === null ? "" : `-${encode(serverHost)}`),
      ) as SimlockDeviceHostConfig,
  );

  const secretProviders = Object.fromEntries(
    Object.entries(settings.secretProviders).map(([id, provider]) => {
      const config = provider.config;
      return [
        id,
        config !== null && typeof config === "object" && !Array.isArray(config)
          ? {
              ...provider,
              config: mapFields(
                config as Record<string, unknown>,
                secretProviderSecretFields.get(provider.kind) ?? [],
                (field, serverHost) =>
                  `secret-provider-${encode(id)}-${encode(provider.kind)}-${encode(field)}` +
                  (serverHost === null ? "" : `-${encode(serverHost)}`),
              ),
            }
          : provider,
      ];
    }),
  ) as ServerSettings["secretProviders"];

  return {
    ...settings,
    providerInstances,
    sourceControlHosts,
    usageLimitSources,
    easDeviceHosts,
    simlockDeviceHosts,
    secretProviders,
  };
}
