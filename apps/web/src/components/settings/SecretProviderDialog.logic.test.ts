import { SecretProviderId } from "@t3tools/contracts";
import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import { secretProviderFromDraft } from "./SecretProviderDialog.logic";

const noToken = { serviceAccountToken: "", savedServiceAccountToken: "" };

describe("secretProviderFromDraft", () => {
  it("adds a provider keyed by its name and reports every field that blocks it", () => {
    expect(
      secretProviderFromDraft(
        { name: "  1Password!  ", account: "my.1password.com", ...noToken },
        new Set(),
        { mode: "add" },
      ),
    ).toEqual(
      Result.succeed({
        id: "1password",
        config: {
          kind: "one_password",
          label: "1Password!",
          config: { account: "my.1password.com" },
        },
      }),
    );

    const blocked = secretProviderFromDraft(
      { name: "1Password", account: "--help", ...noToken },
      new Set(["1password"]),
      { mode: "add" },
    );
    expect(Result.isFailure(blocked) && Object.keys(blocked.failure).toSorted()).toEqual([
      "account",
      "name",
    ]);
  });

  it("keeps the id, and the saved token unless a new one is typed or it is cleared, when an edit renames it", () => {
    const id = SecretProviderId.make("personal");
    for (const [tokens, saved] of [
      [{ serviceAccountToken: "", savedServiceAccountToken: "••••••" }, "••••••"],
      [{ serviceAccountToken: " ops_new ", savedServiceAccountToken: "••••••" }, "ops_new"],
      // The server keeps a saved token the config leaves out, so a clear must be sent.
      [{ ...noToken, clearServiceAccountToken: true }, ""],
    ] as const) {
      const result = secretProviderFromDraft(
        { name: "Personal (team)", account: "team.1password.com", ...tokens },
        new Set(["personal"]),
        { mode: "edit", id },
      );
      expect(Result.isSuccess(result) && result.success).toEqual({
        id,
        config: {
          kind: "one_password",
          label: "Personal (team)",
          config: { account: "team.1password.com", serviceAccountToken: saved },
        },
      });
    }
  });
});
