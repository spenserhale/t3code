import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, SecretProviderConfig, SecretProviderId } from "@t3tools/contracts";
import * as Result from "effect/Result";
import { XIcon } from "lucide-react";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { SecretInput } from "./SecretInput";
import {
  draftFromSecretProvider,
  secretProviderFromDraft,
  type SecretProviderDraft,
} from "./SecretProviderDialog.logic";

/** Mounted per open, so each open starts from a fresh draft. */
export function SecretProviderDialog({
  onClose,
  environmentId,
  environmentLabel,
  existingIds,
  existing,
}: {
  readonly onClose: () => void;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly existingIds: ReadonlySet<string>;
  readonly existing?: { readonly id: SecretProviderId; readonly config: SecretProviderConfig };
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  // An older server would save the token in plain settings and send it to every client.
  const acceptsServiceAccountToken = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    (config) => config?.secretProviderCredentials === true,
  );
  const [draft, setDraft] = useState<SecretProviderDraft>(
    existing
      ? draftFromSecretProvider(existing.config)
      : { name: "", account: "", serviceAccountToken: "", savedServiceAccountToken: "" },
  );
  const [submitted, setSubmitted] = useState(false);
  const result = secretProviderFromDraft(
    draft,
    existingIds,
    existing ? { mode: "edit", id: existing.id } : { mode: "add" },
  );
  const issues = Result.isFailure(result) ? result.failure : {};
  const nameError = submitted ? issues.name : undefined;
  const accountError = submitted ? issues.account : undefined;

  const update = (patch: Partial<SecretProviderDraft>) => setDraft({ ...draft, ...patch });
  const save = () => {
    setSubmitted(true);
    if (Result.isFailure(result)) return;
    updateSettings({ secretProviders: { [result.success.id]: result.success.config } });
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {existing ? `Edit ${existing.config.label}` : "Add a 1Password provider"}
          </DialogTitle>
          <DialogDescription>
            Provider variables on {environmentLabel} can read values from it by name. Values are
            read with the op CLI on that server when a provider starts.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="secret-provider-form"
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="secret-provider-name">Name</Label>
              <Input
                id="secret-provider-name"
                placeholder="Personal"
                value={draft.name}
                onChange={(event) => update({ name: event.target.value })}
                maxLength={64}
                aria-invalid={nameError !== undefined}
                aria-describedby={
                  nameError !== undefined ? "secret-provider-name-error" : undefined
                }
                autoFocus
              />
              {nameError !== undefined ? (
                <p
                  id="secret-provider-name-error"
                  role="alert"
                  className="text-xs text-destructive"
                >
                  {nameError}
                </p>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="secret-provider-account">Account</Label>
              <Input
                id="secret-provider-account"
                placeholder="my.1password.com"
                value={draft.account}
                onChange={(event) => update({ account: event.target.value })}
                maxLength={253}
                spellCheck={false}
                aria-invalid={accountError !== undefined}
                aria-describedby={
                  accountError !== undefined ? "secret-provider-account-error" : undefined
                }
              />
              {accountError !== undefined ? (
                <p
                  id="secret-provider-account-error"
                  role="alert"
                  className="text-xs text-destructive"
                >
                  {accountError}
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                The account shorthand, sign-in address without https://, or ID that op account list
                shows.
              </p>
            </div>
            {acceptsServiceAccountToken ? (
              <div className="grid gap-1.5">
                <Label htmlFor="secret-provider-token">Service account token</Label>
                <div className="flex items-center gap-2">
                  <SecretInput
                    id="secret-provider-token"
                    className="min-w-0 flex-1"
                    configured={draft.savedServiceAccountToken !== ""}
                    placeholder="Optional"
                    value={draft.serviceAccountToken}
                    onChange={(event) => update({ serviceAccountToken: event.target.value })}
                    aria-describedby="secret-provider-token-description"
                  />
                  {draft.savedServiceAccountToken !== "" ? (
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost-destructive"
                      onClick={() =>
                        update({ serviceAccountToken: "", savedServiceAccountToken: "" })
                      }
                      aria-label="Clear service account token"
                    >
                      <XIcon className="size-3.5" />
                    </Button>
                  ) : null}
                </div>
                <p id="secret-provider-token-description" className="text-xs text-muted-foreground">
                  For servers where nobody unlocks 1Password. Give the service account only the
                  vaults it needs.
                </p>
              </div>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="secret-provider-form"
            disabled={submitted && Result.isFailure(result)}
          >
            {existing ? "Save changes" : "Add provider"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
