import type { ProjectId, SecretProviderVault, SecretProviderVaultScope } from "@t3tools/contracts";

/** Where a vault choice is made: the environment itself, or the projects of one environment. */
export type VaultChoiceTarget =
  | { readonly kind: "environment" }
  | { readonly kind: "project"; readonly projectIds: ReadonlyArray<ProjectId> };

export type VaultChoiceMode = "inherit" | "all" | "only";

export interface VaultChoiceDraft {
  readonly mode: VaultChoiceMode;
  /** Ids of the vaults ticked under "only". */
  readonly selectedIds: ReadonlyArray<string>;
  /** The saved vaults when the dialog opened, to keep names of vaults the list no longer has. */
  readonly saved: ReadonlyArray<SecretProviderVault>;
}

/** The project's own entry: the first of its projects that has one. */
function projectChoice(
  entry: SecretProviderVaultScope | undefined,
  projectIds: ReadonlyArray<ProjectId>,
):
  | { readonly own: false }
  | { readonly own: true; readonly vaults: ReadonlyArray<SecretProviderVault> | null } {
  const projects = entry?.projects;
  if (projects === undefined) return { own: false };
  for (const id of projectIds) {
    if (Object.hasOwn(projects, id)) return { own: true, vaults: projects[id] ?? null };
  }
  return { own: false };
}

export function draftFromVaultEntry(
  entry: SecretProviderVaultScope | undefined,
  target: VaultChoiceTarget,
): VaultChoiceDraft {
  const fromList = (
    mode: VaultChoiceMode,
    vaults: ReadonlyArray<SecretProviderVault> | undefined | null,
  ): VaultChoiceDraft => ({
    mode: vaults === undefined || vaults === null ? mode : "only",
    selectedIds: vaults?.map((vault) => vault.id) ?? [],
    saved: vaults ?? [],
  });
  if (target.kind === "environment") return fromList("all", entry?.vaults);
  const choice = projectChoice(entry, target.projectIds);
  return choice.own ? fromList("all", choice.vaults) : fromList("inherit", undefined);
}

/** The entry to save, or null when nothing is left and the provider's entry can go. */
export function vaultEntryFromDraft(
  entry: SecretProviderVaultScope | undefined,
  target: VaultChoiceTarget,
  draft: VaultChoiceDraft,
  /** The listed vaults and the saved ones: where names for the ticked ids come from. */
  rows: ReadonlyArray<VaultRow>,
): SecretProviderVaultScope | null {
  const chosen: ReadonlyArray<SecretProviderVault> = rows
    .filter((row) => draft.selectedIds.includes(row.id))
    .map(({ id, name }) => ({ id, name }));
  let vaults = entry?.vaults;
  let projects = entry?.projects;
  if (target.kind === "environment") {
    vaults = draft.mode === "only" ? chosen : undefined;
  } else {
    const next: Record<string, ReadonlyArray<SecretProviderVault> | null> = { ...projects };
    for (const id of target.projectIds) {
      if (draft.mode === "inherit") delete next[id];
      else next[id] = draft.mode === "only" ? chosen : null;
    }
    projects = Object.keys(next).length === 0 ? undefined : (next as typeof projects);
  }
  if (vaults === undefined && projects === undefined) return null;
  return {
    ...(vaults === undefined ? {} : { vaults }),
    ...(projects === undefined ? {} : { projects }),
  };
}

export interface VaultRow {
  readonly id: string;
  readonly name: string;
  /** Saved earlier but absent from the live list. */
  readonly missing: boolean;
}

/** The live list plus saved vaults it lacks, by name. */
export function mergeVaultRows(
  live: ReadonlyArray<SecretProviderVault>,
  saved: ReadonlyArray<SecretProviderVault>,
): ReadonlyArray<VaultRow> {
  const liveIds = new Set(live.map((vault) => vault.id));
  const seen = new Set<string>();
  const rows: VaultRow[] = [];
  for (const vault of live) {
    if (seen.has(vault.id)) continue;
    seen.add(vault.id);
    rows.push({ id: vault.id, name: vault.name, missing: false });
  }
  for (const vault of saved) {
    if (liveIds.has(vault.id) || seen.has(vault.id)) continue;
    seen.add(vault.id);
    rows.push({ id: vault.id, name: vault.name || vault.id, missing: true });
  }
  return rows.toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function toggleVaultId(
  selectedIds: ReadonlyArray<string>,
  id: string,
  checked: boolean,
): ReadonlyArray<string> {
  const rest = selectedIds.filter((candidate) => candidate !== id);
  return checked ? [...rest, id] : rest;
}

const LISTED_VAULT_NAMES = 2;

/** "All vaults", "No vaults", "Secode, AWS Servers", or "Secode and 3 more". */
export function summarizeVaults(vaults: ReadonlyArray<SecretProviderVault> | undefined): string {
  if (vaults === undefined) return "All vaults";
  if (vaults.length === 0) return "No vaults";
  const names = vaults.map((vault) => vault.name || vault.id);
  if (names.length <= LISTED_VAULT_NAMES) return names.join(", ");
  return `${names[0]} and ${names.length - 1} more`;
}

/** The one-line summary under a provider: the choice here, and where it comes from at a project. */
export function summarizeVaultChoice(
  entry: SecretProviderVaultScope | undefined,
  target: VaultChoiceTarget,
  environmentLabel: string,
): string {
  if (target.kind === "environment") return summarizeVaults(entry?.vaults);
  const choice = projectChoice(entry, target.projectIds);
  return choice.own
    ? `This project: ${summarizeVaults(choice.vaults ?? undefined)}`
    : `Inherited from ${environmentLabel}: ${summarizeVaults(entry?.vaults)}`;
}

/** Titles of the projects with their own choice, sorted. Projects the client does not know are left out. */
export function projectsWithOwnVaultChoice(
  entry: SecretProviderVaultScope | undefined,
  titleByProjectId: ReadonlyMap<string, string>,
): ReadonlyArray<string> {
  const titles = Object.keys(entry?.projects ?? {}).flatMap((id) => {
    const title = titleByProjectId.get(id);
    return title === undefined ? [] : [title];
  });
  return [...new Set(titles)].toSorted((a, b) => a.localeCompare(b));
}

/** Whether a vault choice leaves out the vault named (case-insensitive) or identified by `vault`. */
export function vaultChoiceExcludes(
  allowed: ReadonlyArray<SecretProviderVault> | undefined,
  vault: string,
): boolean {
  if (allowed === undefined) return false;
  const wanted = vault.trim().toLowerCase();
  return !allowed.some(
    (candidate) => candidate.id === vault || candidate.name.toLowerCase() === wanted,
  );
}
