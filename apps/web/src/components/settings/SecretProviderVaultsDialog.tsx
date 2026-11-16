import type {
  EnvironmentId,
  SecretProviderId,
  SecretProviderVault,
  SecretProviderVaultScope,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { listSecretProviderVaults } from "../../secretProviderVaults";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Spinner } from "../ui/spinner";
import {
  draftFromVaultEntry,
  mergeVaultRows,
  summarizeVaults,
  toggleVaultId,
  vaultEntryFromDraft,
  type VaultChoiceDraft,
  type VaultChoiceMode,
  type VaultChoiceTarget,
} from "./SecretProviderVaultsDialog.logic";

type VaultListing =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly vaults: ReadonlyArray<SecretProviderVault> };

/**
 * Mounted per open, so each open starts from a fresh draft. Vaults are listed only once "Only these
 * vaults" is shown, never on page load: 1Password on the server may have to unlock.
 */
export function SecretProviderVaultsDialog({
  onClose,
  environmentId,
  environmentLabel,
  providerId,
  providerLabel,
  entry,
  target,
  projectLabel,
}: {
  readonly onClose: () => void;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly providerId: SecretProviderId;
  readonly providerLabel: string;
  readonly entry: SecretProviderVaultScope | undefined;
  readonly target: VaultChoiceTarget;
  /** The selected project's name, for a project target. */
  readonly projectLabel?: string;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [opened] = useState<VaultChoiceDraft>(() => draftFromVaultEntry(entry, target));
  const [draft, setDraft] = useState<VaultChoiceDraft>(opened);
  const [listing, setListing] = useState<VaultListing>(
    opened.mode === "only" ? { status: "loading" } : { status: "idle" },
  );
  const latestRequest = useRef(0);
  const load = useStableCallback(() => {
    latestRequest.current += 1;
    const request = latestRequest.current;
    setListing({ status: "loading" });
    void listSecretProviderVaults(environmentId, providerId).then((result) => {
      if (latestRequest.current !== request) return;
      setListing(
        "error" in result
          ? { status: "error", message: result.error }
          : { status: "ready", vaults: result.vaults },
      );
    });
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server for the live vault list when the dialog opens on a saved list; the request is outside React
  useEffect(() => {
    if (opened.mode === "only") load();
    return () => {
      latestRequest.current += 1;
    };
  }, [opened, load]);

  const isProject = target.kind === "project";
  const live = listing.status === "ready" ? listing.vaults : [];
  const rows = mergeVaultRows(live, draft.saved);
  const canSave = draft.mode !== "only" || listing.status === "ready";
  const save = () => {
    if (!canSave) return;
    updateSettings({
      secretProviderVaults: {
        [providerId]: vaultEntryFromDraft(entry, target, draft, rows),
      },
    });
    onClose();
  };
  const setMode = (mode: VaultChoiceMode) => {
    setDraft({ ...draft, mode });
    if (mode === "only" && listing.status === "idle") load();
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
          <DialogTitle>Vaults for {providerLabel}</DialogTitle>
          <DialogDescription>
            {isProject
              ? `Choose which vaults ${providerLabel} reads for ${projectLabel ?? "this project"}. Provider variables and requests relayed to another device use their environment's vaults.`
              : `Choose which vaults ${providerLabel} reads on ${environmentLabel}. Recommended: allow only the vaults agents need, such as a vault set aside for them.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="secret-provider-vaults-form"
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <RadioGroup
              aria-label="Vaults to read"
              value={draft.mode}
              onValueChange={(value) => setMode(value as VaultChoiceMode)}
            >
              {isProject ? (
                <ModeOption
                  value="inherit"
                  title={`Same as ${environmentLabel}`}
                  description={summarizeVaults(entry?.vaults)}
                />
              ) : null}
              <ModeOption value="all" title="All vaults" />
              <ModeOption value="only" title="Only these vaults" />
            </RadioGroup>
            {draft.mode === "only" ? (
              <VaultChecklist
                environmentLabel={environmentLabel}
                listing={listing}
                rows={rows}
                selectedIds={draft.selectedIds}
                onToggle={(id, checked) =>
                  setDraft({ ...draft, selectedIds: toggleVaultId(draft.selectedIds, id, checked) })
                }
                onRetry={load}
              />
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="secret-provider-vaults-form" disabled={!canSave}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ModeOption({
  value,
  title,
  description,
}: {
  readonly value: VaultChoiceMode;
  readonly title: string;
  readonly description?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <Radio value={value} className="mt-0.5" />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        {description === undefined ? null : (
          <span className="block text-xs text-muted-foreground wrap-anywhere">{description}</span>
        )}
      </span>
    </label>
  );
}

function VaultChecklist({
  environmentLabel,
  listing,
  rows,
  selectedIds,
  onToggle,
  onRetry,
}: {
  readonly environmentLabel: string;
  readonly listing: VaultListing;
  readonly rows: ReturnType<typeof mergeVaultRows>;
  readonly selectedIds: ReadonlyArray<string>;
  readonly onToggle: (id: string, checked: boolean) => void;
  readonly onRetry: () => void;
}) {
  if (listing.status === "idle" || listing.status === "loading") {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
        <Spinner size="sm" tone="muted" />
        Listing vaults. 1Password on {environmentLabel} may ask to unlock.
      </p>
    );
  }
  if (listing.status === "error") {
    return (
      <div className="grid gap-2" role="alert">
        <p className="text-xs text-destructive wrap-anywhere">{listing.message}</p>
        <div>
          <Button type="button" size="xs" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="grid gap-2">
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">This account has no vaults to list.</p>
      ) : (
        <div className="max-h-64 overflow-y-auto rounded-lg border divide-y">
          {rows.map((row) => (
            <label
              key={row.id}
              className="flex cursor-pointer items-center gap-2.5 px-3 py-2 hover:bg-muted/40"
            >
              <Checkbox
                checked={selectedIds.includes(row.id)}
                onCheckedChange={(checked) => onToggle(row.id, checked === true)}
              />
              <span className="min-w-0 text-sm wrap-anywhere">{row.name}</span>
              {row.missing ? (
                <span className="ms-auto shrink-0 text-xs text-muted-foreground">not found</span>
              ) : null}
            </label>
          ))}
        </div>
      )}
      {selectedIds.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          With none chosen, this provider reads no vault here.
        </p>
      ) : null}
    </div>
  );
}
