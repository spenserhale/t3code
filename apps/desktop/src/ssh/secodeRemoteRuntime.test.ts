import { assert, describe, it } from "@effect/vitest";
import { cliReleaseChannelOf } from "@t3tools/shared/cliRelease";
import { buildRemoteT3RunnerScript } from "@t3tools/ssh/tunnel";

import { SECODE_REMOTE_RUNTIME_VERSION, withSecodeRemoteRuntime } from "./secodeRemoteRuntime.ts";

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

  // Upstream's resolver also names the release mirror, and a dev checkout runs its own server.
  it("replaces only a release runner's version", () => {
    const mirror = "https://mirror.example.com/t3code";
    assert.deepStrictEqual(
      withSecodeRemoteRuntime({ archiveVersion: "0.1.11", releaseBaseUrl: mirror }),
      { archiveVersion: SECODE_REMOTE_RUNTIME_VERSION, releaseBaseUrl: mirror },
    );
    const devRunner = { nodeScriptPath: "/repo/apps/server/src/bin.ts", nodeEngineRange: "^24" };
    assert.strictEqual(withSecodeRemoteRuntime(devRunner), devRunner);
  });
});
