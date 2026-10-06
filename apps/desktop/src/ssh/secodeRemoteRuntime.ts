/**
 * The upstream release whose archive SECode installs and runs on SSH remotes.
 *
 * SECode is built from upstream `main`, so its package version still names
 * the last stable release while its wire protocol and database have moved on.
 * A remote running that stable archive is a server this client refuses, and
 * one that mints pairing tokens where the SECode already running on that
 * machine never looks. Upstream cuts a nightly from the commit `main` is on;
 * its archive is this build's server code.
 *
 * Name the nightly tagged on the commit `secode` was rebuilt from.
 */
export const SECODE_REMOTE_RUNTIME_VERSION = "0.0.46-nightly.20261004.2657";
