import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as SshTunnel from "./tunnel.ts";

const archiveVersion = "1.2.3-preview.20260911.4";

// A Windows remote reached through Git Bash: `uname` reports MINGW, the
// archive is a zip, and only the bsdtar in System32 can open one, not the
// GNU tar on PATH. Shims stand in for that host so the real script runs
// here. The "zip" is a gzip tarball: this pins which archive is asked for
// and which tar opens it; reading a real zip is bsdtar's job.
describe("archive runner script", () => {
  it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "installs the zip archive with the system tar on a Git Bash Windows host",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-archive-runner-" });
        const hostPath = process.env.PATH ?? "";
        const stem = `t3-${archiveVersion}-win32-x64`;
        const stage = `${root}/stage/${stem}`;
        const release = `${root}/mirror/v${archiveVersion}`;
        const systemTarLog = `${root}/system-tar.log`;
        const executables = [
          [`${stage}/t3`, `echo t3 v${archiveVersion}`],
          [
            `${root}/bin/uname`,
            'case "$1" in -s) echo MINGW64_NT-10.0-26300 ;; -m) echo x86_64 ;; esac',
          ],
          [
            `${root}/bin/cygpath`,
            `case "$1" in -S) echo '${root}/System32' ;; -w) printf '%s\\n' "$2" ;; esac`,
          ],
          [`${root}/bin/tar`, "echo 'tar: This does not look like a tar archive' >&2; exit 2"],
          [
            `${root}/System32/tar.exe`,
            `printf '%s\\n' "$*" >> '${systemTarLog}'; PATH='${hostPath.replaceAll("'", "'\\''")}' exec tar "$@"`,
          ],
        ] as const;
        for (const directory of [stage, release, `${root}/bin`, `${root}/System32`]) {
          yield* fs.makeDirectory(directory, { recursive: true });
        }
        for (const [file, body] of executables) {
          yield* fs.writeFileString(file, `#!/bin/sh\n${body}\n`);
          yield* fs.chmod(file, 0o755);
        }
        const pack = yield* spawner.spawn(
          ChildProcess.make("sh", [
            "-c",
            [
              "set -eu",
              `tar -czf '${release}/${stem}.zip' -C '${root}/stage' '${stem}'`,
              `cd '${release}' && (sha256sum '${stem}.zip' 2>/dev/null || shasum -a 256 '${stem}.zip') > SHA256SUMS`,
            ].join("\n"),
          ]),
        );
        assert.equal(Number(yield* pack.exitCode), 0);

        const runner = `${root}/run-t3.sh`;
        yield* fs.writeFileString(
          runner,
          SshTunnel.buildRemoteT3RunnerScript({
            archiveVersion,
            releaseBaseUrl: `file://${root}/mirror`,
          }),
        );
        const home = `${root}/home`;
        yield* fs.makeDirectory(home, { recursive: true });

        // As an SSH remote would: an isolated HOME, and the shims ahead of the host's PATH.
        const child = yield* spawner.spawn(
          ChildProcess.make("sh", [runner, "--version"], {
            env: { PATH: `${root}/bin:${hostPath}`, HOME: home },
            extendEnv: false,
          }),
        );
        const [output, exitCode] = yield* Effect.all(
          [
            child.all.pipe(
              Stream.decodeText(),
              Stream.runFold(
                () => "",
                (acc, chunk) => acc + chunk,
              ),
            ),
            child.exitCode.pipe(Effect.map(Number)),
          ],
          { concurrency: "unbounded" },
        );
        assert.equal(exitCode, 0, output);
        assert.include(output, `t3 v${archiveVersion}`);
        assert.equal(
          (yield* fs.readFileString(
            `${home}/.t3/runtime/versions/${archiveVersion}/.install-complete`,
          )).trim(),
          archiveVersion,
        );
        assert.include(yield* fs.readFileString(systemTarLog), `${stem}.zip`);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
