import type {
  EnvironmentId,
  ProjectId,
  SecretProviderConfig,
  SecretProviderId,
} from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import type { EnvironmentPresentation } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useEnvironmentSessionState } from "../../state/session";
import { OnePasswordIcon, type Icon } from "../Icons";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { SecretProviderDialog } from "./SecretProviderDialog";
import { classifySecretProvider } from "./SecretProviderDialog.logic";
import { SecretProviderVaultsDialog } from "./SecretProviderVaultsDialog";
import {
  projectsWithOwnVaultChoice,
  summarizeVaultChoice,
  type VaultChoiceTarget,
} from "./SecretProviderVaultsDialog.logic";
import { secretProviderUses } from "./SecretsSettings.logic";
import {
  classifyProviderEnvironmentAccess,
  resolveRemoteOperateAccess,
} from "./ProviderSettingsPanel.logic";
import { useSettingsScope } from "./SettingsScopeContext";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { searchableSetting } from "./settingsSearch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const SECRET_PROVIDER_KINDS: Readonly<
  Record<string, { readonly name: string; readonly icon: Icon }>
> = {
  one_password: { name: "1Password", icon: OnePasswordIcon },
};

export function SecretsSettingsPanel() {
  const { scope, environment } = useSettingsScope();
  const connected = environment?.connection.phase === "connected";
  return (
    <SettingsPageContainer>
      {connected &&
      environment.serverConfig !== null &&
      environment.serverConfig.secretProviderSettings !== true ? (
        <SettingsSection {...searchableSetting("secret-providers")}>
          <p className="px-4 py-3 text-sm text-muted-foreground">
            Update SECode on {environment.label} to manage its secret providers.
          </p>
        </SettingsSection>
      ) : connected ? (
        <EnvironmentSecretProviders
          key={environment.environmentId}
          environment={environment}
          projectScoped={scope.kind === "project" || scope.kind === "checkout"}
          projectIds={
            scope.kind === "project" || scope.kind === "checkout"
              ? scope.members
                  .filter((member) => member.environmentId === environment.environmentId)
                  .map((member) => member.id)
              : null
          }
          projectLabel={scope.label}
        />
      ) : (
        <SettingsSection {...searchableSetting("secret-providers")}>
          <p className="px-4 py-3 text-sm text-muted-foreground">
            Connect an environment to manage the secret providers its provider variables read from.
          </p>
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}

function EnvironmentSecretProviders({
  environment,
  projectScoped,
  projectIds,
  projectLabel,
}: {
  readonly environment: EnvironmentPresentation;
  readonly projectScoped: boolean;
  /** This environment's projects behind the selected project or checkout; null at environment scope. */
  readonly projectIds: ReadonlyArray<ProjectId> | null;
  readonly projectLabel: string;
}) {
  const environmentId = environment.environmentId;
  const sessionState = useEnvironmentSessionState(environmentId);
  // The server requires the same grant for secret providers as for provider settings.
  const access = classifyProviderEnvironmentAccess({
    connectionPhase: environment.connection.phase,
    hasServerConfig: environment.serverConfig !== null,
    operateAccess: resolveRemoteOperateAccess({
      session: sessionState.data,
      isPending: sessionState.isPending,
      hasError: sessionState.hasError,
    }),
  });
  const readOnly = access.kind !== "editable" || projectScoped;
  const providers = useEnvironmentSettings(environmentId, (settings) => settings.secretProviders);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const vaultSettings = useEnvironmentSettings(
    environmentId,
    (settings) => settings.secretProviderVaults,
  );
  const projects = useProjects();
  const vaultsSupported = environment.serverConfig?.secretProviderVaults === true;
  const vaultTarget: VaultChoiceTarget =
    projectIds === null ? { kind: "environment" } : { kind: "project", projectIds };
  const projectTitles = new Map(
    projects
      .filter((project) => project.environmentId === environmentId)
      .map((project) => [project.id as string, project.title]),
  );
  const [dialog, setDialog] = useState<
    | null
    | { readonly mode: "add" }
    | { readonly mode: "edit"; readonly id: SecretProviderId }
    | { readonly mode: "vaults"; readonly id: SecretProviderId }
  >(null);
  const entries = Object.entries(providers) as Array<[SecretProviderId, SecretProviderConfig]>;
  const editingConfig = dialog?.mode === "edit" ? providers[dialog.id] : undefined;
  const vaultsConfig = dialog?.mode === "vaults" ? providers[dialog.id] : undefined;
  const editing =
    dialog?.mode === "edit" && editingConfig !== undefined
      ? { id: dialog.id, config: editingConfig }
      : undefined;
  return (
    <>
      <SettingsSection
        {...searchableSetting("secret-providers")}
        headerAction={
          !readOnly ? (
            <Button size="xs" variant="outline" onClick={() => setDialog({ mode: "add" })}>
              <PlusIcon className="size-3" aria-hidden />
              Add provider
            </Button>
          ) : null
        }
      >
        {projectScoped ? (
          <p className="px-4 pt-3 text-xs text-muted-foreground">
            Environment-wide setting. Select an environment to change it.
          </p>
        ) : null}
        {entries.length === 0 ? (
          <SettingsRow
            title="No secret providers configured."
            description="Add a 1Password account, then pick it as the source of a provider variable."
          />
        ) : (
          entries.map(([id, config]) => {
            const classified = classifySecretProvider(config);
            const kind =
              classified.kind === "unsupported"
                ? undefined
                : SECRET_PROVIDER_KINDS[classified.kind];
            const canChooseVaults =
              vaultsSupported &&
              classified.kind === "one_password" &&
              access.kind === "editable" &&
              (projectIds === null || projectIds.length > 0);
            const showVaults = vaultsSupported && classified.kind === "one_password";
            const vaultEntry = Object.hasOwn(vaultSettings, id) ? vaultSettings[id] : undefined;
            const overriddenProjects =
              projectIds === null ? projectsWithOwnVaultChoice(vaultEntry, projectTitles) : [];
            return (
              <SettingsRow
                key={id}
                title={
                  <span className="flex min-w-0 items-center gap-2">
                    {kind ? (
                      <kind.icon className="size-4.5 shrink-0 text-foreground/80" aria-hidden />
                    ) : null}
                    <span className="min-w-0 wrap-anywhere">{config.label}</span>
                  </span>
                }
                description={
                  classified.kind === "one_password" && kind ? (
                    <span className="grid min-w-0 gap-0.5">
                      <span className="flex min-w-0 items-center gap-1">
                        <span className="shrink-0">{kind.name} ·</span>
                        <RedactedSensitiveText
                          value={classified.account}
                          ariaLabel="Toggle account visibility"
                          revealTooltip="Click to reveal account"
                          hideTooltip="Click to hide account"
                          className="max-w-full truncate"
                        />
                      </span>
                      {showVaults ? (
                        <span className="block wrap-anywhere">
                          {summarizeVaultChoice(vaultEntry, vaultTarget, environment.label)}
                        </span>
                      ) : null}
                      {overriddenProjects.length > 0 ? (
                        <span className="block wrap-anywhere">
                          Own vaults for: {overriddenProjects.join(", ")}
                        </span>
                      ) : null}
                    </span>
                  ) : (
                    `Unsupported provider (${config.kind})`
                  )
                }
                control={
                  !readOnly || canChooseVaults ? (
                    <div className="flex items-center gap-1">
                      {canChooseVaults ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => setDialog({ mode: "vaults", id })}
                        >
                          Vaults
                        </Button>
                      ) : null}
                      {readOnly ? null : kind ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => setDialog({ mode: "edit", id })}
                        >
                          Edit
                        </Button>
                      ) : null}
                      {readOnly ? null : (
                        <RemoveSecretProviderButton
                          environmentId={environmentId}
                          id={id}
                          label={config.label}
                          onConfirm={() => updateSettings({ secretProviders: { [id]: null } })}
                        />
                      )}
                    </div>
                  ) : null
                }
              />
            );
          })
        )}
      </SettingsSection>
      {dialog !== null && !readOnly && (dialog.mode === "add" || editing !== undefined) ? (
        <SecretProviderDialog
          onClose={() => setDialog(null)}
          environmentId={environmentId}
          environmentLabel={environment.label}
          existingIds={new Set(Object.keys(providers))}
          {...(editing === undefined ? {} : { existing: editing })}
        />
      ) : null}
      {dialog?.mode === "vaults" &&
      vaultsConfig !== undefined &&
      vaultsSupported &&
      access.kind === "editable" ? (
        <SecretProviderVaultsDialog
          onClose={() => setDialog(null)}
          environmentId={environmentId}
          environmentLabel={environment.label}
          providerId={dialog.id}
          providerLabel={vaultsConfig.label}
          entry={Object.hasOwn(vaultSettings, dialog.id) ? vaultSettings[dialog.id] : undefined}
          target={vaultTarget}
          projectLabel={projectLabel}
        />
      ) : null}
    </>
  );
}

function RemoveSecretProviderButton({
  environmentId,
  id,
  label,
  onConfirm,
}: {
  readonly environmentId: EnvironmentId;
  readonly id: SecretProviderId;
  readonly label: string;
  readonly onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        Remove
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {label}?</AlertDialogTitle>
            <SecretProviderUses environmentId={environmentId} id={id} label={label} />
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              Remove provider
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

function SecretProviderUses({
  environmentId,
  id,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly id: SecretProviderId;
  readonly label: string;
}) {
  const uses = secretProviderUses(useEnvironmentSettings(environmentId), id);
  if (uses.length === 0) {
    return (
      <AlertDialogDescription>
        Nothing reads from {label}. The secrets themselves are untouched.
      </AlertDialogDescription>
    );
  }
  return (
    <>
      <AlertDialogDescription>
        These read from {label} and will be unset. The secrets themselves are untouched.
      </AlertDialogDescription>
      <ul className="max-h-48 list-disc space-y-0.5 overflow-y-auto ps-5 text-sm wrap-anywhere">
        {uses.map((use) => (
          <li key={use.id}>{use.label}</li>
        ))}
      </ul>
    </>
  );
}
