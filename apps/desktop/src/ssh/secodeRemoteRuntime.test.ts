import { assert, describe, it } from "@effect/vitest";
import { cliReleaseChannelOf } from "@t3tools/shared/cliRelease";
import { buildRemoteT3RunnerScript } from "@t3tools/ssh/tunnel";

import { SECODE_REMOTE_RUNTIME_VERSION } from "./secodeRemoteRuntime.ts";

describe("SECODE_REMOTE_RUNTIME_VERSION", () => {
  // A stable release lags `main`, which is the mismatch the pin exists to avoid.
  it("names a nightly release", () => {
    assert.equal(cliReleaseChannelOf(SECODE_REMOTE_RUNTIME_VERSION), "nightly");
  });

  // A malformed pin throws when a remote connects, which breaks every SSH host.
  it("is a version the remote runner installs", () => {
    assert.include(
      buildRemoteT3RunnerScript({ archiveVersion: SECODE_REMOTE_RUNTIME_VERSION }),
      `T3_ARCHIVE_VERSION='${SECODE_REMOTE_RUNTIME_VERSION}'`,
    );
  });
});
