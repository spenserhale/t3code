import type {
  DefaultModelSelection,
  ModelSelection,
  ServerProvider,
  ServerSettings,
} from "@t3tools/contracts";
import { codexModelFamily } from "./model.ts";
import { compareSemverVersions } from "./semver.ts";

const codexFamilies = ["Sol", "Astra", "Luna", "Terra"] as const;
const claudeFamilies = ["Opus", "Sonnet", "Haiku", "Fable"] as const;

function familyRelease(driver: string, model: string) {
  if (driver !== "codex" && driver !== "claudeAgent") return null;
  const match =
    driver === "codex"
      ? /^gpt-(?<version>\d+(?:\.\d+){0,2})-(?<family>[a-z]+)$/.exec(codexModelFamily(model))
      : /^claude-(?<family>[a-z]+)-(?<version>\d{1,3}(?:[.-]\d{1,3}){0,2})$/.exec(model);
  const { family: slug, version } = match?.groups ?? {};
  const names = driver === "codex" ? codexFamilies : claudeFamilies;
  const family = names.find((name) => name.toLowerCase() === slug);
  return family && version ? { family, version: version.replaceAll("-", ".") } : null;
}

export function modelFamilyName(driver: string, model: string) {
  return familyRelease(driver, model)?.family ?? null;
}

export function resolveModelFamilyDefault(
  selection: DefaultModelSelection,
  providers: readonly ServerProvider[],
  settings?: Pick<ServerSettings, "providerModelPreferences">,
): ModelSelection;
export function resolveModelFamilyDefault(
  selection: DefaultModelSelection | null,
  providers: readonly ServerProvider[],
  settings?: Pick<ServerSettings, "providerModelPreferences">,
): ModelSelection | null;
export function resolveModelFamilyDefault(
  selection: DefaultModelSelection | null,
  providers: readonly ServerProvider[],
  settings?: Pick<ServerSettings, "providerModelPreferences">,
): ModelSelection | null {
  if (!selection) return null;
  if (selection.followLatest === undefined) return selection;
  const { followLatest, ...concrete } = selection;
  if (!followLatest) return concrete;
  const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
  if (!provider) return concrete;
  const family = modelFamilyName(provider.driver, selection.model);
  if (!family) return concrete;

  const hidden = settings?.providerModelPreferences?.[selection.instanceId]?.hiddenModels;
  let latest: { model: string; version: string } | undefined;
  for (const entry of provider.models) {
    if (entry.isCustom || entry.isLegacy || hidden?.includes(entry.slug)) continue;
    const release = familyRelease(provider.driver, entry.slug);
    if (release?.family !== family) continue;
    if (!latest || compareSemverVersions(release.version, latest.version) > 0) {
      latest = { model: entry.slug, version: release.version };
    }
  }
  return latest ? { ...concrete, model: latest.model } : concrete;
}
