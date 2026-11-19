import { expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { OrchestratorToolkit } from "./tools.ts";

// Oversized page sizes clamp on decode, so the schema has no `maximum`; Codex also drops
// bounds from its TypeScript view. The description is the only place a model sees a limit.
it("states t3_thread_read page size limits in the parameter descriptions", () => {
  const schema = Tool.getJsonSchema(OrchestratorToolkit.tools.t3_thread_read) as {
    readonly properties: Readonly<Record<string, { readonly description?: string }>>;
  };
  const limits = { limit: "100", runLimit: "50", maxCharsPerItem: "50000" };
  for (const [name, maximum] of Object.entries(limits)) {
    expect(schema.properties[name]?.description, name).toContain(maximum);
  }
});

it("refuses a t3_thread_update whose fields do not fit its action", () => {
  const decode = Schema.decodeUnknownExit(
    OrchestratorToolkit.tools.t3_thread_update.parametersSchema,
  );
  expect(Exit.isFailure(decode({ action: "rename" }))).toBe(true);
  expect(Exit.isFailure(decode({ action: "regenerate_title", title: "New" }))).toBe(true);
  expect(Exit.isSuccess(decode({ action: "rename", title: "New", environmentId: undefined }))).toBe(
    true,
  );
});

it("takes run_with_secrets secrets only as 1Password references, and at least one", () => {
  const decode = Schema.decodeUnknownExit(
    OrchestratorToolkit.tools.run_with_secrets.parametersSchema,
  );
  const command = ["wide-search", "auth", "set", "firecrawl", "--stdin"];
  const reference = "op://Employee/Firecrawl/Apikeys/default";
  expect(Exit.isSuccess(decode({ command, stdin: reference }))).toBe(true);
  expect(Exit.isSuccess(decode({ command, env: { FIRECRAWL_API_KEY: reference } }))).toBe(true);
  for (const input of [
    { command },
    { command, env: {} },
    { command, stdin: "fc-live-123" },
    { command, env: { FIRECRAWL_API_KEY: "fc-live-123" } },
    { command, env: { firecrawl: reference } },
    {
      command,
      env: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`KEY_${index}`, reference])),
    },
    { command: [], stdin: reference },
  ]) {
    expect(Exit.isFailure(decode(input)), JSON.stringify(input)).toBe(true);
  }
});
