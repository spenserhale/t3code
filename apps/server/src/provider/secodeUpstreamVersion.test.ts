import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import { cliReleaseChannelOf } from "@t3tools/shared/cliRelease";

import * as ModelManifest from "./ModelManifest.ts";
import { resolveProviderCompatibility } from "./providerCompatibility.ts";
import { SECODE_UPSTREAM_VERSION } from "./secodeUpstreamVersion.ts";

describe("SECODE_UPSTREAM_VERSION", () => {
  // A stable release lags `main`, which is the mismatch the pin exists to avoid.
  it("names a nightly release", () => {
    assert.equal(cliReleaseChannelOf(SECODE_UPSTREAM_VERSION), "nightly");
  });

  it("picks the policy for the adapters this build has", () => {
    const opencode = ProviderDriverKind.make("opencode");
    for (const [version, expected] of [
      ["2.0.27", "supported"],
      ["1.14.19", "graceful"],
    ] as const) {
      assert.strictEqual(
        resolveProviderCompatibility(
          ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility,
          opencode,
          version,
        )?.status,
        expected,
        `OpenCode ${version}`,
      );
    }
  });
});
