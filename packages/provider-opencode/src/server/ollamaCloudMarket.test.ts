import { assert, describe, it } from "@effect/vitest";

import { ollamaCloudRateModel } from "./ollamaCloudMarket.ts";

describe("ollamaCloudRateModel", () => {
  it("spells Ollama's tags the way OpenRouter names its models, in Ollama Cloud's namespace", () => {
    const keys: ReadonlyArray<readonly [string, string]> = [
      ["gpt-oss:120b", "ollama-cloud/gpt-oss-120b"],
      ["gpt-oss:120b-cloud", "ollama-cloud/gpt-oss-120b"],
      ["glm-4.6:cloud", "ollama-cloud/glm-4.6"],
      ["  GLM-5.3 ", "ollama-cloud/glm-5.3"],
      ["deepseek-v4.1-flash:1017", "ollama-cloud/deepseek-v4.1-flash-1017"],
      ["kimi-k3", "ollama-cloud/kimi-k3"],
    ];
    for (const [id, key] of keys) assert.strictEqual(ollamaCloudRateModel(id), key);
  });
});
