import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { modelFamilyName, resolveModelFamilyDefault } from "./modelFamilyDefault.ts";

function provider(driver: string, id: string, slugs: string[]): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-18T12:00:00.000Z",
    models: slugs.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
  };
}

describe("follow model family releases", () => {
  const codex = provider("codex", "work", [
    "openai.gpt-6.10-sol",
    "gpt-6.9-sol",
    "gpt-6.11-sol-preview",
    "gpt-7-astra",
  ]);
  const legacy = { ...codex.models[0]!, slug: "gpt-6.15-sol", isLegacy: true };
  const custom = { ...legacy, slug: "gpt-7-sol", isLegacy: false, isCustom: true };
  const catalog = [
    provider("codex", "home", ["gpt-8-sol"]),
    { ...codex, models: [...codex.models, custom, legacy] },
  ];
  const pinned = {
    instanceId: codex.instanceId,
    model: "gpt-6.1-sol",
    options: [{ id: "reasoningEffort", value: "high" }],
  };
  const followed = { ...pinned, followLatest: true };

  it("selects the newest stable release on this instance and preserves options", () => {
    expect(resolveModelFamilyDefault(followed, catalog)).toEqual({
      ...pinned,
      model: "openai.gpt-6.10-sol",
    });
    expect(resolveModelFamilyDefault(pinned, catalog)).toBe(pinned);
    expect(resolveModelFamilyDefault({ ...pinned, followLatest: false }, catalog)).toEqual(pinned);
  });

  it("skips hidden releases on the selected instance", () => {
    const preferences = { hiddenModels: ["openai.gpt-6.10-sol"], modelOrder: [] };
    const settings = { providerModelPreferences: { [codex.instanceId]: preferences } };
    expect(resolveModelFamilyDefault(followed, catalog, settings)).toEqual({
      ...pinned,
      model: "gpt-6.9-sol",
    });
  });

  it("uses the saved concrete choice while the family is unavailable", () => {
    expect(resolveModelFamilyDefault(followed, [])).toEqual(pinned);
    expect(
      resolveModelFamilyDefault(followed, [provider("codex", "work", ["gpt-7-astra"])]),
    ).toEqual(pinned);
  });

  it("matches dotted and hyphenated Opus versions, excluding dated and context variants", () => {
    const claude = provider("claudeAgent", "work", [
      "claude-opus-5-5",
      "claude-opus-5.10",
      "claude-opus-5-11-20261118",
      "claude-opus-6[1m]",
    ]);
    expect(resolveModelFamilyDefault({ ...followed, model: "claude-opus-5" }, [claude])).toEqual({
      ...pinned,
      model: "claude-opus-5.10",
    });
  });

  it.each([
    ["codex", "gpt-6.2-sol", "Sol"],
    ["codex", "gpt-6.2-astra", "Astra"],
    ["codex", "gpt-6-luna", "Luna"],
    ["codex", "gpt-6.1-terra", "Terra"],
    ["claudeAgent", "claude-opus-5.5", "Opus"],
    ["claudeAgent", "claude-haiku-5-5", "Haiku"],
    ["claudeAgent", "claude-sonnet-5", "Sonnet"],
    ["claudeAgent", "claude-fable-5-2", "Fable"],
    ["codex", "gpt-6.2", null],
    ["claudeAgent", "opus", null],
    ["opencode", "claude-opus-5", null],
  ] as const)("recognizes %s %s as %s", (driver, slug, expected) => {
    expect(modelFamilyName(driver, slug)).toBe(expected);
  });
});
