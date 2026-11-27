import type { ProjectId, SecretProviderVault, SecretProviderVaultScope } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  draftFromVaultEntry,
  mergeVaultRows,
  projectsWithOwnVaultChoice,
  summarizeVaultChoice,
  summarizeVaults,
  toggleVaultId,
  vaultChoiceExcludes,
  vaultEntryFromDraft,
  type VaultChoiceTarget,
} from "./SecretProviderVaultsDialog.logic";

const vault = (id: string, name: string): SecretProviderVault => ({ id, name });
const secode = vault("v1", "Secode");
const aws = vault("v2", "AWS Servers");
const acento = vault("v3", "Acento Pay");
const p1 = "p1" as ProjectId;
const p2 = "p2" as ProjectId;
const env: VaultChoiceTarget = { kind: "environment" };
const project = (...ids: ProjectId[]): VaultChoiceTarget => ({ kind: "project", projectIds: ids });
const rows = mergeVaultRows([secode, aws, acento], []);

describe("draftFromVaultEntry", () => {
  it("reads no entry as every vault at the environment and as inheriting at a project", () => {
    expect(draftFromVaultEntry(undefined, env)).toMatchObject({ mode: "all", selectedIds: [] });
    expect(draftFromVaultEntry(undefined, project(p1))).toMatchObject({ mode: "inherit" });
  });

  it("keeps an empty list as a choice of no vaults", () => {
    expect(draftFromVaultEntry({ vaults: [] }, env)).toMatchObject({
      mode: "only",
      selectedIds: [],
    });
  });

  it("reads a project's null as every vault and its list as those vaults", () => {
    const entry: SecretProviderVaultScope = {
      vaults: [secode],
      projects: { [p1]: null, [p2]: [acento] },
    };
    expect(draftFromVaultEntry(entry, project(p1))).toMatchObject({ mode: "all" });
    expect(draftFromVaultEntry(entry, project(p2))).toMatchObject({
      mode: "only",
      selectedIds: ["v3"],
    });
  });

  it("uses the first checkout that has its own choice", () => {
    expect(draftFromVaultEntry({ projects: { [p2]: [acento] } }, project(p1, p2))).toMatchObject({
      mode: "only",
    });
  });
});

describe("vaultEntryFromDraft", () => {
  it("sets the environment's vaults and keeps project choices", () => {
    const entry: SecretProviderVaultScope = { projects: { [p1]: null } };
    const draft = {
      ...draftFromVaultEntry(entry, env),
      mode: "only" as const,
      selectedIds: ["v2", "v1"],
    };
    expect(vaultEntryFromDraft(entry, env, draft, rows)).toEqual({
      vaults: [aws, secode],
      projects: { [p1]: null },
    });
  });

  it("returns every vault at the environment by dropping vaults, and null when nothing is left", () => {
    const draft = { ...draftFromVaultEntry({ vaults: [secode] }, env), mode: "all" as const };
    expect(vaultEntryFromDraft({ vaults: [secode] }, env, draft, rows)).toBeNull();
    expect(
      vaultEntryFromDraft({ vaults: [secode], projects: { [p1]: [] } }, env, draft, rows),
    ).toEqual({ projects: { [p1]: [] } });
  });

  it("saves none as an empty list", () => {
    const draft = { ...draftFromVaultEntry(undefined, env), mode: "only" as const };
    expect(vaultEntryFromDraft(undefined, env, draft, rows)).toEqual({ vaults: [] });
  });

  it("writes a project's choice and keeps the environment's vaults", () => {
    const entry: SecretProviderVaultScope = { vaults: [secode] };
    const base = draftFromVaultEntry(entry, project(p1));
    expect(vaultEntryFromDraft(entry, project(p1), { ...base, mode: "all" }, rows)).toEqual({
      vaults: [secode],
      projects: { [p1]: null },
    });
    expect(
      vaultEntryFromDraft(
        entry,
        project(p1, p2),
        { ...base, mode: "only", selectedIds: ["v3"] },
        rows,
      ),
    ).toEqual({ vaults: [secode], projects: { [p1]: [acento], [p2]: [acento] } });
  });

  it("returns a project to inheriting, and null when the entry is then empty", () => {
    const entry: SecretProviderVaultScope = { projects: { [p1]: [acento], [p2]: null } };
    const inherit = { ...draftFromVaultEntry(entry, project(p1)), mode: "inherit" as const };
    expect(vaultEntryFromDraft(entry, project(p1), inherit, rows)).toEqual({
      projects: { [p2]: null },
    });
    expect(
      vaultEntryFromDraft({ projects: { [p1]: null } }, project(p1), inherit, rows),
    ).toBeNull();
  });

  it("keeps the saved name of a vault the list no longer has", () => {
    const gone = vault("v9", "Old vault");
    const merged = mergeVaultRows([secode], [gone]);
    const draft = { ...draftFromVaultEntry({ vaults: [gone] }, env), selectedIds: ["v9", "v1"] };
    expect(vaultEntryFromDraft({ vaults: [gone] }, env, draft, merged)).toEqual({
      vaults: [gone, secode],
    });
  });
});

describe("mergeVaultRows", () => {
  it("sorts by name and marks saved vaults the live list lacks", () => {
    expect(mergeVaultRows([secode, aws], [vault("v1", "Renamed"), vault("v9", "Gone")])).toEqual([
      { id: "v2", name: "AWS Servers", missing: false },
      { id: "v9", name: "Gone", missing: true },
      { id: "v1", name: "Secode", missing: false },
    ]);
  });
});

describe("toggleVaultId", () => {
  it("adds and removes without duplicating", () => {
    expect(toggleVaultId(["a"], "b", true)).toEqual(["a", "b"]);
    expect(toggleVaultId(["a", "b"], "b", true)).toEqual(["a", "b"]);
    expect(toggleVaultId(["a", "b"], "a", false)).toEqual(["b"]);
  });
});

describe("summaries", () => {
  it("shortens long lists", () => {
    expect(summarizeVaults(undefined)).toBe("All vaults");
    expect(summarizeVaults([])).toBe("No vaults");
    expect(summarizeVaults([secode, aws])).toBe("Secode, AWS Servers");
    expect(summarizeVaults([secode, aws, acento, vault("v4", "D"), vault("v5", "E")])).toBe(
      "Secode and 4 more",
    );
  });

  it("says where a project's choice comes from", () => {
    const entry: SecretProviderVaultScope = { vaults: [], projects: { [p1]: [acento] } };
    expect(summarizeVaultChoice(entry, env, "LinkPro")).toBe("No vaults");
    expect(summarizeVaultChoice(entry, project(p1), "LinkPro")).toBe("This project: Acento Pay");
    expect(summarizeVaultChoice(entry, project(p2), "LinkPro")).toBe(
      "Inherited from LinkPro: No vaults",
    );
    expect(summarizeVaultChoice(undefined, project(p2), "LinkPro")).toBe(
      "Inherited from LinkPro: All vaults",
    );
    expect(summarizeVaultChoice({ projects: { [p1]: null } }, project(p1), "LinkPro")).toBe(
      "This project: All vaults",
    );
  });
});

describe("projectsWithOwnVaultChoice", () => {
  it("names known projects once, sorted", () => {
    const titles = new Map<string, string>([
      [p1, "Zed"],
      [p2, "Alpha"],
    ]);
    expect(
      projectsWithOwnVaultChoice(
        { projects: { [p1]: null, [p2]: [], ["p3" as ProjectId]: null } },
        titles,
      ),
    ).toEqual(["Alpha", "Zed"]);
    expect(projectsWithOwnVaultChoice(undefined, titles)).toEqual([]);
  });
});

describe("vaultChoiceExcludes", () => {
  it("matches by id or name ignoring case, and never excludes with no limit", () => {
    expect(vaultChoiceExcludes(undefined, "Anything")).toBe(false);
    expect(vaultChoiceExcludes([secode], "secode")).toBe(false);
    expect(vaultChoiceExcludes([secode], "v1")).toBe(false);
    expect(vaultChoiceExcludes([secode], "T3 Code Sign-ups")).toBe(true);
    expect(vaultChoiceExcludes([], "Secode")).toBe(true);
  });
});
